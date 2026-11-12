import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCRIPTORS, LlmError, MODEL_TABLE, createProvider, type LlmRequest } from '../src/index'
import { LIVE_CHECKS, MetaProvider, metaDescriptor, metaExchange } from '../src/meta'
import { META_MODELS } from '../src/meta/models'
import type { MetaProviderOptions } from '../src/meta/provider'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PDF_BASE64, PNG_BASE64 } from './conformance'
import { createFakeTransport, jsonReply, sseChunks, type FakeReply } from './fake-transport'
import { META_CHAT_URL, META_MAX_TOKENS, META_TEST_MODEL, NORMALISED_USAGE, RAW_USAGE, SYSTEM_KEY, chatChunks, chatReply, metaError, okReply, type MetaUsageFixture } from './meta-wire'

const KEY = CONFORMANCE_API_KEY
const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({ messages: [{ role: 'user', content: 'hi' }], schema: CONFORMANCE_SCHEMA, maxTokens: META_MAX_TOKENS, ...overrides })

function setup(replies: FakeReply[] = [okReply()], model = META_TEST_MODEL, extra: Partial<MetaProviderOptions> = {}) {
  const transport = createFakeTransport({ apiKey: KEY })
  const provider = new MetaProvider({ model, apiKey: KEY, fetch: transport.fetch, sleep: transport.sleep, random: transport.random, ...extra })
  transport.script(...replies)
  return { transport, provider }
}

const body = (transport: { requests: { json: unknown }[] }, index = 0) => transport.requests[index]?.json as Record<string, unknown>

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, 'the call should have failed').toBeInstanceOf(LlmError)
  return error as LlmError
}

const withUsage = (usage: MetaUsageFixture | null, finish: string | null = 'stop') => chatReply(JSON.stringify(CONFORMANCE_DATA), { usage, finish })
const usageOf = async (usage: MetaUsageFixture) => (await setup([withUsage(usage)]).provider.generate(request())).usage
const raw = (prompt: number, completion: number, details: Partial<MetaUsageFixture> = {}): MetaUsageFixture => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...details })

describe('model ids', () => {
  it.each(['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor', 'MUSE-SPARK-1.3-CONTRIBUTOR'])('refuses the contributor id %s and sends nothing', (model) => {
    const transport = createFakeTransport({ apiKey: KEY })
    const act = () => new MetaProvider({ model, apiKey: KEY, fetch: transport.fetch })
    expect(act).toThrow(LlmError)
    expect(act).toThrow(/trains on your content/)
    expect(transport.requests).toHaveLength(0)
  })

  it('refuses a model that is not in the table, and names the known ones', () => {
    const act = () => new MetaProvider({ model: 'muse-spark-1.30', apiKey: KEY })
    expect(act).toThrow(LlmError)
    expect(act).toThrow(/muse-wonder-1\.0, muse-spark-1\.3/)
  })

  it('accepts every model of the table and reports its own capabilities', () => {
    expect(META_MODELS.map((entry) => entry.id)).toEqual(['muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1', 'muse-ember-1.0'])
    for (const entry of META_MODELS) {
      const provider = new MetaProvider({ model: entry.id, apiKey: KEY })
      expect(provider.name).toBe('meta')
      expect(provider.model).toBe(entry.id)
      expect(provider.capabilities).toBe(entry.capabilities)
      expect(entry.capabilities.cache).toBe('automatic')
      expect(entry.capabilities.documents).toBe('native-pdf')
      expect(entry.capabilities.streaming).toBe('required')
    }
  })

  it('sends the model id of the table in the request body', async () => {
    for (const entry of META_MODELS) {
      const { transport, provider } = setup([okReply()], entry.id)
      await provider.generate(request())
      expect(body(transport)['model']).toBe(entry.id)
    }
  })
})

