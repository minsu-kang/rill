import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { GeminiProvider, LIVE_CHECKS, geminiDescriptor } from '../../src/gemini'
import { plainFetch } from '../../src/gemini/provider'
import { LlmError, capabilitiesOf, createProvider, findModel, modelCapabilities, type LlmProvider, type LlmRequest } from '../../src/index'
import { CONFORMANCE_API_KEY, CONFORMANCE_DATA, CONFORMANCE_SCHEMA } from '../conformance'
import { createFakeTransport } from '../fake-transport'
import { GEMINI_ENDPOINT, GEMINI_MODEL, RAW_USAGE, streamEvents, streamReply, type WireEvent } from './wire'

const request: LlmRequest = { schema: CONFORMANCE_SCHEMA, maxTokens: 20_000, messages: [{ role: 'user', content: 'hello' }] }

describe('geminiDescriptor', () => {
  it('names the provider, its key variable and the four models of the table', () => {
    expect(geminiDescriptor).toMatchObject({ id: 'gemini', label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY' })
    expect(geminiDescriptor.models.map((model) => model.id)).toEqual(['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'])
  })

  it('exports its live checks, with a short unique id and a question for each', () => {
    expect(geminiDescriptor.liveChecks).toBe(LIVE_CHECKS)
    expect(LIVE_CHECKS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(LIVE_CHECKS.map((check) => check.id)).size).toBe(LIVE_CHECKS.length)
    for (const check of LIVE_CHECKS) {
      expect(check.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(check.what.length).toBeGreaterThan(20)
    }
  })

  it('has a live check for every fact the reports leave open that the adapter relies on', () => {
    const ids = LIVE_CHECKS.map((check) => check.id)
    for (const wanted of [
      'usage-input-includes-cached',
      'usage-thoughts-separate',
      'implicit-cache-minimum-flash-lite',
      'gif-support',
      'xhigh-acceptance',
      'schema-compile-latency',
      'replay-assistant-text-only',
      'non-streaming-output-cap',
      'invalid-key-response',
      'retry-delay-hints',
    ]) {
      expect(ids, wanted).toContain(wanted)
    }
  })

  it('warns in its data note that a free key lets Google train on and review the content', () => {
    for (const model of geminiDescriptor.models) {
      expect(model.capabilities.dataNote).toMatch(/free/i)
      expect(model.capabilities.dataNote).toMatch(/training/i)
      expect(model.capabilities.dataNote).toMatch(/review/i)
    }
  })

  it('declares what Gemini can do', () => {
    for (const model of geminiDescriptor.models) {
      expect(model.capabilities).toMatchObject({
        structuredOutput: 'strict',
        documents: 'native-pdf',
        images: ['image/png', 'image/jpeg', 'image/webp'],
        cache: 'automatic',
        streaming: 'required',
        reasoningCappedByMaxTokens: true,
        effortLevels: ['low', 'medium', 'high'],
      })
      expect(model.capabilities.maxCacheBreakpoints).toBeUndefined()
    }
  })

  it('is found by the registry and builds a Gemini provider from the key in the environment', () => {
    const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
    const provider = createProvider('gemini:gemini-3.8-flash', { env: { GEMINI_API_KEY: transport.apiKey }, fetch: transport.fetch })
    expect(provider).toBeInstanceOf(GeminiProvider)
    expect(provider.name).toBe('gemini')
    expect(capabilitiesOf(provider)).toBe(modelCapabilities(geminiDescriptor.models, 'gemini-3.8-flash'))
    expect(findModel('gemini:gemini-4-carbon')?.provider).toBe('gemini')
  })

  it('waits three minutes for a reply by default', () => {
    const provider = new GeminiProvider({ model: GEMINI_MODEL, apiKey: CONFORMANCE_API_KEY })
    expect(provider.timeoutMs).toBe(180_000)
    expect(provider.model).toBe(GEMINI_MODEL)
    expect(new GeminiProvider({ model: GEMINI_MODEL, apiKey: CONFORMANCE_API_KEY, timeoutMs: 5000 }).timeoutMs).toBe(5000)
  })

  it('refuses an unknown model, in the registry and when built directly', () => {
    expect(() => createProvider('gemini:gemini-9', { env: { GEMINI_API_KEY: 'k'.repeat(8) } })).toThrow(/known models: gemini-4-carbon/)
    expect(() => new GeminiProvider({ model: 'gemini-9', apiKey: 'k'.repeat(8) })).toThrow(LlmError)
    expect(() => new GeminiProvider({ model: 'gemini-9', apiKey: 'k'.repeat(8) })).toThrow(/gemini-4-carbon/)
  })
})

describe('GeminiProvider endpoint', () => {
  it('posts to the Interactions endpoint under v1beta by default', async () => {
    const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
    transport.script(streamReply(JSON.stringify(CONFORMANCE_DATA)))
    const provider = createProvider('gemini:gemini-3.8-flash', { env: { GEMINI_API_KEY: transport.apiKey }, fetch: transport.fetch, sleep: transport.sleep })
    await provider.generate(request)
    expect(transport.requests[0]?.url).toBe(GEMINI_ENDPOINT)
  })

  it('uses the injected SDK client of the factory options instead of building one', async () => {
    const created: unknown[] = []
    const client = {
      interactions: {
        create: async (params: unknown) => {
          created.push(params)
          return new ReadableStream<unknown>({
            start(controller) {
              for (const event of streamEvents(JSON.stringify(CONFORMANCE_DATA))) if (typeof event.data === 'object') controller.enqueue(event.data)
              controller.close()
            },
          })
        },
      },
    }
    const provider = createProvider('gemini:gemini-3.8-flash', { env: { GEMINI_API_KEY: CONFORMANCE_API_KEY }, client })
    expect((await provider.generate(request)).data).toEqual(CONFORMANCE_DATA)
    expect(created).toHaveLength(1)
  })

  it('uses a base URL override from the factory options', async () => {
    const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
    transport.script(streamReply(JSON.stringify(CONFORMANCE_DATA)))
    const provider = createProvider('gemini:gemini-3.8-flash', { env: { GEMINI_API_KEY: transport.apiKey }, fetch: transport.fetch, baseURL: 'https://proxy.test/gemini/' })
    await provider.generate(request)
    expect(transport.requests[0]?.url).toBe('https://proxy.test/gemini/v1beta/interactions')
  })
})

describe('plainFetch', () => {
  const seen: Array<{ input: unknown; init: RequestInit | undefined }> = []
  const inner = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ input, init })
    return new Response('ok')
  }

  it('hands a Request to the inner fetch as a URL and an init with a string body, headers, method and signal', async () => {
    seen.length = 0
    const controller = new AbortController()
    const request = new Request('https://api.test/x?y=1', { method: 'POST', headers: { 'x-a': '1' }, body: '{"k":true}', signal: controller.signal })
    await plainFetch(inner)(request)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.input).toBe('https://api.test/x?y=1')
    expect(seen[0]?.init?.method).toBe('POST')
    expect(seen[0]?.init?.body).toBe('{"k":true}')
    expect(new Headers(seen[0]?.init?.headers).get('x-a')).toBe('1')
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.init?.signal?.aborted).toBe(false)
    controller.abort()
    expect(seen[0]?.init?.signal?.aborted).toBe(true)
  })

  it('sends no body for a request that cannot have one', async () => {
    seen.length = 0
    await plainFetch(inner)(new Request('https://api.test/x'))
    expect(seen[0]?.init).not.toHaveProperty('body')
    expect(seen[0]?.init?.method).toBe('GET')
  })

  it('passes a URL string and its init through untouched', async () => {
    seen.length = 0
    const init = { method: 'POST', body: 'x' }
    await plainFetch(inner)('https://api.test/y', init)
    expect(seen[0]).toEqual({ input: 'https://api.test/y', init })
  })
})

