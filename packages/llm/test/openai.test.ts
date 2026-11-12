import type OpenAI from 'openai'
import { APIConnectionError } from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LlmError,
  capabilitiesOf,
  createProvider,
  openaiDescriptor,
  providerDescriptor,
  startCall,
  type ImageMediaType,
  type LlmProvider,
  type LlmRequest,
  type LlmUsage,
} from '../src/index'
import { LIVE_CHECKS, OPENAI_MODELS, OpenAiProvider, createOpenAiClient, openaiExchange } from '../src/openai'
import { streamFailure } from '../src/openai/errors'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, PDF_BASE64, PNG_BASE64, conformanceRequests } from './conformance'
import { createFakeTransport, errorReply, jsonReply, sseChunks, sseReply, type FakeReply, type FakeTransport } from './fake-transport'
import { OPENAI_ENDPOINT, OPENAI_MODEL, RAW_USAGE, USAGE, openaiWire, replyOf, responseBody, streamEvents, type Shape } from './openai-wire'

const OK_TEXT = JSON.stringify(CONFORMANCE_DATA)
const requests = conformanceRequests(openaiWire(false))

function setup(...replies: FakeReply[]): { transport: FakeTransport; provider: LlmProvider } {
  const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
  const provider = openaiDescriptor.create({ model: OPENAI_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random })
  transport.script(...replies)
  return { transport, provider }
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LlmError)
  return error as LlmError
}

const ok = (streaming = false) => replyOf(streaming, 'completed', OK_TEXT)
const body = (transport: FakeTransport, index = 0) => transport.requests[index]?.json as Record<string, unknown>
const apiError = (message: string, extra: Record<string, unknown> = {}) => ({ error: { message, type: 'invalid_request_error', param: null, code: null, ...extra } })

function pdfOf(bytes: number): string {
  const full = Math.floor(bytes / 3)
  const rest = bytes - full * 3
  return 'A'.repeat(full * 4) + (rest === 0 ? '' : rest === 1 ? 'AA==' : 'AAA=')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('request body', () => {
  it('always sends store:false and never sends sampling, caching or tool fields the adapter does not own', async () => {
    const withFlags: LlmRequest = { ...requests.cache, effort: 'high' }
    const cases: [string, LlmRequest][] = [
      ['text', requests.text],
      ['history', requests.history],
      ['pdf', requests.pdf],
      ['image', requests.image('image/webp')],
      ['cache flags', withFlags],
      ['streaming', { ...requests.text, maxTokens: 30_000 }],
    ]
    for (const [label, request] of cases) {
      const { transport, provider } = setup(label === 'streaming' ? ok(true) : ok())
      await provider.generate(request)
      const sent = body(transport)
      expect(sent.store, label).toBe(false)
      for (const field of ['temperature', 'top_p', 'logprobs', 'top_logprobs', 'instructions', 'prompt_cache_options', 'prompt_cache_key', 'truncation', 'service_tier', 'background', 'tools', 'previous_response_id', 'include', 'metadata', 'user']) {
        expect(sent, `${label}: ${field}`).not.toHaveProperty(field)
      }
    }
  })

  it('streams exactly above the Anthropic threshold and not at it', async () => {
    const at = setup(ok())
    await at.provider.generate({ ...requests.text, maxTokens: 16_000 })
    expect(body(at.transport)).not.toHaveProperty('stream')
    const above = setup(ok(true))
    await above.provider.generate({ ...requests.text, maxTokens: 16_001 })
    expect(body(above.transport).stream).toBe(true)
  })

  it('uses 16000 output tokens when the request names none, and omits reasoning when no effort is asked', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({ ...requests.text, maxTokens: undefined })
    expect(body(transport).max_output_tokens).toBe(16_000)
    expect(body(transport)).not.toHaveProperty('reasoning')
  })

  it.each([15, 1.5, 128_001, Number.NaN, -1])('refuses maxTokens %s before any request', async (maxTokens) => {
    const { transport, provider } = setup(ok())
    const error = await failure(provider.generate({ ...requests.text, maxTokens }))
    expect(error.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
  })

  it('accepts the documented bounds of maxTokens', async () => {
    for (const maxTokens of [16, 128_000]) {
      const { transport, provider } = setup(ok(maxTokens > 16_000))
      await provider.generate({ ...requests.text, maxTokens })
      expect(body(transport).max_output_tokens).toBe(maxTokens)
    }
  })

  it('refuses an assistant prefill and an empty conversation before any request', async () => {
    const { transport, provider } = setup(ok())
    const prefill = await failure(provider.generate({ ...requests.text, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] }))
    const empty = await failure(provider.generate({ ...requests.text, messages: [] }))
    expect([prefill.kind, empty.kind]).toEqual(['invalid_request', 'invalid_request'])
    expect(transport.requests).toHaveLength(0)
  })

  it('refuses an effort level the capability table does not know', async () => {
    const { transport, provider } = setup(ok())
    const error = await failure(provider.generate({ ...requests.text, effort: 'extreme' as never }))
    expect(error.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
  })

  it('puts system text in one developer message and leaves it out when empty', async () => {
    const blocks = setup(ok())
    await blocks.provider.generate({ ...requests.text, system: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] })
    const input = body(blocks.transport).input as { role: string; content: unknown }[]
    expect(input.filter((item) => item.role === 'developer')).toHaveLength(1)
    expect(input[0]).toEqual({ role: 'developer', content: [{ type: 'input_text', text: 'one' }, { type: 'input_text', text: 'two' }, { type: 'input_text', text: 'three' }] })
    for (const system of [undefined, '', []]) {
      const none = setup(ok())
      await none.provider.generate({ ...requests.text, system })
      expect((body(none.transport).input as { role: string }[]).map((item) => item.role)).toEqual(['user'])
    }
  })

  it('sends assistant parts as joined text and refuses non-text assistant parts', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({
      ...requests.text,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'a', cache: true }, { type: 'text', text: 'b' }] },
        { role: 'user', content: 'r' },
      ],
    })
    expect((body(transport).input as unknown[])[2]).toEqual({ role: 'assistant', content: 'ab' })
    const error = await failure(
      provider.generate({
        ...requests.text,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }] },
          { role: 'user', content: 'r' },
        ],
      }),
    )
    expect(error.kind).toBe('invalid_request')
  })

  it('numbers the PDF files of one request and keeps the order the caller gave', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({
      ...requests.text,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'document', mediaType: 'application/pdf', data: PDF_BASE64 },
            { type: 'document', mediaType: 'application/pdf', data: PDF_BASE64 },
          ],
        },
      ],
    })
    const content = (body(transport).input as { content: { type: string; filename?: string }[] }[]).at(-1)?.content
    expect(content?.map((part) => part.type)).toEqual(['input_text', 'input_file', 'input_file'])
    expect(content?.map((part) => part.filename)).toEqual([undefined, 'document-1.pdf', 'document-2.pdf'])
  })

  it('refuses an image type the model does not take before any request', async () => {
    const { transport, provider } = setup(ok())
    const error = await failure(provider.generate(requests.image('image/bmp' as ImageMediaType)))
    expect(error.kind).toBe('invalid_request')
    expect(error.message).toContain('image/bmp')
    expect(transport.requests).toHaveLength(0)
  })
})

