import { describe, expect, it } from 'vitest'
import { grokExchange } from '../../src/grok'
import { sseChunks } from '../fake-transport'
import { RAW_USAGE, USAGE, completed, created, delta, incomplete, responseObject, streamOf, type ResponseOptions } from './wire'

const sse = (events: Parameters<typeof sseChunks>[0]) => sseChunks(events).join('')
const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

describe('grokExchange', () => {
  it('reads a finished stream: model, stop reason, normalised usage and the output item types', () => {
    const parsed = grokExchange.parse(sse(streamOf()), true)
    expect(parsed).toEqual({
      model: 'grok-4.7',
      stopReason: 'end_turn',
      usage: USAGE,
      contentBlockTypes: ['reasoning', 'output_text'],
      fallbackBlocks: 0,
      thinkingChars: 0,
      badReply: null,
    })
  })

  it('reads a plain JSON reply the same way', () => {
    const parsed = grokExchange.parse(JSON.stringify(responseObject()), true)
    expect(parsed.model).toBe('grok-4.7')
    expect(parsed.usage).toEqual(USAGE)
    expect(parsed.badReply).toBeNull()
    expect(parsed.contentBlockTypes).toEqual(['reasoning', 'output_text'])
  })

  it('counts the characters of reasoning summaries as thinking', () => {
    const output = [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'abc' }, { type: 'summary_text', text: 'de' }], encrypted_content: 'x' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] },
    ]
    expect(grokExchange.parse(sse([completed({ output }).data].map((data) => ({ data }))), true).thinkingChars).toBe(5)
  })

  it.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', 'content_filter'],
    ['max_time_limit', 'time_limit'],
    ['max_prompt_tokens', 'max_prompt_tokens'],
    ['something_new', 'something_new'],
  ])('maps the incomplete reason %s to the stop reason %s and does not call it a bad reply', (reason, stop) => {
    const parsed = grokExchange.parse(sse(streamOf({ reason, text: '{"a":' }, 'incomplete')), true)
    expect(parsed.stopReason).toBe(stop)
    expect(parsed.badReply).toBeNull()
    expect(parsed.usage).toEqual(USAGE)
  })

  it('uses the same usage arithmetic as the adapter, with and without total_tokens', () => {
    const noTotal = Object.fromEntries(Object.entries(RAW_USAGE).filter(([key]) => key !== 'total_tokens'))
    expect(grokExchange.parse(sse(streamOf({ usage: noTotal })), true).usage).toEqual(USAGE)
    expect(grokExchange.parse(sse(streamOf({ usage: { input_tokens: 10, output_tokens: 4 } })), true).usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  it('reads the terminal event written as a flat object and with the event name only', () => {
    const body = responseObject()
    expect(grokExchange.parse(sse([{ data: { type: 'response.completed', ...body } }]), true).model).toBe('grok-4.7')
    expect(grokExchange.parse(sse([{ event: 'response.completed', data: { response: body } }]), true).usage).toEqual(USAGE)
  })

  it('takes the last terminal event and ignores deltas, comments and junk', () => {
    const text = [': ping\n\n', 'data: nope\n\n', sse([created(), delta('x'), completed({ model: 'first' }), completed({ model: 'second' })]), 'data: [DONE]\n\n'].join('')
    expect(grokExchange.parse(text, true).model).toBe('second')
  })

  describe('a reply that cannot be used', () => {
    const bad = (body: string) => grokExchange.parse(body, true)

    it('an empty body', () => {
      expect(bad('').badReply).toBe('the reply body is empty')
      expect(bad('  \n').badReply).toBe('the reply body is empty')
    })

    it('a JSON value that is not an object', () => {
      expect(bad('[1]').badReply).toBe('the reply is not a JSON object')
      expect(bad('"x"').badReply).toBe('the reply is not a JSON object')
    })

    it('a stream with no final event', () => {
      expect(bad(sse([created(), delta('{')])).badReply).toBe('the stream has no final event')
      expect(bad('this is not json or a stream').badReply).toBe('the stream has no final event')
      expect(bad(sse([{ event: 'error', data: { type: 'error', error: { message: 'x' } } }])).badReply).toBe('the stream has no final event')
    })

    it('no usage, or usage with an impossible count', () => {
      expect(bad(sse(streamOf({ usage: null }))).badReply).toBe('the reply has no usage')
      expect(bad(sse(streamOf({ usage: { output_tokens: 3 } }))).badReply).toMatch(/usage/)
      expect(bad(sse(streamOf({ usage: { ...RAW_USAGE, input_tokens_details: { cached_tokens: 99_999 } } }))).badReply).toMatch(/impossible/)
      const parsed = bad(sse(streamOf({ usage: { ...RAW_USAGE, input_tokens: -1 } })))
      expect(parsed.badReply).not.toBeNull()
      expect(parsed.usage).toEqual(zero)
    })

    it('a final response that carries an error object', () => {
      const body = { ...responseObject(), error: { message: 'boom' } }
      expect(bad(JSON.stringify(body)).badReply).toBe('the reply carries an error object')
      expect(bad(sse([{ event: 'response.failed', data: { type: 'response.failed', response: body } }])).badReply).toBe('the reply carries an error object')
    })
  })

  describe('a reply that was already an error', () => {
    it.each([
      ['a JSON error body', JSON.stringify({ code: 'not-found', error: 'no such model' })],
      ['a nested error body', JSON.stringify({ error: { message: 'bad', code: 'x' } })],
      ['an HTML page', '<html>bad gateway</html>'],
      ['nothing', ''],
    ])('%s is not reported as a bad reply', (_, body) => {
      const parsed = grokExchange.parse(body, false)
      expect(parsed.badReply).toBeNull()
      expect(parsed.usage).toEqual(zero)
      expect(parsed.model).toBeNull()
      expect(parsed.stopReason).toBeNull()
    })
  })

  it('never throws on arbitrary text', () => {
    for (const text of ['{', 'null', 'data: {"type":', 'event: x\n', '\u0000', 'data: {"type":"response.completed","response":5}\n\n', JSON.stringify({ usage: 5, output: 7 })]) {
      for (const success of [true, false]) expect(() => grokExchange.parse(text, success), text).not.toThrow()
    }
  })

  it('never throws on deeply nested, truncated or shuffled input', () => {
    const fragments = ['{', '}', '[', ']', '"', ':', ',', 'data: ', 'event: ', '\n', '\n\n', '\r\n', 'response.completed', 'type', 'usage', 'null', '5', '\u0000', '[DONE]', 'error']
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    const inputs = ['['.repeat(200_000), '{"a":'.repeat(50_000), `data: ${'['.repeat(100_000)}\n\n`, 'data: '.repeat(10_000)]
    for (let index = 0; index < 300; index++) inputs.push(Array.from({ length: 1 + (next() % 30) }, () => fragments[next() % fragments.length]).join(''))
    for (const text of inputs) for (const success of [true, false]) expect(() => grokExchange.parse(text, success)).not.toThrow()
  })

  it('does not take a model name from a non-string', () => {
    const options: ResponseOptions = { extra: { model: 42 } }
    expect(grokExchange.parse(sse(streamOf(options)), true).model).toBeNull()
  })

  it('reads an incomplete event even when the body carries no text', () => {
    const body = sse([incomplete({ reason: 'content_filter', output: [] })])
    const parsed = grokExchange.parse(body, true)
    expect(parsed.stopReason).toBe('content_filter')
    expect(parsed.contentBlockTypes).toEqual([])
  })
})