describe('reasoning effort', () => {
  const FULL = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } as const
  const CLAMPED = { ...FULL, max: 'xhigh' } as const
  const cases: [string, Record<string, string>, string][] = [
    ['muse-wonder-1.0', FULL, 'high'],
    ['muse-spark-1.3', FULL, 'high'],
    ['muse-spark-1.2', CLAMPED, 'high'],
    ['muse-spark-1.1', CLAMPED, 'high'],
    ['muse-ember-1.0', FULL, 'medium'],
  ]

  it.each(cases)('%s sends each level as the table says, max only where allowed, and a default when unset', async (model, expected, unset) => {
    for (const [level, native] of Object.entries(expected)) {
      const { transport, provider } = setup([okReply()], model)
      await provider.generate(request({ effort: level as 'low' }))
      expect(body(transport)['reasoning_effort'], `${model} ${level}`).toBe(native)
    }
    const { transport, provider } = setup([okReply()], model)
    await provider.generate(request())
    expect(body(transport)['reasoning_effort']).toBe(unset)
  })

  it('never sends none or minimal, for any model, level or default', async () => {
    const seen = new Set<unknown>()
    for (const entry of META_MODELS) {
      for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        const { transport, provider } = setup([okReply()], entry.id)
        await provider.generate(request(effort === undefined ? {} : { effort }))
        seen.add(body(transport)['reasoning_effort'])
      }
    }
    expect([...seen].sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh'])
  })

  it('declares the levels each model really takes', () => {
    const levels = (id: string) => META_MODELS.find((entry) => entry.id === id)?.capabilities.effortLevels
    expect(levels('muse-spark-1.3')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(levels('muse-spark-1.2')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(levels('muse-spark-1.1')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(levels('muse-ember-1.0')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('request shape', () => {
  it('sends only documented Chat Completions fields, always streaming, with the key in the authorization header', async () => {
    const { transport, provider } = setup()
    await provider.generate(request({ system: 'sys' }))
    const sent = transport.requests[0]
    expect(sent?.url).toBe(META_CHAT_URL)
    expect(Object.keys(sent?.json as object).sort()).toEqual(
      ['max_completion_tokens', 'messages', 'model', 'prompt_cache_key', 'reasoning_effort', 'response_format', 'stream', 'stream_options'].sort(),
    )
    expect(sent?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(sent?.headers['content-type']).toBe('application/json')
    expect(sent?.headers['accept']).toBe('text/event-stream')
    expect(Object.entries(sent?.headers ?? {}).filter(([, value]) => value.includes(KEY)).map(([name]) => name)).toEqual(['authorization'])
  })

  it('has no non-streaming path: every request streams and asks for usage, whatever the token budget', async () => {
    for (const maxTokens of [1, 100, 4000, 16_000, 100_000, 900_000]) {
      const { transport, provider } = setup()
      await provider.generate(request({ maxTokens }))
      expect(body(transport)).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxTokens })
    }
  })

  it('treats a JSON body for a streaming request as an unusable reply and does not retry it', async () => {
    const { transport, provider } = setup([jsonReply({ id: 'x', choices: [] })])
    const error = await failure(provider.generate(request()))
    expect(error.kind).toBe('invalid_output')
    expect(transport.requests).toHaveLength(1)
    expect(transport.openBodies()).toBe(0)
  })

  it('never sends sampling parameters, stop sequences, logprobs, storage flags or the other protocols fields', async () => {
    const { transport, provider } = setup()
    await provider.generate(request({ system: 'sys', effort: 'max' }))
    for (const field of ['temperature', 'top_p', 'top_k', 'logprobs', 'stop', 'n', 'store', 'max_tokens', 'max_output_tokens', 'text', 'input', 'instructions', 'tools', 'service_tier', 'prompt_cache_retention', 'background']) {
      expect(body(transport), field).not.toHaveProperty(field)
    }
  })

  it('uses the default budget of the provider unless the request says otherwise, and rejects a budget that cannot work', async () => {
    const plain = setup()
    await plain.provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema: CONFORMANCE_SCHEMA })
    expect(body(plain.transport)['max_completion_tokens']).toBe(16_000)
    const small = setup([okReply()], META_TEST_MODEL, { maxTokens: 2500 })
    await small.provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema: CONFORMANCE_SCHEMA })
    expect(body(small.transport)['max_completion_tokens']).toBe(2500)
    for (const maxTokens of [0, -5, 1.5, Number.NaN]) {
      const { transport, provider } = setup()
      expect((await failure(provider.generate(request({ maxTokens })))).kind).toBe('invalid_request')
      expect(transport.requests).toHaveLength(0)
    }
  })

  it('rejects more output tokens than the model documents, before any request', async () => {
    const ember = setup([okReply()], 'muse-ember-1.0')
    await ember.provider.generate(request({ maxTokens: 524_288 }))
    const { transport, provider } = setup([okReply()], 'muse-ember-1.0')
    const error = await failure(provider.generate(request({ maxTokens: 524_289 })))
    expect(error.kind).toBe('invalid_request')
    expect(error.message).toContain('524288')
    expect(transport.requests).toHaveLength(0)
    const spark = setup()
    await spark.provider.generate(request({ maxTokens: 900_000 }))
  })

  it('posts to a custom base URL with or without trailing slashes', async () => {
    for (const baseURL of ['http://meta.test/v1', 'http://meta.test/v1/', 'http://meta.test/v1//']) {
      const { transport, provider } = setup([okReply()], META_TEST_MODEL, { baseURL })
      await provider.generate(request())
      expect(transport.requests[0]?.url).toBe('http://meta.test/v1/chat/completions')
    }
  })

  it('puts all system blocks into one developer message in front, joined by a blank line, and omits it when there is no text', async () => {
    const withBlocks = setup()
    await withBlocks.provider.generate(request({ system: [{ text: 'one', cache: true }, { text: '' }, { text: 'two' }] }))
    expect((body(withBlocks.transport)['messages'] as unknown[])[0]).toEqual({ role: 'developer', content: 'one\n\ntwo' })
    for (const system of [undefined, '', [], [{ text: '' }]]) {
      const { transport, provider } = setup()
      await provider.generate(request(system === undefined ? {} : { system }))
      const sent = body(transport)
      expect((sent['messages'] as { role: string }[]).map((message) => message.role)).toEqual(['user'])
      expect(sent).not.toHaveProperty('prompt_cache_key')
    }
  })

  it('sends the schema unchanged as a non-strict json_schema with a fixed name', async () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { anyOf: [{ type: 'number' }, { type: 'null' }] } }, required: ['a'] }
    const { transport, provider } = setup()
    await provider.generate(request({ schema }))
    expect(body(transport)['response_format']).toEqual({ type: 'json_schema', json_schema: { name: 'rill_output', strict: false, schema } })
  })

  it('numbers the PDF files of one request in order and drops cache flags from parts', async () => {
    const onePage = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF').toString('base64')
    const { transport, provider } = setup()
    await provider.generate(
      request({
        messages: [
          { role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: onePage, cache: true }, { type: 'text', text: 'a', cache: true }] },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: onePage }] },
        ],
      }),
    )
    const messages = body(transport)['messages'] as { content: unknown }[]
    const names = JSON.stringify(messages).match(/document-\d+\.pdf/g)
    expect(names).toEqual(['document-1.pdf', 'document-2.pdf'])
    expect(JSON.stringify(messages)).not.toContain('cache')
  })

  it('replays assistant text parts as one string and refuses anything but text from the assistant', async () => {
    const ok = setup()
    await ok.provider.generate(
      request({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          { role: 'user', content: 'q2' },
        ],
      }),
    )
    expect((body(ok.transport)['messages'] as unknown[])[1]).toEqual({ role: 'assistant', content: 'ab' })
    const bad = setup()
    const error = await failure(
      bad.provider.generate(
        request({
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }] },
            { role: 'user', content: 'q2' },
          ],
        }),
      ),
    )
    expect(error.kind).toBe('invalid_request')
    expect(bad.transport.requests).toHaveLength(0)
  })

  it('refuses a request that ends on an assistant turn or has no messages', async () => {
    for (const messages of [[], [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]] as LlmRequest['messages'][]) {
      const { transport, provider } = setup()
      expect((await failure(provider.generate(request({ messages })))).kind).toBe('invalid_request')
      expect(transport.requests).toHaveLength(0)
    }
  })
})