describe('combined PDF size', () => {
  it('rejects PDFs above 50 MB in total before any request and names neither the data nor the key', async () => {
    for (const sizes of [[50_000_001], [25_000_001, 25_000_000], [20_000_000, 20_000_000, 10_000_001]]) {
      const { transport, provider } = setup(ok())
      const error = await failure(
        provider.generate({
          ...requests.text,
          messages: [{ role: 'user', content: [...sizes.map((size) => ({ type: 'document' as const, mediaType: 'application/pdf' as const, data: pdfOf(size) })), { type: 'text', text: 'go' }] }],
        }),
      )
      expect(error.kind).toBe('invalid_request')
      expect(error.message).toBe('the PDF files add up to 50,000,001 bytes, above the 50,000,000 bytes OpenAI accepts for all files in one request')
      expect(error.message).not.toContain('AAAA')
      expect(transport.requests).toHaveLength(0)
    }
  })

  it('sends PDFs that add up to exactly 50,000,000 bytes', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({
      ...requests.text,
      messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: pdfOf(25_000_000) }, { type: 'document', mediaType: 'application/pdf', data: pdfOf(25_000_000) }] }],
    })
    expect(transport.requests).toHaveLength(1)
  })

  it('does not count images against the file limit', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({ ...requests.text, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: pdfOf(60_000_000) }] }] })
    expect(transport.requests).toHaveLength(1)
  })
})

describe('cache breakpoints', () => {
  const flagged = (text: string) => ({ text, cache: true })

  it('keeps the first three flags in document order and drops the rest', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({
      ...requests.text,
      system: [flagged('s1'), { text: 's2' }, flagged('s3')],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'u1', cache: true }, { type: 'text', text: 'u2', cache: true }, { type: 'text', text: 'u3' }] }],
    })
    const input = body(transport).input as { content: { text: string; prompt_cache_breakpoint?: unknown }[] }[]
    const marked = input.flatMap((item) => item.content.filter((block) => block.prompt_cache_breakpoint !== undefined).map((block) => block.text))
    expect(marked).toEqual(['s1', 's3', 'u1'])
  })

  it('marks image and document parts too', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate({
      ...requests.text,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', mediaType: 'application/pdf', data: PDF_BASE64, cache: true },
            { type: 'image', mediaType: 'image/png', data: PNG_BASE64, cache: true },
            { type: 'text', text: 'go' },
          ],
        },
      ],
    })
    const content = (body(transport).input as { content: Record<string, unknown>[] }[]).at(-1)?.content ?? []
    expect(content.map((part) => part.prompt_cache_breakpoint)).toEqual([{ mode: 'explicit' }, { mode: 'explicit' }, undefined])
  })

  it('treats the request-level flag as the implicit mode that is already on and sends nothing for it', async () => {
    const on = setup(ok())
    await on.provider.generate({ ...requests.cacheOff, cache: true })
    const off = setup(ok())
    await off.provider.generate({ ...requests.cacheOff, cache: false })
    const unset = setup(ok())
    await unset.provider.generate(requests.cacheOff)
    expect(body(on.transport)).toEqual(body(unset.transport))
    expect(body(off.transport)).toEqual(body(unset.transport))
  })

  it('declares three explicit breakpoints', () => {
    const { provider } = setup()
    expect(capabilitiesOf(provider).maxCacheBreakpoints).toBe(3)
  })
})

