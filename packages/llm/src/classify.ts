import Anthropic, { type APIError } from '@anthropic-ai/sdk'
import { LlmError, type LlmErrorOptions } from './types'

const MAX_DETAIL = 300

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
  if (error instanceof Error && /authentication method/i.test(error.message)) {
    return new LlmError('auth', 'no Anthropic credentials found; set ANTHROPIC_API_KEY', { cause: error })
  }
  const text = error instanceof Error ? detail(error) : String(error)
  return new LlmError('unknown', `unexpected error calling the model provider: ${text}`, { cause: error })
}
