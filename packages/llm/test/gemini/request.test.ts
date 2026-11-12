import { describe, expect, it } from 'vitest'
import { CONFORMANCE_DATA, CONFORMANCE_SCHEMA, PDF_BASE64, PNG_BASE64 } from '../conformance'
import { GeminiProvider } from '../../src/gemini'
import { buildRequest } from '../../src/gemini/request'
import { LlmError, capabilitiesOf, geminiDescriptor, modelCapabilities, type ImageMediaType, type LlmRequest } from '../../src/index'
import { GEMINI_MODEL, geminiSetup } from './wire'

const base = { schema: CONFORMANCE_SCHEMA, maxTokens: 20_000 }
const user = (content: LlmRequest['messages'][number]['content']): LlmRequest['messages'] => [{ role: 'user', content }]
const build = (request: LlmRequest) => buildRequest(GEMINI_MODEL, modelCapabilities(geminiDescriptor.models, GEMINI_MODEL), request, 32_768)

async function sent(request: LlmRequest, model?: string): Promise<Record<string, unknown>> {
  const { transport, provider } = geminiSetup(undefined, model)
  const result = await provider.generate(request)
  expect(result.data).toEqual(CONFORMANCE_DATA)
  return transport.requests[0]?.json as Record<string, unknown>
}

async function refused(request: LlmRequest): Promise<{ error: LlmError; requests: number }> {
  const { transport, provider } = geminiSetup()
  const error = await provider.generate(request).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LlmError)
  return { error: error as LlmError, requests: transport.requests.length }
}

describe('Gemini request: a capability record that reads no PDF', () => {
  it('refuses a PDF before building anything', () => {
    const none = { ...modelCapabilities(geminiDescriptor.models, GEMINI_MODEL), documents: 'none' as const }
    const pdf: LlmRequest = { ...base, messages: user([{ type: 'document', mediaType: 'application/pdf', data: PDF_BASE64 }]) }
    expect(() => buildRequest(GEMINI_MODEL, none, pdf, 32_768)).toThrow('does not read PDF')
  })
})