describe('structured output schema', () => {
  const optional = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } }, required: ['a'], additionalProperties: false }

  it('makes optional properties nullable and required on the wire and removes the nulls from the reply', async () => {
    const { transport, provider } = setup(replyOf(false, 'completed', '{"a":1,"b":null}'))
    const result = await provider.generate({ ...requests.text, schema: optional })
    const format = (body(transport).text as { format: { schema: { required: string[]; properties: { b: unknown } } } }).format
    expect(format.schema.required).toEqual(['a', 'b'])
    expect(format.schema.properties.b).toEqual({ type: ['string', 'null'] })
    expect(result.data).toEqual({ a: 1 })
  })

  it('sends only keywords the guide lists: oneOf becomes anyOf, const an enum, unsupported ones are gone', async () => {
    const schema = {
      type: 'object',
      properties: {
        kind: { const: 'x' },
        value: { oneOf: [{ type: 'string', minLength: 1, maxLength: 5, default: 'q' }, { type: 'number' }] },
        default: { type: 'boolean' },
        both: { allOf: [{ type: 'string' }], type: 'string' },
      },
      required: ['kind', 'value', 'default', 'both'],
      additionalProperties: false,
      if: { properties: {} },
      then: {},
      dependentRequired: {},
    }
    const { transport, provider } = setup(replyOf(false, 'completed', '{"kind":"x","value":"s","default":true,"both":"b"}'))
    await provider.generate({ ...requests.text, schema })
    const sent = (body(transport).text as { format: { schema: Record<string, unknown> } }).format.schema
    expect(sent).toEqual({
      type: 'object',
      properties: {
        kind: { enum: ['x'] },
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        default: { type: 'boolean' },
        both: { type: 'string' },
      },
      required: ['kind', 'value', 'default', 'both'],
      additionalProperties: false,
    })
  })

  it('rejects a schema over the limits before any request, naming where', async () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let level = 0; level < 11; level++) deep = { type: 'object', properties: { next: deep }, required: ['next'], additionalProperties: false }
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['depth', deep, /depth limit of 10/],
      ['root', { type: 'array', items: { type: 'string' } }, /plain object at its root/],
      ['free-form keys', { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['m'], additionalProperties: false }, /free-form keys/],
    ]
    for (const [label, schema, pattern] of cases) {
      const { transport, provider } = setup(ok())
      const error = await failure(provider.generate({ ...requests.text, schema }))
      expect(error.kind, label).toBe('invalid_request')
      expect(error.message, label).toMatch(pattern)
      expect(transport.requests, label).toHaveLength(0)
    }
  })

  it('accepts a recursive schema', async () => {
    const tree = { type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } }, required: ['children'], additionalProperties: false }
    const { transport, provider } = setup(replyOf(false, 'completed', '{"children":[{"children":[]}]}'))
    const result = await provider.generate({ ...requests.text, schema: tree })
    expect(transport.requests).toHaveLength(1)
    expect(result.data).toEqual({ children: [{ children: [] }] })
  })
})

describe('usage', () => {
  const usageReply = (usage: unknown, shape: Shape = 'completed') => jsonReply({ ...responseBody(shape, OK_TEXT), usage })

  it('subtracts both cache buckets from the input and does not add reasoning to the output twice', async () => {
    const { provider } = setup(usageReply({ ...RAW_USAGE, input_tokens: 5000, input_tokens_details: { cached_tokens: 1200, cache_write_tokens: 800 }, output_tokens: 700, output_tokens_details: { reasoning_tokens: 650 } }))
    const result = await provider.generate(requests.text)
    expect(result.usage).toEqual({ inputTokens: 3000, outputTokens: 700, cacheReadInputTokens: 1200, cacheCreationInputTokens: 800 })
  })

  it('reads missing cache details as zero', async () => {
    for (const details of [undefined, null, {}, { cached_tokens: 10 }, { cache_write_tokens: 20 }]) {
      const { provider } = setup(usageReply({ input_tokens: 100, output_tokens: 5, ...(details === undefined ? {} : { input_tokens_details: details }) }))
      const result = await provider.generate(requests.text)
      const cached = (details as { cached_tokens?: number } | null)?.cached_tokens ?? 0
      const written = (details as { cache_write_tokens?: number } | null)?.cache_write_tokens ?? 0
      expect(result.usage).toEqual({ inputTokens: 100 - cached - written, outputTokens: 5, cacheReadInputTokens: cached, cacheCreationInputTokens: written })
    }
  })

  it.each<[string, unknown]>([
    ['cache buckets above the input', { input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 30 }, output_tokens: 5 }],
    ['a negative count', { input_tokens: -1, output_tokens: 5 }],
    ['a fraction', { input_tokens: 10.5, output_tokens: 5 }],
    ['a text count', { input_tokens: '10', output_tokens: 5 }],
    ['no usage', undefined],
    ['null usage', null],
  ])('a completed reply with %s is invalid_output and not retried', async (_label, usage) => {
    const { transport, provider } = setup(usageReply(usage))
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe('invalid_output')
    expect(transport.requests).toHaveLength(1)
    expect(error.message).not.toContain(CONFORMANCE_API_KEY)
  })

  it('carries the billed usage and model on an incomplete reply', async () => {
    const { provider } = setup(usageReply(RAW_USAGE, 'cut'))
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe('truncated')
    expect(error.usage).toEqual(USAGE)
    expect(error.model).toBe(OPENAI_MODEL)
    expect(error.servedModels).toEqual([OPENAI_MODEL])
  })

  it('reports an unreadable reply without usage as invalid_output with no usage', async () => {
    const { provider } = setup(jsonReply({ id: 'resp_x' }))
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe('invalid_output')
    expect(error.usage).toBeUndefined()
  })
})

