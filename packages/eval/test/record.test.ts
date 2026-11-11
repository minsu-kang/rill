import { LlmError, type LlmProvider, type LlmRequest } from '@rill/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvalProvider, createRecorder, withEffort, withSignal, type FetchFn } from '../src/record'

const SECRET_KEY = 'sk-ant-test-SECRET-123'
const DOCUMENT_MARKER = 'RECEIPT-BYTES-MARKER-XYZ'

interface Sent {
  url: string
  headers: Headers
  body: Record<string, unknown>
  signal: AbortSignal | undefined
}

interface Canned {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  raw?: string
  advanceMs?: number
}

function message(model: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  }
}

function fakeFetch(respond: (sent: Sent, index: number) => Canned, clock?: { now: number }) {
  const sent: Sent[] = []
  const fetchFn: FetchFn = (input, init) => {
    const entry: Sent = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      signal: init?.signal ?? undefined,
    }
    sent.push(entry)
    const canned = respond(entry, sent.length - 1)
    if (clock !== undefined) clock.now += canned.advanceMs ?? 10
    const text = canned.raw ?? JSON.stringify(canned.body ?? {})
    return Promise.resolve(
      new Response(text, { status: canned.status ?? 200, headers: { 'content-type': canned.raw === undefined ? 'application/json' : 'text/html', ...canned.headers } }),
    )
  }
  return { fetch: fetchFn, sent }
}

