import { describe, expect, it } from 'vitest'
import { emptyExchange } from '../src/descriptor'
import { metaExchange } from '../src/meta'
import { CONFORMANCE_DATA } from './conformance'
import { sseChunks } from './fake-transport'
import { META_TEST_MODEL, NORMALISED_USAGE, RAW_USAGE, chatChunks, type MetaUsageFixture } from './meta-wire'

const stream = (content: string, options: Parameters<typeof chatChunks>[1] = {}) => sseChunks(chatChunks(content, options)).join('')
const json = (value: unknown) => JSON.stringify(value)
const completion = (overrides: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  model: META_TEST_MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: json(CONFORMANCE_DATA), refusal: null } }],
  usage: RAW_USAGE,
  ...overrides,
})

describe('the Meta exchange parser on a stream', () => {
  it('reads the model, the finish reason, the usage buckets and the kinds of content', () => {
    expect(metaExchange.parse(stream(json(CONFORMANCE_DATA)), true)).toEqual({
      model: META_TEST_MODEL,
      stopReason: 'stop',
      usage: NORMALISED_USAGE,
      contentBlockTypes: ['text'],
      fallbackBlocks: 0,
      thinkingChars: 0,
      badReply: null,
    })
  })

  it('marks a refusal and keeps the finish reason of a cut-off reply', () => {
    expect(metaExchange.parse(stream('', { refusal: 'no' }), true)).toMatchObject({ contentBlockTypes: ['refusal'], stopReason: 'stop', badReply: null })
    expect(metaExchange.parse(stream('{"a":', { finish: 'length' }), true)).toMatchObject({ stopReason: 'length', usage: NORMALISED_USAGE, badReply: null })
    expect(metaExchange.parse(stream('', { finish: 'content_filter' }), true)).toMatchObject({ stopReason: 'content_filter', contentBlockTypes: [] })
  })

  it('reads the usage the way the adapter does, cached subset and larger reasoning count included', () => {
    const usage = (value: MetaUsageFixture) => metaExchange.parse(stream('{}', { usage: value }), true).usage
    expect(usage({ prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400, prompt_tokens_details: { cached_tokens: 250 } })).toEqual({
      inputTokens: 750,
      outputTokens: 400,
      cacheReadInputTokens: 250,
      cacheCreationInputTokens: 0,
    })
    expect(usage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 9 } }).outputTokens).toBe(9)
  })

  it.each([
    ['no finish reason', stream('{"a":1}', { finish: null }), 'the stream ended before the model finished its reply'],
    ['no usage', stream('{"a":1}', { usage: null }), 'the reply has no usage'],
    ['unusable usage', stream('{"a":1}', { usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } }), 'the reply has an invalid usage.prompt_tokens'],
    ['an error event', `event: error\ndata: ${json({ error: { message: 'x', type: 'server_error', code: 'service_overloaded' } })}\n\n`, 'service_overloaded'],
    ['an event that is not JSON', 'data: {nope\n\n', 'not JSON'],
  ])('flags a successful stream with %s as a bad reply', (_name, body, text) => {
    const parsed = metaExchange.parse(body, true)
    expect(parsed.badReply).toContain(text)
  })

  it('does not call the same body bad when the call did not succeed', () => {
    expect(metaExchange.parse(stream('{"a":1}', { finish: null }), false).badReply).toBeNull()
    expect(metaExchange.parse(stream('{"a":1}', { usage: null }), false).badReply).toBeNull()
  })

  it('reports an oversized stream event as a bad reply instead of throwing', () => {
    const huge = `data: ${'x'.repeat(9 * 1024 * 1024)}\n\n`
    expect(metaExchange.parse(huge, true).badReply).toMatch(/larger than 8 MiB/)
  })
})

describe('the Meta exchange parser on a JSON body', () => {
  it('reads a complete reply the same way as a stream', () => {
    expect(metaExchange.parse(json(completion()), true)).toEqual({
      model: META_TEST_MODEL,
      stopReason: 'stop',
      usage: NORMALISED_USAGE,
      contentBlockTypes: ['text'],
      fallbackBlocks: 0,
      thinkingChars: 0,
      badReply: null,
    })
  })

  it('marks a refusal message, and tolerates missing message fields', () => {
    const refused = completion({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'no' } }] })
    expect(metaExchange.parse(json(refused), true)).toMatchObject({ contentBlockTypes: ['refusal'] })
    const bare = completion({ choices: [{ index: 0 }] })
    expect(metaExchange.parse(json(bare), true)).toMatchObject({ stopReason: null, contentBlockTypes: [], badReply: null })
  })

  it.each([
    ['no choices array', completion({ choices: undefined }), 'the reply has no choices'],
    ['an empty choices array', completion({ choices: [] }), 'the reply has no choices'],
    ['no usage', completion({ usage: undefined }), 'the reply has no usage'],
    ['a bad usage count', completion({ usage: { prompt_tokens: 'many', completion_tokens: 1 } }), 'invalid usage.prompt_tokens'],
    ['more cached than prompt tokens', completion({ usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6 } } }), 'impossible'],
  ])('flags a successful body with %s', (_name, body, text) => {
    expect(metaExchange.parse(json(body), true).badReply).toContain(text)
  })

  it('reads what it can from an error body without calling it bad', () => {
    const body = json({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } })
    expect(metaExchange.parse(body, false)).toEqual(emptyExchange(null))
    expect(metaExchange.parse(json(completion({ usage: undefined })), false)).toMatchObject({ model: META_TEST_MODEL, stopReason: 'stop', badReply: null })
  })

  it('flags an empty body, something that is not an object and text that is not a stream', () => {
    expect(metaExchange.parse('', true).badReply).toBe('the reply body is empty')
    expect(metaExchange.parse('   \n', true).badReply).toBe('the reply body is empty')
    expect(metaExchange.parse('[1,2]', true).badReply).toBe('the reply is not a JSON object')
    expect(metaExchange.parse('"text"', true).badReply).toBe('the reply is not a JSON object')
    expect(metaExchange.parse('<html>oops</html>', true).badReply).toMatch(/stream ended/)
    expect(metaExchange.parse('', false)).toEqual(emptyExchange(null))
    expect(metaExchange.parse('<html>oops</html>', false)).toEqual(emptyExchange(null))
  })
})