interface Created {
  params: Record<string, unknown>
  options: Record<string, unknown>
}

function fakeClient(events: readonly WireEvent[]): { client: unknown; created: Created[]; streams: ReadableStream<unknown>[] } {
  const created: Created[] = []
  const streams: ReadableStream<unknown>[] = []
  const client = {
    interactions: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        created.push({ params, options })
        const stream = new ReadableStream<unknown>({
          start(controller) {
            for (const event of events) if (typeof event.data === 'object') controller.enqueue(event.data)
            controller.close()
          },
        })
        streams.push(stream)
        return stream
      },
    },
  }
  return { client, created, streams }
}

describe('GeminiProvider with an injected SDK client', () => {
  const build = (client: unknown): LlmProvider => new GeminiProvider({ model: GEMINI_MODEL, apiKey: CONFORMANCE_API_KEY, client: client as never })

  it('calls interactions.create once, with store off, streaming on, retries off and the call signal', async () => {
    const { client, created } = fakeClient(streamEvents(JSON.stringify(CONFORMANCE_DATA)))
    const result = await build(client).generate({ ...request, system: 'sys', effort: 'high' })
    expect(result.data).toEqual(CONFORMANCE_DATA)
    expect(result.usage.cacheReadInputTokens).toBe(RAW_USAGE.total_cached_tokens)
    expect(created).toHaveLength(1)
    expect(created[0]?.params).toMatchObject({ model: GEMINI_MODEL, store: false, stream: true, system_instruction: 'sys', generation_config: { thinking_level: 'high' } })
    expect(created[0]?.options.retries).toEqual({ strategy: 'none' })
    expect(created[0]?.options.signal).toBeInstanceOf(AbortSignal)
  })

  it('reads the stream it was given to the end and lets go of it', async () => {
    const { client, created, streams } = fakeClient(streamEvents(JSON.stringify(CONFORMANCE_DATA)))
    await build(client).generate(request)
    expect(created).toHaveLength(1)
    expect(streams[0]?.locked).toBe(false)
  })

  it('refuses a client reply that is not a stream, without retrying', async () => {
    let calls = 0
    const client = {
      interactions: {
        create: async () => {
          calls += 1
          return { id: 'v1', status: 'completed' }
        },
      },
    }
    const error = await build(client).generate(request).then(
      () => undefined,
      (caught: unknown) => caught as LlmError,
    )
    expect(error).toMatchObject({ kind: 'invalid_output' })
    expect(calls).toBe(1)
  })

  describe('when the HTTP layer never reports an abort', () => {
    const silentStream = (events: readonly unknown[], onCancel: () => void) =>
      new ReadableStream<unknown>({
        start(controller) {
          for (const event of events) controller.enqueue(event)
        },
        pull: () => new Promise<void>(() => undefined),
        cancel: onCancel,
      })
    const first = [{ event_type: 'interaction.created', interaction: { id: 'v1', status: 'in_progress', model: GEMINI_MODEL } }]

    it('stops waiting for the next event and cancels the stream when the caller aborts', async () => {
      let cancelled = 0
      const client = { interactions: { create: async () => silentStream(first, () => void (cancelled += 1)) } }
      const controller = new AbortController()
      const pending = build(client).generate(request, { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
      expect(cancelled).toBe(1)
    })

    it('reports the deadline as a timeout', async () => {
      let cancelled = 0
      const client = { interactions: { create: async () => silentStream(first, () => void (cancelled += 1)) } }
      await expect(build(client).generate(request, { timeoutMs: 30 })).rejects.toMatchObject({ kind: 'timeout' })
      expect(cancelled).toBe(1)
    })

    it('stops waiting for the reply to start, and closes a stream that arrives late', async () => {
      let cancelled = 0
      let release: (stream: ReadableStream<unknown>) => void = () => undefined
      const client = { interactions: { create: () => new Promise<ReadableStream<unknown>>((resolve) => (release = resolve)) } }
      const controller = new AbortController()
      const pending = build(client).generate(request, { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
      release(silentStream(first, () => void (cancelled += 1)))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(cancelled).toBe(1)
    })
  })

  it('reports a deadline that expires while waiting to retry as a timeout, not as a cancel', async () => {
    const client = { interactions: { create: async () => Promise.reject(Object.assign(new Error('503 busy'), { status: 503, headers: new Headers(), body: JSON.stringify({ error: { code: 'service_unavailable', message: 'busy' } }) })) } }
    const provider = new GeminiProvider({ model: GEMINI_MODEL, apiKey: CONFORMANCE_API_KEY, client: client as never, sleep: () => new Promise<void>(() => undefined), random: () => 0 })
    await expect(provider.generate(request, { timeoutMs: 600 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('leaves no abort listener on the signal it handed to the client', async () => {
    const { client, created } = fakeClient(streamEvents(JSON.stringify(CONFORMANCE_DATA)))
    await build(client).generate(request)
    const signal = created[0]?.options.signal as AbortSignal
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('retries an SDK error that carries a 503 and then gives up after two retries', async () => {
    let calls = 0
    const client = {
      interactions: {
        create: async () => {
          calls += 1
          throw Object.assign(new Error('503 busy'), { status: 503, headers: new Headers(), body: JSON.stringify({ error: { code: 'service_unavailable', message: 'busy' } }) })
        },
      },
    }
    const sleeps: number[] = []
    const provider = new GeminiProvider({ model: GEMINI_MODEL, apiKey: CONFORMANCE_API_KEY, client: client as never, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 })
    const error = await provider.generate(request).then(
      () => undefined,
      (caught: unknown) => caught as LlmError,
    )
    expect(error).toMatchObject({ kind: 'overloaded', status: 503 })
    expect(calls).toBe(3)
    expect(sleeps).toHaveLength(2)
  })
})
