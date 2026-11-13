import type { KeyVerdict, ProviderId } from '../shared/host-api'

export interface KeyCheckRequest {
  method: 'GET'
  headers: Record<string, string>
  redirect: 'error'
  credentials: 'omit'
  signal: AbortSignal
}

export type KeyCheckFetch = (url: string, init: KeyCheckRequest) => Promise<Response>

export interface KeyCheckDeps {
  fetch: KeyCheckFetch
  timeoutMs?: number
}

export type KeyChecker = (provider: ProviderId, key: string) => Promise<KeyVerdict>

interface Target {
  url: string
  headers(key: string): Record<string, string>
  rejection?: RegExp
  scopeShortfall?: RegExp
}

const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 4096
const USER_AGENT = 'Rill'
const HEADER_SAFE = /^[\x21-\x7e]+$/

const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT })

const TARGETS: Readonly<Record<ProviderId, Target>> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'User-Agent': USER_AGENT }),
  },
  openai: { url: 'https://api.openai.com/v1/models', headers: bearer, scopeShortfall: /insufficient permissions|missing scopes/i },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (key) => ({ 'x-goog-api-key': key, 'User-Agent': USER_AGENT }),
    rejection: /API_KEY_INVALID/,
  },
  grok: { url: 'https://api.x.ai/v1/models', headers: bearer, rejection: /incorrect api key|invalid api key/i },
  meta: { url: 'https://api.meta.ai/v1/models', headers: bearer },
}

export async function readBounded(response: Response, limit = MAX_BODY_BYTES): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return new TextDecoder().decode(bytes.subarray(0, limit))
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function classify(target: Target, response: Response): Promise<KeyVerdict> {
  const status = response.status
  if (status >= 200 && status < 300) {
    await discard(response)
    return { status: 'valid' }
  }
  if (status === 400) {
    const text = await readBounded(response)
    if (target.rejection?.test(text) === true) return { status: 'invalid', reason: 'rejected' }
    return { status: 'unverified', reason: 'unexpected_status' }
  }
  if (status === 401 && target.scopeShortfall !== undefined) {
    const text = await readBounded(response)
    return target.scopeShortfall.test(text) ? { status: 'unverified', reason: 'forbidden' } : { status: 'invalid', reason: 'unauthorized' }
  }
  await discard(response)
  if (status === 401) return { status: 'invalid', reason: 'unauthorized' }
  if (status === 403) return { status: 'unverified', reason: 'forbidden' }
  if (status === 429) return { status: 'unverified', reason: 'rate_limited' }
  if (status >= 500 && status < 600) return { status: 'unverified', reason: 'server_error' }
  return { status: 'unverified', reason: 'unexpected_status' }
}

export function createKeyChecker(deps: KeyCheckDeps): KeyChecker {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  return async (provider, key) => {
    if (!HEADER_SAFE.test(key)) return { status: 'invalid', reason: 'malformed' }
    const target = TARGETS[provider]
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await deps.fetch(target.url, {
        method: 'GET',
        headers: target.headers(key),
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      })
      return await classify(target, response)
    } catch {
      return { status: 'unverified', reason: timedOut ? 'timeout' : 'network' }
    } finally {
      clearTimeout(timer)
    }
  }
}
