import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai'
import { classifyHttp, type HttpErrorInfo } from '../classify'
import type { LlmCall } from '../http'
import { LlmError, type LlmErrorKind } from '../types'
import { clip, codeError, isRecord } from './reply'

const QUOTA_LABELS: ReadonlySet<string> = new Set(['insufficient_quota', 'credit_balance_exhausted'])
const QUOTA_SUFFIX = /(?:spend|usage)_limit_exceeded$/

const isQuota = (label: string | undefined): boolean => label !== undefined && (QUOTA_LABELS.has(label) || QUOTA_SUFFIX.test(label))

function kindFor(info: HttpErrorInfo): LlmErrorKind | undefined {
  if (info.status === 403 && info.code === 'misalignment_policy_violation') return 'refusal'
  if (info.status === 429 && (isQuota(info.code) || isQuota(info.type))) return 'auth'
  return undefined
}

function causeText(cause: unknown, secrets: readonly string[]): string {
  const messages: string[] = []
  for (let depth = 0, current: unknown = cause; depth < 4 && current instanceof Error; depth++, current = current.cause) {
    if (current.message !== '' && !messages.includes(current.message)) messages.push(current.message)
  }
  return messages.length === 0 ? 'no detail' : clip(messages.join(': '), secrets)
}

function fromHttp(error: APIError, secrets: readonly string[]): LlmError {
  const status = error.status as number
  const bodyText = isRecord(error.error) ? JSON.stringify({ error: error.error }) : ''
  const classified = classifyHttp(status, bodyText, error.headers, { kindFor, secrets })
  const param = typeof error.param === 'string' && error.param !== '' ? error.param : undefined
  if (classified.kind !== 'invalid_request' || param === undefined) return classified
  return new LlmError('invalid_request', `${classified.message} (parameter ${param.slice(0, 64)})`, {
    status,
    ...(classified.requestId === undefined ? {} : { requestId: classified.requestId }),
    ...(classified.category === undefined ? {} : { category: classified.category }),
  })
}

export function classifyOpenAiError(error: unknown, call: LlmCall, secrets: readonly string[]): LlmError {
  if (error instanceof LlmError) return error
  if (call.signal.aborted) return call.abortError()
  if (error instanceof APIUserAbortError) return new LlmError('aborted', 'the request was cancelled')
  if (error instanceof APIConnectionTimeoutError) return new LlmError('timeout', 'the request to the model provider timed out')
  if (error instanceof APIConnectionError) return new LlmError('connection', `could not reach the model provider (${causeText(error.cause, secrets)})`)
  if (error instanceof APIError) {
    if (error.status !== undefined) return fromHttp(error, secrets)
    return codeError(typeof error.code === 'string' ? error.code : undefined, error.message, secrets, error.requestID == null ? {} : { requestId: error.requestID })
  }
  const text = clip(error instanceof Error ? error.message : String(error), secrets)
  return new LlmError('unknown', `unexpected error calling the model provider: ${text}`)
}

export function streamFailure(error: unknown, call: LlmCall, secrets: readonly string[]): unknown {
  if (error instanceof LlmError || error instanceof APIError) return error
  if (call.signal.aborted) return call.abortError()
  if (error instanceof SyntaxError) return new LlmError('invalid_output', 'the model provider sent a stream event that is not valid JSON')
  return new LlmError('connection', `the connection to the model provider dropped while the reply was streaming (${causeText(error, secrets)})`)
}
