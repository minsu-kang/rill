import { describe, expect, it } from 'vitest'
import { classifyGeminiHttp, eventError, sdkFailure } from '../../src/gemini/errors'
import { LlmError, startCall } from '../../src/index'

const KEY = 'AIzaSyD-rill-test-key-0123456789abcdef'
const classify = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  classifyGeminiHttp(status, typeof body === 'string' ? body : JSON.stringify(body), new Headers(headers), [KEY])

const interactions = (code: string, message = 'm') => ({ error: { code, message } })
const generateContent = (code: number, status: string, message = 'm') => ({ error: { code, status, message } })

describe('classifyGeminiHttp: Interactions error codes', () => {
  it.each([
    [401, 'authentication', 'auth'],
    [403, 'permission_denied', 'auth'],
    [402, 'payment_required', 'auth'],
    [429, 'rate_limit_exceeded', 'rate_limit'],
    [429, 'quota_exceeded', 'rate_limit'],
    [429, 'too_many_requests', 'rate_limit'],
    [503, 'service_unavailable', 'overloaded'],
    [500, 'api_error', 'overloaded'],
    [504, 'deadline_exceeded', 'timeout'],
    [499, 'cancelled', 'connection'],
    [400, 'invalid_request', 'invalid_request'],
    [400, 'failed_precondition', 'invalid_request'],
    [400, 'parameter_unknown', 'invalid_request'],
    [416, 'out_of_range', 'invalid_request'],
    [404, 'model_not_found', 'invalid_request'],
    [400, 'safety', 'refusal'],
    [400, 'prohibited_content', 'refusal'],
    [400, 'blocklist', 'refusal'],
    [400, 'jailbreak', 'refusal'],
    [400, 'recitation', 'refusal'],
    [400, 'language', 'refusal'],
    [400, 'spii', 'refusal'],
    [400, 'content_blocked', 'refusal'],
  ] as const)('%i %s is %s', (status, code, kind) => {
    const error = classify(status, interactions(code))
    expect(error).toBeInstanceOf(LlmError)
    expect(error.kind).toBe(kind)
    expect(error.status).toBe(status)
    expect(error.category).toBe(code)
  })

  it('keeps the quota category so the caller can tell a spent quota from a rate limit', () => {
    expect(classify(429, interactions('quota_exceeded')).category).toBe('quota_exceeded')
    expect(classify(429, interactions('rate_limit_exceeded')).category).toBe('rate_limit_exceeded')
  })
})

describe('classifyGeminiHttp: generateContent statuses', () => {
  it.each([
    [400, 'INVALID_ARGUMENT', 'invalid_request'],
    [400, 'FAILED_PRECONDITION', 'invalid_request'],
    [402, 'RESOURCE_EXHAUSTED', 'auth'],
    [403, 'PERMISSION_DENIED', 'auth'],
    [404, 'NOT_FOUND', 'invalid_request'],
    [429, 'RESOURCE_EXHAUSTED', 'rate_limit'],
    [499, 'CANCELLED', 'connection'],
    [500, 'INTERNAL', 'overloaded'],
    [503, 'UNAVAILABLE', 'overloaded'],
    [504, 'DEADLINE_EXCEEDED', 'timeout'],
  ] as const)('%i %s is %s', (status, name, kind) => {
    expect(classify(status, generateContent(status, name)).kind).toBe(kind)
  })

  it('reads the documented over-long prompt (a 500 INTERNAL) as a context error that is not retried', () => {
    const error = classify(500, generateContent(500, 'INTERNAL', 'Your input context is too long'))
    expect(error).toMatchObject({ kind: 'invalid_request', status: 500, category: 'context_too_long' })
    expect(error.retryable).toBe(false)
  })
})

describe('classifyGeminiHttp: invalid keys', () => {
  it.each(['API key not valid. Please pass a valid API key.', 'API key expired. Please renew the API key.', 'The API key is invalid'])('a 400 saying "%s" is an auth error', (message) => {
    expect(classify(400, generateContent(400, 'INVALID_ARGUMENT', message)).kind).toBe('auth')
  })

  it('does not take other 400s for key problems, and does not take a 500 for one', () => {
    expect(classify(400, generateContent(400, 'INVALID_ARGUMENT', 'Unknown name "foo"')).kind).toBe('invalid_request')
    expect(classify(400, generateContent(400, 'INVALID_ARGUMENT', 'api key mentioned but nothing is wrong')).kind).toBe('invalid_request')
    expect(classify(500, generateContent(500, 'INTERNAL', 'API key not valid')).kind).toBe('overloaded')
  })
})

