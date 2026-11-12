import { describe, expect, it } from 'vitest'
import {
  EFFORT_LEVELS,
  LlmError,
  capabilitiesOf,
  createProvider,
  type FetchFn,
  type LlmEffort,
  type LlmRequest,
} from '../../src/index'
import { GROK_DEFAULT_MAX_TOKENS, GROK_DEFAULT_TIMEOUT_MS, GrokProvider } from '../../src/grok'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PNG_BASE64 } from '../conformance'
import { createFakeTransport, errorReply, jsonReply, sseChunks, sseReply, type FakeReply, type FakeTransport } from '../fake-transport'
import { GROK_ENDPOINT, GROK_MODEL, RAW_USAGE, completed, created, delta, incomplete, okReply, responseObject, USAGE } from './wire'

const ask: LlmRequest = { system: 'You are a test system.', messages: [{ role: 'user', content: 'hello' }], schema: CONFORMANCE_SCHEMA, maxTokens: 4000 }

function setup(model = GROK_MODEL, options: { baseURL?: string } = {}) {
  const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
  const provider = new GrokProvider({ model, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random, ...options })
  return { transport, provider }
}

async function run(replies: FakeReply[], request: LlmRequest = ask, model = GROK_MODEL) {
  const { transport, provider } = setup(model)
  transport.script(...replies)
  const outcome = await provider.generate(request).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error: error as LlmError }),
  )
  return { transport, ...outcome }
}

const bodyOf = (transport: FakeTransport, index = 0) => (transport.requests[index]?.json ?? {}) as Record<string, unknown>

function pick(transport: FakeTransport, ...path: (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Record<string | number, unknown>)[key] : undefined), bodyOf(transport))
}

