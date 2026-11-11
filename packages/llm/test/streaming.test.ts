import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, LlmError, STREAMING_ABOVE_MAX_TOKENS, type LlmRequest, type LlmResult } from '../src/index'
import { closeServers, errorBody, message, mock, provider, request, sse, streamEvents, type Reply, type Seen } from './mock'

afterEach(closeServers)

const LONG = STREAMING_ABOVE_MAX_TOKENS + 1
const SHORT = STREAMING_ABOVE_MAX_TOKENS

const answer = (seen: Seen, reply: Record<string, unknown>): Reply =>
  seen.body.stream === true ? { sse: { events: streamEvents(reply) } } : { body: reply }

async function both(reply: Record<string, unknown>, options: { refusalFallback?: boolean } = {}) {
  const run = async (maxTokens: number): Promise<{ result: LlmResult | LlmError; seen: Seen[] }> => {
    const { seen, baseURL } = await mock((entry) => answer(entry, reply))
    const result = await provider(baseURL, options).generate({ ...request, maxTokens }).catch((e: unknown) => e as LlmError)
    return { result, seen }
  }
  return { plain: await run(SHORT), streamed: await run(LONG) }
}

const without = (value: object, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

const fallbackReply = message('', {
  model: 'claude-opus-4-8',
  content: [
    { type: 'text', text: '{"a":' },
    {
      type: 'fallback',
      from: { model: 'claude-opus-5-5' },
      to: { model: 'claude-opus-4-8' },
      trigger: { type: 'refusal', category: null },
    },
    { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    { type: 'text', text: '{"a":2}' },
  ],
})

describe('when a call streams', () => {
  it('streams above 16000 max tokens and not at or below it', async () => {
    expect(STREAMING_ABOVE_MAX_TOKENS).toBe(16_000)
    for (const refusalFallback of [true, false]) {
      const { plain, streamed } = await both(message('{"a":1}'), { refusalFallback })
      expect(plain.seen[0]!.body).not.toHaveProperty('stream')
      expect(streamed.seen[0]!.body).toMatchObject({ stream: true, max_tokens: LONG })
      expect(plain.result).toMatchObject({ data: { a: 1 } })
      expect(streamed.result).toMatchObject({ data: { a: 1 } })
    }
  })

  it('uses the effective max tokens: the request value wins over the provider value', async () => {
    const { seen, baseURL } = await mock((entry) => answer(entry, message('{"a":1}')))
    const big = provider(baseURL, { maxTokens: 32_000 })
    await big.generate(request)
    await big.generate({ ...request, maxTokens: 8000 })
    const small = provider(baseURL, { maxTokens: 4000 })
    await small.generate(request)
    await small.generate({ ...request, maxTokens: 30_000 })
    expect(seen.map((entry) => entry.body.stream === true)).toEqual([true, false, false, true])
  })

  it('stays on the beta endpoint with the fallback options when it streams, and on the plain one without', async () => {
    const withFallback = await mock((entry) => answer(entry, message('{"a":1}')))
    await provider(withFallback.baseURL).generate({ ...request, maxTokens: LONG })
    expect(withFallback.seen[0]!.url).toBe('/v1/messages')
    expect(withFallback.seen[0]!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(withFallback.seen[0]!.body).toMatchObject({ fallbacks: 'default', stream: true })
    const plainEndpoint = await mock((entry) => answer(entry, message('{"a":1}')))
    await provider(plainEndpoint.baseURL, { refusalFallback: false }).generate({ ...request, maxTokens: LONG })
    expect(plainEndpoint.seen[0]!.url).toBe('/v1/messages')
    expect(plainEndpoint.seen[0]!.headers['anthropic-beta']).toBeUndefined()
    expect(plainEndpoint.seen[0]!.body).not.toHaveProperty('fallbacks')
  })

  it('sends the same request body as the non-streaming call apart from stream and max_tokens', async () => {
    const rich: LlmRequest = {
      ...request,
      system: [{ text: 'rules' }, { text: 'catalog', cache: true }],
      messages: [
        { role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: 'UERG', cache: true }, { type: 'text', text: 'go' }] },
        { role: 'assistant', content: '{"a":0}' },
        { role: 'user', content: 'again' },
      ],
      effort: 'high',
      cache: true,
    }
    for (const refusalFallback of [true, false]) {
      const { seen, baseURL } = await mock((entry) => answer(entry, message('{"a":1}')))
      const p = provider(baseURL, { refusalFallback })
      await p.generate({ ...rich, maxTokens: SHORT })
      await p.generate({ ...rich, maxTokens: LONG })
      expect(without(seen[1]!.body, 'stream', 'max_tokens')).toEqual(without(seen[0]!.body, 'max_tokens'))
      expect(seen[1]!.body.stream).toBe(true)
    }
  })
})

describe('a streamed reply', () => {
  it('turns server-sent events into the same result as the buffered reply', async () => {
    const { seen, baseURL } = await mock((entry) =>
      answer(entry, message('{"a":42}', { model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } })),
    )
    const result = await provider(baseURL).generate({ ...request, maxTokens: LONG })
    expect(seen).toHaveLength(1)
    expect(result).toMatchObject({
      data: { a: 42 },
      model: 'claude-sonnet-5-5',
      requestedModel: DEFAULT_MODEL,
      stopReason: 'end_turn',
      fallbackUsed: false,
      usage: { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 },
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  const fixtures: [string, Record<string, unknown>, { refusalFallback?: boolean }][] = [
    ['a plain reply', message('{"a":7}'), {}],
    ['a plain reply on the plain endpoint', message('{"a":7}'), { refusalFallback: false }],
    [
      'null cache counters and several text blocks',
      message('', {
        content: [
          { type: 'text', text: '{"a":' },
          { type: 'text', text: '5}' },
        ],
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      }),
      {},
    ],
    ['thinking blocks that are ignored', message('', { content: [{ type: 'thinking', thinking: 'let me think', signature: 'sig' }, { type: 'text', text: '{"a":9}' }] }), {}],
    ['a fallback block that hides the first text', fallbackReply, {}],
    [
      'a reply that stopped at a stop sequence',
      message('{"a":1}', { stop_reason: 'stop_sequence', stop_sequence: 'x' }),
      {},
    ],
  ]

  it.each(fixtures)('gives the same LlmResult streamed and buffered for %s', async (_name, reply, options) => {
    const { plain, streamed } = await both(reply, options)
    expect(plain.result).not.toBeInstanceOf(Error)
    expect(streamed.result).not.toBeInstanceOf(Error)
    expect(without(streamed.result, 'durationMs')).toEqual(without(plain.result, 'durationMs'))
  })

  it('ignores the text of the declined model and reports the fallback', async () => {
    const { seen, baseURL } = await mock((entry) => answer(entry, fallbackReply))
    const result = await provider(baseURL).generate({ ...request, maxTokens: LONG })
    expect(seen[0]!.body.stream).toBe(true)
    expect(result).toMatchObject({ data: { a: 2 }, model: 'claude-opus-4-8', requestedModel: DEFAULT_MODEL, fallbackUsed: true })
  })

  const failures: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      'a refusal',
      message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } }),
      { kind: 'refusal', retryable: false, category: 'cyber' },
    ],
    ['max_tokens', message('{"a":', { stop_reason: 'max_tokens' }), { kind: 'truncated', retryable: false }],
    [
      'a full context window',
      message('{"a":', { stop_reason: 'model_context_window_exceeded' }),
      { kind: 'truncated', retryable: false },
    ],
    ['text that is not JSON', message('not json'), { kind: 'invalid_output', retryable: true }],
    ['a reply without text', message('', { content: [] }), { kind: 'invalid_output', retryable: true }],
    [
      'nothing after the last fallback block',
      message('', { content: [{ type: 'text', text: '{"a":1}' }, { type: 'fallback', from: { model: 'a' }, to: { model: 'b' }, trigger: { type: 'refusal', category: null } }] }),
      { kind: 'invalid_output' },
    ],
  ]

  it.each(failures)('fails with the same error streamed and buffered for %s', async (_name, reply, expected) => {
    const { plain, streamed } = await both(reply)
    for (const outcome of [plain.result, streamed.result]) {
      expect(outcome).toBeInstanceOf(LlmError)
      expect(outcome).toMatchObject(expected)
    }
    expect((streamed.result as LlmError).message).toBe((plain.result as LlmError).message)
  })
})