describe('reply handling', () => {
  const withOutput = (output: unknown[], extra: Record<string, unknown> = {}) => jsonReply({ ...responseBody('completed', OK_TEXT), output, ...extra })
  const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'message', id: 'msg_x', role: 'assistant', status: 'completed', content, ...extra })

  it('joins output_text parts and skips commentary messages', async () => {
    const { provider } = setup(
      withOutput([
        message([{ type: 'output_text', text: 'thinking out loud', annotations: [] }], { phase: 'commentary' }),
        message([{ type: 'output_text', text: '{"a":', annotations: [] }, { type: 'output_text', text: '1}', annotations: [] }], { phase: 'final_answer' }),
      ]),
    )
    expect((await provider.generate(requests.text)).data).toEqual({ a: 1 })
  })

  it('reports a reply with no text as invalid_output with the billed usage', async () => {
    const { provider } = setup(withOutput([{ type: 'reasoning', id: 'rs_1', summary: [] }, message([])]))
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe('invalid_output')
    expect(error.usage).toEqual(USAGE)
  })

  it('does not echo the refusal text and does not retry', async () => {
    const { transport, provider } = setup(replyOf(false, 'refused', ''))
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe('refusal')
    expect(error.message).not.toContain('cannot help')
    expect(transport.requests).toHaveLength(1)
  })

  it('reports the served model and the requested model', async () => {
    const { provider } = setup(jsonReply(responseBody('completed', OK_TEXT, { model: 'gpt-6.1-sol-served' })))
    const result = await provider.generate(requests.text)
    expect(result.model).toBe('gpt-6.1-sol-served')
    expect(result.requestedModel).toBe(OPENAI_MODEL)
    expect(result.servedModels).toEqual(['gpt-6.1-sol-served'])
    expect(result.fallbackUsed).toBe(false)
  })

  it.each<[string, Record<string, unknown>, LlmError['kind']]>([
    ['content filter', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'refusal'],
    ['an unknown incomplete reason', { status: 'incomplete', incomplete_details: { reason: 'steered' } }, 'unknown'],
    ['incomplete without a reason', { status: 'incomplete', incomplete_details: null }, 'unknown'],
    ['a cancelled response', { status: 'cancelled' }, 'unknown'],
    ['an unfinished response', { status: 'in_progress' }, 'invalid_output'],
    ['a queued response', { status: 'queued' }, 'invalid_output'],
  ])('maps %s', async (_label, extra, kind) => {
    const { transport, provider } = setup(jsonReply({ ...responseBody('completed', OK_TEXT), ...extra }))
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe(kind)
    expect(transport.requests).toHaveLength(1)
  })

  it.each<[string, LlmError['kind']]>([
    ['server_error', 'overloaded'],
    ['rate_limit_exceeded', 'rate_limit'],
    ['invalid_prompt', 'invalid_request'],
    ['data_residency_mismatch', 'invalid_request'],
    ['invalid_base64_image', 'invalid_request'],
    ['image_too_large', 'invalid_request'],
    ['bio_policy', 'refusal'],
    ['misalignment_policy_violation', 'refusal'],
    ['image_content_policy_violation', 'refusal'],
    ['something_new', 'unknown'],
  ])('a failed response with code %s is %s and is never retried', async (code, kind) => {
    for (const streaming of [false, true]) {
      const failed = responseBody('completed', '', { status: 'failed', output: [], usage: null, error: { code, message: `broke with ${CONFORMANCE_API_KEY}` } })
      const { transport, provider } = setup(streaming ? sseReply(streamEvents(failed)) : jsonReply(failed))
      const error = await failure(provider.generate({ ...requests.text, maxTokens: streaming ? 20_000 : 4000 }))
      expect(error.kind, `${code} streaming=${streaming}`).toBe(kind)
      expect(error.category).toBe(code)
      expect(error.message).not.toContain(CONFORMANCE_API_KEY)
      expect(transport.requests).toHaveLength(1)
      expect(transport.sleeps).toEqual([])
    }
  })

  it('keeps the billed usage of a failed response that reports one', async () => {
    const failed = responseBody('completed', '', { status: 'failed', error: { code: 'server_error', message: 'x' } })
    const { provider } = setup(jsonReply(failed))
    expect((await failure(provider.generate(requests.text))).usage).toEqual(USAGE)
  })
})