describe('prompt cache key', () => {
  it('is the same for the same system text whatever the user says, and has no readable text in it', async () => {
    const keys: unknown[] = []
    for (const user of ['first question', 'a completely different second question']) {
      const { transport, provider } = setup()
      await provider.generate(request({ system: 'You are a test system.', messages: [{ role: 'user', content: user }] }))
      keys.push(body(transport)['prompt_cache_key'])
    }
    expect(keys[0]).toBe(SYSTEM_KEY)
    expect(keys[1]).toBe(keys[0])
    expect(String(keys[0])).toMatch(/^rill-[0-9a-f]{16}$/)
    expect(String(keys[0])).not.toMatch(/test|system|question/)
  })

  it('differs when the system text differs, and does not depend on how the text is split into blocks of cache flags', async () => {
    const key = async (system: LlmRequest['system']) => {
      const { transport, provider } = setup()
      await provider.generate(request({ system }))
      return body(transport)['prompt_cache_key']
    }
    expect(await key('alpha')).not.toBe(await key('beta'))
    expect(await key([{ text: 'alpha', cache: true }])).toBe(await key('alpha'))
    expect(await key([{ text: 'a' }, { text: 'b' }])).toBe(await key('a\n\nb'))
  })
})

describe('schema limits before any request', () => {
  const nested = (depth: number): Record<string, unknown> => (depth === 0 ? { type: 'string' } : { type: 'object', properties: { next: nested(depth - 1) }, required: ['next'] })
  const refused = async (schema: Record<string, unknown>) => {
    const { transport, provider } = setup()
    const error = await failure(provider.generate(request({ schema })))
    expect(error.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
    return error
  }

  it('refuses a recursive schema and names where it recurses', async () => {
    const error = await refused({ type: 'object', properties: { child: { $ref: '#/$defs/node' } }, $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } } })
    expect(error.message).toMatch(/recursive/)
    expect(error.message).toContain('#/$defs/node')
  })

  it('allows objects nested ten deep and refuses eleven', async () => {
    const ok = setup()
    await ok.provider.generate(request({ schema: nested(10) }))
    const error = await refused(nested(11))
    expect(error.message).toMatch(/depth limit of 10/)
  })

  it('refuses too many properties, too many characters and too many enum values', async () => {
    const properties = Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`p${index}`, { type: 'string' }]))
    expect((await refused({ type: 'object', properties })).message).toMatch(/more than 5000 properties/)
    expect((await refused({ type: 'object', properties: { x: { type: 'string', enum: ['a'.repeat(120_001)] } } })).message).toMatch(/120000 characters/)
    expect((await refused({ type: 'object', properties: { x: { type: 'string', enum: Array.from({ length: 1001 }, (_, index) => `v${index}`) } } })).message).toMatch(/1000 enum values/)
  })

  it('sends the shape of a planner schema as it is, with optional properties and unions', async () => {
    const node = {
      type: 'object',
      properties: { id: { type: 'string' }, type: { type: 'string', enum: ['a', 'b'] }, config: { type: 'string' }, retry: { type: 'object', properties: { times: { type: 'integer' } }, required: ['times'] } },
      required: ['id', 'type', 'config'],
    }
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['workflow', 'questions'] },
        workflow: { type: 'object', properties: { nodes: { type: 'array', items: node }, edges: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' } }, required: ['from'] } } }, required: ['nodes', 'edges'] },
        pick: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['kind'],
    }
    const { transport, provider } = setup()
    await provider.generate(request({ schema }))
    expect((body(transport)['response_format'] as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(schema)
  })
})

