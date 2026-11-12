import { ANTHROPIC_CAPABILITIES, findModel, providerDescriptor, type LlmCapabilities, type LlmProvider } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { replyOf as openaiReply } from '../../llm/test/openai-wire'
import { okReply as grokReply } from '../../llm/test/grok/wire'
import { streamReply as geminiReply } from '../../llm/test/gemini/wire'
import { chatReply as metaReply } from '../../llm/test/meta-wire'
import { createFakeTransport, jsonReply, type FakeReply } from '../../llm/test/fake-transport'
import { createRecorder, withDefaults, withEffort, withSignal, type FetchFn } from '../src/record'

const post = (fetch: FetchFn, body: unknown, signal?: AbortSignal) =>
  fetch('https://example.test/v1', { method: 'POST', body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })

async function record(provider: 'openai' | 'gemini' | 'grok' | 'meta', reply: FakeReply, body: unknown = {}) {
  const transport = createFakeTransport()
  transport.script(reply)
  const recorder = createRecorder(transport.fetch, undefined, providerDescriptor(provider).exchange)
  const response = await post(recorder.fetch, body)
  const exchange = recorder.exchanges()[0]!
  return { exchange, response }
}

describe('the recorder with a provider exchange parser', () => {
  it('reads a JSON reply of the OpenAI Responses API', async () => {
    const { exchange, response } = await record('openai', openaiReply(false, 'completed', '{"a":1}'), { max_output_tokens: 777 })
    expect(exchange.status).toBe(200)
    expect(exchange.model).toBe('gpt-6.1-sol')
    expect(exchange.usage).toEqual({ inputTokens: 9300, outputTokens: 1450, cacheReadInputTokens: 300, cacheCreationInputTokens: 200 })
    expect(exchange.badReply).toBeNull()
    expect(exchange.requestMaxTokens).toBe(777)
    expect(await response.text()).toContain('"gpt-6.1-sol"')
  })

  it('reads the terminal event of an SSE reply of the Gemini Interactions API', async () => {
    const { exchange } = await record('gemini', geminiReply('{"a":1}'), { generation_config: { max_output_tokens: 20_000 } })
    expect(exchange.usage).toEqual({ inputTokens: 700, outputTokens: 650, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 })
    expect(exchange.model).toBe('gemini-3.8-flash')
    expect(exchange.badReply).toBeNull()
    expect(exchange.requestMaxTokens).toBe(20_000)
  })

  it('reads the terminal event of an SSE reply of xAI', async () => {
    const { exchange } = await record('grok', grokReply(), { max_output_tokens: 16_000 })
    expect(exchange.usage).toEqual({ inputTokens: 1200, outputTokens: 3300, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0 })
    expect(exchange.model).toBe('grok-4.7')
    expect(exchange.requestMaxTokens).toBe(16_000)
  })

  it('reads an SSE reply of the Meta chat completions API', async () => {
    const { exchange } = await record('meta', metaReply('{"a":1}'), { max_completion_tokens: 8000 })
    expect(exchange.usage).toEqual({ inputTokens: 700, outputTokens: 650, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 })
    expect(exchange.requestMaxTokens).toBe(8000)
  })

  it('marks a success reply the parser cannot read as a bad reply', async () => {
    const { exchange } = await record('openai', jsonReply({ nothing: true }))
    expect(exchange.badReply).not.toBeNull()
  })

  it('reads max_tokens of the Anthropic body by default and reports no max when the body has none', async () => {
    const transport = createFakeTransport()
    transport.script(jsonReply({ id: 'm', type: 'message', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    const recorder = createRecorder(transport.fetch)
    await post(recorder.fetch, { max_tokens: 123 })
    await post(recorder.fetch, {})
    expect(recorder.exchanges().map((exchange) => exchange.requestMaxTokens)).toEqual([123, null])
    expect(recorder.exchanges()[0]!.model).toBe('claude-sonnet-5-5')
  })

  it('reads the request id from either header spelling', async () => {
    const transport = createFakeTransport()
    transport.script(jsonReply({}, 200, { 'x-request-id': 'req-x' }), jsonReply({}, 200, { 'request-id': 'req-plain' }))
    const recorder = createRecorder(transport.fetch)
    await post(recorder.fetch, {})
    await post(recorder.fetch, {})
    expect(recorder.exchanges().map((exchange) => exchange.requestId)).toEqual(['req-x', 'req-plain'])
  })

  it('does not wait on a body that never ends once the call is aborted', async () => {
    const stuck: FetchFn = async () => new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 })
    const recorder = createRecorder(stuck)
    const controller = new AbortController()
    const pending = post(recorder.fetch, {}, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await pending
    const [exchange] = recorder.exchanges()
    expect(exchange?.failure).toBe('AbortError')
    expect(exchange?.status).toBe(200)
  })

  it('keeps an exchange complete when the body is read in full before the response is handed back', async () => {
    const transport = createFakeTransport()
    transport.script(geminiReply('{"a":1}'))
    const recorder = createRecorder(transport.fetch, undefined, providerDescriptor('gemini').exchange)
    await post(recorder.fetch, {})
    expect(recorder.exchanges()).toHaveLength(1)
    expect(recorder.exchanges()[0]!.bodyBytes).toBeGreaterThan(0)
  })
})

function providerWith(capabilities: LlmCapabilities | undefined): LlmProvider & { seen: { request: unknown; options: unknown }[] } {
  const seen: { request: unknown; options: unknown }[] = []
  const provider = {
    name: 'p',
    ...(capabilities === undefined ? {} : { capabilities }),
    seen,
    generate: async (request: unknown, options: unknown) => {
      seen.push({ request, options })
      throw new Error('not called for real')
    },
  }
  return provider as unknown as LlmProvider & { seen: { request: unknown; options: unknown }[] }
}

describe('provider wrappers keep what the provider declares', () => {
  const grok = findModel('grok:grok-4.7')!.capabilities

  it('withEffort and withSignal keep the capabilities and the name', () => {
    const base = providerWith(grok)
    for (const wrapped of [withEffort(base, 'low'), withSignal(base, new AbortController().signal), withDefaults(base, { maxTokens: 1000 })]) {
      expect(wrapped.name).toBe('p')
      expect(wrapped.capabilities).toBe(grok)
    }
  })

  it('declares nothing when the provider declares nothing', () => {
    const wrapped = withEffort(providerWith(undefined), 'low')
    expect(wrapped.capabilities).toBeUndefined()
    expect(ANTHROPIC_CAPABILITIES).toBeDefined()
  })

  it('withDefaults fills in max tokens and the call deadline only where the caller left them out', async () => {
    const base = providerWith(undefined)
    const wrapped = withDefaults(base, { maxTokens: 1000, timeoutMs: 5000 })
    await wrapped.generate({ messages: [], schema: {} }).catch(() => undefined)
    await wrapped.generate({ messages: [], schema: {}, maxTokens: 300 }, { timeoutMs: 100 }).catch(() => undefined)
    expect(base.seen[0]).toEqual({ request: { messages: [], schema: {}, maxTokens: 1000 }, options: { timeoutMs: 5000 } })
    expect(base.seen[1]).toEqual({ request: { messages: [], schema: {}, maxTokens: 300 }, options: { timeoutMs: 100 } })
  })
})
