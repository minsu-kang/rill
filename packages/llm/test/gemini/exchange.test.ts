import { describe, expect, it } from 'vitest'
import { geminiExchange } from '../../src/gemini'
import { sseChunks } from '../fake-transport'
import { DONE, GEMINI_MODEL, NORMALISED_USAGE, RAW_USAGE, completedEvent, createdEvent, errorEvent, outputEvents, streamEvents, thoughtEvents, type WireEvent } from './wire'

const body = (events: readonly WireEvent[]) => sseChunks(events).join('')
const parse = (events: readonly WireEvent[], success = true) => geminiExchange.parse(body(events), success)
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

describe('Gemini exchange parser: streams', () => {
  it('reads the model, status, billed buckets and step types from a finished stream', () => {
    expect(parse(streamEvents('{"a":1}'))).toEqual({
      model: GEMINI_MODEL,
      stopReason: 'completed',
      usage: NORMALISED_USAGE,
      contentBlockTypes: ['thought', 'model_output'],
      fallbackBlocks: 0,
      thinkingChars: 0,
      badReply: null,
    })
  })

  it('reports an unfinished answer by its status, without calling the reply bad', () => {
    const parsed = parse(streamEvents('{"a":', 'incomplete'))
    expect(parsed).toMatchObject({ stopReason: 'incomplete', usage: NORMALISED_USAGE, badReply: null })
  })

  it('takes the model of the first event when the last one names none', () => {
    const parsed = parse([createdEvent('gemini-4-argon'), ...outputEvents(0, ['x']), completedEvent('completed', RAW_USAGE, null), DONE])
    expect(parsed.model).toBe('gemini-4-argon')
  })

  it('flags a successful reply that has no final event, no usage or impossible usage', () => {
    const noFinal = parse([createdEvent(), ...outputEvents(0, ['x'])])
    expect(noFinal.badReply).toMatch(/final event/)
    expect(noFinal.usage).toEqual(ZERO)
    expect(parse([createdEvent(), completedEvent('completed', null), DONE]).badReply).toMatch(/usage/)
    expect(parse([createdEvent(), completedEvent('completed', { total_input_tokens: 5, total_cached_tokens: 9 }), DONE]).badReply).toMatch(/usage/)
  })

  it('flags a successful stream that carried an error event, and says which', () => {
    const parsed = parse([createdEvent(), errorEvent('gateway_timeout'), DONE])
    expect(parsed.badReply).toMatch(/gateway_timeout/)
  })

  it('does not flag an unfinished stream that came with a failure status', () => {
    expect(parse([createdEvent(), errorEvent('gateway_timeout'), DONE], false).badReply).toBeNull()
    expect(parse([createdEvent(), ...thoughtEvents(0)], false)).toMatchObject({ badReply: null, contentBlockTypes: ['thought'], usage: ZERO })
  })

  it('counts the last event of a stream that has no end marker', () => {
    const events = streamEvents('{"a":1}').slice(0, -1)
    expect(events.at(-1)?.event).toBe('interaction.completed')
    expect(parse(events)).toMatchObject({ stopReason: 'completed', usage: NORMALISED_USAGE, badReply: null })
  })

  it('stops at the end marker', () => {
    const parsed = parse([...streamEvents('{"a":1}'), errorEvent('gateway_timeout')])
    expect(parsed.badReply).toBeNull()
  })

  it('ignores events it does not know and data that is not JSON', () => {
    const events: WireEvent[] = [createdEvent(), { event: 'x', data: 'plain text' }, { event: 'x', data: { event_type: 'new.thing' } }, ...streamEvents('{}').slice(1)]
    expect(parse(events)).toMatchObject({ badReply: null, usage: NORMALISED_USAGE })
  })
})

describe('Gemini exchange parser: JSON bodies', () => {
  const json = (value: unknown) => JSON.stringify(value)

  it('reads a whole interaction sent as JSON', () => {
    const parsed = geminiExchange.parse(
      json({ id: 'v1', object: 'interaction', status: 'completed', model: GEMINI_MODEL, steps: [{ type: 'thought' }, { type: 'model_output', content: [] }], usage: RAW_USAGE }),
      true,
    )
    expect(parsed).toMatchObject({ model: GEMINI_MODEL, stopReason: 'completed', usage: NORMALISED_USAGE, contentBlockTypes: ['thought', 'model_output'], badReply: null })
  })

  it('reads an error body without calling it a bad reply when the request failed', () => {
    const parsed = geminiExchange.parse(json({ error: { code: 'rate_limit_exceeded', message: 'slow' } }), false)
    expect(parsed).toMatchObject({ model: null, stopReason: null, usage: ZERO, badReply: null })
  })

  it('calls a successful JSON body without an interaction a bad reply', () => {
    expect(geminiExchange.parse(json({ error: { code: 'x' } }), true).badReply).toMatch(/interaction/)
    expect(geminiExchange.parse(json([1, 2]), true).badReply).toMatch(/interaction/)
  })
})

describe('Gemini exchange parser: other bodies', () => {
  it('calls an empty or unreadable successful body bad, and says nothing about a failed one', () => {
    expect(geminiExchange.parse('', true).badReply).toMatch(/empty/)
    expect(geminiExchange.parse('   \n', true).badReply).toMatch(/empty/)
    expect(geminiExchange.parse('<html>oops</html>', true).badReply).toMatch(/not a stream/)
    expect(geminiExchange.parse('', false)).toMatchObject({ badReply: null, usage: ZERO })
    expect(geminiExchange.parse('<html>oops</html>', false).badReply).toBeNull()
  })

  it('copes with CRLF line ends and a stream cut in the middle of an event', () => {
    const text = body(streamEvents('{"a":1}')).replace(/\n/g, '\r\n')
    expect(geminiExchange.parse(text, true).badReply).toBeNull()
    const cut = body(streamEvents('{"a":1}')).slice(0, -40)
    expect(geminiExchange.parse(cut, true).badReply).toMatch(/final event|stream/)
  })
})