describe('request shape', () => {
  it('posts to the Responses endpoint with a bearer key and asks for a stream', async () => {
    const { transport } = await run([okReply()])
    const sent = transport.requests[0]
    expect(sent?.url).toBe(GROK_ENDPOINT)
    expect(sent?.headers['authorization']).toBe(`Bearer ${CONFORMANCE_API_KEY}`)
    expect(sent?.headers['accept']).toBe('text/event-stream')
    expect(sent?.headers['content-type']).toBe('application/json')
  })

  it.each([
    ['the default', undefined, 'https://api.x.ai/v1/responses'],
    ['the US endpoint', 'https://us.api.x.ai', 'https://us.api.x.ai/v1/responses'],
    ['a trailing slash', 'https://us.api.x.ai/', 'https://us.api.x.ai/v1/responses'],
    ['a base that already ends in /v1', 'https://us.api.x.ai/v1', 'https://us.api.x.ai/v1/responses'],
    ['a base that ends in /v1/', 'https://us.api.x.ai/v1/', 'https://us.api.x.ai/v1/responses'],
  ])('builds the endpoint from %s', async (_, baseURL, expected) => {
    const { transport, provider } = setup(GROK_MODEL, baseURL === undefined ? {} : { baseURL })
    transport.script(okReply())
    await provider.generate(ask)
    expect(transport.requests[0]?.url).toBe(expected)
  })

  it.each(['api.x.ai', '', 'ftp://api.x.ai', 'file:///etc/hosts', 'localhost:8080'])('refuses the base URL %j, before anything is sent', (baseURL) => {
    const transport = createFakeTransport()
    const act = () => new GrokProvider({ model: GROK_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, baseURL })
    expect(act).toThrow(LlmError)
    expect(act).toThrow(/baseURL/)
  })

  it('accepts an http base URL for a local test server and drops its query and fragment', async () => {
    const { transport, provider } = setup(GROK_MODEL, { baseURL: 'http://127.0.0.1:8080/proxy?x=1#frag' })
    transport.script(okReply())
    await provider.generate(ask)
    expect(transport.requests[0]?.url).toBe('http://127.0.0.1:8080/proxy/v1/responses')
  })

  it('always sends store false and stream true, whatever the request holds', async () => {
    const requests: LlmRequest[] = [
      ask,
      { ...ask, system: undefined },
      { ...ask, system: [{ text: 'a', cache: true }, { text: 'b' }], cache: true },
      { ...ask, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }, { type: 'text', text: 'x' }] }] },
      { ...ask, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] },
      { ...ask, maxTokens: 50_000 },
      { ...ask, maxTokens: undefined },
      ...EFFORT_LEVELS.map((effort) => ({ ...ask, effort })),
    ]
    for (const request of requests) {
      const { transport, error } = await run([okReply()], request)
      expect(error).toBeUndefined()
      const body = bodyOf(transport)
      expect(body['store']).toBe(false)
      expect(body['stream']).toBe(true)
    }
  })

  it('never sends sampling parameters, stop sequences or penalties, and keeps to documented top-level fields', async () => {
    const documented = new Set(['model', 'stream', 'store', 'prompt_cache_key', 'max_output_tokens', 'reasoning', 'input', 'text'])
    const { transport } = await run([okReply()], { ...ask, effort: 'max', cache: true })
    const keys = Object.keys(bodyOf(transport))
    for (const key of keys) expect(documented.has(key), key).toBe(true)
    for (const banned of ['temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'logprobs', 'tools', 'instructions', 'previous_response_id', 'background', 'truncation', 'metadata'])
      expect(keys).not.toContain(banned)
  })

  it('sends max_output_tokens from maxTokens and a default when it is unset', async () => {
    const explicit = await run([okReply()], { ...ask, maxTokens: 777 })
    expect(bodyOf(explicit.transport)['max_output_tokens']).toBe(777)
    const implicit = await run([okReply()], { ...ask, maxTokens: undefined })
    expect(bodyOf(implicit.transport)['max_output_tokens']).toBe(GROK_DEFAULT_MAX_TOKENS)
    expect(bodyOf(implicit.transport)['max_output_tokens']).toBe(16_000)
  })

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses maxTokens %s before any request', async (maxTokens) => {
    const { transport, error } = await run([okReply()], { ...ask, maxTokens })
    expect(error?.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
  })

  it('declares a 900 second client timeout by default and lets the call deadline win', async () => {
    const { provider } = setup()
    expect(GROK_DEFAULT_TIMEOUT_MS).toBe(900_000)
    expect(provider.timeoutMs).toBe(900_000)
    const { transport, provider: slow } = setup()
    transport.script({ kind: 'hang' })
    const error = await slow.generate(ask, { timeoutMs: 30 }).catch((caught: unknown) => caught)
    expect((error as LlmError).kind).toBe('timeout')
  })

  it('reports a deadline that expires while waiting to retry as a timeout, not as a cancel', async () => {
    const { transport } = setup()
    transport.script(errorReply(503, { error: { message: 'busy' } }), okReply())
    const slow = new GrokProvider({ model: GROK_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, sleep: () => new Promise<void>(() => undefined), random: () => 0 })
    const error = (await slow.generate(ask, { timeoutMs: 600 }).catch((caught: unknown) => caught)) as LlmError
    expect(error.kind).toBe('timeout')
    expect(transport.requests).toHaveLength(1)
  })

  it('leaves out the system message and the cache key when there is no system text', async () => {
    for (const system of [undefined, '', [], [{ text: '' }]] as LlmRequest['system'][]) {
      const { transport } = await run([okReply()], { ...ask, system })
      const body = bodyOf(transport)
      expect(body['prompt_cache_key']).toBeUndefined()
      expect(body['input']).toEqual([{ role: 'user', content: 'hello' }])
    }
  })

  it('joins system blocks into one message in order', async () => {
    const { transport } = await run([okReply()], { ...ask, system: [{ text: 'one' }, { text: 'two', cache: true }, { text: 'three' }] })
    expect(pick(transport, 'input', 0)).toEqual({ role: 'system', content: 'one\n\ntwo\n\nthree' })
  })

  it('skips empty system blocks when joining', async () => {
    const { transport } = await run([okReply()], { ...ask, system: [{ text: 'one' }, { text: '' }, { text: 'two' }] })
    expect(pick(transport, 'input', 0)).toEqual({ role: 'system', content: 'one\n\ntwo' })
  })

  it('refuses an effort level it does not know before any request', async () => {
    const { transport, error } = await run([okReply()], { ...ask, effort: 'bogus' as LlmEffort })
    expect(error?.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
  })

  it('maps assistant parts to one string and refuses non-text parts in an assistant turn', async () => {
    const parts: LlmRequest['messages'] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }, { type: 'text', text: 'a2' }] },
      { role: 'user', content: 'q2' },
    ]
    const { transport } = await run([okReply()], { ...ask, system: undefined, messages: parts })
    expect(pick(transport, 'input', 1)).toEqual({ role: 'assistant', content: 'a1a2' })
    const image: LlmRequest['messages'] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }] },
      { role: 'user', content: 'q2' },
    ]
    const refused = await run([okReply()], { ...ask, messages: image })
    expect(refused.error?.kind).toBe('invalid_request')
    expect(refused.transport.requests).toHaveLength(0)
  })

  it('refuses a last message that is not from the user', async () => {
    const { transport, error } = await run([okReply()], { ...ask, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] })
    expect(error?.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
  })

  it('refuses an empty message list', async () => {
    const { error } = await run([okReply()], { ...ask, messages: [] })
    expect(error?.kind).toBe('invalid_request')
  })
})

