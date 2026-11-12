import Anthropic, { type APIError } from '@anthropic-ai/sdk'
import { LlmError, type LlmErrorKind, type LlmErrorOptions } from './types'

const MAX_DETAIL = 300

const STREAM_ERROR_KINDS: ReadonlyMap<string, LlmErrorKind> = new Map([
  ['overloaded_error', 'overloaded'],
  ['api_error', 'overloaded'],
  ['rate_limit_error', 'rate_limit'],
  ['timeout_error', 'timeout'],
  ['authentication_error', 'auth'],
  ['permission_error', 'auth'],
])
const DROPPED_CONNECTION_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'])
const STREAM_ENDED_EARLY = /^(stream ended without producing|request ended without sending any chunks)/

function detail(error: Error): string {
  const text = error.message.replace(/\s+/g, ' ').trim()
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text
}

function headerNumber(headers: Headers | undefined, name: string): number | undefined {
  const raw = headers?.get(name)
  if (raw === null || raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function retryAfterMs(error: APIError): number | undefined {
  const milliseconds = headerNumber(error.headers, 'retry-after-ms')
  if (milliseconds !== undefined) return milliseconds
  const seconds = headerNumber(error.headers, 'retry-after')
  return seconds === undefined ? undefined : seconds * 1000
}

function isDroppedStream(error: Error): boolean {
  if (STREAM_ENDED_EARLY.test(error.message)) return true
  let cause: unknown = error.cause
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    const code = (cause as { code?: unknown }).code
    if (cause.message === 'terminated' || (typeof code === 'string' && DROPPED_CONNECTION_CODES.has(code))) return true
    cause = cause.cause
  }
  return false
}

function meta(error: APIError): LlmErrorOptions {
  return {
    cause: error,
    status: error.status,
    requestId: error.requestID ?? undefined,
    retryAfterMs: retryAfterMs(error),
  }
}

export function classifyError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LlmError('aborted', 'the request was cancelled', { cause: error })
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('timeout', 'the request to the model provider timed out', { cause: error })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('connection', 'could not reach the model provider', { cause: error })
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status
    const streamKind = status === undefined ? STREAM_ERROR_KINDS.get(error.type ?? '') : undefined
    if (streamKind !== undefined) {
      return new LlmError(streamKind, `the model provider ended the stream with an error (${error.type})`, meta(error))
    }
    if (status === 401 || status === 403) {
      return new LlmError('auth', `the model provider rejected the credentials (${status})`, meta(error))
    }
    if (status === 429) {
      return new LlmError('rate_limit', 'the model provider is rate limiting requests (429)', meta(error))
    }
    if (status === 408) {
      return new LlmError('timeout', 'the model provider timed out (408)', meta(error))
    }
    if (status !== undefined && status >= 500) {
      return new LlmError('overloaded', `the model provider had a server error (${status})`, meta(error))
    }
    return new LlmError(
      'invalid_request',
      `the model provider rejected the request (${status ?? 'unknown status'}): ${detail(error)}`,
      meta(error),
    )
  }
  if (error instanceof Anthropic.AnthropicError && isDroppedStream(error)) {
    return new LlmError('connection', 'the connection to the model provider dropped while the reply was streaming', { cause: error })
  }
  if (error instanceof Error && /authentication method/i.test(error.message)) {
    return new LlmError('auth', 'no Anthropic credentials found; set ANTHROPIC_API_KEY', { cause: error })
  }
  const text = error instanceof Error ? detail(error) : String(error)
  return new LlmError('unknown', `unexpected error calling the model provider: ${text}`, { cause: error })
}

export type HeaderSource = Headers | Readonly<Record<string, string | undefined>> | undefined

export interface HttpErrorInfo {
  status: number
  message: string
  code?: string
  type?: string
  param?: string
  retryAfterMs?: number
  requestId?: string
}

export interface ClassifyHttpOptions {
  kindFor?: (info: HttpErrorInfo) => LlmErrorKind | undefined
  secrets?: readonly string[]
  now?: () => number
}

