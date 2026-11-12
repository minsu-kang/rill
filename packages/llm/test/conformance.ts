import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { EFFORT_LEVELS, LlmError, capabilitiesOf, type ImageMediaType, type LlmEffort, type LlmProvider, type LlmRequest, type LlmUsage } from '../src/index'
import { createFakeTransport, type FakeReply, type FakeTransport } from './fake-transport'

export interface ConformanceWire {
  mode: string
  maxTokens: number
  endpoint?: string
  /** For an sse reply, build the chunks with sseChunks so that every chunk holds one whole event. */
  ok: { reply: FakeReply; data: unknown; usage: LlmUsage; model: string; stopReason?: string }
  truncated: { reply: FakeReply; usage?: LlmUsage }
  refusal: { reply: FakeReply; usage?: LlmUsage }
  notJson: FakeReply
  auth: FakeReply
  rateLimit: FakeReply
  overloaded: FakeReply
  invalidRequest: FakeReply
  contextTooLong: FakeReply
  goldens: ConformanceGoldens
}

export interface ConformanceGoldens {
  text: unknown
  history?: unknown
  pdf?: unknown
  image: unknown
  cache: unknown
}

export interface ProviderConformance {
  name: string
  /** Hand the adapter transport.apiKey, transport.fetch (or an SDK client built on it), transport.sleep and transport.random. */
  build(transport: FakeTransport): LlmProvider
  wire: ConformanceWire | readonly ConformanceWire[]
  effortPath: readonly string[]
  effortWhenUnset?: string
}

export interface ConformanceCase {
  name: string
  run(): Promise<void>
}

export const CONFORMANCE_API_KEY = 'rill-test-key-4f9c2a7e'
export const CONFORMANCE_SCHEMA = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false }
export const CONFORMANCE_DATA = { a: 1 }
export const PDF_BASE64 = Buffer.from('%PDF-1.4 rill conformance').toString('base64')
export const PNG_BASE64 = Buffer.from('rill-conformance-png').toString('base64')
export const RETRY_AFTER_MS = 7000

const IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export function conformanceRequests(wire: ConformanceWire) {
  const base = { schema: CONFORMANCE_SCHEMA, maxTokens: wire.maxTokens }
  const user = (content: LlmRequest['messages'][number]['content']): LlmRequest['messages'] => [{ role: 'user', content }]
  return {
    text: { ...base, system: 'You are a test system.', messages: user('hello') } satisfies LlmRequest,
    history: {
      ...base,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    } satisfies LlmRequest,
    pdf: {
      ...base,
      messages: user([
        { type: 'document', mediaType: 'application/pdf', data: PDF_BASE64 },
        { type: 'text', text: 'Extract the fields.' },
      ]),
    } satisfies LlmRequest,
    image: (mediaType: ImageMediaType): LlmRequest => ({
      ...base,
      messages: user([
        { type: 'image', mediaType, data: PNG_BASE64 },
        { type: 'text', text: 'Describe it.' },
      ]),
    }),
    cache: {
      ...base,
      system: [{ text: 'Stable system part.', cache: true }, { text: 'Second system part.' }],
      messages: user([{ type: 'text', text: 'Stable user part.', cache: true }, { type: 'text', text: 'Volatile user part.' }]),
      cache: true,
    } satisfies LlmRequest,
    cacheOff: {
      ...base,
      system: [{ text: 'Stable system part.' }, { text: 'Second system part.' }],
      messages: user([{ type: 'text', text: 'Stable user part.' }, { type: 'text', text: 'Volatile user part.' }]),
    } satisfies LlmRequest,
    overCache: (count: number): LlmRequest => ({
      ...base,
      system: Array.from({ length: count }, (_, index) => ({ text: `system ${index}`, cache: true })),
      messages: user('hello'),
    }),
  }
}

const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function chain(error: unknown): string {
  const parts: string[] = []
  for (let depth = 0, current: unknown = error; depth < 6 && current instanceof Error; depth++, current = current.cause) {
    parts.push(`${current.name} ${current.message}`)
  }
  return parts.join('\n')
}

