import { describe, expect, it } from 'vitest'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA } from '../conformance'
import { errorReply, jsonReply, sseReply, type FakeReply } from '../fake-transport'
import { LlmError, type LlmRequest } from '../../src/index'
import {
  DONE,
  GEMINI_MODEL,
  NORMALISED_USAGE,
  RAW_USAGE,
  completedEvent,
  createdEvent,
  errorEvent,
  geminiSetup,
  outputEvents,
  streamEvents,
  streamReply,
  thoughtEvents,
  type WireEvent,
} from './wire'

const request: LlmRequest = { schema: CONFORMANCE_SCHEMA, maxTokens: 20_000, messages: [{ role: 'user', content: 'hello' }] }
const TEXT = JSON.stringify(CONFORMANCE_DATA)

const run = (reply: FakeReply | readonly FakeReply[]) => {
  const setup = geminiSetup(Array.isArray(reply) ? reply : [reply as FakeReply])
  return { ...setup, result: setup.provider.generate(request) }
}

async function fails(reply: FakeReply | readonly FakeReply[]): Promise<{ error: LlmError; requests: number }> {
  const { result, transport } = run(reply)
  const error = await result.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LlmError)
  return { error: error as LlmError, requests: transport.requests.length }
}

const stream = (events: readonly WireEvent[], then: 'end' | 'hold' | 'drop' = 'end') => sseReply(events, then)

