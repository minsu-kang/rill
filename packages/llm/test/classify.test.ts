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

describe('classifyError for streamed replies', () => {
  const eventError = (type: string | undefined, headers: Record<string, string> = {}) =>
    new Anthropic.APIError(undefined, { type: 'error', error: { type, message: 'secret-detail-xyz' } }, undefined, new Headers(headers), type as never)

  it.each([
    ['overloaded_error', 'overloaded', true],
    ['api_error', 'overloaded', true],
    ['rate_limit_error', 'rate_limit', true],
    ['timeout_error', 'timeout', true],
    ['authentication_error', 'auth', false],
    ['permission_error', 'auth', false],
  ] as const)('maps an error event of type %s to %s', (type, kind, retryable) => {
    const mapped = classifyError(eventError(type, { 'request-id': 'req_9', 'retry-after': '2' }))
    expect(mapped).toMatchObject({ kind, retryable, requestId: 'req_9', retryAfterMs: 2000, status: undefined })
    expect(mapped.message).toContain(type)
    expect(mapped.message).not.toContain('secret-detail-xyz')
  })

  it.each(['invalid_request_error', 'billing_error', 'not_found_error', 'brand_new_error', '__proto__', 'constructor', 'toString', undefined])(
    'keeps an error event of type %s as a rejected request',
    (type) => {
      expect(classifyError(eventError(type))).toMatchObject({ kind: 'invalid_request', retryable: false })
    },
  )

  it('lets the HTTP status win over the error type when there is a status', () => {
    const error = Anthropic.APIError.generate(
      400,
      { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
      '400 x',
      new Headers(),
    )
    expect(classifyError(error)).toMatchObject({ kind: 'invalid_request', status: 400 })
  })

  const socketError = () => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  const wrapped = (cause: Error) => new Anthropic.AnthropicError('terminated', { cause })

  it('maps the error the SDK raises for a dropped stream to a retryable connection error', () => {
    const terminated = new TypeError('terminated', { cause: socketError() })
    const mapped = classifyError(wrapped(terminated))
    expect(mapped).toMatchObject({ kind: 'connection', retryable: true })
    expect(mapped.cause).toBeInstanceOf(Anthropic.AnthropicError)
  })

  it('recognises a drop by the message or by the network error code alone', () => {
    expect(classifyError(wrapped(new TypeError('terminated')))).toMatchObject({ kind: 'connection' })
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']) {
      const cause = Object.assign(new Error('read failed'), { code })
      expect(classifyError(wrapped(cause))).toMatchObject({ kind: 'connection', retryable: true })
    }
  })

  it('recognises a stream that ended without a message', () => {
    for (const text of ['stream ended without producing a Message with role=assistant', 'request ended without sending any chunks']) {
      expect(classifyError(new Anthropic.AnthropicError(text))).toMatchObject({ kind: 'connection', retryable: true })
    }
  })

  it('leaves other SDK errors and unrelated causes as unknown', () => {
    expect(classifyError(new Anthropic.AnthropicError('Unexpected event order, got message_start before receiving "message_stop"'))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
    expect(classifyError(wrapped(Object.assign(new Error('no access'), { code: 'EACCES' })))).toMatchObject({ kind: 'unknown' })
    expect(classifyError(new Anthropic.AnthropicError('something else', { cause: 'terminated' }))).toMatchObject({ kind: 'unknown' })
  })

  it('finds the network code further down the cause chain', () => {
    const twoDeep = new TypeError('fetch failed', { cause: new Error('socket', { cause: socketError() }) })
    expect(classifyError(wrapped(twoDeep))).toMatchObject({ kind: 'connection', retryable: true })
    expect(classifyError(wrapped(new TypeError('fetch failed', { cause: socketError() })))).toMatchObject({ kind: 'connection' })
  })

  it('does not call a plain error a dropped stream, and keeps the missing-credentials hint for SDK errors', () => {
    expect(classifyError(new Error('terminated'))).toMatchObject({ kind: 'unknown' })
    expect(classifyError(new Error('failed', { cause: new TypeError('terminated') }))).toMatchObject({ kind: 'unknown' })
    expect(classifyError(new Error('stream ended without producing a Message with role=assistant'))).toMatchObject({ kind: 'unknown' })
    expect(classifyError(new Anthropic.AnthropicError('Could not resolve authentication method. Expected apiKey.'))).toMatchObject({
      kind: 'auth',
    })
  })
})