describe('PDF input', () => {
  const pdf = { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=' } as const

  it('is refused with the documented message before any request, wherever the part sits', async () => {
    const earlier: LlmRequest['messages'] = [
      { role: 'user', content: [pdf, { type: 'text', text: 'old' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new' },
    ]
    for (const messages of [[{ role: 'user', content: [{ type: 'text', text: 'x' }, pdf] }] as LlmRequest['messages'], earlier]) {
      const { transport, error } = await run([okReply()], { ...ask, messages })
      expect(error).toBeInstanceOf(LlmError)
      expect(error?.kind).toBe('invalid_request')
      expect(error?.message).toBe('this provider does not read PDF files')
      expect(transport.requests).toHaveLength(0)
    }
  })

  it('does not put the file content in the message', async () => {
    const { error } = await run([okReply()], { ...ask, messages: [{ role: 'user', content: [{ ...pdf, data: 'SECRETPDFCONTENT' }] }] })
    expect(JSON.stringify(error)).not.toContain('SECRETPDFCONTENT')
    expect(error?.message).not.toContain('SECRETPDFCONTENT')
  })

  it('declares that documents are not read', () => {
    expect(capabilitiesOf(setup().provider).documents).toBe('none')
  })
})

describe('images', () => {
  const MIB = 1024 * 1024
  const image = (data: string): LlmRequest => ({ ...ask, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', data }] }] })

  it('sends jpeg as a data URL', async () => {
    const { transport } = await run([okReply()], image(PNG_BASE64))
    expect(pick(transport, 'input', 1)).toEqual({ role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${PNG_BASE64}` }] })
  })

  it('accepts an image of exactly 20 MiB and refuses one byte more, counting the base64 padding', async () => {
    const exact = Buffer.alloc(20 * MIB).toString('base64')
    const over = Buffer.alloc(20 * MIB + 1).toString('base64')
    expect(exact.endsWith('=')).toBe(true)
    expect(over.endsWith('=')).toBe(false)
    expect((await run([okReply()], image(exact))).error).toBeUndefined()
    const refused = await run([okReply()], image(over))
    expect(refused.error?.kind).toBe('invalid_request')
    expect(refused.error?.message).toMatch(/20 MiB/)
    expect(refused.transport.requests).toHaveLength(0)
  })

  it.each(['image/gif', 'image/webp'] as const)('refuses %s and names it', async (mediaType) => {
    const { transport, error } = await run([okReply()], { ...ask, messages: [{ role: 'user', content: [{ type: 'image', mediaType, data: PNG_BASE64 }] }] })
    expect(error?.kind).toBe('invalid_request')
    expect(error?.message).toContain(mediaType)
    expect(transport.requests).toHaveLength(0)
  })

  it('declares png and jpeg only', () => {
    expect(capabilitiesOf(setup().provider).images).toEqual(['image/png', 'image/jpeg'])
  })
})

describe('effort', () => {
  const sent = async (model: string, effort?: LlmEffort) => {
    const { transport } = await run([okReply({ model })], { ...ask, ...(effort === undefined ? {} : { effort }) }, model)
    return pick(transport, 'reasoning')
  }

  it.each([
    ['grok-4.7', { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }],
    ['grok-4.6', { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }],
    ['grok-4.5', { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }],
    ['grok-4.3', { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }],
  ])('%s sends each level as the model table says (max included)', async (model, expected) => {
    for (const level of EFFORT_LEVELS) expect(await sent(model, level), `${model} ${level}`).toEqual({ effort: expected[level as keyof typeof expected] })
  })

  it('always sends an effort, medium when the request has none, never none', async () => {
    for (const model of ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3']) {
      expect(await sent(model)).toEqual({ effort: 'medium' })
      for (const level of EFFORT_LEVELS) expect(await sent(model, level)).not.toEqual({ effort: 'none' })
    }
  })

  it('lets the constructor change the default', async () => {
    const transport = createFakeTransport()
    const provider = new GrokProvider({ model: GROK_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, effort: 'low' })
    transport.script(okReply())
    await provider.generate(ask)
    expect(bodyOf(transport)['reasoning']).toEqual({ effort: 'low' })
  })

  it('does not cap reasoning with maxTokens, and says so in the capabilities', () => {
    expect(capabilitiesOf(setup().provider).reasoningCappedByMaxTokens).toBe(false)
  })

  it('declares three distinguished levels on grok-4.5 and four on the others', () => {
    expect(capabilitiesOf(setup('grok-4.5').provider).effortLevels).toEqual(['low', 'medium', 'high'])
    expect(capabilitiesOf(setup('grok-4.3').provider).effortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})

describe('models', () => {
  it('refuses a model that is not in the table, naming the known ones', () => {
    const transport = createFakeTransport()
    const act = () => new GrokProvider({ model: 'grok-9', apiKey: transport.apiKey, fetch: transport.fetch })
    expect(act).toThrow(LlmError)
    expect(act).toThrow(/grok-4\.7/)
  })

  it('is what the registry builds for grok:<id>, with the model and the key from XAI_API_KEY', async () => {
    const transport = createFakeTransport()
    const provider = createProvider('grok:grok-4.3', { env: { XAI_API_KEY: transport.apiKey }, fetch: transport.fetch, sleep: transport.sleep, random: transport.random })
    expect(provider).toBeInstanceOf(GrokProvider)
    expect(provider.name).toBe('grok')
    transport.script(okReply({ model: 'grok-4.3' }))
    const result = await provider.generate(ask)
    expect(bodyOf(transport)['model']).toBe('grok-4.3')
    expect(result.requestedModel).toBe('grok-4.3')
    expect(transport.requests[0]?.headers['authorization']).toBe(`Bearer ${CONFORMANCE_API_KEY}`)
  })

  it('reports the model the reply names and the requested one, without a fallback', async () => {
    const { result } = await run([okReply({ model: 'grok-4.3' })])
    expect(result?.requestedModel).toBe(GROK_MODEL)
    expect(result?.model).toBe('grok-4.3')
    expect(result?.fallbackUsed).toBe(false)
  })

  it('falls back to the requested id when the reply names no model', async () => {
    const reply = sseReply([created(), { event: 'response.completed', data: { type: 'response.completed', response: { ...responseObject(), model: undefined } } }])
    const { result } = await run([reply])
    expect(result?.model).toBe(GROK_MODEL)
  })
})

describe('usage', () => {
  const usageOf = async (usage: unknown) => run([okReply({ usage })])

  it('subtracts the cached tokens from the input and takes the output as total minus input', async () => {
    const { result } = await usageOf(RAW_USAGE)
    expect(result?.usage).toEqual(USAGE)
    expect(USAGE.inputTokens + USAGE.cacheReadInputTokens).toBe(RAW_USAGE.input_tokens)
    expect(USAGE.outputTokens).toBe(RAW_USAGE.output_tokens + RAW_USAGE.output_tokens_details.reasoning_tokens)
  })

  it('counts reasoning inside the output even when total_tokens counts it only once', async () => {
    const { result } = await usageOf({ ...RAW_USAGE, total_tokens: 6200 + 900 + 2400 })
    expect(result?.usage.outputTokens).toBe(3300)
    const other = await usageOf({ ...RAW_USAGE, output_tokens: 3300, total_tokens: 6200 + 3300 })
    expect(other.result?.usage.outputTokens).toBe(3300)
  })

  it('adds output and reasoning when total_tokens is missing', async () => {
    const noTotal = Object.fromEntries(Object.entries(RAW_USAGE).filter(([key]) => key !== 'total_tokens'))
    const { result } = await usageOf(noTotal)
    expect(result?.usage).toEqual(USAGE)
  })

  it('treats missing detail objects as zero and reports no cache write', async () => {
    const { result } = await usageOf({ input_tokens: 100, output_tokens: 20 })
    expect(result?.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    const nulls = await usageOf({ input_tokens: 100, output_tokens: 20, input_tokens_details: null, output_tokens_details: null })
    expect(nulls.result?.usage.cacheReadInputTokens).toBe(0)
  })

  it('rejects impossible counts as invalid_output', async () => {
    const impossible: unknown[] = [
      { ...RAW_USAGE, input_tokens_details: { cached_tokens: 7000 } },
      { ...RAW_USAGE, total_tokens: 100 },
      { ...RAW_USAGE, input_tokens: -1 },
      { ...RAW_USAGE, input_tokens: 1.5 },
      { ...RAW_USAGE, input_tokens_details: { cached_tokens: -1 } },
      { ...RAW_USAGE, output_tokens_details: { reasoning_tokens: '5' } },
      { ...RAW_USAGE, input_tokens_details: 5 },
      { ...RAW_USAGE, output_tokens_details: 'x' },
      { input_tokens: 5 },
      { ...RAW_USAGE, input_tokens: '6200' },
      { output_tokens: 5 },
      {},
      null,
      'usage',
    ]
    for (const usage of impossible) {
      const { error, transport } = await usageOf(usage)
      expect(error?.kind, JSON.stringify(usage)).toBe('invalid_output')
      expect(transport.requests).toHaveLength(1)
    }
  })

  it('refuses a reply with no usage at all', async () => {
    const reply = sseReply([created(), { data: { type: 'response.completed', response: { ...responseObject(), usage: undefined } } }])
    const { error } = await run([reply])
    expect(error?.kind).toBe('invalid_output')
  })
})

describe('reading the reply', () => {
  const textOf = async (output: unknown[]) => run([okReply({ output })])
  const message = (...content: unknown[]) => ({ type: 'message', role: 'assistant', status: 'completed', content })
  const out = (text: string) => ({ type: 'output_text', text })

  it('reads the last message even when it comes before the reasoning item', async () => {
    const { result } = await textOf([message(out('{"a":1}')), { type: 'reasoning', summary: [], encrypted_content: 'x' }])
    expect(result?.data).toEqual({ a: 1 })
  })

  it('reads the last of several messages and joins the output parts of one message', async () => {
    const first = await textOf([message(out('{"a":0}')), message(out('{"a'), out('":2}'))])
    expect(first.result?.data).toEqual({ a: 2 })
  })

  it('skips tool-call items and other part types', async () => {
    const { result } = await textOf([{ type: 'custom_tool_call', name: 'attachment_search' }, message({ type: 'annotation' }, out('{"a":3}'))])
    expect(result?.data).toEqual({ a: 3 })
  })

  it('treats a reply without a message or without text as invalid_output', async () => {
    for (const output of [[], [{ type: 'reasoning', summary: [] }], [message()], [message(out(''))], 'nope']) {
      const { error } = await textOf(output as unknown[])
      expect(error?.kind, JSON.stringify(output)).toBe('invalid_output')
      expect(error?.usage).toEqual(USAGE)
    }
  })

  it('says that the reply had no text, apart from saying it was not JSON', async () => {
    const { error } = await textOf([message(out(''))])
    expect(error?.message).toContain('no text')
  })

  it('does not retry or leak the model text when the text is not JSON', async () => {
    const { error, transport } = await run([okReply({ text: 'SECRETMODELTEXT {' })])
    expect(error?.kind).toBe('invalid_output')
    expect(error?.message).not.toContain('SECRETMODELTEXT')
    expect(error?.usage).toEqual(USAGE)
    expect(transport.requests).toHaveLength(1)
  })

  it('reads the final response from either event naming style, and from a flat terminal event', async () => {
    const body = responseObject()
    const dataOnly = sseReply([{ data: { type: 'response.created', response: {} } }, { data: { type: 'response.completed', response: body } }])
    expect((await run([dataOnly])).result?.data).toEqual(CONFORMANCE_DATA)
    const eventOnly = sseReply([{ event: 'response.created', data: {} }, { event: 'response.completed', data: { response: body } }])
    expect((await run([eventOnly])).result?.data).toEqual(CONFORMANCE_DATA)
    const flat = sseReply([created(), { data: { type: 'response.completed', ...body } }])
    expect((await run([flat])).result?.data).toEqual(CONFORMANCE_DATA)
  })

  it('ignores deltas, unknown events, comments, empty and non-JSON events', async () => {
    const reply: FakeReply = {
      kind: 'sse',
      chunks: [
        ': keep-alive\n\n',
        'data: \n\n',
        'data: not json at all\n\n',
        'data: [1,2]\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"hm"}\n\n',
        'data: {"type":"response.future_thing","x":1}\n\n',
        `data: ${JSON.stringify(completed().data)}\n\n`,
        'data: [DONE]\n\n',
      ],
    }
    const { result } = await run([reply])
    expect(result?.data).toEqual(CONFORMANCE_DATA)
  })

  it('stops at the terminal event and ignores what follows it', async () => {
    const reply = sseReply([created(), completed(), { data: { type: 'error', error: { message: 'late' } } }])
    expect((await run([reply])).result?.data).toEqual(CONFORMANCE_DATA)
  })

  it('reports stop reason end_turn for a completed reply', async () => {
    expect((await run([okReply()])).result?.stopReason).toBe('end_turn')
  })

  it('reads events that arrive split across chunks', async () => {
    const text = JSON.stringify({ a: 1, note: 'caf\u00e9 \u4e2d\u6587' })
    const wire = `event: response.completed\ndata: ${JSON.stringify(completed({ text }).data)}\n\n`
    const whole: FakeReply = { kind: 'sse', chunks: [wire.slice(0, 30), wire.slice(30, 90), wire.slice(90)] }
    expect((await run([whole])).result?.data).toEqual({ a: 1, note: 'caf\u00e9 \u4e2d\u6587' })
  })
})

describe('stop reasons', () => {
  const stopped = (reason: string | null | undefined, extra: Partial<Parameters<typeof incomplete>[0]> = {}) =>
    run([sseReply([created(), incomplete({ reason: reason ?? null, text: '{"a":', ...extra })])])

  it.each([
    ['max_output_tokens', 'truncated', 'max_output_tokens'],
    ['content_filter', 'refusal', 'content_filter'],
    ['max_time_limit', 'timeout', 'max_time_limit'],
    ['max_prompt_tokens', 'invalid_request', 'context_too_long'],
  ])('incomplete with %s is %s', async (reason, kind, category) => {
    const { error, transport } = await stopped(reason)
    expect(error?.kind).toBe(kind)
    expect(error?.category).toBe(category)
    expect(error?.usage).toEqual(USAGE)
    expect(error?.model).toBe(GROK_MODEL)
    expect(transport.requests).toHaveLength(1)
  })

  it('names an unknown incomplete reason and does not retry', async () => {
    const { error, transport } = await stopped('something_new')
    expect(error?.kind).toBe('unknown')
    expect(error?.message).toContain('something_new')
    expect(transport.requests).toHaveLength(1)
    const none = await stopped(undefined)
    expect(none.error?.kind).toBe('unknown')
  })

  it('does not return text from an incomplete reply even when the JSON happens to parse', async () => {
    const { error, result } = await run([sseReply([created(), incomplete({ reason: 'max_output_tokens', text: '{"a":1}' })])])
    expect(result).toBeUndefined()
    expect(error?.kind).toBe('truncated')
  })

  it('takes an incomplete event whose response says completed as incomplete', async () => {
    const reply = sseReply([created(), { event: 'response.incomplete', data: { type: 'response.incomplete', response: responseObject({ reason: 'max_output_tokens' }) } }])
    expect((await run([reply])).error?.kind).toBe('truncated')
  })

  it('keeps a long incomplete reason short in the message', async () => {
    const { error } = await stopped('r'.repeat(500))
    expect(error?.kind).toBe('unknown')
    expect(error?.message.length).toBeLessThan(120)
  })

  it('a failed response without an error object is unknown, and any other unfinished status is invalid_output', async () => {
    const failed = sseReply([created(), { event: 'response.failed', data: { type: 'response.failed', response: { ...responseObject(), status: 'failed' } } }])
    const one = await run([failed])
    expect(one.error?.kind).toBe('unknown')
    expect(one.error?.usage).toEqual(USAGE)
    for (const status of ['in_progress', 'cancelled', 'x'.repeat(200)]) {
      const reply = sseReply([created(), { event: 'response.completed', data: { type: 'response.completed', response: { ...responseObject(), status } } }])
      const { error } = await run([reply])
      expect(error?.kind, status).toBe('invalid_output')
      expect(error?.message.length).toBeLessThan(120)
    }
  })

  it('takes a completed event whose response says incomplete as incomplete', async () => {
    const { error } = await run([sseReply([created(), completed({ status: 'incomplete', reason: 'max_output_tokens' })])])
    expect(error?.kind).toBe('truncated')
  })

  it('keeps the billed usage on a refusal and gives it a category', async () => {
    const { error } = await run([okReply({ content: [{ type: 'refusal', refusal: 'SECRETREASON' }] })])
    expect(error?.kind).toBe('refusal')
    expect(error?.category).toBe('refusal')
    expect(error?.message).not.toContain('SECRETREASON')
    expect(error?.usage).toEqual(USAGE)
  })

  it('lets a refusal win over text in the same message', async () => {
    const { error } = await run([okReply({ content: [{ type: 'output_text', text: '{"a":1}' }, { type: 'refusal', refusal: 'no' }] })])
    expect(error?.kind).toBe('refusal')
  })

  it('does not fail a truncated reply on a bad usage block, and still reports truncation', async () => {
    const { error } = await run([sseReply([created(), incomplete({ reason: 'max_output_tokens', usage: { oops: true } })])])
    expect(error?.kind).toBe('truncated')
    expect(error?.usage).toBeUndefined()
  })
})

describe('streams that do not finish', () => {
  it('a stream that ends without a terminal event is a connection error, and is not retried once it started', async () => {
    const { error, transport } = await run([sseReply([created(), delta('{"a"')])])
    expect(error?.kind).toBe('connection')
    expect(error?.message).toMatch(/final event|terminal/)
    expect(transport.requests).toHaveLength(1)
    expect(transport.sleeps).toEqual([])
  })

  it('an empty stream is a connection error that is retried, two retries at most', async () => {
    const { error, transport } = await run([sseReply([])])
    expect(error?.kind).toBe('connection')
    expect(transport.requests).toHaveLength(3)
    expect(transport.sleeps).toHaveLength(2)
  })

  it('an empty stream followed by a good reply succeeds on the retry', async () => {
    const { result, transport } = await run([sseReply([]), okReply()])
    expect(result?.data).toEqual(CONFORMANCE_DATA)
    expect(transport.requests).toHaveLength(2)
  })

  it('a JSON body for a streaming request is invalid_output and is not retried', async () => {
    const { error, transport } = await run([jsonReply(responseObject())])
    expect(error?.kind).toBe('invalid_output')
    expect(transport.requests).toHaveLength(1)
  })

  it('an error event after output has started is raised once and never retried', async () => {
    const reply = sseReply([created(), { event: 'error', data: { type: 'error', error: { message: 'Service temporarily unavailable' } } }])
    const { error, transport } = await run([reply, okReply()])
    expect(error?.kind).toBe('overloaded')
    expect(transport.requests).toHaveLength(1)
    expect(transport.sleeps).toEqual([])
  })

  it('an error event as the very first event is not retried either', async () => {
    const reply = sseReply([{ data: { type: 'error', error: { message: 'Service temporarily unavailable' } } }])
    const { error, transport } = await run([reply, okReply()])
    expect(error?.kind).toBe('overloaded')
    expect(transport.requests).toHaveLength(1)
  })
})

describe('request ids', () => {
  const withId = (events: Parameters<typeof sseChunks>[0]): FakeReply => ({ kind: 'sse', headers: { 'x-request-id': 'req-stream-1' }, chunks: sseChunks(events) })

  it('are kept on every failure that happens after the stream has opened', async () => {
    const cases: [string, FakeReply][] = [
      ['truncated', withId([created(), incomplete({ reason: 'max_output_tokens' })])],
      ['refusal', withId([created(), completed({ content: [{ type: 'refusal', refusal: 'no' }] })])],
      ['invalid output', withId([created(), completed({ text: 'nope' })])],
      ['stream error', withId([created(), { event: 'error', data: { type: 'error', error: { message: 'Service temporarily unavailable' } } }])],
      ['error object', withId([created(), { data: { type: 'response.completed', response: { ...responseObject(), error: { message: 'Invalid API key' } } } }])],
      ['no final event', withId([created()])],
    ]
    for (const [name, reply] of cases) expect((await run([reply])).error?.requestId, name).toBe('req-stream-1')
  })
})

describe('error events', () => {
  const failWith = async (data: unknown, name: string | undefined = 'error') => {
    const { error } = await run([sseReply([created(), { ...(name === undefined ? {} : { event: name }), data }])])
    return error
  }

  it.each([
    [{ type: 'error', error: { message: 'Service temporarily unavailable' } }, 'overloaded'],
    [{ type: 'error', message: 'Service temporarily unavailable' }, 'overloaded'],
    [{ code: 'unavailable', error: 'Service temporarily unavailable' }, 'overloaded'],
    [{ type: 'error', error: { code: '529', message: 'busy' } }, 'overloaded'],
    [{ type: 'error', error: { code: '500', message: 'zzz' } }, 'overloaded'],
    [{ type: 'error', error: { code: '502', message: 'zzz' } }, 'overloaded'],
    [{ type: 'error', error: { code: '404', message: 'zzz' } }, 'invalid_request'],
    [{ type: 'error', error: { code: 503, message: 'busy' } }, 'overloaded'],
    [{ type: 'error', error: { code: 'overloaded_error', message: 'busy' } }, 'overloaded'],
    [{ type: 'error', error: { message: 'Rate limit reached for this team' } }, 'rate_limit'],
    [{ type: 'error', error: { code: 429, message: 'slow down' } }, 'rate_limit'],
    [{ type: 'error', error: { message: 'Invalid API key' } }, 'auth'],
    [{ type: 'error', error: { code: 401, message: 'nope' } }, 'auth'],
    [{ type: 'error', error: { message: 'something odd happened' } }, 'unknown'],
    [{ type: 'error' }, 'unknown'],
    ['plain text', 'unknown'],
    ['"a json string"', 'unknown'],
    ['[1,2]', 'unknown'],
  ])('%j becomes %s', async (data, kind) => {
    expect((await failWith(data))?.kind).toBe(kind)
  })

  it('says what went wrong in an unrecognised error, shortened and without the key', async () => {
    const plain = await failWith({ type: 'error', error: { message: 'something odd happened' } })
    expect(plain?.message).toBe('the model provider ended the stream with an error: something odd happened')
    const long = await failWith({ type: 'error', error: { message: `${CONFORMANCE_API_KEY} ${'w'.repeat(2000)}` } })
    expect(long?.message.length).toBeLessThan(400)
    expect(long?.message).not.toContain(CONFORMANCE_API_KEY)
    expect((await failWith({ type: 'error' }))?.message).toBe('the model provider ended the stream with an error')
  })

  it('uses the error type as the category, but not the generic type error', async () => {
    const typed = await failWith({ type: 'error', error: { type: 'overloaded_error', message: 'x' } })
    expect(typed?.kind).toBe('overloaded')
    expect(typed?.category).toBe('overloaded_error')
    const flat = await failWith({ type: 'error', message: 'Service temporarily unavailable' })
    expect(flat?.kind).toBe('overloaded')
    expect(flat?.category).toBeUndefined()
  })

  it('reads the kind from a data-only error event too', async () => {
    expect((await failWith({ type: 'error', error: { message: 'Service temporarily unavailable' } }, undefined))?.kind).toBe('overloaded')
  })

  it('a context overflow message is invalid_request with the right category', async () => {
    const error = await failWith({ type: 'error', error: { message: 'This model has a maximum context length of 500000 tokens' } })
    expect(error?.kind).toBe('invalid_request')
    expect(error?.category).toBe('context_too_long')
  })

  it('never echoes the key from an error event', async () => {
    for (const data of [
      { type: 'error', error: { message: `bad key ${CONFORMANCE_API_KEY}` } },
      { type: 'error', error: { message: `Service temporarily unavailable for ${CONFORMANCE_API_KEY}` } },
      { type: 'error', message: `weird ${CONFORMANCE_API_KEY}` },
    ]) {
      const error = await failWith(data)
      expect(error?.message).not.toContain(CONFORMANCE_API_KEY)
      expect(JSON.stringify(error)).not.toContain(CONFORMANCE_API_KEY)
    }
  })

  it('a response.failed event or an error object inside the response is an error', async () => {
    const failed = sseReply([created(), { event: 'response.failed', data: { type: 'response.failed', response: { ...responseObject({ status: 'completed' }), status: 'failed', error: { message: 'Service temporarily unavailable', code: 'unavailable' } } } }])
    expect((await run([failed])).error?.kind).toBe('overloaded')
    const inline = sseReply([created(), { data: { type: 'response.completed', response: { ...responseObject(), error: { message: 'Invalid API key' } } } }])
    expect((await run([inline])).error?.kind).toBe('auth')
  })
})

describe('HTTP errors', () => {
  const status = async (code: number, body: unknown = { error: { message: 'x' } }, headers: Record<string, string> = {}) =>
    run([errorReply(code, body, headers)])

  it.each([
    [401, 'auth', 1],
    [403, 'auth', 1],
    [400, 'invalid_request', 1],
    [404, 'invalid_request', 1],
    [405, 'invalid_request', 1],
    [415, 'invalid_request', 1],
    [422, 'invalid_request', 1],
    [429, 'rate_limit', 3],
    [500, 'overloaded', 3],
    [502, 'overloaded', 3],
    [503, 'overloaded', 3],
    [529, 'overloaded', 3],
  ])('%s is %s after %s request(s)', async (code, kind, count) => {
    const { error, transport } = await status(code)
    expect(error?.kind).toBe(kind)
    expect(error?.status).toBe(code)
    expect(transport.requests).toHaveLength(count)
  })

  it('reads the documented model-not-found body and keeps the request id', async () => {
    const { error } = await status(404, { code: 'not-found', error: 'The model grok-9 does not exist or your team does not have access to it' }, { 'x-request-id': 'req-123' })
    expect(error?.kind).toBe('invalid_request')
    expect(error?.category).toBe('not-found')
    expect(error?.requestId).toBe('req-123')
    expect(error?.message).toContain('does not exist')
  })

  it('reads retry-after in seconds and in milliseconds', async () => {
    expect((await status(429, {}, { 'retry-after': '3' })).error?.retryAfterMs).toBe(3000)
    expect((await status(429, {}, { 'retry-after-ms': '1500' })).error?.retryAfterMs).toBe(1500)
  })

  it('keeps the key out of a body that echoes it, in every documented error shape', async () => {
    for (const body of [{ error: `key ${CONFORMANCE_API_KEY}` }, { code: 'x', error: `key ${CONFORMANCE_API_KEY}` }, { error: { message: `Bearer ${CONFORMANCE_API_KEY}` } }]) {
      const { error } = await status(400, body)
      expect(error?.message).not.toContain(CONFORMANCE_API_KEY)
    }
  })

  it('a non-JSON error body still classifies by status', async () => {
    const { error } = await run([{ kind: 'text', status: 502, body: '<html>bad gateway</html>' }])
    expect(error?.kind).toBe('overloaded')
  })
})

describe('caching', () => {
  const keyOf = async (request: LlmRequest) => bodyOf((await run([okReply()], request)).transport)['prompt_cache_key']

  it('derives the key from the system blocks only: stable across different user text, free of it', async () => {
    const one = await keyOf({ ...ask, messages: [{ role: 'user', content: 'first question about topic ALPHA' }] })
    const two = await keyOf({ ...ask, messages: [{ role: 'user', content: 'a different question about BETA' }] })
    expect(one).toBe(two)
    expect(one).toMatch(/^rill-[0-9a-f]{32}$/)
    for (const word of ['ALPHA', 'BETA', 'question', 'topic']) expect(one).not.toContain(word)
  })

  it('does not depend on the user text even when it equals the system text', async () => {
    const same = await keyOf({ ...ask, messages: [{ role: 'user', content: 'You are a test system.' }] })
    expect(same).toBe(await keyOf(ask))
  })

  it('is the same for the same blocks however the flags are set, and differs when the system text differs', async () => {
    const plain = await keyOf({ ...ask, system: [{ text: 'a' }, { text: 'b' }] })
    expect(await keyOf({ ...ask, system: [{ text: 'a', cache: true }, { text: 'b' }], cache: true })).toBe(plain)
    expect(await keyOf({ ...ask, system: [{ text: 'a' }, { text: 'c' }] })).not.toBe(plain)
    expect(await keyOf({ ...ask, system: [{ text: 'b' }, { text: 'a' }] })).not.toBe(plain)
  })

  it('is the same across two separate provider instances', async () => {
    expect(await keyOf(ask)).toBe(await keyOf(ask))
  })

  it('ignores every cache flag, so flagged and unflagged requests are identical', async () => {
    const flagged = await run([okReply()], {
      ...ask,
      system: [{ text: 's', cache: true }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache: true }] }],
      cache: true,
    })
    const plain = await run([okReply()], { ...ask, system: [{ text: 's' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
    expect(bodyOf(flagged.transport)).toEqual(bodyOf(plain.transport))
    expect(JSON.stringify(bodyOf(flagged.transport))).not.toMatch(/cache_control|cache_breakpoint|"cache":/)
  })

  it('declares automatic caching with no explicit breakpoints', () => {
    const caps = capabilitiesOf(setup().provider)
    expect(caps.cache).toBe('automatic')
    expect(caps.maxCacheBreakpoints).toBeUndefined()
  })
})

describe('the key', () => {
  it('only ever appears in the Authorization header', async () => {
    const { transport } = await run([okReply()], { ...ask, system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
    const sent = transport.requests[0]
    expect(sent?.body).not.toContain(CONFORMANCE_API_KEY)
    expect(sent?.url).not.toContain(CONFORMANCE_API_KEY)
    const carriers = Object.entries(sent?.headers ?? {}).filter(([, value]) => value.includes(CONFORMANCE_API_KEY))
    expect(carriers.map(([name]) => name)).toEqual(['authorization'])
  })

  it('stays out of connection errors and of errors whose cause is the fetch failure', async () => {
    const leaky: FetchFn = async () => {
      throw new TypeError(`fetch failed for key ${CONFORMANCE_API_KEY}`)
    }
    const provider = new GrokProvider({ model: GROK_MODEL, apiKey: CONFORMANCE_API_KEY, fetch: leaky, sleep: async () => undefined, random: () => 0.5 })
    const error = (await provider.generate(ask).catch((caught: unknown) => caught)) as LlmError
    expect(error.kind).toBe('connection')
    expect(error.message).not.toContain(CONFORMANCE_API_KEY)
    expect(JSON.stringify(error)).not.toContain(CONFORMANCE_API_KEY)
  })
})

describe('streams survive realistic bodies', () => {
  it('reads a long reply of many deltas without keeping them', async () => {
    const events = [created(), ...Array.from({ length: 500 }, (_, index) => delta(`part ${index} `)), completed()]
    const { result } = await run([sseReply(events)])
    expect(result?.data).toEqual(CONFORMANCE_DATA)
  })

  it('reads the terminal event even when it is large', async () => {
    const big = JSON.stringify({ a: 1, filler: 'x'.repeat(2_000_000) })
    const { result } = await run([sseReply([created(), completed({ text: big })])])
    expect((result?.data as { filler: string }).filler).toHaveLength(2_000_000)
  })
})

describe('the data note and prices', () => {
  it('tells the user how long xAI keeps requests and that it does not train on them', () => {
    expect(capabilitiesOf(setup().provider).dataNote).toMatch(/30 days/)
    expect(capabilitiesOf(setup().provider).dataNote).toMatch(/not train/)
  })
})