describe('streaming', () => {
  const big = { ...requests.text, maxTokens: 20_000 }
  const events = () => streamEvents(responseBody('completed', OK_TEXT))

  it('returns at the terminal event and closes the connection even when the server keeps it open', async () => {
    const { transport, provider } = setup(sseReply(events(), 'hold'))
    const result = await provider.generate(big)
    expect(result.data).toEqual(CONFORMANCE_DATA)
    expect(transport.openBodies()).toBe(0)
  })

  it('reads an error event as a typed error and does not retry it', async () => {
    for (const named of [true, false]) {
      const failed = { type: 'error', code: 'server_error', message: `oops ${CONFORMANCE_API_KEY}`, param: null, sequence_number: 3 }
      const { transport, provider } = setup(sseReply([...events().slice(0, 2), { ...(named ? { event: 'error' } : {}), data: failed }], 'hold'))
      const error = await failure(provider.generate(big))
      expect(error.kind).toBe('overloaded')
      expect(error.message).not.toContain(CONFORMANCE_API_KEY)
      expect(transport.requests).toHaveLength(1)
      expect(transport.openBodies()).toBe(0)
    }
  })

  it.each([
    ['an event: error frame', { event: 'error', data: { type: 'error', code: 'server_error', message: 'boom', param: null, sequence_number: 0 } }, 'overloaded'],
    ['a data-only error frame', { data: { type: 'error', code: 'server_error', message: 'boom', param: null, sequence_number: 0 } }, 'overloaded'],
    ['a rate-limit error frame', { event: 'error', data: { type: 'error', code: 'rate_limit_exceeded', message: 'slow', param: null, sequence_number: 0 } }, 'rate_limit'],
    ['a frame that carries an error object', { data: { error: { code: 'server_error', message: 'boom' } } }, 'overloaded'],
  ] as const)('does not retry when %s is the very first thing streamed', async (_label, frame, kind) => {
    const { transport, provider } = setup(sseReply([frame]), ok(true))
    const error = await failure(provider.generate(big))
    expect(error.kind).toBe(kind)
    expect(transport.requests).toHaveLength(1)
    expect(transport.sleeps).toEqual([])
  })

  it('still retries a transport error that the SDK raises before any frame', async () => {
    let calls = 0
    const reply = responseBody('completed', OK_TEXT)
    const client = {
      responses: {
        create: async () =>
          (async function* () {
            calls += 1
            if (calls === 1) throw new APIConnectionError({ message: 'socket hang up' })
            for (const event of streamEvents(reply)) yield event.data
          })(),
      },
    } as unknown as OpenAI
    const sleeps: number[] = []
    const provider = new OpenAiProvider({ model: OPENAI_MODEL, apiKey: CONFORMANCE_API_KEY, client, sleep: async (ms) => void sleeps.push(ms) })
    expect((await provider.generate(big)).data).toEqual(CONFORMANCE_DATA)
    expect(calls).toBe(2)
  })

  it('does not retry when the first frame is not JSON', async () => {
    const { transport, provider } = setup({ kind: 'sse', chunks: ['data: {not json\n\n'], then: 'end' }, ok(true))
    expect((await failure(provider.generate(big))).kind).toBe('invalid_output')
    expect(transport.requests).toHaveLength(1)
  })

  it('treats a stream that ends after some events without a final one as a dropped connection and does not retry', async () => {
    const { transport, provider } = setup(sseReply(events().slice(0, 4), 'end'), ok(true))
    const error = await failure(provider.generate(big))
    expect(error.kind).toBe('connection')
    expect(transport.requests).toHaveLength(1)
    expect(transport.sleeps).toEqual([])
  })

  it('retries a stream that ends before its first event', async () => {
    const { transport, provider } = setup(sseReply([], 'end'), ok(true))
    const result = await provider.generate(big)
    expect(result.data).toEqual(CONFORMANCE_DATA)
    expect(transport.requests).toHaveLength(2)
    expect(transport.sleeps).toHaveLength(1)
  })

  it('retries a connection that drops before its first event', async () => {
    const { transport, provider } = setup(sseReply([], 'drop'), ok(true))
    expect((await provider.generate(big)).data).toEqual(CONFORMANCE_DATA)
    expect(transport.requests).toHaveLength(2)
  })

  it('reports a stream event that is not JSON as invalid_output', async () => {
    const chunks = [...sseChunks(events().slice(0, 2)), 'data: {not json\n\n']
    const { transport, provider } = setup({ kind: 'sse', chunks, then: 'hold' })
    const error = await failure(provider.generate(big))
    expect(error.kind).toBe('invalid_output')
    expect(transport.requests).toHaveLength(1)
    expect(transport.openBodies()).toBe(0)
  })

  it('does not assemble text from deltas when the terminal event has none', async () => {
    const all = streamEvents(responseBody('completed', OK_TEXT, { output: [] }))
    const { provider } = setup(sseReply(all))
    const error = await failure(provider.generate(big))
    expect(error.kind).toBe('invalid_output')
  })
})

