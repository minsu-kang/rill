import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'
import { createServer as nodeCreateServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HostError, MAX_ACCOUNT_LENGTH, type OAuthProvider } from '../shared/host-api'
import type { ClockLike } from './engine-supervisor'
import { readBounded } from './key-check'
import { OAUTH_PROVIDER_CONFIGS, grantsRequiredScopes, redirectUri } from './oauth-providers'

export type OAuthClock = ClockLike

export interface OAuthFetchInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  redirect: 'error'
  credentials: 'omit'
  signal: AbortSignal
}

export type OAuthFetch = (url: string, init: OAuthFetchInit) => Promise<Response>

export interface OAuthApp {
  clientId: string
  clientSecret?: string
}

export interface FetchDeps {
  fetch: OAuthFetch
  clock: OAuthClock
}

export interface FlowDeps extends FetchDeps {
  openExternal(url: string): Promise<void>
  randomBytes?: (size: number) => Buffer
  createServer?: (listener: RequestListener) => Server
  timeoutMs?: number
}

export interface SignInResult {
  accessToken: string
  refreshToken: string
  scope: string
  expiresAt: number
  account?: string
}

export interface SignIn {
  done: Promise<SignInResult>
  cancel(): void
}

export interface AccessGrant {
  accessToken: string
  expiresAt: number
  refreshToken?: string
  scope?: string
}

export type RefreshOutcome = { kind: 'ok'; grant: AccessGrant } | { kind: 'revoked' } | { kind: 'transient'; retryAfterMs?: number }

export const CALLBACK_PATH = '/oauth/callback'
export const OAUTH_TIMEOUT_MS = 180_000
export const REQUEST_TIMEOUT_MS = 15_000
const MAX_ANSWER_BYTES = 64 * 1024
const MAX_CODE_LENGTH = 4096
const MAX_REFRESH_TOKEN_LENGTH = 4096
const MAX_RETRY_AFTER_MS = 3_600_000
const MAX_EXPIRES_SECONDS = 86_400
const ACCESS_TOKEN = /^[A-Za-z0-9\-._~+/]{8,8192}={0,3}$/
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/
const UNWANTED = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const USER_AGENT = 'Rill'

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  Connection: 'close',
} as const

const DONE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rill</title></head><body><p>You can close this tab and go back to Rill.</p><p lang="ko">이 탭을 닫고 Rill로 돌아가세요.</p></body></html>'
const REFUSED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rill</title></head><body><p>This address is not valid.</p></body></html>'

function failure(code: 'OAUTH_TIMEOUT' | 'OAUTH_CANCELLED' | 'OAUTH_DENIED' | 'OAUTH_EXCHANGE_FAILED' | 'OAUTH_SCOPE_MISSING'): HostError {
  return new HostError(code)
}

export function createPkcePair(random: (size: number) => Buffer = nodeRandomBytes): { verifier: string; challenge: string } {
  const verifier = random(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function createStateValue(random: (size: number) => Buffer = nodeRandomBytes): string {
  return random(16).toString('hex')
}

export function buildAuthorizeUrl(input: { provider: OAuthProvider; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const config = OAUTH_PROVIDER_CONFIGS[input.provider]
  const url = new URL(config.authorizeUrl)
  const params = url.searchParams
  params.set('response_type', 'code')
  params.set('client_id', input.clientId)
  params.set('redirect_uri', input.redirectUri)
  params.set('scope', config.scopes.join(' '))
  params.set('state', input.state)
  params.set('code_challenge', input.challenge)
  params.set('code_challenge_method', 'S256')
  for (const [name, value] of Object.entries(config.authorizeParams)) params.set(name, value)
  return url.toString()
}

async function withTimeout<T>(deps: FetchDeps, outer: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = deps.clock.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const forward = () => controller.abort()
  outer?.addEventListener('abort', forward, { once: true })
  if (outer?.aborted === true) controller.abort()
  try {
    return await work(controller.signal)
  } finally {
    deps.clock.clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  }
}

function postForm(deps: FetchDeps, url: string, form: URLSearchParams, signal: AbortSignal): Promise<Response> {
  return deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: form.toString(),
    redirect: 'error',
    credentials: 'omit',
    signal,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = JSON.parse(await readBounded(response, MAX_ANSWER_BYTES))
    return isRecord(body) ? body : undefined
  } catch {
    return undefined
  }
}

function secondsOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) return Number(value) > 0 ? Number(value) : undefined
  return undefined
}