describe('Gemini request body', () => {
  it('always streams and never stores, whatever the request carries', async () => {
    const requests: LlmRequest[] = [
      { ...base, messages: user('hello') },
      { ...base, messages: user([{ type: 'document', mediaType: 'application/pdf', data: PDF_BASE64 }]) },
      { ...base, messages: user([{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }]), effort: 'high' },
      { ...base, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], cache: true },
    ]
    for (const request of requests) {
      const body = await sent(request)
      expect(body.store).toBe(false)
      expect(body.stream).toBe(true)
    }
  })

  it('sends only documented fields and none of the sampling or summary knobs', async () => {
    const body = await sent({ ...base, system: 'sys', messages: user('hello'), effort: 'medium' })
    expect(Object.keys(body).sort()).toEqual(['generation_config', 'input', 'model', 'response_format', 'store', 'stream', 'system_instruction'])
    expect(Object.keys(body.generation_config as object).sort()).toEqual(['max_output_tokens', 'thinking_level'])
    const text = JSON.stringify(body)
    for (const banned of ['temperature', 'top_p', 'top_k', 'candidate_count', 'thinking_summaries', 'previous_interaction_id', 'background', 'tools']) {
      expect(text, banned).not.toContain(`"${banned}"`)
    }
  })

  it('sends the key in a header and never in the URL or the body', async () => {
    const { transport, provider } = geminiSetup()
    await provider.generate({ ...base, messages: user('hello') })
    const [request] = transport.requests
    expect(request?.headers['x-goog-api-key']).toBe(transport.apiKey)
    expect(request?.url).not.toContain(transport.apiKey)
    expect(request?.body).not.toContain(transport.apiKey)
  })

  it('hands the injected fetch a plain URL string and an init with a string body', async () => {
    const { transport } = geminiSetup()
    let seen: { input: unknown; body: unknown } | undefined
    const inner = transport.fetch
    const provider = new GeminiProvider({
      model: GEMINI_MODEL,
      apiKey: transport.apiKey,
      fetch: (input, init) => {
        seen = { input, body: init?.body }
        return inner(input, init)
      },
      sleep: transport.sleep,
      random: transport.random,
    })
    await provider.generate({ ...base, messages: user('hello') })
    expect(typeof seen?.input).toBe('string')
    expect(typeof seen?.body).toBe('string')
  })

  describe('system prompt', () => {
    it('joins blocks with a blank line and sends a plain string as it is', async () => {
      expect((await sent({ ...base, system: 'plain', messages: user('x') })).system_instruction).toBe('plain')
      expect((await sent({ ...base, system: [{ text: 'one' }, { text: 'two', cache: true }, { text: 'three' }], messages: user('x') })).system_instruction).toBe('one\n\ntwo\n\nthree')
    })

    it('leaves the field out for an empty or missing system prompt', async () => {
      const systems: Array<LlmRequest['system']> = [undefined, '', []]
      for (const system of systems) {
        const body = await sent({ ...base, ...(system === undefined ? {} : { system }), messages: user('x') })
        expect(body, JSON.stringify(system)).not.toHaveProperty('system_instruction')
      }
    })
  })

  describe('input', () => {
    it('turns one user message into a content array and keeps the order of its parts', async () => {
      const body = await sent({
        ...base,
        messages: user([
          { type: 'text', text: 'before' },
          { type: 'image', mediaType: 'image/webp', data: PNG_BASE64 },
          { type: 'document', mediaType: 'application/pdf', data: PDF_BASE64 },
          { type: 'text', text: 'after' },
        ]),
      })
      expect(body.input).toEqual([
        { type: 'text', text: 'before' },
        { type: 'image', mime_type: 'image/webp', data: PNG_BASE64 },
        { type: 'document', mime_type: 'application/pdf', data: PDF_BASE64 },
        { type: 'text', text: 'after' },
      ])
    })

    it('replays earlier turns as typed steps, assistant turns as text only', async () => {
      const body = await sent({
        ...base,
        messages: [
          { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }, { type: 'text', text: 'what is this' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a cat' }, { type: 'text', text: ' and a dog' }] },
          { role: 'user', content: 'thanks' },
        ],
      })
      expect(body.input).toEqual([
        { type: 'user_input', content: [{ type: 'image', mime_type: 'image/png', data: PNG_BASE64 }, { type: 'text', text: 'what is this' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'a cat' }, { type: 'text', text: ' and a dog' }] },
        { type: 'user_input', content: [{ type: 'text', text: 'thanks' }] },
      ])
      expect(JSON.stringify(body)).not.toContain('thought')
    })

    it('refuses an assistant turn that is not plain text, before any request', async () => {
      const { error, requests } = await refused({
        ...base,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }] },
          { role: 'user', content: 'again' },
        ],
      })
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toMatch(/assistant/)
      expect(requests).toBe(0)
    })

    it('never produces a prefill: a last assistant turn or no turn at all is refused before any request', async () => {
      for (const messages of [[{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], []] as LlmRequest['messages'][]) {
        const { error, requests } = await refused({ ...base, messages })
        expect(error.kind).toBe('invalid_request')
        expect(requests).toBe(0)
      }
    })
  })

  describe('generation config', () => {
    it('sends maxTokens as max_output_tokens, and a roomy default when none is given', async () => {
      expect((await sent({ ...base, maxTokens: 12_345, messages: user('x') })).generation_config).toEqual({ max_output_tokens: 12_345 })
      expect((await sent({ schema: CONFORMANCE_SCHEMA, messages: user('x') })).generation_config).toEqual({ max_output_tokens: 32_768 })
    })

    it('clamps maxTokens to what the model can write', async () => {
      const cap = capabilitiesOf(geminiSetup().provider).maxOutputTokens
      expect(cap).toBe(65_536)
      expect((await sent({ ...base, maxTokens: 200_000, messages: user('x') })).generation_config).toEqual({ max_output_tokens: 65_536 })
    })

    it('refuses a maxTokens that is not a positive whole number', async () => {
      for (const maxTokens of [0, -5, 1.5, Number.NaN]) {
        const { error, requests } = await refused({ ...base, maxTokens, messages: user('x') })
        expect(error.kind, String(maxTokens)).toBe('invalid_request')
        expect(requests).toBe(0)
      }
    })

    it('leaves the thinking level out when no effort is asked for', async () => {
      expect((await sent({ ...base, messages: user('x') })).generation_config).not.toHaveProperty('thinking_level')
    })

    it('collapses xhigh and max to high and declares only three distinguishable levels', async () => {
      const caps = capabilitiesOf(geminiSetup().provider)
      expect(caps.effortLevels).toEqual(['low', 'medium', 'high'])
      expect(caps.effortMap).toEqual({ low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' })
      const levels = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } as const
      for (const [effort, level] of Object.entries(levels)) {
        const body = await sent({ ...base, messages: user('x'), effort: effort as keyof typeof levels })
        expect((body.generation_config as { thinking_level: string }).thinking_level, effort).toBe(level)
      }
    })
  })

  describe('attachments', () => {
    it('takes png, jpeg and webp and refuses gif before any request', async () => {
      for (const mediaType of ['image/png', 'image/jpeg', 'image/webp'] as ImageMediaType[]) {
        const body = await sent({ ...base, messages: user([{ type: 'image', mediaType, data: PNG_BASE64 }]) })
        expect(JSON.stringify(body.input)).toContain(mediaType)
      }
      const { error, requests } = await refused({ ...base, messages: user([{ type: 'image', mediaType: 'image/gif', data: PNG_BASE64 }]) })
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toContain('image/gif')
      expect(requests).toBe(0)
    })

    it('refuses more than 3600 images in one request', async () => {
      const images = Array.from({ length: 3601 }, () => ({ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }) as const)
      const { error, requests } = await refused({ ...base, messages: user(images) })
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toMatch(/3600/)
      expect(requests).toBe(0)
      const fine = await sent({ ...base, messages: user(images.slice(0, 3600)) })
      expect((fine.input as unknown[]).length).toBe(3600)
    })

    it('refuses a PDF over 50 MB and never puts file content in the message', async () => {
      const data = 'A'.repeat(66_800_000)
      const { error, requests } = await refused({ ...base, messages: user([{ type: 'document', mediaType: 'application/pdf', data }]) })
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toMatch(/PDF/)
      expect(error.message).toMatch(/50 MB/)
      expect(error.message).not.toContain('AAAA')
      expect(requests).toBe(0)
    })

    it('refuses a request whose attachments together pass the payload cap', async () => {
      const data = 'A'.repeat(33_400_000)
      const parts = Array.from({ length: 4 }, () => ({ type: 'image', mediaType: 'image/png', data }) as const)
      const { error, requests } = await refused({ ...base, messages: user(parts) })
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toMatch(/75 MB/)
      expect(error.message).not.toContain('AAAA')
      expect(requests).toBe(0)
    })

    it('counts base64 by the bytes it decodes to, padding included', () => {
      const pdf = (data: string) => build({ ...base, messages: user([{ type: 'document', mediaType: 'application/pdf', data }]) })
      expect(() => pdf(`${'A'.repeat(66_666_666)}==`)).not.toThrow()
      expect(() => pdf(`${'A'.repeat(66_666_667)}=`)).not.toThrow()
      expect(() => pdf('A'.repeat(66_666_668))).toThrow(/50 MB/)
    })

    it('takes attachments that add up to exactly the payload cap and refuses one byte more', () => {
      const exact = `${'A'.repeat(33_333_334)}==`
      const part = { type: 'image', mediaType: 'image/png', data: exact } as const
      expect(() => build({ ...base, messages: user([part, part, part]) })).not.toThrow()
      expect(() => build({ ...base, messages: user([part, part, part, { type: 'image', mediaType: 'image/png', data: 'AAAA' }]) })).toThrow(/75 MB/)
    })
  })

  describe('response schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z]+$' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, uniqueItems: true, contains: { type: 'string' }, minContains: 1, maxContains: 2 },
        nested: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], minProperties: 1, maxProperties: 3 },
      },
      required: ['name'],
    }

    it('removes the keywords Gemini silently ignores and keeps everything else in order', async () => {
      const copy = structuredClone(schema)
      const body = await sent({ ...base, schema, messages: user('x') })
      const sentSchema = (body.response_format as { schema: Record<string, unknown> }).schema
      expect(sentSchema).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[a-z]+$' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
          nested: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
        },
        required: ['name'],
      })
      expect(Object.keys((sentSchema as { properties: object }).properties)).toEqual(['name', 'tags', 'nested'])
      expect(schema).toEqual(copy)
    })

    it('sends the response format as JSON text with the schema inline', async () => {
      const body = await sent({ ...base, messages: user('x') })
      expect(body.response_format).toEqual({ type: 'text', mime_type: 'application/json', schema: CONFORMANCE_SCHEMA })
    })

    it('lets a recursive schema through but refuses a reference that points nowhere, naming where', async () => {
      const recursive = { type: 'object', properties: { value: { type: 'string' }, next: { anyOf: [{ $ref: '#' }, { type: 'null' }] } }, required: ['value'] }
      expect(await sent({ ...base, schema: recursive, messages: user('x') })).toBeDefined()
      const broken = { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }
      const { error, requests } = await refused({ ...base, schema: broken, messages: user('x') })
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toContain('#/properties/a')
      expect(requests).toBe(0)
    })
  })

  describe('models', () => {
    it.each(geminiDescriptor.models.map((model) => model.id))('%s is sent under its own id', async (id) => {
      expect((await sent({ ...base, messages: user('x') }, id)).model).toBe(id)
    })
  })
})