const CONTEXT_OVERFLOW = /context (?:length|window|is too long)|too long for|exceeds? (?:the )?(?:maximum )?(?:context|input)|input (?:is )?too long|maximum context/i
const SECRET_SHAPES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|rk|xai|gsk)-[A-Za-z0-9_*-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bLLM_[A-Za-z0-9_-]{16,}/g,
]

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return undefined
}

export function parseRetryAfterMs(headers: HeaderSource, now: () => number = Date.now): number | undefined {
  const milliseconds = header(headers, 'retry-after-ms')?.trim()
  if (milliseconds !== undefined && milliseconds !== '' && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) return Number(milliseconds)
  const raw = header(headers, 'retry-after')?.trim()
  if (raw === undefined || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now())
}

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]')
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[redacted]')
  return out
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined
}

function errorInfo(status: number, bodyText: string, headers: HeaderSource, options: ClassifyHttpOptions): HttpErrorInfo {
  const info: HttpErrorInfo = { status, message: bodyText }
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    parsed = undefined
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const outer = parsed as Record<string, unknown>
    const inner = typeof outer.error === 'object' && outer.error !== null ? (outer.error as Record<string, unknown>) : outer
    info.message = text(inner.message) ?? text(outer.error) ?? text(outer.message) ?? ''
    const code = text(inner.code) ?? text(outer.code)
    const type = text(inner.type) ?? text(inner.status)
    if (code !== undefined) info.code = code.slice(0, 64)
    if (type !== undefined) info.type = type.slice(0, 64)
    const param = text(inner.param)
    if (param !== undefined) info.param = param.slice(0, 64)
  }
  const retryAfterMs = parseRetryAfterMs(headers, options.now)
  if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs
  const requestId = header(headers, 'x-request-id') ?? header(headers, 'request-id')
  if (requestId !== undefined) info.requestId = requestId
  return info
}

function defaultKind(status: number): LlmErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 499) return 'connection'
  if (status >= 500) return 'overloaded'
  return 'invalid_request'
}

export function classifyHttp(status: number, bodyText: string, headers?: HeaderSource, options: ClassifyHttpOptions = {}): LlmError {
  const info = errorInfo(status, bodyText, headers, options)
  const meta: LlmErrorOptions = {
    status,
    ...(info.requestId === undefined ? {} : { requestId: info.requestId }),
    ...(info.retryAfterMs === undefined ? {} : { retryAfterMs: info.retryAfterMs }),
  }
  const detail = detailOf(redactSecrets(info.message, options.secrets))
  const label = info.code ?? info.type
  const suffix = detail === '' ? '' : `: ${detail}`
  if (CONTEXT_OVERFLOW.test(info.message)) {
    return new LlmError('invalid_request', `the input is too long for this model (${status})${suffix}`, { ...meta, category: 'context_too_long' })
  }
  const custom = options.kindFor?.(info)
  const kind = custom ?? defaultKind(status)
  const category = label === undefined ? {} : { category: label }
  if (custom !== undefined) {
    return new LlmError(kind, `the model provider refused the request (${status}${label === undefined ? '' : ` ${label}`})${suffix}`, { ...meta, ...category })
  }
  switch (kind) {
    case 'auth':
      return new LlmError(kind, status === 402 ? 'the model provider reports a billing or credit problem (402)' : `the model provider rejected the credentials (${status})`, { ...meta, ...category })
    case 'rate_limit':
      return new LlmError(kind, 'the model provider is rate limiting requests (429)', { ...meta, ...category })
    case 'timeout':
      return new LlmError(kind, `the model provider timed out (${status})`, { ...meta, ...category })
    case 'connection':
      return new LlmError(kind, `the model provider closed the request (${status})`, { ...meta, ...category })
    case 'overloaded':
      return new LlmError(kind, `the model provider had a server error (${status})`, { ...meta, ...category })
    default:
      return new LlmError(kind, `the model provider rejected the request (${status})${suffix}`, { ...meta, ...category })
  }
}

function detailOf(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_DETAIL ? `${collapsed.slice(0, MAX_DETAIL)}...` : collapsed
}
