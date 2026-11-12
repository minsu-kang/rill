import { describe, expect, it } from 'vitest'
import { classifyHttp, parseRetryAfterMs } from '../src/index'

const KEY = 'sk-live-abcdef0123456789'
const body = (error: Record<string, unknown>) => JSON.stringify({ error })

describe('parseRetryAfterMs', () => {
  const now = () => Date.parse('2026-11-12T10:00:00Z')

  it('reads seconds, fractional seconds and milliseconds, preferring the millisecond header', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '7' }), now)).toBe(7000)
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '1.5' }), now)).toBe(1500)
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(250)
    expect(parseRetryAfterMs({ 'Retry-After': '3' }, now)).toBe(3000)
  })

  it('treats a zero millisecond wait as a real value, not as missing', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '0' }), now)).toBe(0)
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '0', 'retry-after': '9' }), now)).toBe(0)
  })

  it('reads an HTTP date and never returns a negative wait', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'Thu, 12 Nov 2026 10:00:30 GMT' }), now)).toBe(30_000)
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'Thu, 12 Nov 2026 09:00:00 GMT' }), now)).toBe(0)
  })

  it.each(['', '  ', 'soon', '-3', 'NaN', 'Infinity'])('ignores the unusable value %j', (value) => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': value }), now)).toBeUndefined()
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': value }), now)).toBeUndefined()
  })

  it('returns undefined without headers', () => {
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined()
    expect(parseRetryAfterMs(new Headers(), now)).toBeUndefined()
  })
})

describe('classifyHttp', () => {
  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [402, 'auth', false],
    [429, 'rate_limit', true],
    [408, 'timeout', true],
    [504, 'timeout', true],
    [500, 'overloaded', true],
    [502, 'overloaded', true],
    [503, 'overloaded', true],
    [529, 'overloaded', true],
    [499, 'connection', true],
    [400, 'invalid_request', false],
    [404, 'invalid_request', false],
    [413, 'invalid_request', false],
    [422, 'invalid_request', false],
  ] as const)('maps %i to %s', (status, kind, retryable) => {
    const error = classifyHttp(status, '', new Headers())
    expect(error.kind).toBe(kind)
    expect(error.retryable).toBe(retryable)
    expect(error.status).toBe(status)
  })

  it('carries retry-after, request id and the vendor error code', () => {
    const error = classifyHttp(
      429,
      body({ message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' }),
      new Headers({ 'retry-after': '5', 'x-request-id': 'req_9' }),
    )
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterMs: 5000, requestId: 'req_9', category: 'rate_limit_exceeded' })
  })

  it('reads the Gemini, xAI and Anthropic error shapes', () => {
    expect(classifyHttp(400, body({ code: 400, message: 'bad schema', status: 'INVALID_ARGUMENT' }), new Headers()).message).toContain('bad schema')
    expect(classifyHttp(404, JSON.stringify({ code: 'not-found', error: 'The model x does not exist' }), new Headers()).message).toContain('The model x does not exist')
    expect(classifyHttp(400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }), new Headers()).message).toContain('nope')
    expect(classifyHttp(400, 'plain text body', new Headers()).message).toContain('plain text body')
  })

  it('names a context overflow as an invalid request whatever the status', () => {
    for (const status of [400, 413, 500]) {
      const error = classifyHttp(status, body({ message: 'Your input context is too long for this model' }), new Headers())
      expect(error.kind).toBe('invalid_request')
      expect(error.category).toBe('context_too_long')
      expect(error.message).toContain('too long')
    }
    expect(classifyHttp(400, body({ message: "the model's context length is only 1048576 tokens" }), new Headers()).category).toBe('context_too_long')
  })

  it('lets a vendor map its own codes to another kind', () => {
    const error = classifyHttp(429, body({ code: 'credit_balance_exhausted', message: 'out of credit' }), new Headers(), {
      kindFor: (info) => (info.code === 'credit_balance_exhausted' ? 'auth' : undefined),
    })
    expect(error.kind).toBe('auth')
    expect(error.message).toContain('credit_balance_exhausted')
    expect(classifyHttp(429, body({ code: 'other' }), new Headers(), { kindFor: () => undefined }).kind).toBe('rate_limit')
  })

  it('never puts a key into the message, from the body or from the listed secrets', () => {
    const echo = `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY}`
    for (const status of [400, 401, 429, 500]) {
      const error = classifyHttp(status, body({ message: echo }), new Headers(), { secrets: [KEY] })
      expect(error.message).not.toContain(KEY)
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(KEY)
    }
    const shaped = classifyHttp(400, body({ message: 'bad xai-0123456789abcdefghij and AIzaSyA1234567890abcdefghijk and Bearer abc.def-ghi_jklmnop' }), new Headers())
    expect(shaped.message).not.toMatch(/xai-0123|AIzaSyA1234|abc\.def/)
  })

  it('keeps the detail short and on one line', () => {
    const error = classifyHttp(400, body({ message: `line one\n\n   line two ${'x'.repeat(1000)}` }), new Headers())
    expect(error.message).not.toContain('\n')
    expect(error.message.length).toBeLessThan(500)
    expect(error.message).toContain('line one line two')
  })

  it('handles an empty or unparseable body without throwing', () => {
    expect(classifyHttp(400, '', new Headers()).kind).toBe('invalid_request')
    expect(classifyHttp(500, '<html>oops</html>', new Headers()).kind).toBe('overloaded')
  })
})

describe('classifyHttp details', () => {
  it('reads the request id from either header name', () => {
    expect(classifyHttp(500, '{}', new Headers({ 'x-request-id': 'req_x' })).requestId).toBe('req_x')
    expect(classifyHttp(500, '{}', new Headers({ 'request-id': 'req_plain' })).requestId).toBe('req_plain')
    expect(classifyHttp(500, '{}', new Headers({ 'x-request-id': 'req_x', 'request-id': 'req_plain' })).requestId).toBe('req_x')
  })

  it('keeps no more than 64 characters of a vendor code or type as the category', () => {
    expect(classifyHttp(400, body({ code: 'c'.repeat(100), message: 'm' })).category).toBe('c'.repeat(64))
    expect(classifyHttp(400, body({ type: 't'.repeat(100), message: 'm' })).category).toBe('t'.repeat(64))
  })

  it('redacts a secret of four characters but not one of three', async () => {
    const { redactSecrets } = await import('../src/index')
    expect(redactSecrets('the key abcd leaked', ['abcd'])).toBe('the key [redacted] leaked')
    expect(redactSecrets('the key abc leaked', ['abc'])).toBe('the key abc leaked')
  })
})
