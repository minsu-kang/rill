import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicProvider, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, LlmError, type LlmRequest } from '../src/index'
import { closeServers, errorBody, message, mock, provider, request, schema, type Reply } from './mock'

afterEach(closeServers)

describe('AnthropicProvider request', () => {
  it('sends a structured-output request with fallbacks on by default', async () => {
    const { seen, baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    await provider(baseURL).generate(request)
    expect(seen).toHaveLength(1)
    const sent = seen[0]!
    expect(sent.url).toBe('/v1/messages')
    expect(sent.headers.authorization).toBe('Bearer test-key')
    expect(sent.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(sent.body).toMatchObject({
      model: DEFAULT_MODEL,
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      fallbacks: 'default',
    })
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'system', 'cache_control']) {
      expect(sent.body).not.toHaveProperty(forbidden)
    }
  })

  it('uses the plain endpoint without the beta header when refusalFallback is false', async () => {
    const { seen, baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    await provider(baseURL, { refusalFallback: false }).generate(request)
    expect(seen[0]!.headers['anthropic-beta']).toBeUndefined()
    expect(seen[0]!.body).not.toHaveProperty('fallbacks')
  })

  it('skips the fallback for Haiku models unless asked for', async () => {
    const { seen, baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    await provider(baseURL, { model: 'claude-haiku-5-5' }).generate(request)
    await provider(baseURL, { model: 'claude-haiku-5-5', refusalFallback: true }).generate(request)
    expect(seen[0]!.headers['anthropic-beta']).toBeUndefined()
    expect(seen[0]!.body).not.toHaveProperty('fallbacks')
    expect(seen[1]!.body).toMatchObject({ fallbacks: 'default' })
  })

  it('honours model, effort, maxTokens, system and cache settings', async () => {
    const { seen, baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    const custom = provider(baseURL, { model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 4000 })
    expect(custom.model).toBe('claude-sonnet-5-5')
    await custom.generate({ ...request, system: 'be exact', cache: true })
    await custom.generate({ ...request, effort: 'low', maxTokens: 900 })
    expect(seen[0]!.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 4000,
      system: 'be exact',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'high' },
    })
    expect(seen[1]!.body).toMatchObject({ max_tokens: 900, output_config: { effort: 'low' } })
    expect(seen[1]!.body).not.toHaveProperty('cache_control')
  })

  it('maps text, pdf and image parts to content blocks', async () => {
    const { seen, baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    await provider(baseURL).generate({
      schema,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', mediaType: 'application/pdf', data: 'UERG' },
            { type: 'image', mediaType: 'image/png', data: 'UE5H' },
            { type: 'text', text: 'what is this' },
          ],
        },
        { role: 'assistant', content: '{"a":0}' },
        { role: 'user', content: 'again' },
      ],
    })
    expect(seen[0]!.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
          { type: 'text', text: 'what is this' },
        ],
      },
      { role: 'assistant', content: '{"a":0}' },
      { role: 'user', content: 'again' },
    ])
  })

  it('refuses a conversation that ends with an assistant turn (prefill) before calling the API', async () => {
    const { seen, baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    const messages: LlmRequest['messages'] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '{' },
    ]
    await expect(provider(baseURL).generate({ schema, messages })).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(provider(baseURL).generate({ schema, messages: [] })).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(seen).toHaveLength(0)
  })
})