describe('attachments', () => {
  const image = { type: 'image', mediaType: 'image/png', data: PNG_BASE64 } as const
  const pdf = (data: string) => ({ type: 'document', mediaType: 'application/pdf', data }) as const
  const pdfWithPages = (pages: number) =>
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n${Array.from({ length: pages }, (_, index) => `${index + 2} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`).join('')}%%EOF`).toString('base64')
  const send = (parts: LlmRequest['messages'][number]['content']) => {
    const { transport, provider } = setup()
    return { transport, outcome: provider.generate(request({ messages: [{ role: 'user', content: parts }] })) }
  }

  it('accepts exactly 50 images and refuses 51 with the counts in the message', async () => {
    const ok = send([...Array.from({ length: 50 }, () => image)])
    await ok.outcome
    expect(ok.transport.requests).toHaveLength(1)
    const over = send([...Array.from({ length: 51 }, () => image), { type: 'text', text: 'x' }])
    const error = await failure(over.outcome)
    expect(error.kind).toBe('invalid_request')
    expect(error.message).toContain('51')
    expect(error.message).toContain('50')
    expect(over.transport.requests).toHaveLength(0)
  })

  it('counts the page images of a PDF toward the same limit, page by page', async () => {
    const fits = send([pdf(pdfWithPages(3)), ...Array.from({ length: 47 }, () => image)])
    await fits.outcome
    expect(fits.transport.requests).toHaveLength(1)
    const over = send([pdf(pdfWithPages(3)), ...Array.from({ length: 48 }, () => image)])
    const error = await failure(over.outcome)
    expect(error.message).toMatch(/51 images/)
    expect(error.message).toMatch(/48 attached image\(s\) plus up to 3 page images from 1 PDF file/)
    expect(over.transport.requests).toHaveLength(0)
  })

  it('counts at most the first 50 pages of each PDF and adds up several files', async () => {
    const long = send([pdf(pdfWithPages(400)), image])
    const error = await failure(long.outcome)
    expect(error.message).toMatch(/1 attached image\(s\) plus up to 50 page images/)
    const two = send([pdf(pdfWithPages(30)), pdf(pdfWithPages(21))])
    expect((await failure(two.outcome)).message).toMatch(/51 images/)
    const alone = send([pdf(pdfWithPages(400))])
    await alone.outcome
    expect(alone.transport.requests).toHaveLength(1)
  })

  it('treats a PDF whose pages cannot be counted as the largest case the cap allows', async () => {
    const alone = send([pdf(PDF_BASE64)])
    await alone.outcome
    const withImage = send([pdf(PDF_BASE64), image])
    expect((await failure(withImage.outcome)).message).toMatch(/51 images/)
    expect(withImage.transport.requests).toHaveLength(0)
  })

  it('leaves the file content out of the refusal', async () => {
    const over = send([pdf(pdfWithPages(60)), image])
    const error = await failure(over.outcome)
    expect(error.message).not.toContain(PNG_BASE64)
    expect(error.message).not.toContain(PDF_BASE64)
    expect(error.message.length).toBeLessThan(400)
  })

  it('refuses attachments above 50 million bytes in total, before any request, and accepts exactly 50 million', async () => {
    const big = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4)
    const exact = send([{ type: 'image', mediaType: 'image/png', data: big(49_999_998) }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }])
    await exact.outcome
    expect(exact.transport.requests).toHaveLength(1)
    const over = send([{ type: 'image', mediaType: 'image/png', data: big(30_000_000) }, { type: 'image', mediaType: 'image/jpeg', data: big(20_000_001) }])
    const error = await failure(over.outcome)
    expect(error.kind).toBe('invalid_request')
    expect(error.message).toMatch(/50000001 bytes.*50000000 bytes/)
    expect(over.transport.requests).toHaveLength(0)
    const pdfOver = send([{ type: 'document', mediaType: 'application/pdf', data: big(50_000_001) }])
    expect((await failure(pdfOver.outcome)).message).toMatch(/50000001 bytes/)
  })

  it('sends every image type Meta takes', async () => {
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      const { transport, provider } = setup()
      await provider.generate(request({ messages: [{ role: 'user', content: [{ type: 'image', mediaType, data: PNG_BASE64 }] }] }))
      expect(JSON.stringify(body(transport)['messages'])).toContain(`data:${mediaType};base64,`)
    }
  })
})

describe('usage', () => {
  it('subtracts cached tokens from the input and reports them as cache reads, never as writes', async () => {
    expect(await usageOf(raw(1000, 400, { prompt_tokens_details: { cached_tokens: 300 } }))).toEqual({ inputTokens: 700, outputTokens: 400, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 })
    expect(await usageOf(raw(1000, 400, { prompt_tokens_details: { cached_tokens: 1000 } }))).toEqual({ inputTokens: 0, outputTokens: 400, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 })
  })

  it('takes missing or null detail objects and counts as zero', async () => {
    const plain = { inputTokens: 1000, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    expect(await usageOf(raw(1000, 400))).toEqual(plain)
    expect(await usageOf(raw(1000, 400, { prompt_tokens_details: {}, completion_tokens_details: {} }))).toEqual(plain)
    expect(await usageOf(raw(1000, 400, { prompt_tokens_details: { cached_tokens: null }, completion_tokens_details: { reasoning_tokens: null } }))).toEqual(plain)
  })

  it('reads completion tokens as the whole output, reasoning included, and never adds the reasoning on top', async () => {
    expect((await usageOf(raw(1000, 650, { completion_tokens_details: { reasoning_tokens: 250 } }))).outputTokens).toBe(650)
    expect((await usageOf(raw(1000, 650, { completion_tokens_details: { reasoning_tokens: 650 } }))).outputTokens).toBe(650)
  })

  it('raises the output to the reasoning tokens when those are larger than the completion tokens', async () => {
    expect((await usageOf(raw(1000, 100, { completion_tokens_details: { reasoning_tokens: 400 } }))).outputTokens).toBe(400)
  })

  it('matches the fixture of the wire module exactly', async () => {
    expect(await usageOf(RAW_USAGE)).toEqual(NORMALISED_USAGE)
  })

  it.each([
    ['more cached tokens than prompt tokens', raw(100, 10, { prompt_tokens_details: { cached_tokens: 101 } })],
    ['negative prompt tokens', raw(-1, 10)],
    ['fractional completion tokens', raw(10, 1.5)],
    ['a string count', { prompt_tokens: '10', completion_tokens: 10 } as unknown as MetaUsageFixture],
    ['an invalid cached count', raw(10, 10, { prompt_tokens_details: { cached_tokens: -2 } })],
    ['an invalid reasoning count', raw(10, 10, { completion_tokens_details: { reasoning_tokens: 'x' as unknown as number } })],
    ['no completion tokens', { prompt_tokens: 10 } as unknown as MetaUsageFixture],
  ])('refuses %s as an unusable reply and does not retry', async (_name, usage) => {
    const { transport, provider } = setup([withUsage(usage)])
    const error = await failure(provider.generate(request()))
    expect(error.kind).toBe('invalid_output')
    expect(error.message).toMatch(/usable token usage/)
    expect(transport.requests).toHaveLength(1)
  })

  it('refuses a reply that never reports usage, but still reports a cut-off or refused reply as such', async () => {
    const none = await failure(setup([withUsage(null)]).provider.generate(request()))
    expect(none.kind).toBe('invalid_output')
    expect(none.message).toMatch(/no usage/)
    expect(none.usage).toBeUndefined()
    const cut = await failure(setup([withUsage(null, 'length')]).provider.generate(request()))
    expect(cut.kind).toBe('truncated')
    expect(cut.usage).toBeUndefined()
    expect(cut.model).toBe(META_TEST_MODEL)
  })

  it('accepts usage in the same chunk as the finish reason and ignores null usage on earlier chunks', async () => {
    const events = [
      { data: { model: META_TEST_MODEL, choices: [{ index: 0, delta: { content: '{"a":1}' }, finish_reason: null }], usage: null } },
      { data: { model: META_TEST_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: RAW_USAGE } },
      { data: '[DONE]' },
    ]
    const result = await setup([{ kind: 'sse', chunks: sseChunks(events) }]).provider.generate(request())
    expect(result.usage).toEqual(NORMALISED_USAGE)
    expect(result.data).toEqual(CONFORMANCE_DATA)
  })
})

describe('stop reasons and replies', () => {
  const kindOf = async (reply: FakeReply) => failure(setup([reply]).provider.generate(request()))

  it('reports a cut-off reply as truncated even when the text happens to be complete JSON', async () => {
    const error = await kindOf(chatReply(JSON.stringify(CONFORMANCE_DATA), { finish: 'length' }))
    expect(error.kind).toBe('truncated')
    expect(error.message).toMatch(/reasoning counts toward maxTokens/)
    expect(error.usage).toEqual(NORMALISED_USAGE)
    expect(error.model).toBe(META_TEST_MODEL)
  })

  it('reports the content filter and a refusal text as refusals with the billed usage', async () => {
    const filtered = await kindOf(chatReply('', { finish: 'content_filter' }))
    expect(filtered).toMatchObject({ kind: 'refusal', category: 'content_filter' })
    expect(filtered.usage).toEqual(NORMALISED_USAGE)
    const refused = await kindOf(chatReply('', { refusal: 'I cannot help with that.' }))
    expect(refused).toMatchObject({ kind: 'refusal', category: 'refusal' })
    expect(refused.usage).toEqual(NORMALISED_USAGE)
    expect(refused.message).not.toContain('cannot help')
  })

  it('reports a tool call as an unusable reply', async () => {
    for (const finish of ['tool_calls', 'function_call']) {
      const error = await kindOf(chatReply('', { finish }))
      expect(error.kind).toBe('invalid_output')
      expect(error.message).toMatch(/tool call/)
      expect(error.usage).toEqual(NORMALISED_USAGE)
    }
  })

  it('reports an empty reply and text that is not JSON as unusable, with the usage that was billed', async () => {
    const empty = await kindOf(chatReply('', { finish: 'stop' }))
    expect(empty).toMatchObject({ kind: 'invalid_output' })
    expect(empty.message).toMatch(/no text/)
    expect(empty.usage).toEqual(NORMALISED_USAGE)
    const text = await kindOf(chatReply('{"a":', { finish: 'stop' }))
    expect(text.kind).toBe('invalid_output')
    expect(text.message).toMatch(/not valid JSON/)
    expect(text.cause).toBeInstanceOf(SyntaxError)
    expect(text.usage).toEqual(NORMALISED_USAGE)
  })

  it('keeps an unknown finish reason as the stop reason when the text is valid JSON', async () => {
    const result = await setup([chatReply(JSON.stringify(CONFORMANCE_DATA), { finish: 'end_turn' })]).provider.generate(request())
    expect(result).toMatchObject({ stopReason: 'end_turn', data: CONFORMANCE_DATA })
  })

  it('reports the model that served the reply, falls back to the requested one, and joins the deltas', async () => {
    const served = await setup([chatReply('{"a":1}', { model: 'muse-spark-1.3-20261001' })]).provider.generate(request())
    expect(served).toMatchObject({ model: 'muse-spark-1.3-20261001', requestedModel: META_TEST_MODEL, fallbackUsed: false })
    const events = [
      { data: { choices: [{ index: 0, delta: { content: '{"a"' }, finish_reason: null }] } },
      { data: { choices: [{ index: 0, delta: { content: ':1}' }, finish_reason: null }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { choices: [], usage: RAW_USAGE } },
    ]
    const bare = await setup([{ kind: 'sse', chunks: sseChunks(events) }]).provider.generate(request())
    expect(bare).toMatchObject({ model: META_TEST_MODEL, data: { a: 1 } })
  })

  it('ignores reasoning deltas, other choices, comments and empty chunks, and survives events cut at any byte', async () => {
    const events = [
      { data: { model: META_TEST_MODEL, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking' }, finish_reason: null }] } },
      { data: { model: META_TEST_MODEL, choices: [{ index: 1, delta: { content: 'WRONG' }, finish_reason: 'stop' }] } },
      { data: { model: META_TEST_MODEL, choices: [{ index: 0, delta: { content: '{"a":1}' }, finish_reason: null }] } },
      { data: { model: META_TEST_MODEL, choices: [] } },
      { data: { model: META_TEST_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { model: META_TEST_MODEL, choices: [], usage: RAW_USAGE } },
      { data: '[DONE]' },
    ]
    const wire = `: keep-alive\n\n${sseChunks(events).join('')}`
    const pieces = wire.match(/[\s\S]{1,7}/g) ?? []
    const { transport, provider } = setup([{ kind: 'sse', chunks: pieces }])
    const result = await provider.generate(request())
    expect(result.data).toEqual(CONFORMANCE_DATA)
    expect(result.usage).toEqual(NORMALISED_USAGE)
    expect(transport.openBodies()).toBe(0)
  })

  it('treats a stream that ends before any finish reason as a dropped connection, without retrying', async () => {
    const events = chatChunks('{"a":', { finish: null, usage: null })
    const { transport, provider } = setup([{ kind: 'sse', chunks: sseChunks(events) }, okReply()])
    const error = await failure(provider.generate(request()))
    expect(error.kind).toBe('connection')
    expect(transport.requests).toHaveLength(1)
    expect(transport.sleeps).toEqual([])
  })

  it('treats an event that is not JSON as an unusable reply', async () => {
    const { transport, provider } = setup([{ kind: 'sse', chunks: ['data: {not json\n\n'] }, okReply()])
    const error = await failure(provider.generate(request()))
    expect(error.kind).toBe('invalid_output')
    expect(transport.requests).toHaveLength(1)
  })
})

describe('errors inside the stream', () => {
  const error = (data: unknown, event?: string) => ({ kind: 'sse', chunks: sseChunks([...chatChunks('{"a":', { finish: null, usage: null, done: false }).slice(0, 2), { ...(event === undefined ? {} : { event }), data }]), then: 'end' }) as FakeReply

  it.each([
    ['an error event with an overloaded code', { error: { message: 'busy', type: 'server_error', code: 'service_overloaded' } }, 'error', 'overloaded'],
    ['an error object in a plain chunk', { error: { message: 'busy', type: 'server_error', code: 'backend_unavailable' } }, undefined, 'overloaded'],
    ['a shutting down notice', { error: { message: 'bye', type: 'server_error', code: 'server_shutting_down' } }, 'error', 'overloaded'],
    ['a rate limit', { error: { message: 'slow', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, 'error', 'rate_limit'],
    ['an authentication failure', { error: { message: 'no', type: 'authentication_error', code: 'invalid_api_key' } }, 'error', 'auth'],
    ['a content policy violation', { error: { message: 'no', type: 'invalid_request_error', code: 'content_policy_violation' } }, 'error', 'refusal'],
    ['an invalid request', { error: { message: 'bad', type: 'invalid_request_error', code: null } }, 'error', 'invalid_request'],
    ['a failed response event', { message: 'failed', type: 'server_error' }, 'response.failed', 'overloaded'],
    ['an error of a shape nobody documented', { oops: true }, 'error', 'connection'],
    ['an error event that is not JSON', 'upstream reset', 'error', 'connection'],
    ['an error that is only a string', { error: 'upstream reset' }, undefined, 'connection'],
  ])('maps %s to %s and does not retry, since output had started', async (_name, data, event, kind) => {
    const { transport, provider } = setup([error(data, event), okReply()])
    const failed = await failure(provider.generate(request()))
    expect(failed.kind).toBe(kind)
    expect(transport.requests).toHaveLength(1)
    expect(transport.sleeps).toEqual([])
    expect(transport.openBodies()).toBe(0)
  })

  it('keeps the text of an error that comes as a plain string', async () => {
    const failed = await failure(setup([error({ error: 'upstream reset by peer' })]).provider.generate(request()))
    expect(failed.message).toContain('upstream reset by peer')
  })

  it('names the error code and the vendor message, and never the key', async () => {
    const failed = await failure(
      setup([error({ error: { message: `busy for ${KEY} and Bearer abcdefghij123456`, type: 'server_error', code: 'service_overloaded' } }, 'error')]).provider.generate(request()),
    )
    expect(failed.message).toContain('service_overloaded')
    expect(failed.message).toContain('busy for')
    expect(failed.message).not.toContain(KEY)
    expect(failed.message).not.toContain('abcdefghij123456')
    expect(failed.category).toBe('service_overloaded')
    expect(JSON.stringify(failed)).not.toContain(KEY)
  })

  it('does not retry an error event that is the very first event either, because output has started', async () => {
    const first = { kind: 'sse', chunks: sseChunks([{ event: 'error', data: { error: { message: 'busy', type: 'server_error', code: 'service_overloaded' } } }]) } as FakeReply
    const { transport, provider } = setup([first, okReply()])
    expect((await failure(provider.generate(request()))).kind).toBe('overloaded')
    expect(transport.requests).toHaveLength(1)
  })
})

describe('http errors', () => {
  const send = (reply: FakeReply) => {
    const { transport, provider } = setup([reply])
    return { transport, outcome: failure(provider.generate(request())) }
  }

  it.each([
    [401, 'authentication_error', 'invalid_api_key', 'auth', 1],
    [402, 'billing_error', 'billing_not_configured', 'auth', 1],
    [403, 'permission_error', null, 'auth', 1],
    [404, 'invalid_request_error', 'model_not_found', 'invalid_request', 1],
    [400, 'invalid_request_error', null, 'invalid_request', 1],
    [413, 'invalid_request_error', 'payload_too_large', 'invalid_request', 1],
    [400, 'invalid_request_error', 'content_policy_violation', 'refusal', 1],
    [429, 'rate_limit_error', 'rate_limit_exceeded', 'rate_limit', 3],
    [503, 'server_error', 'service_overloaded', 'overloaded', 3],
    [503, 'server_error', 'backend_unavailable', 'overloaded', 3],
    [503, 'server_error', 'server_shutting_down', 'overloaded', 3],
    [500, 'server_error', null, 'overloaded', 3],
    [504, 'server_error', 'gateway_timeout', 'timeout', 1],
  ])('maps %i %s %s to %s with %i request(s)', async (status, type, code, kind, requests) => {
    const { transport, outcome } = send(metaError(status, `vendor says ${status}`, type, code))
    const error = await outcome
    expect(error.kind).toBe(kind)
    expect(error.status).toBe(status)
    expect(transport.requests).toHaveLength(requests)
    expect(transport.openBodies()).toBe(0)
  })

  it('explains a 402 as a billing problem and a 403 as access or region, keeping the vendor message', async () => {
    const billing = await send(metaError(402, 'add a card', 'billing_error', 'billing_not_configured')).outcome
    expect(billing.message).toMatch(/billing or credit/)
    const forbidden = await send(metaError(403, 'model not enabled', 'permission_error', null)).outcome
    expect(forbidden.message).toMatch(/model not enabled/)
    expect(forbidden.message).toMatch(/may not include this model, or the model is not offered in your region/)
    expect(forbidden.status).toBe(403)
    const bare = await send({ kind: 'text', status: 403, body: '' }).outcome
    expect(bare.kind).toBe('auth')
    expect(bare.message).toMatch(/not offered in your region/)
  })

  it('reads the context length message as a context overflow', async () => {
    const error = await send(metaError(400, "This request has 1200000 tokens, but the model's context length is only 1048576 tokens", 'invalid_request_error', null)).outcome
    expect(error).toMatchObject({ kind: 'invalid_request', category: 'context_too_long' })
  })

  it('keeps the request id and reads error bodies that are not JSON, an empty 404 and HTML', async () => {
    const withId = await send(metaError(400, 'bad', 'invalid_request_error', null, { 'x-request-id': 'req-42' })).outcome
    expect(withId.requestId).toBe('req-42')
    const empty = await send({ kind: 'text', status: 404, body: '' }).outcome
    expect(empty).toMatchObject({ kind: 'invalid_request', status: 404 })
    const html = await send({ kind: 'text', status: 502, body: '<html>bad gateway</html>' }).outcome
    expect(html).toMatchObject({ kind: 'overloaded', status: 502 })
  })

  it('caps a long retry-after at one minute and still adds jitter above it', async () => {
    const { transport, provider } = setup([metaError(503, 'busy', 'server_error', 'backend_unavailable', { 'retry-after': '600' }), okReply()])
    await provider.generate(request())
    expect(transport.sleeps).toHaveLength(1)
    expect(transport.sleeps[0]).toBeGreaterThanOrEqual(60_000)
    expect(transport.sleeps[0]).toBeLessThanOrEqual(60_250)
  })

  it('waits with the jittered backoff of the shared helper, from the injected random source', async () => {
    for (const [random, expected] of [[0, [250, 500]], [1, [500, 1000]]] as const) {
      const transport = createFakeTransport({ apiKey: KEY })
      transport.script(metaError(503, 'busy', 'server_error', 'service_overloaded'))
      const provider = new MetaProvider({ model: META_TEST_MODEL, apiKey: KEY, fetch: transport.fetch, sleep: transport.sleep, random: () => random })
      await failure(provider.generate(request()))
      expect(transport.sleeps).toEqual(expected)
    }
  })

  it('ends a wait between retries with a timeout when the deadline passes, and with a cancel when the caller aborts', async () => {
    const stuck = () => new Promise<void>(() => undefined)
    const slow = createFakeTransport({ apiKey: KEY })
    slow.script(metaError(503, 'busy', 'server_error', 'service_overloaded'), okReply())
    const late = new MetaProvider({ model: META_TEST_MODEL, apiKey: KEY, fetch: slow.fetch, sleep: stuck, random: () => 0 })
    const expired = await failure(late.generate(request(), { timeoutMs: 600 }))
    expect(expired.kind).toBe('timeout')
    expect(slow.requests).toHaveLength(1)
    const quick = createFakeTransport({ apiKey: KEY })
    quick.script(metaError(503, 'busy', 'server_error', 'service_overloaded'), okReply())
    const cancelled = new MetaProvider({ model: META_TEST_MODEL, apiKey: KEY, fetch: quick.fetch, sleep: stuck })
    const controller = new AbortController()
    const pending = failure(cancelled.generate(request(), { signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    expect((await pending).kind).toBe('aborted')
    expect(quick.requests).toHaveLength(1)
  })

  it('does not retry a 504, since the vendor says to stream or shrink the request instead', async () => {
    const { transport, outcome } = send(metaError(504, 'too slow', 'server_error', 'gateway_timeout'))
    expect((await outcome).kind).toBe('timeout')
    expect(transport.sleeps).toEqual([])
  })

  it('never puts the key in an error, whatever the status, and hides key shaped strings the vendor echoes', async () => {
    for (const status of [400, 401, 402, 403, 404, 413, 429, 500, 503, 504]) {
      const error = await send(metaError(status, `echo ${KEY} and LLM_abcdefghijklmnopqrstuv1234 and Bearer ${KEY}`, 'server_error', 'x')).outcome
      const text = `${error.message}\n${JSON.stringify(error)}`
      expect(text, String(status)).not.toContain(KEY)
      expect(text, String(status)).not.toContain('abcdefghijklmnopqrstuv1234')
    }
    const plain = await send({ kind: 'text', status: 500, body: `upstream said ${KEY}` }).outcome
    expect(plain.message).not.toContain(KEY)
  })

  it('sends the key only in the authorization header, also on a retry', async () => {
    const { transport, provider } = setup([metaError(503, 'busy', 'server_error', 'service_overloaded'), okReply()])
    await provider.generate(request({ system: 'sys' }))
    for (const sent of transport.requests) {
      expect(sent.body).not.toContain(KEY)
      expect(sent.url).not.toContain(KEY)
      expect(sent.headers['authorization']).toBe(`Bearer ${KEY}`)
    }
  })
})

describe('descriptor', () => {
  it('is the meta entry of the default registry, with its key variable, label, models and live checks', () => {
    expect(DEFAULT_DESCRIPTORS).toContain(metaDescriptor)
    expect(metaDescriptor).toMatchObject({ id: 'meta', label: 'Meta (Muse)', keyEnv: 'META_API_KEY', models: META_MODELS, liveChecks: LIVE_CHECKS, exchange: metaExchange })
    expect(MODEL_TABLE.filter((entry) => entry.provider === 'meta')).toEqual([...META_MODELS])
  })

  it('creates a provider that uses the injected fetch, sleep and random, and ignores an SDK client', async () => {
    const transport = createFakeTransport({ apiKey: KEY })
    transport.script(metaError(503, 'busy', 'server_error', 'service_overloaded'), okReply())
    const provider = createProvider('meta:muse-ember-1.0', { env: { META_API_KEY: KEY }, fetch: transport.fetch, sleep: transport.sleep, random: transport.random, client: { unused: true }, baseURL: 'http://meta.test/v1' })
    expect(provider).toBeInstanceOf(MetaProvider)
    const result = await provider.generate(request())
    expect(result.requestedModel).toBe('muse-ember-1.0')
    expect(transport.requests.map((sent) => sent.url)).toEqual(['http://meta.test/v1/chat/completions', 'http://meta.test/v1/chat/completions'])
    expect(transport.sleeps).toHaveLength(1)
  })

  it('refuses contributor ids and unknown models, and names the key variable when it is missing', () => {
    expect(() => createProvider('meta:muse-spark-1.3-contributor', { env: { META_API_KEY: KEY } })).toThrow(/trains on your content/)
    expect(() => createProvider('meta:muse-spark-9', { env: { META_API_KEY: KEY } })).toThrow(/unknown model/)
    expect(() => createProvider('meta:muse-spark-1.3', { env: {} })).toThrow(/META_API_KEY/)
  })

  it('lists the live checks the plan names, each once with a plain sentence', () => {
    const ids = LIVE_CHECKS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['completion-tokens-include-reasoning', 'schema-with-reasoning-pdf-and-streaming', 'cache-minimum-and-ttl', 'max-output-spark-and-wonder', 'regional-availability']) {
      expect(ids).toContain(id)
    }
    for (const entry of LIVE_CHECKS) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/)
      expect(entry.what.length).toBeGreaterThan(40)
      expect(entry.what).not.toContain('—')
    }
  })
})