async function rejection(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, 'the call should have failed').toBeInstanceOf(LlmError)
  return error as LlmError
}

function pointerValue(body: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined), body)
}

function prefixOf(reply: FakeReply): FakeReply {
  return reply.kind === 'sse' ? { ...reply, chunks: reply.chunks.slice(0, 1), then: 'hold' } : { kind: 'hang' }
}

async function untilRequested(transport: FakeTransport): Promise<void> {
  for (let waited = 0; transport.requests.length === 0 && waited < 2000; waited += 5) await sleepReal(5)
  await sleepReal(25)
}

function conformanceFor(config: ProviderConformance, wire: ConformanceWire): ConformanceCase[] {
  const requests = conformanceRequests(wire)
  const label = (text: string) => `[${wire.mode}] ${text}`
  const setup = (...replies: FakeReply[]) => {
    const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
    const provider = config.build(transport)
    transport.script(...replies)
    return { transport, provider, caps: capabilitiesOf(provider) }
  }
  const settle = (transport: FakeTransport, timersBefore: number) => {
    expect(transport.openBodies(), 'a response body was left open').toBe(0)
    expect(timers(), 'a timer was left running').toBeLessThanOrEqual(timersBefore)
  }
  const noKey = (error: unknown) => {
    expect(chain(error), 'the API key appears in an error').not.toContain(CONFORMANCE_API_KEY)
    expect(JSON.stringify(error), 'the API key appears in the serialised error').not.toContain(CONFORMANCE_API_KEY)
  }
  const failing = async (reply: FakeReply, kind: LlmError['kind'], requestCount: number, request: LlmRequest = requests.text) => {
    const timersBefore = timers()
    const { transport, provider } = setup(reply)
    const error = await rejection(provider.generate(request))
    expect(error.kind).toBe(kind)
    expect(transport.requests, 'number of requests sent').toHaveLength(requestCount)
    noKey(error)
    settle(transport, timersBefore)
    return { error, transport }
  }
  const status = (reply: FakeReply) => ('status' in reply ? reply.status : undefined)

  const cases: ConformanceCase[] = [
    {
      name: label('text and schema: data, model, stop reason, usage buckets and the exact request'),
      async run() {
        const timersBefore = timers()
        const { transport, provider } = setup(wire.ok.reply)
        const result = await provider.generate(requests.text)
        expect(result.data).toEqual(wire.ok.data)
        expect(result.usage).toEqual(wire.ok.usage)
        expect(result.model).toBe(wire.ok.model)
        if (wire.ok.stopReason !== undefined) expect(result.stopReason).toBe(wire.ok.stopReason)
        expect(result.requestedModel.length).toBeGreaterThan(0)
        expect(typeof result.fallbackUsed).toBe('boolean')
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
        expect(transport.requests).toHaveLength(1)
        const sent = transport.requests[0]
        expect(sent?.method).toBe('POST')
        if (wire.endpoint !== undefined) expect(sent?.url).toBe(wire.endpoint)
        expect(sent?.json).toEqual(wire.goldens.text)
        expect(Object.values(sent?.headers ?? {}).some((value) => value.includes(CONFORMANCE_API_KEY)), 'the key must travel in a header').toBe(true)
        expect(sent?.body).not.toContain(CONFORMANCE_API_KEY)
        expect(JSON.stringify(result)).not.toContain(CONFORMANCE_API_KEY)
        settle(transport, timersBefore)
      },
    },
    {
      name: label('assistant history is replayed in order and the last turn stays with the user'),
      async run() {
        const { transport, provider } = setup(wire.ok.reply)
        await provider.generate(requests.history)
        if (wire.goldens.history !== undefined) expect(transport.requests[0]?.json).toEqual(wire.goldens.history)
        const text = transport.requests[0]?.body ?? ''
        expect(text.indexOf('first')).toBeGreaterThan(-1)
        expect(text.indexOf('first')).toBeLessThan(text.indexOf('answer'))
        expect(text.indexOf('answer')).toBeLessThan(text.indexOf('second'))
        const prefill = provider.generate({ ...requests.history, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] })
        expect((await rejection(prefill)).kind).toBe('invalid_request')
      },
    },
    {
      name: label('PDF: sent natively, or refused before any request'),
      async run() {
        const { transport, provider, caps } = setup(wire.ok.reply)
        if (caps.documents === 'native-pdf') {
          await provider.generate(requests.pdf)
          expect(transport.requests[0]?.body).toContain(PDF_BASE64)
          expect(wire.goldens.pdf, 'a native PDF provider needs a pdf golden').toBeDefined()
          expect(transport.requests[0]?.json).toEqual(wire.goldens.pdf)
        } else {
          const error = await rejection(provider.generate(requests.pdf))
          expect(error.kind).toBe('invalid_request')
          expect(error.message).toMatch(/PDF/)
          expect(transport.requests).toHaveLength(0)
          noKey(error)
        }
      },
    },
    {
      name: label('images: each declared type is sent, every other type is refused before any request'),
      async run() {
        const { caps } = setup()
        for (const mediaType of IMAGE_TYPES) {
          const { transport, provider } = setup(wire.ok.reply)
          if (caps.images.includes(mediaType)) {
            await provider.generate(requests.image(mediaType))
            expect(transport.requests[0]?.body, mediaType).toContain(PNG_BASE64)
            if (mediaType === 'image/png') expect(transport.requests[0]?.json).toEqual(wire.goldens.image)
          } else {
            const error = await rejection(provider.generate(requests.image(mediaType)))
            expect(error.kind, mediaType).toBe('invalid_request')
            expect(error.message, mediaType).toContain(mediaType)
            expect(transport.requests, mediaType).toHaveLength(0)
          }
        }
      },
    },
    {
      name: label('cache flags: mapped as declared, or ignored without error'),
      async run() {
        const flagged = setup(wire.ok.reply)
        await flagged.provider.generate(requests.cache)
        expect(flagged.transport.requests[0]?.json).toEqual(wire.goldens.cache)
        const { caps } = flagged
        if (caps.cache !== 'explicit') {
          const plain = setup(wire.ok.reply)
          await plain.provider.generate(requests.cacheOff)
          expect(flagged.transport.requests[0]?.json, 'flags must change nothing on this provider').toEqual(plain.transport.requests[0]?.json)
          return
        }
        const limit = caps.maxCacheBreakpoints ?? 0
        expect(limit).toBeGreaterThan(0)
        const over = setup(wire.ok.reply)
        const outcome = await over.provider.generate(requests.overCache(limit + 2)).then(
          () => 'sent',
          (error: unknown) => error,
        )
        if (outcome === 'sent') {
          const again = setup(wire.ok.reply)
          await again.provider.generate(requests.overCache(limit + 2))
          expect(again.transport.requests[0]?.json, 'dropping extra flags must be deterministic').toEqual(over.transport.requests[0]?.json)
        } else {
          expect(outcome).toBeInstanceOf(LlmError)
          expect((outcome as LlmError).kind).toBe('invalid_request')
          expect(over.transport.requests).toHaveLength(0)
        }
      },
    },
    {
      name: label('effort: every level is sent as effortMap says, and an unset level sends effortWhenUnset'),
      async run() {
        const { caps } = setup()
        for (const level of EFFORT_LEVELS) {
          const { transport, provider } = setup(wire.ok.reply)
          await provider.generate({ ...requests.text, effort: level as LlmEffort })
          expect(pointerValue(transport.requests[0]?.json, config.effortPath), level).toBe(caps.effortMap[level])
        }
        const unset = setup(wire.ok.reply)
        await unset.provider.generate(requests.text)
        expect(pointerValue(unset.transport.requests[0]?.json, config.effortPath)).toBe(config.effortWhenUnset)
      },
    },
    {
      name: label('truncated and refused replies become errors that carry the billed usage'),
      async run() {
        const cut = await failing(wire.truncated.reply, 'truncated', 1)
        if (wire.truncated.usage !== undefined) expect(cut.error.usage).toEqual(wire.truncated.usage)
        const refused = await failing(wire.refusal.reply, 'refusal', 1)
        if (wire.refusal.usage !== undefined) expect(refused.error.usage).toEqual(wire.refusal.usage)
      },
    },
    {
      name: label('text that is not JSON is invalid_output and is not retried'),
      async run() {
        await failing(wire.notJson, 'invalid_output', 1)
      },
    },
    {
      name: label('auth: rejected once, status kept, key never echoed'),
      async run() {
        expect(JSON.stringify(wire.auth), 'the auth fixture must echo the key').toContain(CONFORMANCE_API_KEY)
        const { error } = await failing(wire.auth, 'auth', 1)
        expect(error.status).toBe(status(wire.auth))
      },
    },
    {
      name: label('invalid request and context too long are rejected once'),
      async run() {
        const invalid = await failing(wire.invalidRequest, 'invalid_request', 1)
        expect(invalid.error.status).toBe(status(wire.invalidRequest))
        const long = await failing(wire.contextTooLong, 'invalid_request', 1)
        expect(long.error.status).toBe(status(wire.contextTooLong))
      },
    },
    {
      name: label('rate limit: retry-after is read and honoured, two retries at most'),
      async run() {
        const { error, transport } = await failing(wire.rateLimit, 'rate_limit', 3)
        expect(error.retryAfterMs).toBe(RETRY_AFTER_MS)
        expect(error.status).toBe(status(wire.rateLimit))
        expect(transport.sleeps).toHaveLength(2)
        for (const waited of transport.sleeps) expect(waited).toBeGreaterThanOrEqual(RETRY_AFTER_MS)
      },
    },
    {
      name: label('rate limit: a wait that does not fit the deadline fails at once with the rate limit'),
      async run() {
        const { transport, provider } = setup(wire.rateLimit, wire.ok.reply)
        const error = await rejection(provider.generate(requests.text, { timeoutMs: RETRY_AFTER_MS - 1000 }))
        expect(error.kind).toBe('rate_limit')
        expect(error.retryAfterMs).toBe(RETRY_AFTER_MS)
        expect(transport.requests).toHaveLength(1)
        expect(transport.sleeps).toEqual([])
      },
    },
    {
      name: label('overloaded: two retries, then the error'),
      async run() {
        const { error, transport } = await failing(wire.overloaded, 'overloaded', 3)
        expect(error.status).toBe(status(wire.overloaded))
        expect(transport.sleeps).toHaveLength(2)
      },
    },
    {
      name: label('a transient error before any output is retried and the call succeeds'),
      async run() {
        const timersBefore = timers()
        const { transport, provider } = setup(wire.overloaded, wire.ok.reply)
        const result = await provider.generate(requests.text)
        expect(result.data).toEqual(wire.ok.data)
        expect(transport.requests).toHaveLength(2)
        expect(transport.sleeps).toHaveLength(1)
        settle(transport, timersBefore)
      },
    },
    {
      name: label('a connection failure before any output is retried; a persistent one gives up after two retries'),
      async run() {
        const recovered = setup({ kind: 'network-error' }, wire.ok.reply)
        await recovered.provider.generate(requests.text)
        expect(recovered.transport.requests).toHaveLength(2)
        await failing({ kind: 'network-error' }, 'connection', 3)
      },
    },
    {
      name: label('nothing is retried once the first event has arrived'),
      async run() {
        if (wire.ok.reply.kind !== 'sse') return
        const dropped: FakeReply = { ...wire.ok.reply, chunks: wire.ok.reply.chunks.slice(0, 1), then: 'drop' }
        const timersBefore = timers()
        const { transport, provider } = setup(dropped, wire.ok.reply)
        const error = await rejection(provider.generate(requests.text))
        expect(error.kind).toBe('connection')
        expect(transport.requests).toHaveLength(1)
        expect(transport.sleeps).toEqual([])
        settle(transport, timersBefore)
      },
    },
    {
      name: label('abort before the call: aborted, nothing sent'),
      async run() {
        const { transport, provider } = setup(wire.ok.reply)
        const controller = new AbortController()
        controller.abort()
        const error = await rejection(provider.generate(requests.text, { signal: controller.signal }))
        expect(error.kind).toBe('aborted')
        expect(transport.requests).toHaveLength(0)
      },
    },
    {
      name: label('abort during the call: aborted, not retried, body closed, no listener left'),
      async run() {
        const timersBefore = timers()
        const { transport, provider } = setup(prefixOf(wire.ok.reply), wire.ok.reply)
        const controller = new AbortController()
        const pending = rejection(provider.generate(requests.text, { signal: controller.signal }))
        await untilRequested(transport)
        controller.abort()
        const error = await pending
        expect(error.kind).toBe('aborted')
        expect(transport.requests).toHaveLength(1)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        settle(transport, timersBefore)
      },
    },
    {
      name: label('abort after the call finished changes nothing and leaves no listener'),
      async run() {
        const timersBefore = timers()
        const { transport, provider } = setup(wire.ok.reply)
        const controller = new AbortController()
        const result = await provider.generate(requests.text, { signal: controller.signal })
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        controller.abort()
        expect(result.data).toEqual(wire.ok.data)
        settle(transport, timersBefore)
      },
    },
    {
      name: label('deadline: expiry is a timeout, not retried, nothing left running'),
      async run() {
        const timersBefore = timers()
        const { transport, provider } = setup(prefixOf(wire.ok.reply), wire.ok.reply)
        const controller = new AbortController()
        const error = await rejection(provider.generate(requests.text, { signal: controller.signal, timeoutMs: 40 }))
        expect(error.kind).toBe('timeout')
        expect(transport.requests).toHaveLength(1)
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        settle(transport, timersBefore)
      },
    },
    {
      name: label('a timeout that is not a positive number is refused before any request'),
      async run() {
        const { transport, provider } = setup(wire.ok.reply)
        expect((await rejection(provider.generate(requests.text, { timeoutMs: 0 }))).kind).toBe('invalid_request')
        expect((await rejection(provider.generate(requests.text, { timeoutMs: Number.NaN }))).kind).toBe('invalid_request')
        expect(transport.requests).toHaveLength(0)
      },
    },
  ]
  return cases
}

