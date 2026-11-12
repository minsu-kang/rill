import { classifyHttp, redactSecrets, type HttpErrorInfo } from '../classify'
import type { LlmCall } from '../http'
import { LlmError, type LlmErrorKind, type LlmErrorOptions } from '../types'

const MAX_DETAIL = 300
const SCHEMA_HINT = 'Gemini limits how complex a response schema can be; flatten nesting, shorten property names, trim enum values or lower maxItems'
const SCHEMA_POINTER = /#?(?:\/[A-Za-z0-9_$~-]+){2,}|\bschema(?:\.[A-Za-z0-9_$-]+)+/

const REFUSAL_CODES: readonly string[] = ['safety', 'prohibited_content', 'blocklist', 'jailbreak', 'recitation', 'language', 'spii', 'content_blocked']

const EVENT_KINDS: ReadonlyMap<string, LlmErrorKind> = new Map<string, LlmErrorKind>([
  ['authentication', 'auth'],
  ['permission_denied', 'auth'],
  ['payment_required', 'auth'],
  ['rate_limit_exceeded', 'rate_limit'],
  ['quota_exceeded', 'rate_limit'],
  ['too_many_requests', 'rate_limit'],
  ['service_unavailable', 'overloaded'],
  ['api_error', 'overloaded'],
  ['deadline_exceeded', 'timeout'],
  ['gateway_timeout', 'timeout'],
  ['cancelled', 'connection'],
  ['invalid_request', 'invalid_request'],
  ['failed_precondition', 'invalid_request'],
  ['parameter_unknown', 'invalid_request'],
  ['out_of_range', 'invalid_request'],
  ['model_not_found', 'invalid_request'],
  ['missing_thought_signature', 'invalid_request'],
  ...REFUSAL_CODES.map((code): [string, LlmErrorKind] => [code, 'refusal']),
])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function detailOf(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_DETAIL ? `${collapsed.slice(0, MAX_DETAIL)}...` : collapsed
}

function isInvalidKey(message: string): boolean {
  return /api key/i.test(message) && /not valid|invalid|expired/i.test(message)
}

function kindFor(info: HttpErrorInfo): LlmErrorKind | undefined {
  const code = info.code?.toLowerCase()
  if (code !== undefined && REFUSAL_CODES.includes(code)) return 'refusal'
  if (info.status === 400 && isInvalidKey(info.message)) return 'auth'
  return undefined
}

function retryDelayMs(bodyText: string): number | undefined {
  const error = jsonOf(bodyText)?.['error']
  const details = isRecord(error) ? error['details'] : undefined
  if (!Array.isArray(details)) return undefined
  for (const detail of details) {
    const delay = isRecord(detail) ? detail['retryDelay'] : undefined
    const seconds = typeof delay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(delay)?.[1] : undefined
    if (seconds !== undefined) return Math.round(Number(seconds) * 1000)
  }
  return undefined
}

function withRetryHint(headers: Headers | undefined, bodyText: string): Headers {
  const out = new Headers(headers)
  if (out.has('retry-after') || out.has('retry-after-ms')) return out
  const delay = retryDelayMs(bodyText)
  if (delay !== undefined) out.set('retry-after-ms', String(delay))
  return out
}

function providerMessage(bodyText: string): string {
  const error = jsonOf(bodyText)?.['error']
  const message = isRecord(error) ? error['message'] : undefined
  return typeof message === 'string' ? message : ''
}

function withSchemaHint(error: LlmError, bodyText: string, secrets: readonly string[]): LlmError {
  const message = redactSecrets(providerMessage(bodyText), secrets)
  if (!/schema/i.test(message)) return error
  const pointer = SCHEMA_POINTER.exec(message)?.[0]
  const where = pointer === undefined ? '' : ` (the reply points at ${pointer})`
  return new LlmError('invalid_request', `${error.message}. Hint: ${SCHEMA_HINT}${where}.`, {
    status: error.status,
    requestId: error.requestId,
    category: error.category,
  })
}

export function classifyGeminiHttp(status: number, bodyText: string, headers: Headers | undefined, secrets: readonly string[]): LlmError {
  const error = classifyHttp(status, bodyText, withRetryHint(headers, bodyText), { secrets, kindFor })
  return status === 400 && error.kind === 'invalid_request' && error.category !== 'context_too_long' ? withSchemaHint(error, bodyText, secrets) : error
}

export function eventError(code: string | undefined, message: string | undefined, secrets: readonly string[], billed: LlmErrorOptions = {}): LlmError {
  const kind = (code === undefined ? undefined : EVENT_KINDS.get(code)) ?? 'unknown'
  const detail = detailOf(redactSecrets(message ?? '', secrets))
  const label = code === undefined ? '' : ` (${code})`
  return new LlmError(kind, `the model provider ended the stream with an error${label}${detail === '' ? '' : `: ${detail}`}`, {
    ...(code === undefined ? {} : { category: code }),
    ...billed,
  })
}

interface HttpShape {
  status: number
  headers: Headers | undefined
  body: string
}

function httpShape(error: unknown): HttpShape | undefined {
  if (!(error instanceof Error)) return undefined
  const { status, statusCode, headers, body } = error as { status?: unknown; statusCode?: unknown; headers?: unknown; body?: unknown }
  const code = typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : undefined
  if (code === undefined || code < 100) return undefined
  return { status: code, headers: headers instanceof Headers ? headers : undefined, body: typeof body === 'string' ? body : '' }
}

export function sdkFailure(error: unknown, call: LlmCall, secrets: readonly string[]): LlmError {
  if (error instanceof LlmError) return error
  if (call.signal.aborted) return call.abortError()
  const http = httpShape(error)
  if (http !== undefined) return classifyGeminiHttp(http.status, http.body, http.headers, secrets)
  return new LlmError('connection', 'could not reach the model provider', { cause: error })
}