describe('Gemini usage', () => {
  const usageFor = async (usage: unknown) => (await run(streamReply(TEXT, 'completed', usage)).result).usage

  it('subtracts cached tokens from the input and adds thought tokens to the output', async () => {
    expect(await usageFor(RAW_USAGE)).toEqual({ inputTokens: 700, outputTokens: 650, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 })
    expect(await usageFor(RAW_USAGE)).toEqual(NORMALISED_USAGE)
  })

  it('has no cache write bucket and leaves tool-use tokens out', async () => {
    const usage = await usageFor({ total_input_tokens: 50, total_cached_tokens: 0, total_output_tokens: 7, total_thought_tokens: 0, total_tool_use_tokens: 999 })
    expect(usage).toEqual({ inputTokens: 50, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  it('reads absent counters as zero, as an API that omits zero fields would send them', async () => {
    expect(await usageFor({ total_input_tokens: 80 })).toEqual({ inputTokens: 80, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  it('counts a fully cached prompt as zero uncached input', async () => {
    expect(await usageFor({ total_input_tokens: 400, total_cached_tokens: 400, total_output_tokens: 3 })).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
    })
  })

  it.each([
    ['no usage object', null],
    ['no input count', { total_output_tokens: 5 }],
    ['a negative count', { total_input_tokens: -1, total_output_tokens: 5 }],
    ['a fractional count', { total_input_tokens: 10.5, total_output_tokens: 5 }],
    ['a count that is not a number', { total_input_tokens: '10', total_output_tokens: 5 }],
    ['more cached tokens than input tokens', { total_input_tokens: 100, total_cached_tokens: 300, total_output_tokens: 5 }],
  ])('%s is invalid_output and not retried', async (_name, usage) => {
    const { error, requests } = await fails(streamReply(TEXT, 'completed', usage))
    expect(error.kind).toBe('invalid_output')
    expect(requests).toBe(1)
  })
})

describe('Gemini stream', () => {
  it('reads the text of model output steps only and ignores thought steps and signatures', async () => {
    const events = [createdEvent(), ...thoughtEvents(0), ...outputEvents(1, ['{"a"', ':', '1}']), completedEvent('completed'), DONE]
    const result = await run(stream(events)).result
    expect(result.data).toEqual(CONFORMANCE_DATA)
  })

  it('ignores deltas that are not text even when they carry a text field', async () => {
    const stray: WireEvent = { event: 'step.delta', data: { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', text: 'HIDDEN THOUGHT' } } }
    const events = [createdEvent(), stray, ...outputEvents(1, [TEXT]), completedEvent('completed'), DONE]
    expect((await run(stream(events)).result).data).toEqual(CONFORMANCE_DATA)
  })

  it('joins the text of several output steps in the order they arrive', async () => {
    const events = [createdEvent(), ...outputEvents(0, ['{"a"']), ...thoughtEvents(1), ...outputEvents(2, [':1}']), completedEvent('completed'), DONE]
    expect((await run(stream(events)).result).data).toEqual(CONFORMANCE_DATA)
  })

  it('reports the raw status as the stop reason and the served model as the model', async () => {
    const result = await run(streamReply(TEXT)).result
    expect(result).toMatchObject({ stopReason: 'completed', model: GEMINI_MODEL, requestedModel: GEMINI_MODEL, fallbackUsed: false, servedModels: [GEMINI_MODEL] })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('flags a reply served by another model than the requested one', async () => {
    const result = await run(streamReply(TEXT, 'completed', RAW_USAGE, 'gemini-3.5-flash-lite')).result
    expect(result).toMatchObject({ model: 'gemini-3.5-flash-lite', requestedModel: GEMINI_MODEL, fallbackUsed: true, servedModels: ['gemini-3.5-flash-lite'] })
  })

  it('falls back to the model of the first event, then to the requested model', async () => {
    const events = (completed: WireEvent) => [createdEvent('gemini-4-argon'), ...outputEvents(0, [TEXT]), completed, DONE]
    const fromCreated = await run(stream(events(completedEvent('completed', RAW_USAGE, null)))).result
    expect(fromCreated.model).toBe('gemini-4-argon')
    const none = await run(stream([createdEvent(null), ...outputEvents(0, [TEXT]), completedEvent('completed', RAW_USAGE, null), DONE])).result
    expect(none).toMatchObject({ model: GEMINI_MODEL, fallbackUsed: false })
  })

  it('reads the text from the final event when no text arrived as deltas', async () => {
    const steps = [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }]
    const events = [createdEvent(), completedEvent('completed', RAW_USAGE, GEMINI_MODEL, { steps }), DONE]
    expect((await run(stream(events)).result).data).toEqual(CONFORMANCE_DATA)
  })

  it('skips events that are not objects, have no known type, or are comments', async () => {
    const events: WireEvent[] = [
      createdEvent(),
      { event: 'x', data: 'not json at all' },
      { event: 'x', data: { event_type: 'interaction.status_update', interaction_id: 'v1', status: 'in_progress' } },
      { event: 'x', data: { event_type: 'something.new', payload: 1 } },
      { event: 'x', data: { no_type: true } },
      ...outputEvents(0, [TEXT]),
      completedEvent('completed'),
      DONE,
    ]
    expect((await run(stream(events)).result).data).toEqual(CONFORMANCE_DATA)
  })

  it('does not need the end marker when the stream simply closes after the final event', async () => {
    const events = streamEvents(TEXT).slice(0, -1)
    expect((await run(stream(events)).result).data).toEqual(CONFORMANCE_DATA)
  })

  it('stops reading at the end marker and closes the stream', async () => {
    const { result, transport } = run(stream([...streamEvents(TEXT), { event: 'x', data: { event_type: 'step.delta', index: 5, delta: { type: 'text', text: 'LATE' } } }]))
    expect((await result).data).toEqual(CONFORMANCE_DATA)
    expect(transport.openBodies()).toBe(0)
  })

  it('treats a stream that ends before the final event as a dropped connection, not retried once output arrived', async () => {
    const { error, requests } = await fails([stream([createdEvent(), ...outputEvents(0, ['{"a"'])]), streamReply(TEXT)])
    expect(error.kind).toBe('connection')
    expect(requests).toBe(1)
  })

  it('retries a stream that ends without a single event, up to two times', async () => {
    const { error, requests } = await fails(sseReply([]))
    expect(error.kind).toBe('connection')
    expect(requests).toBe(3)
  })

  it('refuses a JSON body for a streaming request without retrying', async () => {
    const { error, requests } = await fails(jsonReply({ id: 'v1', status: 'completed', steps: [], usage: RAW_USAGE }))
    expect(error.kind).toBe('invalid_output')
    expect(requests).toBe(1)
  })

  it('is invalid_output, with the billed usage, for empty text and for text that is not JSON', async () => {
    for (const text of ['', 'not json', '{"a":']) {
      const events = [createdEvent(), ...(text === '' ? [] : outputEvents(0, [text])), completedEvent('completed'), DONE]
      const { error } = await fails(stream(events))
      expect(error.kind, text).toBe('invalid_output')
      expect(error.usage, text).toEqual(NORMALISED_USAGE)
      expect(error.model).toBe(GEMINI_MODEL)
    }
  })
})

describe('Gemini statuses', () => {
  const withStatus = (status: string, extra: Record<string, unknown> = {}, usage: unknown = RAW_USAGE) =>
    stream([createdEvent(), ...outputEvents(0, ['{"a":']), completedEvent(status, usage, GEMINI_MODEL, extra), DONE])

  it.each(['incomplete', 'requires_continuation'])('%s is truncated and carries the billed usage and model', async (status) => {
    const { error, requests } = await fails(withStatus(status))
    expect(error.kind).toBe('truncated')
    expect(error.usage).toEqual(NORMALISED_USAGE)
    expect(error.model).toBe(GEMINI_MODEL)
    expect(requests).toBe(1)
  })

  it('a truncated reply without usable usage still says truncated', async () => {
    const { error } = await fails(withStatus('incomplete', {}, { total_input_tokens: 'many' }))
    expect(error.kind).toBe('truncated')
    expect(error.usage).toBeUndefined()
  })

  it('cancelled is aborted', async () => {
    expect((await fails(withStatus('cancelled'))).error.kind).toBe('aborted')
  })

  it('failed maps the first error code, or is unknown without one', async () => {
    expect((await fails(withStatus('failed', { errors: [{ code: 'service_unavailable', message: 'busy' }] }))).error.kind).toBe('overloaded')
    expect((await fails(withStatus('failed', { errors: [{ code: 'safety', message: 'blocked' }] }))).error.kind).toBe('refusal')
    expect((await fails(withStatus('failed'))).error.kind).toBe('unknown')
  })

  it.each(['requires_action', 'budget_exceeded', 'queued', 'in_progress', 'something_new'])('%s is invalid_output naming the status', async (status) => {
    const { error, requests } = await fails(withStatus(status))
    expect(error.kind).toBe('invalid_output')
    expect(error.message).toContain(status)
    expect(requests).toBe(1)
  })
})

describe('Gemini stream errors', () => {
  const failing = (code: string, message?: string) => stream([createdEvent(), errorEvent(code, message), DONE])

  it.each([
    ['gateway_timeout', 'timeout'],
    ['deadline_exceeded', 'timeout'],
    ['service_unavailable', 'overloaded'],
    ['api_error', 'overloaded'],
    ['rate_limit_exceeded', 'rate_limit'],
    ['quota_exceeded', 'rate_limit'],
    ['authentication', 'auth'],
    ['permission_denied', 'auth'],
    ['invalid_request', 'invalid_request'],
    ['safety', 'refusal'],
    ['prohibited_content', 'refusal'],
    ['cancelled', 'aborted'],
    ['something_new', 'unknown'],
  ] as const)('an error event with code %s is %s', async (code, kind) => {
    const { error } = await fails(failing(code))
    expect(error.kind).toBe(kind)
    expect(error.category).toBe(code)
  })

  it('is not retried, because the stream had already started', async () => {
    const { requests } = await fails([failing('service_unavailable'), streamReply(TEXT)])
    expect(requests).toBe(1)
  })

  it('never echoes the key from an error message, and keeps the detail otherwise', async () => {
    const { error } = await fails(failing('invalid_request', `bad key ${CONFORMANCE_API_KEY} and a schema problem`))
    expect(error.message).not.toContain(CONFORMANCE_API_KEY)
    expect(error.message).toContain('a schema problem')
  })

  it('reads an error event with no body as unknown', async () => {
    const events: WireEvent[] = [createdEvent(), { event: 'error', data: { event_type: 'error' } }, DONE]
    expect((await fails(stream(events))).error.kind).toBe('unknown')
  })
})

describe('Gemini HTTP errors', () => {
  it('keeps the status, reads the request id, and does not retry a refusal', async () => {
    const { error, requests } = await fails(errorReply(400, { error: { code: 'jailbreak', message: 'Input blocked: no' } }, { 'x-request-id': 'req-9' }))
    expect(error).toMatchObject({ kind: 'refusal', status: 400, requestId: 'req-9', category: 'jailbreak' })
    expect(requests).toBe(1)
  })

  it('does not retry a quota that is spent, but retries a rate limit', async () => {
    const quota = errorReply(429, { error: { code: 'quota_exceeded', message: 'daily quota spent' } })
    const first = await fails(quota)
    expect(first.error.kind).toBe('rate_limit')
    expect(first.requests).toBe(1)
    const rate = await fails(errorReply(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }))
    expect(rate.requests).toBe(3)
  })

  it('reads error replies that are not JSON by their status, and keeps the page out of the message', async () => {
    const page = (status: number, body: string): FakeReply => ({ kind: 'text', status, body, contentType: 'text/html' })
    const gateway = await fails(page(502, '<html>bad gateway</html>'))
    expect(gateway.error).toMatchObject({ kind: 'overloaded', status: 502 })
    expect(gateway.error.message).not.toContain('<html>')
    expect(gateway.requests).toBe(3)
    expect((await fails(page(429, 'Too Many Requests'))).error.kind).toBe('rate_limit')
    const bad = await fails(page(400, '<html>nope</html>'))
    expect(bad.error).toMatchObject({ kind: 'invalid_request', status: 400 })
    expect(bad.requests).toBe(1)
  })

  it('honours a Retry-After header as well as the RetryInfo in the body', async () => {
    const setup = geminiSetup([errorReply(429, { error: { code: 'rate_limit_exceeded', message: 'x' } }, { 'retry-after': '3' }), streamReply(TEXT)])
    await setup.provider.generate(request)
    expect(setup.transport.sleeps).toHaveLength(1)
    expect(setup.transport.sleeps[0]).toBeGreaterThanOrEqual(3000)
    expect(setup.transport.sleeps[0]).toBeLessThan(3500)
  })
})