function parseGrant(body: Record<string, unknown> | undefined, now: number): AccessGrant | undefined {
  if (body === undefined) return undefined
  const { access_token: access, expires_in: expires, refresh_token: refresh, scope, token_type: type } = body
  if (typeof access !== 'string' || !ACCESS_TOKEN.test(access)) return undefined
  if (type !== undefined && (typeof type !== 'string' || type.toLowerCase() !== 'bearer')) return undefined
  const seconds = secondsOf(expires)
  if (seconds === undefined) return undefined
  const grant: AccessGrant = { accessToken: access, expiresAt: now + Math.min(seconds, MAX_EXPIRES_SECONDS) * 1000 }
  if (typeof refresh === 'string' && refresh.length >= 1 && refresh.length <= MAX_REFRESH_TOKEN_LENGTH && !refresh.includes('\u0000')) grant.refreshToken = refresh
  if (typeof scope === 'string' && scope.length <= 2000) grant.scope = scope
  return grant
}

function accountText(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || secrets.some((secret) => value.includes(secret))) return undefined
  const text = value.replace(UNWANTED, '').trim().slice(0, MAX_ACCOUNT_LENGTH).replace(LONE_SURROGATE, '').trim()
  return text === '' ? undefined : text
}

async function fetchAccount(provider: OAuthProvider, accessToken: string, secrets: readonly string[], deps: FetchDeps, outer: AbortSignal): Promise<string | undefined> {
  const config = OAUTH_PROVIDER_CONFIGS[provider]
  try {
    const body = await withTimeout(deps, outer, async (signal) => {
      const response = await deps.fetch(config.userinfoUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
        redirect: 'error',
        credentials: 'omit',
        signal,
      })
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
      return readJson(response)
    })
    if (body === undefined) return undefined
    for (const field of config.accountFields) {
      const text = accountText(body[field], secrets)
      if (text !== undefined) return text
    }
  } catch {
    return undefined
  }
  return undefined
}

function tokenForm(provider: OAuthProvider, app: OAuthApp, values: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams(values)
  form.set('client_id', app.clientId)
  if (OAUTH_PROVIDER_CONFIGS[provider].clientSecret === 'optional' && app.clientSecret !== undefined) form.set('client_secret', app.clientSecret)
  return form
}

async function exchange(input: { provider: OAuthProvider; app: OAuthApp; code: string; redirect: string; verifier: string; deps: FetchDeps; outer: AbortSignal }): Promise<AccessGrant> {
  const { provider, deps, outer } = input
  let grant: AccessGrant | undefined
  try {
    grant = await withTimeout(deps, outer, async (signal) => {
      const form = tokenForm(provider, input.app, { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirect, code_verifier: input.verifier })
      const response = await postForm(deps, OAUTH_PROVIDER_CONFIGS[provider].tokenUrl, form, signal)
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
      return parseGrant(await readJson(response), deps.clock.now())
    })
  } catch {
    grant = undefined
  }
  if (outer.aborted) throw failure('OAUTH_CANCELLED')
  if (grant === undefined) throw failure('OAUTH_EXCHANGE_FAILED')
  return grant
}

type Callback = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'malformed' } | { kind: 'timeout' } | { kind: 'cancelled' }

function sameState(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reply(res: ServerResponse, status: number, page: string): void {
  res.statusCode = status
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(page))
  res.end(page)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
    server.listen({ port: 0, host: '127.0.0.1' })
  })
}

function callbackOf(query: URLSearchParams): Callback {
  if (query.has('error')) return { kind: 'denied' }
  const codes = query.getAll('code')
  const code = codes[0]
  if (codes.length !== 1 || code === undefined || code.length < 1 || code.length > MAX_CODE_LENGTH) return { kind: 'malformed' }
  return { kind: 'code', code }
}