const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false }
const request: LlmRequest = { messages: [{ role: 'user', content: `please read ${DOCUMENT_MARKER}` }], schema, effort: 'low' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createRecorder', () => {
  it('records the response facts and leaves the body unread for the caller', async () => {
    const clock = { now: 1000 }
    const reply = message('claude-haiku-5-5', '{"a":1}', {
      content: [
        { type: 'thinking', thinking: 'abcdef', signature: 's' },
        { type: 'fallback', from: { model: 'x' }, to: { model: 'y' } },
        { type: 'text', text: '{"a":1}' },
      ],
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    })
    const api = fakeFetch(() => ({ headers: { 'request-id': 'req_abc' }, advanceMs: 250, body: reply }), clock)
    const recorder = createRecorder(api.fetch, () => clock.now)
    const response = await recorder.fetch('https://example.test/v1/messages', { method: 'POST', body: '{}' })
    expect(response.bodyUsed).toBe(false)
    expect(await response.json()).toEqual(reply)
    const [exchange, ...rest] = recorder.exchanges()
    expect(rest).toEqual([])
    expect(exchange).toEqual({
      startedAtMs: 1000,
      durationMs: 250,
      status: 200,
      requestId: 'req_abc',
      model: 'claude-haiku-5-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 },
      contentBlockTypes: ['thinking', 'fallback', 'text'],
      fallbackBlocks: 1,
      thinkingChars: 6,
      bodyBytes: new TextEncoder().encode(JSON.stringify(reply)).length,
      failure: null,
      badReply: null,
      requestMaxTokens: null,
    })
  })

  it('turns null cache counters into zero and sums several thinking blocks', async () => {
    const api = fakeFetch(() => ({
      body: message('m', '{}', {
        content: [
          { type: 'thinking', thinking: 'ab' },
          { type: 'thinking', thinking: 'cde' },
          { type: 'thinking' },
          { type: 'text', text: '{}' },
          'junk',
          { notAType: true },
        ],
        usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      }),
    }))
    const recorder = createRecorder(api.fetch)
    await recorder.fetch('https://example.test')
    expect(recorder.exchanges()[0]).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      thinkingChars: 5,
      contentBlockTypes: ['thinking', 'thinking', 'thinking', 'text'],
    })
  })

  it.each([
    ['an HTML page', { raw: '<html>bad gateway</html>', status: 200 }],
    ['an empty body', { raw: '', status: 200 }],
    ['an error body', { body: { type: 'error', error: { type: 'api_error', message: 'x' } }, status: 500 }],
    ['a JSON array', { body: [1, 2], status: 200 }],
    ['a JSON string', { body: 'hello', status: 200 }],
    ['a body without usage', { body: { model: 'm', content: [] }, status: 200 }],
    ['wrong field types', { body: { model: 5, stop_reason: {}, usage: { input_tokens: 'many', output_tokens: -4 }, content: 'text' }, status: 200 }],
  ] as const)('still records an exchange for %s', async (_label, canned) => {
    const api = fakeFetch(() => canned)
    const recorder = createRecorder(api.fetch)
    const response = await recorder.fetch('https://example.test')
    expect(response.status).toBe(canned.status)
    const [exchange] = recorder.exchanges()
    expect(exchange?.status).toBe(canned.status)
    expect(exchange?.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    expect(exchange?.contentBlockTypes).toEqual([])
    expect(exchange?.failure).toBeNull()
  })

  it('keeps the model and usage of an error-free reply that has other unknown fields', async () => {
    const api = fakeFetch(() => ({ body: message('claude-opus-5-5', '{}', { extra: { nested: true } }) }))
    const recorder = createRecorder(api.fetch)
    await recorder.fetch('https://example.test')
    expect(recorder.exchanges()[0]).toMatchObject({ model: 'claude-opus-5-5', stopReason: 'end_turn', requestId: null })
  })

  it('records a request that fails before any response and rethrows the error', async () => {
    const clock = { now: 500 }
    const failing: FetchFn = () => {
      clock.now += 40
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }
    const recorder = createRecorder(failing, () => clock.now)
    await expect(recorder.fetch('https://example.test')).rejects.toMatchObject({ name: 'AbortError' })
    expect(recorder.exchanges()).toEqual([
      expect.objectContaining({ startedAtMs: 500, durationMs: 40, status: null, model: null, failure: 'AbortError', bodyBytes: 0 }),
    ])
  })

  it('records every request in order and hands out copies', async () => {
    const api = fakeFetch((_sent, index) => ({ body: message(`m${index}`, '{}') }))
    const recorder = createRecorder(api.fetch)
    await recorder.fetch('https://example.test/1')
    await recorder.fetch('https://example.test/2')
    const first = recorder.exchanges()
    expect(first.map((entry) => entry.model)).toEqual(['m0', 'm1'])
    first[0]!.usage.inputTokens = 999
    first[0]!.contentBlockTypes.push('tampered')
    first.pop()
    expect(recorder.exchanges()).toHaveLength(2)
    expect(recorder.exchanges()[0]?.usage.inputTokens).toBe(120)
    expect(recorder.exchanges()[0]?.contentBlockTypes).toEqual(['text'])
  })

  it('wraps the global fetch when no inner fetch is given', async () => {
    const stub = vi.fn<FetchFn>(() => Promise.resolve(new Response(JSON.stringify(message('claude-haiku-5-5', '{}')), { status: 200 })))
    vi.stubGlobal('fetch', stub)
    const recorder = createRecorder()
    await recorder.fetch('https://example.test/x', { method: 'POST' })
    expect(stub).toHaveBeenCalledTimes(1)
    expect(recorder.exchanges()[0]).toMatchObject({ status: 200, model: 'claude-haiku-5-5' })
    expect(typeof recorder.exchanges()[0]?.startedAtMs).toBe('number')
  })

  it('never stores the request body, the request headers or the URL', async () => {
    const api = fakeFetch(() => ({ body: message('claude-sonnet-5-5', '{"a":1}') }))
    const recorder = createRecorder(api.fetch)
    await recorder.fetch(`https://example.test/v1/messages?token=${SECRET_KEY}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET_KEY}`, 'x-api-key': SECRET_KEY },
      body: JSON.stringify({ messages: [{ role: 'user', content: DOCUMENT_MARKER }] }),
    })
    const dump = JSON.stringify(recorder.exchanges())
    expect(api.sent[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET_KEY}`)
    for (const forbidden of [SECRET_KEY, DOCUMENT_MARKER, 'authorization', 'x-api-key', 'example.test', 'Bearer', 'messages']) {
      expect(dump.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('createEvalProvider', () => {
  it('drives the real Anthropic provider through the recording fetch', async () => {
    const clock = { now: 0 }
    const api = fakeFetch(
      () => ({ headers: { 'request-id': 'req_1' }, advanceMs: 120, body: message('claude-sonnet-5-5', '{"a":42}') }),
      clock,
    )
    const { provider, recorder } = createEvalProvider({ model: 'claude-sonnet-5-5', apiKey: SECRET_KEY, fetch: api.fetch, clock: () => clock.now })
    const result = await provider.generate(request)
    expect(result).toMatchObject({ data: { a: 42 }, model: 'claude-sonnet-5-5', requestedModel: 'claude-sonnet-5-5', fallbackUsed: false })
    expect(recorder.exchanges()).toEqual([
      expect.objectContaining({ durationMs: 120, status: 200, requestId: 'req_1', model: 'claude-sonnet-5-5', usage: expect.objectContaining({ inputTokens: 120 }) }),
    ])
    const sent = api.sent[0]!
    expect(sent.url).toContain('/v1/messages')
    expect(sent.headers.get('authorization')).toBe(`Bearer ${SECRET_KEY}`)
  })

  it('turns server-side fallback off for every model, including Sonnet and Opus', async () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
      const api = fakeFetch(() => ({ body: message(model, '{"a":1}') }))
      await createEvalProvider({ model, apiKey: 'k', fetch: api.fetch }).provider.generate(request)
      expect(api.sent[0]?.body).toMatchObject({ model })
      expect(api.sent[0]?.body).not.toHaveProperty('fallbacks')
      expect(api.sent[0]?.headers.get('anthropic-beta')).toBeNull()
    }
  })

  it('does not retry inside the SDK: a 429 reaches the caller after one request', async () => {
    const api = fakeFetch(() => ({ status: 429, headers: { 'retry-after-ms': '1' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } } }))
    const { provider, recorder } = createEvalProvider({ model: 'claude-haiku-5-5', apiKey: 'k', fetch: api.fetch })
    await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(api.sent).toHaveLength(1)
    expect(recorder.exchanges()).toEqual([expect.objectContaining({ status: 429 })])
  })

  it('records usage even when the reply is a refusal or is cut off', async () => {
    const refusal = fakeFetch(() => ({
      body: message('claude-opus-5-5', '', { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: { input_tokens: 300, output_tokens: 0 } }),
    }))
    const first = createEvalProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: refusal.fetch })
    await expect(first.provider.generate(request)).rejects.toMatchObject({ kind: 'refusal' })
    expect(first.recorder.exchanges()[0]).toMatchObject({ stopReason: 'refusal', usage: { inputTokens: 300, outputTokens: 0 } })
    const cut = fakeFetch(() => ({ body: message('claude-opus-5-5', '{"a"', { stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 16000 } }) }))
    const second = createEvalProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: cut.fetch })
    await expect(second.provider.generate(request)).rejects.toMatchObject({ kind: 'truncated' })
    expect(second.recorder.exchanges()[0]).toMatchObject({ stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 16000 } })
  })

  it('applies an effort override to every request', async () => {
    const api = fakeFetch(() => ({ body: message('claude-opus-5-5', '{"a":1}') }))
    const { provider } = createEvalProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: api.fetch, effort: 'high' })
    await provider.generate(request)
    await provider.generate({ ...request, effort: 'low' })
    expect(api.sent.map((entry) => (entry.body['output_config'] as { effort: string }).effort)).toEqual(['high', 'high'])
    const plain = fakeFetch(() => ({ body: message('claude-opus-5-5', '{"a":1}') }))
    await createEvalProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: plain.fetch }).provider.generate(request)
    expect((plain.sent[0]?.body['output_config'] as { effort: string }).effort).toBe('low')
  })

  it('uses the default signal when the caller passes none, and the caller signal otherwise', async () => {
    const api = fakeFetch(() => ({ body: message('claude-haiku-5-5', '{"a":1}') }))
    const defaultSignal = new AbortController()
    const { provider } = createEvalProvider({ model: 'claude-haiku-5-5', apiKey: 'k', fetch: api.fetch, signal: defaultSignal.signal })
    await provider.generate(request)
    const own = new AbortController()
    await provider.generate(request, { signal: own.signal })
    expect(api.sent).toHaveLength(2)
    expect(api.sent[0]?.signal?.aborted).toBe(false)
    defaultSignal.abort()
    await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'aborted' })
    await expect(provider.generate(request, { signal: own.signal })).resolves.toMatchObject({ data: { a: 1 } })
  })

  it('never leaks the key or the document into what the recorder stored', async () => {
    const api = fakeFetch(() => ({ body: message('claude-haiku-5-5', '{"a":1}') }))
    const { provider, recorder } = createEvalProvider({ model: 'claude-haiku-5-5', apiKey: SECRET_KEY, fetch: api.fetch })
    await provider.generate({
      ...request,
      system: 'system text SYSTEM-MARKER',
      messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: DOCUMENT_MARKER }, { type: 'text', text: 'read it' }] }],
    })
    expect(JSON.stringify(api.sent[0]?.body)).toContain(DOCUMENT_MARKER)
    const dump = JSON.stringify(recorder.exchanges())
    for (const forbidden of [SECRET_KEY, DOCUMENT_MARKER, 'SYSTEM-MARKER', 'authorization', 'Bearer']) {
      expect(dump).not.toContain(forbidden)
    }
  })
})

describe('withEffort and withSignal', () => {
  function spy() {
    const calls: { request: LlmRequest; signal: AbortSignal | undefined }[] = []
    const provider: LlmProvider = {
      name: 'spy',
      generate: (req, options) => {
        calls.push({ request: req, signal: options?.signal })
        return Promise.reject(new LlmError('unknown', 'stop'))
      },
    }
    return { provider, calls }
  }

  it('withEffort rewrites request.effort and keeps the rest of the request and the call options', async () => {
    const { provider, calls } = spy()
    const signal = new AbortController().signal
    const wrapped = withEffort(provider, 'xhigh')
    expect(wrapped.name).toBe('spy')
    await wrapped.generate({ ...request, system: 's', maxTokens: 50 }, { signal }).catch(() => undefined)
    expect(calls[0]?.request).toEqual({ ...request, system: 's', maxTokens: 50, effort: 'xhigh' })
    expect(calls[0]?.signal).toBe(signal)
  })

  it('withSignal fills in a missing signal only', async () => {
    const { provider, calls } = spy()
    const fallback = new AbortController().signal
    const own = new AbortController().signal
    const wrapped = withSignal(provider, fallback)
    await wrapped.generate(request).catch(() => undefined)
    await wrapped.generate(request, {}).catch(() => undefined)
    await wrapped.generate(request, { signal: own }).catch(() => undefined)
    expect(calls.map((call) => call.signal)).toEqual([fallback, fallback, own])
    expect(wrapped.name).toBe('spy')
  })
})