describe('classifyGeminiHttp: retry hints', () => {
  const detail = (retryDelay: unknown) => ({ error: { code: 'rate_limit_exceeded', message: 'm', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo' }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] } })

  it('reads RetryInfo.retryDelay from the body', () => {
    expect(classify(429, detail('34s')).retryAfterMs).toBe(34_000)
    expect(classify(429, detail('0.5s')).retryAfterMs).toBe(500)
    expect(classify(429, detail('2.25s')).retryAfterMs).toBe(2250)
  })

  it('ignores a delay it cannot read', () => {
    for (const bad of ['soon', '-3s', '10', 7, null, '5m']) expect(classify(429, detail(bad)).retryAfterMs, String(bad)).toBeUndefined()
  })

  it('lets the Retry-After headers win over the body', () => {
    expect(classify(429, detail('34s'), { 'retry-after': '3' }).retryAfterMs).toBe(3000)
    expect(classify(429, detail('34s'), { 'retry-after-ms': '1200' }).retryAfterMs).toBe(1200)
  })

  it('has no hint when there is none', () => {
    expect(classify(429, interactions('rate_limit_exceeded')).retryAfterMs).toBeUndefined()
    expect(classify(429, 'not json').retryAfterMs).toBeUndefined()
  })
})

describe('classifyGeminiHttp: too-complex schemas', () => {
  const rejected = (message: string) => classify(400, generateContent(400, 'INVALID_ARGUMENT', message))

  it('adds a hint to a schema rejection', () => {
    const error = rejected('The specified schema produces a constraint that has too many states for serving.')
    expect(error.kind).toBe('invalid_request')
    expect(error.message).toMatch(/too many states/)
    expect(error.message).toMatch(/simplify|shorten|flatten/i)
    expect(error.status).toBe(400)
  })

  it('names the schema location when the reply gives one', () => {
    expect(rejected('schema is too complex at #/properties/items/items/properties/tags').message).toContain('(the reply points at #/properties/items/items/properties/tags)')
    expect(rejected('response_format.schema.properties.items.items is too deeply nested for the schema').message).toContain('(the reply points at schema.properties.items.items)')
    expect(rejected('The specified schema produces a constraint that has too many states for serving.').message).not.toContain('points at')
  })

  it('adds nothing to a 400 that is not about the schema, or to other statuses', () => {
    expect(rejected('Unknown name "foo" at generation_config').message).not.toMatch(/simplify|shorten|flatten/i)
    expect(classify(429, generateContent(429, 'RESOURCE_EXHAUSTED', 'schema quota')).message).not.toMatch(/simplify|shorten|flatten/i)
    expect(classify(404, interactions('model_not_found', 'no schema for this model')).message).not.toMatch(/simplify|shorten|flatten/i)
  })

  it('keeps the status, category and request id', () => {
    const error = classify(400, interactions('invalid_request', 'the schema is too complex'), { 'x-request-id': 'r1' })
    expect(error).toMatchObject({ kind: 'invalid_request', status: 400, category: 'invalid_request', requestId: 'r1' })
  })
})

describe('classifyGeminiHttp: secrets and odd bodies', () => {
  it('removes the key and key-shaped strings from the message', () => {
    const error = classify(400, interactions('invalid_request', `key ${KEY} rejected; also AIzaSyAbcdefghijklmnopqrstuvwx`))
    expect(error.message).not.toContain(KEY)
    expect(error.message).not.toContain('AIzaSyAbcdefghij')
    expect(error.message).toContain('[redacted]')
  })

  it('survives a body that is not JSON, not an object, or empty', () => {
    expect(classify(502, '<html>bad gateway</html>').kind).toBe('overloaded')
    expect(classify(500, '[1,2,3]').kind).toBe('overloaded')
    expect(classify(400, '').kind).toBe('invalid_request')
    expect(classify(429, 'null').kind).toBe('rate_limit')
  })
})

describe('eventError', () => {
  it('maps stream error codes and names the code as the category', () => {
    expect(eventError('gateway_timeout', 'Deadline expired', [KEY])).toMatchObject({ kind: 'timeout', category: 'gateway_timeout' })
    expect(eventError('service_unavailable', 'x', [KEY]).kind).toBe('overloaded')
    expect(eventError('rate_limit_exceeded', 'x', [KEY]).kind).toBe('rate_limit')
    expect(eventError('safety', 'Input blocked', [KEY]).kind).toBe('refusal')
    expect(eventError(undefined, undefined, [KEY]).kind).toBe('unknown')
  })

  it('keeps the message, cut short, without the key', () => {
    const error = eventError('invalid_request', `${KEY} ${'x'.repeat(1000)}`, [KEY])
    expect(error.message).not.toContain(KEY)
    expect(error.message.length).toBeLessThan(500)
  })
})

describe('sdkFailure', () => {
  const call = () => startCall(60_000)

  it('keeps an LlmError as it is', () => {
    const own = new LlmError('refusal', 'no')
    const active = call()
    expect(sdkFailure(own, active, [KEY])).toBe(own)
    active.dispose()
  })

  it('reads the status, headers and body of an SDK error and classifies them', () => {
    const active = call()
    const sdkError = Object.assign(new Error(`429 slow down ${KEY}`), {
      status: 429,
      headers: new Headers({ 'retry-after': '4' }),
      body: JSON.stringify(interactions('rate_limit_exceeded', `slow down ${KEY}`)),
    })
    const error = sdkFailure(sdkError, active, [KEY])
    expect(error).toMatchObject({ kind: 'rate_limit', status: 429, retryAfterMs: 4000 })
    expect(error.message).not.toContain(KEY)
    expect(error.cause).toBeUndefined()
    active.dispose()
  })

  it('accepts statusCode as the status, and a missing header object', () => {
    const active = call()
    const error = sdkFailure(Object.assign(new Error('x'), { statusCode: 503, body: '' }), active, [KEY])
    expect(error).toMatchObject({ kind: 'overloaded', status: 503 })
    active.dispose()
  })

  it('reports the call as aborted or timed out when its signal fired, whatever the error was', async () => {
    const controller = new AbortController()
    const active = startCall(60_000, controller.signal)
    controller.abort()
    expect(sdkFailure(new TypeError('terminated'), active, [KEY]).kind).toBe('aborted')
    active.dispose()
    const quick = startCall(5)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sdkFailure(new Error('x'), quick, [KEY]).kind).toBe('timeout')
    quick.dispose()
  })

  it('takes anything else for a connection failure and keeps the cause', () => {
    const active = call()
    const cause = new TypeError('fetch failed')
    const error = sdkFailure(cause, active, [KEY])
    expect(error).toMatchObject({ kind: 'connection' })
    expect(error.cause).toBe(cause)
    expect(sdkFailure('boom', active, [KEY]).kind).toBe('connection')
    active.dispose()
  })
})
