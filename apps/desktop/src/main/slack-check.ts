import type { SlackVerdict } from '../shared/host-api'
import { readBounded } from './key-check'

export interface SlackCheckRequest {
  method: 'POST'
  headers: Record<string, string>
  redirect: 'error'
  credentials: 'omit'
  signal: AbortSignal
}

export type SlackCheckFetch = (url: string, init: SlackCheckRequest) => Promise<Response>

export interface SlackCheckDeps {
  fetch: SlackCheckFetch
  timeoutMs?: number
}

export type SlackChecker = (token: string) => Promise<SlackVerdict>

const URL = 'https://slack.com/api/auth.test'
const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 16 * 1024
const MAX_TEXT = 80
const REJECTED: ReadonlySet<string> = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'])
const UNWANTED = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function displayText(value: unknown, token: string): string | undefined {
  if (typeof value !== 'string' || value.includes(token)) return undefined
  const text = value.replace(UNWANTED, '').trim().slice(0, MAX_TEXT).replace(LONE_SURROGATE, '').trim()
  return text === '' ? undefined : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function classify(token: string, response: Response): Promise<SlackVerdict> {
  const status = response.status
  if (status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    if (status === 401) return { status: 'invalid', reason: 'unauthorized' }
    if (status === 403) return { status: 'unverified', reason: 'forbidden' }
    if (status === 429) return { status: 'unverified', reason: 'rate_limited' }
    if (status >= 500 && status < 600) return { status: 'unverified', reason: 'server_error' }
    return { status: 'unverified', reason: 'unexpected_status' }
  }
  let body: unknown
  try {
    body = JSON.parse(await readBounded(response, MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'unverified', reason: 'unexpected_status' }
    throw error
  }
  if (!isRecord(body) || typeof body.ok !== 'boolean') return { status: 'unverified', reason: 'unexpected_status' }
  if (body.ok) {
    const workspace = displayText(body.team, token)
    const bot = displayText(body.user, token)
    return { status: 'valid', ...(workspace === undefined ? {} : { workspace }), ...(bot === undefined ? {} : { bot }) }
  }
  if (typeof body.error === 'string' && REJECTED.has(body.error)) return { status: 'invalid', reason: 'unauthorized' }
  return { status: 'unverified', reason: body.error === 'ratelimited' ? 'rate_limited' : 'forbidden' }
}

export function createSlackChecker(deps: SlackCheckDeps): SlackChecker {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  return async (token) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await deps.fetch(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Rill' },
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      })
      return await classify(token, response)
    } catch {
      return { status: 'unverified', reason: timedOut ? 'timeout' : 'network' }
    } finally {
      clearTimeout(timer)
    }
  }
}