describe('AnthropicProvider result', () => {
  it('parses the JSON reply and maps usage, model and call metadata', async () => {
    const { baseURL } = await mock(() => ({ body: message('{"a":42}', { model: 'claude-sonnet-5-5' }) }))
    const result = await provider(baseURL).generate(request)
    expect(result).toMatchObject({
      data: { a: 42 },
      model: 'claude-sonnet-5-5',
      requestedModel: DEFAULT_MODEL,
      stopReason: 'end_turn',
      fallbackUsed: false,
      servedModels: ['claude-sonnet-5-5'],
      usage: { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 },
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('treats missing cache counters as zero and joins several text blocks', async () => {
    const { baseURL } = await mock(() => ({
      body: message('', {
        content: [
          { type: 'text', text: '{"a":' },
          { type: 'text', text: '5}' },
        ],
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      }),
    }))
    const result = await provider(baseURL).generate(request)
    expect(result.data).toEqual({ a: 5 })
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  it('ignores thinking blocks and uses only the text after the last fallback block', async () => {
    const { baseURL } = await mock(() => ({
      body: message('', {
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: '{"a":' },
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '{"a":2}' },
        ],
      }),
    }))
    const result = await provider(baseURL).generate(request)
    expect(result).toMatchObject({ data: { a: 2 }, model: 'claude-opus-4-8', requestedModel: DEFAULT_MODEL, fallbackUsed: true })
  })

  it('reports a fallback that the usage iterations show even without a fallback block', async () => {
    const { baseURL } = await mock(() => ({
      body: message('{"a":3}', {
        usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
      }),
    }))
    expect((await provider(baseURL).generate(request)).fallbackUsed).toBe(true)
  })

  it('fails with kind invalid_output when nothing follows the last fallback block', async () => {
    const { baseURL } = await mock(() => ({
      body: message('', { content: [{ type: 'text', text: '{"a":1}' }, { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }] }),
    }))
    await expect(provider(baseURL).generate(request)).rejects.toMatchObject({ kind: 'invalid_output' })
  })

  it('fails with kind refusal and names the category', async () => {
    const { baseURL } = await mock(() => ({
      body: message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } }),
    }))
    const error = await provider(baseURL).generate(request).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'refusal', retryable: false, category: 'cyber' })
    expect((error as LlmError).message).toContain('cyber')
  })

  it('fails with kind truncated when the reply hit max_tokens', async () => {
    const { baseURL } = await mock(() => ({ body: message('{"a":', { stop_reason: 'max_tokens' }) }))
    await expect(provider(baseURL).generate(request)).rejects.toMatchObject({ kind: 'truncated', retryable: false })
  })

  it('fails with a retryable invalid_output for text that is not JSON or a reply without text', async () => {
    const bad = await mock(() => ({ body: message('not json at all') }))
    await expect(provider(bad.baseURL).generate(request)).rejects.toMatchObject({ kind: 'invalid_output', retryable: true })
    const empty = await mock(() => ({ body: message('', { content: [] }) }))
    await expect(provider(empty.baseURL).generate(request)).rejects.toMatchObject({ kind: 'invalid_output' })
  })

  it('turns a malformed 200 reply into an LlmError instead of a TypeError', async () => {
    const replies: Reply[] = [
      { raw: '<html>gateway says hi</html>' },
      { body: {} },
      { body: [] },
      { body: { ...message('{"a":1}'), usage: undefined } },
      { body: { ...message('{"a":1}'), content: 'text' } },
    ]
    for (const reply of replies) {
      const { baseURL } = await mock(() => reply)
      const error = await provider(baseURL).generate(request).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect(error).toMatchObject({ kind: 'invalid_output' })
    }
  })
})

describe('AnthropicProvider errors', () => {
  it.each([
    [401, 'authentication_error', 'auth', false],
    [429, 'rate_limit_error', 'rate_limit', true],
    [500, 'api_error', 'overloaded', true],
    [400, 'invalid_request_error', 'invalid_request', false],
  ] as const)('maps HTTP %i to %s', async (status, type, kind, retryable) => {
    const { baseURL } = await mock(() => ({ status, body: errorBody(type, 'nope') }))
    const error = await provider(baseURL).generate(request).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind, retryable, status })
  })

  it('carries the retry-after hint of a 429', async () => {
    const { baseURL } = await mock(() => ({
      status: 429,
      headers: { 'retry-after-ms': '2500', 'request-id': 'req_abc' },
      body: errorBody('rate_limit_error', 'slow down'),
    }))
    const error = await provider(baseURL).generate(request).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterMs: 2500, requestId: 'req_abc' })
  })

  it('reports a connection failure as retryable', async () => {
    const error = await provider('http://127.0.0.1:1').generate(request).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'connection', retryable: true })
  })

  it('times out slow replies after timeoutMs and defaults to two minutes', async () => {
    expect(new AnthropicProvider().timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000)
    const { baseURL } = await mock(() => ({ body: message('{"a":1}'), delayMs: 1000 }))
    const error = await provider(baseURL, { timeoutMs: 50 }).generate(request).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('leaves the SDK retries on: a 500 followed by a success is a success', async () => {
    const { seen, baseURL } = await mock((_seen, index) =>
      index === 0
        ? { status: 500, headers: { 'retry-after-ms': '1' }, body: errorBody('api_error', 'hiccup') }
        : { body: message('{"a":1}') },
    )
    const result = await new AnthropicProvider({ apiKey: 'test-key', baseURL }).generate(request)
    expect(result.data).toEqual({ a: 1 })
    expect(seen).toHaveLength(2)
  })

  it('maps an aborted call to kind aborted', async () => {
    const { baseURL } = await mock(() => ({ body: message('{"a":1}'), delayMs: 2000 }))
    const controller = new AbortController()
    const pending = provider(baseURL).generate(request, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('does not read credentials or throw when it is only constructed', () => {
    expect(() => new AnthropicProvider()).not.toThrow()
    expect(new AnthropicProvider().model).toBe(DEFAULT_MODEL)
  })
})