function globalCases(config: ProviderConformance): ConformanceCase[] {
  return [
    {
      name: 'declares a name and capabilities that agree with each other',
      async run() {
        const provider = config.build(createFakeTransport({ apiKey: CONFORMANCE_API_KEY }))
        expect(provider.name.length).toBeGreaterThan(0)
        expect(provider.capabilities, 'a new adapter must declare its capabilities').toBeDefined()
        const caps = capabilitiesOf(provider)
        expect(Object.keys(caps.effortMap).sort()).toEqual([...EFFORT_LEVELS].sort())
        const natives = new Set(caps.effortLevels.map((level) => caps.effortMap[level]))
        expect(natives.size, 'effortLevels must be levels the model really distinguishes').toBe(caps.effortLevels.length)
        for (const level of EFFORT_LEVELS) expect(natives.has(caps.effortMap[level]), `${level} must map to one of the distinguished levels`).toBe(true)
        if (caps.cache === 'explicit') expect(caps.maxCacheBreakpoints).toBeGreaterThan(0)
        expect(caps.dataNote.length).toBeGreaterThan(0)
      },
    },
  ]
}

export function conformanceCases(config: ProviderConformance): ConformanceCase[] {
  const wires = Array.isArray(config.wire) ? (config.wire as readonly ConformanceWire[]) : [config.wire as ConformanceWire]
  return [...globalCases(config), ...wires.flatMap((wire) => conformanceFor(config, wire))]
}

export function describeProviderConformance(config: ProviderConformance): void {
  describe(`${config.name} conformance`, () => {
    for (const entry of conformanceCases(config)) it(entry.name, entry.run)
  })
}