export function startSignIn(input: { provider: OAuthProvider; app: OAuthApp; deps: FlowDeps }): SignIn {
  const { provider, app, deps } = input
  const random = deps.randomBytes ?? nodeRandomBytes
  const abort = new AbortController()
  let wake: (() => void) | undefined

  async function run(): Promise<SignInResult> {
    const { verifier, challenge } = createPkcePair(random)
    const state = createStateValue(random)
    let port = 0
    let finished = false
    let resolveCallback!: (callback: Callback) => void
    const callback = new Promise<Callback>((resolve) => {
      resolveCallback = resolve
    })
    wake = () => resolveCallback({ kind: 'cancelled' })

    const handle = (req: IncomingMessage, res: ServerResponse): void => {
      const raw = req.url ?? ''
      const mark = raw.indexOf('?')
      const path = mark === -1 ? raw : raw.slice(0, mark)
      const host = req.headers.host
      const hostOk = host === `127.0.0.1:${port}` || host === `localhost:${port}`
      if (finished || req.method !== 'GET' || path !== CALLBACK_PATH || !hostOk) {
        reply(res, 404, REFUSED_PAGE)
        return
      }
      const query = new URLSearchParams(mark === -1 ? '' : raw.slice(mark + 1))
      const states = query.getAll('state')
      const given = states[0]
      if (states.length !== 1 || given === undefined || !sameState(given, state)) {
        reply(res, 400, REFUSED_PAGE)
        return
      }
      finished = true
      const outcome = callbackOf(query)
      res.once('finish', () => resolveCallback(outcome))
      res.once('close', () => resolveCallback(outcome))
      reply(res, 200, DONE_PAGE)
    }

    const server = (deps.createServer ?? nodeCreateServer)(handle)
    server.on('clientError', (_error, socket) => socket.destroy())
    let timer: unknown
    const cleanup = async (): Promise<void> => {
      deps.clock.clearTimeout(timer)
      await closeServer(server)
    }
    try {
      try {
        port = await listen(server)
      } catch {
        throw failure('OAUTH_EXCHANGE_FAILED')
      }
      if (abort.signal.aborted) throw failure('OAUTH_CANCELLED')
      const redirect = redirectUri(provider, port)
      timer = deps.clock.setTimeout(() => resolveCallback({ kind: 'timeout' }), deps.timeoutMs ?? OAUTH_TIMEOUT_MS)
      try {
        await deps.openExternal(buildAuthorizeUrl({ provider, clientId: app.clientId, redirectUri: redirect, state, challenge }))
      } catch {
        throw failure('OAUTH_EXCHANGE_FAILED')
      }
      const outcome = await callback
      deps.clock.clearTimeout(timer)
      await cleanup()
      if (outcome.kind === 'timeout') throw failure('OAUTH_TIMEOUT')
      if (outcome.kind === 'cancelled') throw failure('OAUTH_CANCELLED')
      if (outcome.kind === 'denied') throw failure('OAUTH_DENIED')
      if (outcome.kind === 'malformed') throw failure('OAUTH_EXCHANGE_FAILED')
      const grant = await exchange({ provider, app, code: outcome.code, redirect, verifier, deps, outer: abort.signal })
      const config = OAUTH_PROVIDER_CONFIGS[provider]
      if (grant.refreshToken === undefined) throw failure('OAUTH_SCOPE_MISSING')
      if (grant.scope !== undefined && !grantsRequiredScopes(provider, grant.scope)) throw failure('OAUTH_SCOPE_MISSING')
      const account = await fetchAccount(provider, grant.accessToken, [grant.accessToken, grant.refreshToken], deps, abort.signal)
      if (abort.signal.aborted) throw failure('OAUTH_CANCELLED')
      return {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        scope: grant.scope ?? config.scopes.join(' '),
        expiresAt: grant.expiresAt,
        ...(account === undefined ? {} : { account }),
      }
    } finally {
      await cleanup()
    }
  }

  return {
    done: run(),
    cancel() {
      if (abort.signal.aborted) return
      abort.abort()
      wake?.()
    },
  }
}

function retryAfterOf(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const value = header.trim()
  if (/^\d{1,9}$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS)
  if (!HTTP_DATE.test(value)) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS)
}

export async function refreshTokens(input: { provider: OAuthProvider; app: OAuthApp; refreshToken: string; deps: FetchDeps }): Promise<RefreshOutcome> {
  const { provider, deps } = input
  try {
    return await withTimeout<RefreshOutcome>(deps, undefined, async (signal) => {
      const form = tokenForm(provider, input.app, { grant_type: 'refresh_token', refresh_token: input.refreshToken })
      const response = await postForm(deps, OAUTH_PROVIDER_CONFIGS[provider].tokenUrl, form, signal)
      if (response.status >= 200 && response.status < 300) {
        const grant = parseGrant(await readJson(response), deps.clock.now())
        return grant === undefined ? { kind: 'transient' } : { kind: 'ok', grant }
      }
      const retryAfterMs = retryAfterOf(response.headers.get('retry-after'), deps.clock.now())
      const body = await readJson(response)
      const code = body === undefined ? undefined : body.error
      if (code === 'invalid_grant' || code === 'invalid_client') return { kind: 'revoked' }
      return retryAfterMs === undefined ? { kind: 'transient' } : { kind: 'transient', retryAfterMs }
    })
  } catch {
    return { kind: 'transient' }
  }
}

export async function revokeRefreshToken(input: { provider: OAuthProvider; refreshToken: string; deps: FetchDeps }): Promise<void> {
  const url = OAUTH_PROVIDER_CONFIGS[input.provider].revokeUrl
  if (url === undefined) return
  try {
    await withTimeout(input.deps, undefined, async (signal) => {
      const response = await postForm(input.deps, url, new URLSearchParams({ token: input.refreshToken }), signal)
      await response.body?.cancel().catch(() => undefined)
    })
  } catch {
    return
  }
}