describe('a stream that breaks', () => {
  const opening = streamEvents(message('{"a":1}')).slice(0, 4)

  it.each([
    ['overloaded_error', 'overloaded', true],
    ['api_error', 'overloaded', true],
    ['rate_limit_error', 'rate_limit', true],
    ['timeout_error', 'timeout', true],
    ['authentication_error', 'auth', false],
    ['permission_error', 'auth', false],
    ['invalid_request_error', 'invalid_request', false],
  ] as const)('maps an %s event after some text to kind %s', async (type, kind, retryable) => {
    const { baseURL } = await mock(() => ({
      headers: { 'request-id': 'req_stream' },
      sse: { events: [...opening, sse('error', errorBody(type, 'mid-stream trouble'))] },
    }))
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind, retryable, requestId: 'req_stream' })
  })

  it('reports a connection dropped mid-stream as a retryable connection error', async () => {
    const { seen, baseURL } = await mock(() => ({ sse: { events: opening, then: 'drop' } }))
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'connection', retryable: true })
    expect(seen).toHaveLength(1)
  })

  it('reports a stream that ends before message_stop as a retryable connection error', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: opening } }))
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'connection', retryable: true })
  })

  it('reports a stream that ends right after the headers the same way', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: [] } }))
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'connection', retryable: true })
  })

  it('maps an abort while events are flowing to kind aborted and closes the connection', async () => {
    const { seen, baseURL } = await mock(() => ({ sse: { events: opening, then: 'hold' } }))
    const controller = new AbortController()
    const pending = provider(baseURL).generate({ ...request, maxTokens: LONG }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    await expect.poll(() => seen[0]!.closed).toBe(true)
  })

  it('maps an abort that happened before the call to kind aborted without a hanging stream', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: opening, then: 'hold' } }))
    const controller = new AbortController()
    controller.abort()
    await expect(provider(baseURL).generate({ ...request, maxTokens: LONG }, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    })
  })

  it('times out a stream whose response does not start within the per-call timeout', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: streamEvents(message('{"a":1}')) }, delayMs: 400 }))
    const strict = await provider(baseURL).generate({ ...request, maxTokens: LONG }, { timeoutMs: 50 }).catch((e: unknown) => e)
    expect(strict).toMatchObject({ kind: 'timeout', retryable: true })
    await expect(provider(baseURL).generate({ ...request, maxTokens: LONG })).resolves.toMatchObject({ data: { a: 1 } })
  })

  it('classifies an HTTP error on a streamed request like a buffered one', async () => {
    const { baseURL } = await mock(() => ({
      status: 429,
      headers: { 'retry-after-ms': '2500', 'request-id': 'req_abc' },
      body: errorBody('rate_limit_error', 'slow down'),
    }))
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429, retryAfterMs: 2500, requestId: 'req_abc' })
    const auth = await mock(() => ({ status: 401, body: errorBody('authentication_error', 'bad key') }))
    await expect(provider(auth.baseURL).generate({ ...request, maxTokens: LONG })).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('reports an unreachable provider as a retryable connection error', async () => {
    const error = await provider('http://127.0.0.1:1').generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'connection', retryable: true })
  })

  it('keeps the SDK retries for the connection phase: a 500 followed by a stream is a success', async () => {
    const { seen, baseURL } = await mock((_entry, index) =>
      index === 0
        ? { status: 500, headers: { 'retry-after-ms': '1' }, body: errorBody('api_error', 'hiccup') }
        : { sse: { events: streamEvents(message('{"a":1}')) } },
    )
    const result = await provider(baseURL, { maxRetries: 2 }).generate({ ...request, maxTokens: LONG })
    expect(result.data).toEqual({ a: 1 })
    expect(seen).toHaveLength(2)
  })

  it('does not treat a truncated stream as complete JSON', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: streamEvents(message('{"a":', { stop_reason: 'max_tokens' })) } }))
    await expect(provider(baseURL).generate({ ...request, maxTokens: LONG })).rejects.toMatchObject({ kind: 'truncated' })
  })
})