describe('http errors', () => {
  it.each<[string, FakeReply, LlmError['kind'], number]>([
    ['bad key', errorReply(401, apiError('Incorrect API key provided')), 'auth', 1],
    ['region', errorReply(403, apiError('Country, region, or territory not supported')), 'auth', 1],
    ['policy block', errorReply(403, apiError('blocked', { code: 'misalignment_policy_violation' })), 'refusal', 1],
    ['out of credit by code', errorReply(429, apiError('You exceeded your current quota', { code: 'credit_balance_exhausted' })), 'auth', 1],
    ['out of quota by type', errorReply(429, apiError('You exceeded your current quota', { type: 'insufficient_quota' })), 'auth', 1],
    ['org spend limit', errorReply(429, apiError('limit', { code: 'organization_spend_limit_exceeded' })), 'auth', 1],
    ['project spend limit', errorReply(429, apiError('limit', { code: 'project_spend_limit_exceeded' })), 'auth', 1],
    ['org usage limit', errorReply(429, apiError('limit', { code: 'organization_usage_limit_exceeded' })), 'auth', 1],
    ['plain rate limit', errorReply(429, apiError('Rate limit reached for requests', { type: 'rate_limit_error' })), 'rate_limit', 3],
    ['slow down', errorReply(429, apiError('slow down', { code: 'slow_down' })), 'rate_limit', 3],
    ['overloaded', errorReply(503, apiError('overloaded', { code: 'server_is_overloaded' })), 'overloaded', 3],
    ['server error', errorReply(500, apiError('The server had an error')), 'overloaded', 3],
    ['gateway page', { kind: 'text', status: 502, body: '<html>bad gateway</html>' }, 'overloaded', 3],
    ['request timeout', errorReply(408, apiError('timeout')), 'timeout', 1],
    ['bad request', errorReply(400, apiError('bad field')), 'invalid_request', 1],
    ['not found', errorReply(404, apiError('no such model')), 'invalid_request', 1],
  ])('%s', async (_label, reply, kind, sent) => {
    const { transport, provider } = setup(reply)
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe(kind)
    expect(transport.requests).toHaveLength(sent)
    expect(error.status).toBe('status' in reply ? reply.status : undefined)
  })

  it('names the offending parameter of a rejected request', async () => {
    const { provider } = setup(errorReply(400, apiError('Invalid schema', { param: 'text.format.schema' })))
    const error = await failure(provider.generate(requests.text))
    expect(error.message).toContain('Invalid schema')
    expect(error.message).toContain('text.format.schema')
  })

  it('shortens a very long parameter name', async () => {
    const { provider } = setup(errorReply(400, apiError('Invalid schema', { param: `text.${'x'.repeat(200)}` })))
    const error = await failure(provider.generate(requests.text))
    expect(error.message).toContain(`(parameter text.${'x'.repeat(59)})`)
  })

  it('keeps the request id and the quota code, and removes the key from a message that echoes it', async () => {
    const reply = errorReply(400, apiError(`bad key ${CONFORMANCE_API_KEY} and Bearer sk-abcdefgh12345678`), { 'x-request-id': 'req_42' })
    const { provider } = setup(reply)
    const error = await failure(provider.generate(requests.text))
    expect(error.requestId).toBe('req_42')
    expect(error.message).toContain('[redacted]')
    expect(error.message).not.toContain(CONFORMANCE_API_KEY)
    expect(error.message).not.toContain('sk-abcdefgh12345678')
    const quota = setup(errorReply(429, apiError('x', { code: 'credit_balance_exhausted' })))
    expect((await failure(quota.provider.generate(requests.text))).category).toBe('credit_balance_exhausted')
  })

  it('reads retry-after-ms and the HTTP-date form of retry-after', async () => {
    const ms = setup(errorReply(429, apiError('slow'), { 'retry-after-ms': '1500' }))
    expect((await failure(ms.provider.generate(requests.text))).retryAfterMs).toBe(1500)
    expect(ms.transport.sleeps.every((waited) => waited >= 1500 && waited < 2000)).toBe(true)
  })

  it('describes a failed network call without the key, and keeps no cause that could carry it', async () => {
    const reason = new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED 127.0.0.1:443 for ${CONFORMANCE_API_KEY}`) })
    const { transport, provider } = setup({ kind: 'network-error', error: reason })
    const error = await failure(provider.generate(requests.text))
    expect(error.kind).toBe('connection')
    expect(error.message).toContain('fetch failed: connect ECONNREFUSED 127.0.0.1:443')
    expect(error.message).not.toContain(CONFORMANCE_API_KEY)
    expect(error.cause).toBeUndefined()
    expect(transport.requests).toHaveLength(3)
  })
})

describe('stream failures', () => {
  const secrets = [CONFORMANCE_API_KEY]

  it('describes a dropped stream without the key and keeps no cause', () => {
    const call = startCall(1000)
    try {
      const reason = new TypeError('terminated', { cause: new Error(`socket closed by ${CONFORMANCE_API_KEY}`) })
      const error = streamFailure(reason, call, secrets) as LlmError
      expect(error).toBeInstanceOf(LlmError)
      expect(error.kind).toBe('connection')
      expect(error.message).toContain('terminated: socket closed by [redacted]')
      expect(error.cause).toBeUndefined()
    } finally {
      call.dispose()
    }
  })

  it('maps broken event JSON to invalid_output and passes typed errors through', () => {
    const call = startCall(1000)
    try {
      expect((streamFailure(new SyntaxError('malformed server-sent event JSON.'), call, secrets) as LlmError).kind).toBe('invalid_output')
      const typed = new LlmError('overloaded', 'busy')
      expect(streamFailure(typed, call, secrets)).toBe(typed)
    } finally {
      call.dispose()
    }
  })

  it('reports a caller abort instead of a dropped connection', () => {
    const caller = new AbortController()
    const call = startCall(1000, caller.signal)
    try {
      caller.abort()
      expect((streamFailure(new TypeError('terminated'), call, secrets) as LlmError).kind).toBe('aborted')
    } finally {
      call.dispose()
    }
  })
})

describe('the SDK client', () => {
  it('is built without retries, with the public endpoint, and ignores OpenAI variables of the environment', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://elsewhere.invalid/v1')
    vi.stubEnv('OPENAI_ORG_ID', 'org-ambient')
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-ambient')
    const client = createOpenAiClient({ apiKey: CONFORMANCE_API_KEY })
    expect(client.maxRetries).toBe(0)
    expect(client.baseURL).toBe('https://api.openai.com/v1')
    expect(client.organization).toBeNull()
    expect(client.project).toBeNull()
  })

  it('uses a base URL that is passed in', () => {
    expect(createOpenAiClient({ apiKey: CONFORMANCE_API_KEY, baseURL: 'https://eu.api.openai.com/v1' }).baseURL).toBe('https://eu.api.openai.com/v1')
  })

  it('is the client the provider sends through, and the requests go to the Responses endpoint with the key in a header', async () => {
    const { transport, provider } = setup(ok())
    await provider.generate(requests.text)
    expect(transport.requests[0]?.url).toBe(OPENAI_ENDPOINT)
    expect(transport.requests[0]?.headers.authorization).toBe(`Bearer ${CONFORMANCE_API_KEY}`)
  })

  it('tells an injected client to retry zero times on every call, with the call deadline and a signal', async () => {
    const calls: { body: Record<string, unknown>; options: Record<string, unknown> }[] = []
    const reply = responseBody('completed', OK_TEXT)
    const client = {
      responses: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.push({ body: params, options })
          if (params.stream !== true) return reply
          return (async function* () {
            for (const event of streamEvents(reply)) yield event.data
          })()
        },
      },
    } as unknown as OpenAI
    const provider = new OpenAiProvider({ model: OPENAI_MODEL, apiKey: CONFORMANCE_API_KEY, client })
    await provider.generate(requests.text, { timeoutMs: 5000 })
    await provider.generate({ ...requests.text, maxTokens: 20_000 }, { timeoutMs: 7000 })
    expect(calls.map((call) => call.options.maxRetries)).toEqual([0, 0])
    expect(calls.map((call) => call.options.timeout)).toEqual([5000, 7000])
    expect(calls.every((call) => call.options.signal instanceof AbortSignal)).toBe(true)
    expect(calls[0]?.body.stream).toBeUndefined()
    expect(calls[1]?.body.stream).toBe(true)
  })

  it('passes the provider default deadline when the call names none', async () => {
    const seen: unknown[] = []
    const reply = responseBody('completed', OK_TEXT)
    const client = { responses: { create: async (_params: unknown, options: { timeout: unknown }) => (seen.push(options.timeout), reply) } } as unknown as OpenAI
    await new OpenAiProvider({ model: OPENAI_MODEL, apiKey: CONFORMANCE_API_KEY, client, timeoutMs: 33_000 }).generate(requests.text)
    expect(seen).toEqual([33_000])
  })
})

describe('descriptor and registry', () => {
  it('describes the provider', () => {
    expect(openaiDescriptor).toMatchObject({ id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY' })
    expect(openaiDescriptor.models).toBe(OPENAI_MODELS)
    expect(openaiDescriptor.liveChecks).toBe(LIVE_CHECKS)
    expect(openaiDescriptor.exchange).toBe(openaiExchange)
    expect(providerDescriptor('openai')).toBe(openaiDescriptor)
  })

  it('creates a provider per model with that model capabilities', () => {
    for (const model of OPENAI_MODELS) {
      const provider = openaiDescriptor.create({ model: model.id, apiKey: CONFORMANCE_API_KEY })
      expect(provider.name).toBe('openai')
      expect(capabilitiesOf(provider)).toBe(model.capabilities)
    }
  })

  it('refuses a model that is not in the table', () => {
    expect(() => openaiDescriptor.create({ model: 'gpt-4o', apiKey: CONFORMANCE_API_KEY })).toThrow(/unknown OpenAI model/)
    expect(() => openaiDescriptor.create({ model: 'gpt-4o', apiKey: CONFORMANCE_API_KEY })).toThrow(LlmError)
  })

  it('is created by the registry from the environment and talks to the endpoint', async () => {
    const transport = createFakeTransport({ apiKey: 'sk-from-env-12345678' })
    const provider = createProvider('openai:gpt-6-luna', { env: { OPENAI_API_KEY: 'sk-from-env-12345678' }, fetch: transport.fetch, sleep: transport.sleep, random: transport.random })
    transport.script(ok())
    expect((await provider.generate(requests.text)).data).toEqual(CONFORMANCE_DATA)
    expect(body(transport).model).toBe('gpt-6-luna')
    expect(transport.requests[0]?.headers.authorization).toBe('Bearer sk-from-env-12345678')
  })

  it('names the key variable when it is missing', () => {
    expect(() => createProvider('openai:gpt-6-luna', { env: {} })).toThrow(/OPENAI_API_KEY/)
  })

  it('lists live checks with unique ids and a plain statement each', () => {
    expect(LIVE_CHECKS.length).toBeGreaterThan(0)
    expect(new Set(LIVE_CHECKS.map((check) => check.id)).size).toBe(LIVE_CHECKS.length)
    for (const check of LIVE_CHECKS) {
      expect(check.id).toMatch(/^[a-z0-9-]+$/)
      expect(check.what.length).toBeGreaterThan(20)
    }
  })
})

describe('exchange parser', () => {
  const zero: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  const json = (shape: Shape = 'completed', extra: Record<string, unknown> = {}) => JSON.stringify(responseBody(shape, OK_TEXT, extra))
  const stream = (shape: Shape = 'completed', extra: Record<string, unknown> = {}) => sseChunks(streamEvents(responseBody(shape, OK_TEXT, extra))).join('')

  it('reads model, stop reason, usage buckets and block types from a JSON reply and from the stream', () => {
    for (const text of [json(), stream()]) {
      expect(openaiExchange.parse(text, true)).toEqual({
        model: OPENAI_MODEL,
        stopReason: 'end_turn',
        usage: USAGE,
        contentBlockTypes: ['reasoning', 'output_text'],
        fallbackBlocks: 0,
        thinkingChars: 0,
        badReply: null,
      })
    }
  })

  it('agrees with what the provider returns for the same reply', async () => {
    const { provider } = setup(ok())
    const result = await provider.generate(requests.text)
    const parsed = openaiExchange.parse(json(), true)
    expect(parsed.usage).toEqual(result.usage)
    expect(parsed.model).toBe(result.model)
    expect(parsed.stopReason).toBe(result.stopReason)
  })

  it('names the stop reasons of incomplete and refused replies', () => {
    expect(openaiExchange.parse(json('cut'), true)).toMatchObject({ stopReason: 'max_tokens', badReply: null, usage: USAGE })
    expect(openaiExchange.parse(stream('cut'), true)).toMatchObject({ stopReason: 'max_tokens', badReply: null })
    expect(openaiExchange.parse(json('filtered'), true).stopReason).toBe('content_filter')
    expect(openaiExchange.parse(json('refused'), true)).toMatchObject({ stopReason: 'refusal', contentBlockTypes: ['reasoning', 'refusal'] })
  })

  it('counts the characters of reasoning summaries', () => {
    const output = [
      { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'abc' }, { type: 'summary_text', text: 'de' }], content: [{ type: 'reasoning_text', text: 'fghi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: OK_TEXT }] },
    ]
    expect(openaiExchange.parse(json('completed', { output }), true).thinkingChars).toBe(9)
  })

  it('flags a successful reply that cannot be used', () => {
    const bad = (text: string) => openaiExchange.parse(text, true)
    expect(bad('')).toMatchObject({ badReply: 'the reply body is empty', usage: zero })
    expect(bad('<html>')).toMatchObject({ badReply: 'the reply is not JSON' })
    expect(bad('[]')).toMatchObject({ badReply: 'the reply is not a JSON object' })
    expect(bad('{}')).toMatchObject({ badReply: 'the reply has no output array' })
    expect(bad('"x"')).toMatchObject({ badReply: 'the reply is not a JSON object' })
    expect(bad(json('completed', { usage: { input_tokens: -3, output_tokens: 1 } }))).toMatchObject({ badReply: 'the reply has an invalid usage' })
    expect(bad(json('completed', { usage: undefined }))).toMatchObject({ badReply: 'the reply has an invalid usage' })
    expect(bad(JSON.stringify(responseBody('completed', OK_TEXT, { status: 'failed', usage: null, error: { code: 'server_error', message: 'x' } })))).toMatchObject({
      badReply: 'the response did not finish (failed, server_error)',
    })
    expect(bad(sseChunks(streamEvents(responseBody('completed', OK_TEXT))).slice(0, 4).join(''))).toMatchObject({ badReply: 'the reply stream ended without a final event' })
    expect(bad('event: ping\n\n')).toMatchObject({ badReply: 'the reply is not JSON' })
  })

  it('does not flag an HTTP error body and still reads what is there', () => {
    expect(openaiExchange.parse(JSON.stringify(apiError('nope')), false)).toEqual({ model: null, stopReason: null, usage: zero, contentBlockTypes: [], fallbackBlocks: 0, thinkingChars: 0, badReply: null })
    expect(openaiExchange.parse('<html>', false).badReply).toBeNull()
    expect(openaiExchange.parse('', false).badReply).toBeNull()
    expect(openaiExchange.parse(json('cut'), false)).toMatchObject({ model: OPENAI_MODEL, usage: USAGE, badReply: null })
  })

  it('does not throw on an oversized stream event', () => {
    const huge = `data: ${'x'.repeat(9 * 1024 * 1024)}\n\n`
    expect(openaiExchange.parse(huge, true).badReply).toBe('the reply is not JSON')
  })
})
