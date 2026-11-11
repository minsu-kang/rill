import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { LlmError, classifyError } from '../src/index'

const apiError = (status: number, message = 'boom', headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, `${status} ${message}`, new Headers(headers))

describe('LlmError', () => {
  it('marks only transient kinds and unusable replies as retryable', () => {
    const retryable = ['rate_limit', 'overloaded', 'connection', 'timeout', 'invalid_output'] as const
    const permanent = ['auth', 'invalid_request', 'refusal', 'truncated', 'aborted', 'unknown'] as const
    for (const kind of retryable) expect(new LlmError(kind, 'x').retryable).toBe(true)
    for (const kind of permanent) expect(new LlmError(kind, 'x').retryable).toBe(false)
  })

  it('keeps its kind, name, cause and metadata', () => {
    const cause = new Error('inner')
    const error = new LlmError('rate_limit', 'slow', { cause, status: 429, requestId: 'req_1', retryAfterMs: 2000, category: 'c' })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('LlmError')
    expect(error.kind).toBe('rate_limit')
    expect(error.cause).toBe(cause)
    expect(error).toMatchObject({ status: 429, requestId: 'req_1', retryAfterMs: 2000, category: 'c' })
    expect(new LlmError('unknown', 'x').status).toBeUndefined()
  })
})

describe('classifyError', () => {
  it('passes an LlmError through unchanged', () => {
    const error = new LlmError('refusal', 'declined')
    expect(classifyError(error)).toBe(error)
  })

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [408, 'timeout', true],
    [500, 'overloaded', true],
    [529, 'overloaded', true],
    [400, 'invalid_request', false],
    [404, 'invalid_request', false],
  ] as const)('maps HTTP %i to %s (retryable: %s)', (status, kind, retryable) => {
    const result = classifyError(apiError(status))
    expect(result.kind).toBe(kind)
    expect(result.retryable).toBe(retryable)
    expect(result.status).toBe(status)
  })

  it('carries the request id and the retry-after hint from the response headers', () => {
    expect(classifyError(apiError(429, 'x', { 'request-id': 'req_123', 'retry-after-ms': '1500' }))).toMatchObject({
      status: 429,
      requestId: 'req_123',
      retryAfterMs: 1500,
    })
    expect(classifyError(apiError(429, 'x', { 'retry-after': '3' })).retryAfterMs).toBe(3000)
    expect(classifyError(apiError(429, 'x', { 'retry-after': 'soon' })).retryAfterMs).toBeUndefined()
    expect(classifyError(apiError(429)).retryAfterMs).toBeUndefined()
    expect(classifyError(apiError(429)).requestId).toBeUndefined()
  })

  it('does not put provider detail into auth, rate limit or server errors', () => {
    for (const status of [401, 403, 429, 500]) {
      expect(classifyError(apiError(status, 'secret-detail-xyz')).message).not.toContain('secret-detail-xyz')
    }
  })

  it('keeps provider detail for rejected requests and caps its length', () => {
    expect(classifyError(apiError(400, 'output_config.format.schema is invalid')).message).toContain(
      'output_config.format.schema is invalid',
    )
    const long = classifyError(apiError(400, 'x'.repeat(2000))).message
    expect(long.length).toBeLessThan(450)
    expect(long.endsWith('...')).toBe(true)
  })

  it('says so when the SDK gives no status', () => {
    const odd = new Anthropic.APIError(undefined, undefined, 'weird failure', undefined)
    expect(classifyError(odd).message).toContain('unknown status')
    expect(classifyError(odd).message).not.toContain('undefined')
  })

  it('maps connection, timeout and abort errors', () => {
    expect(classifyError(new Anthropic.APIConnectionError({}))).toMatchObject({ kind: 'connection', retryable: true })
    expect(classifyError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: 'timeout', retryable: true })
    expect(classifyError(new Anthropic.APIUserAbortError())).toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('maps the missing-credentials error from the SDK to auth with a hint', () => {
    const error = new Error('Could not resolve authentication method. Expected one of apiKey, authToken to be set.')
    expect(classifyError(error)).toMatchObject({
      kind: 'auth',
      retryable: false,
      message: 'no Anthropic credentials found; set ANTHROPIC_API_KEY',
    })
  })

  it('maps anything else to a non-retryable unknown error and keeps the cause', () => {
    const cause = new TypeError('bad thing')
    const mapped = classifyError(cause)
    expect(mapped).toMatchObject({ kind: 'unknown', retryable: false })
    expect(mapped.message).toContain('bad thing')
    expect(mapped.cause).toBe(cause)
    expect(classifyError('plain string')).toMatchObject({ kind: 'unknown' })
  })
})
