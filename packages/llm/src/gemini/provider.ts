import type { GoogleGenAIRequestOptions } from '@google/genai'
import type { LlmCapabilities } from '../capabilities'
import { startCall, type FetchFn, type LlmCall } from '../http'
import { withRetry, type RetryAttempt } from '../retry'
import { LlmError, type LlmCallOptions, type LlmProvider, type LlmRequest, type LlmResult } from '../types'
import { eventError, sdkFailure } from './errors'
import { GEMINI_MODELS } from './models'
import { InteractionReader, interactionResult } from './reply'
import { buildRequest, type GeminiParams } from './request'

export const DEFAULT_TIMEOUT_MS = 180_000
export const DEFAULT_MAX_TOKENS = 32_768
const API_VERSION = 'v1beta'
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/'

export interface GeminiClient {
  interactions: { create(params: GeminiParams, options?: GoogleGenAIRequestOptions): Promise<unknown> }
}

export interface GeminiProviderOptions {
  model: string
  apiKey: string
  fetch?: FetchFn
  client?: GeminiClient
  baseURL?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxRetries?: number
  timeoutMs?: number
  maxTokens?: number
}

interface EventStream {
  getReader(): ReadableStreamDefaultReader<unknown>
}

const isEventStream = (value: unknown): value is EventStream => typeof (value as Partial<EventStream> | null)?.getReader === 'function'

interface Abortion {
  promise: Promise<never>
  dispose(): void
}

function abortion(call: LlmCall): Abortion {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(call.abortError())
    call.signal.addEventListener('abort', listener, { once: true })
  })
  promise.catch(() => undefined)
  return { promise, dispose: () => listener !== undefined && call.signal.removeEventListener('abort', listener) }
}

async function closeStream(stream: unknown): Promise<void> {
  if (!isEventStream(stream)) return
  const reader = stream.getReader()
  await reader.cancel().catch(() => undefined)
  reader.releaseLock()
}

export function plainFetch(inner: FetchFn): FetchFn {
  return async (input, init) => {
    if (!(input instanceof Request)) return inner(input, init)
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD'
    return inner(input.url, { method: input.method, headers: input.headers, signal: input.signal, ...(hasBody ? { body: await input.text() } : {}) })
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini'
  readonly capabilities: LlmCapabilities
  private readonly modelId: string
  private readonly timeout: number
  private readonly maxTokens: number
  private readonly secrets: readonly string[]
  private pending: Promise<GeminiClient> | undefined

  constructor(private readonly options: GeminiProviderOptions) {
    const info = GEMINI_MODELS.find((entry) => entry.id === options.model)
    if (info === undefined) {
      throw new LlmError('invalid_request', `unknown model '${options.model}' for Google Gemini; known models: ${GEMINI_MODELS.map((entry) => entry.id).join(', ')}`)
    }
    this.capabilities = info.capabilities
    this.modelId = options.model
    this.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.secrets = [options.apiKey]
    if (options.client !== undefined) this.pending = Promise.resolve(options.client)
  }

  get model(): string {
    return this.modelId
  }

  get timeoutMs(): number {
    return this.timeout
  }

  async generate(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmResult> {
    const params = buildRequest(this.modelId, this.capabilities, request, this.maxTokens)
    const call = startCall(callOptions.timeoutMs ?? this.timeout, callOptions.signal)
    const startedAt = Date.now()
    try {
      return await withRetry((attempt) => this.attempt(params, call, attempt, startedAt), {
        signal: call.signal,
        abortError: () => call.abortError(),
        remainingMs: () => call.remainingMs(),
        shouldRetry: (error) => error.category !== 'quota_exceeded',
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
        ...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
      })
    } finally {
      call.dispose()
    }
  }

  private async attempt(params: GeminiParams, call: LlmCall, attempt: RetryAttempt, startedAt: number): Promise<LlmResult> {
    if (call.signal.aborted) throw call.abortError()
    const aborted = abortion(call)
    try {
      const stream = await this.open(params, call, aborted.promise)
      const reader = stream.getReader()
      try {
        return await this.read(reader, attempt, startedAt, aborted.promise)
      } catch (error) {
        throw sdkFailure(error, call, this.secrets)
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } finally {
      aborted.dispose()
    }
  }

  private async open(params: GeminiParams, call: LlmCall, aborted: Promise<never>): Promise<EventStream> {
    const creating = this.client().then((client) => client.interactions.create(params, { signal: call.signal, retries: { strategy: 'none' } }))
    let stream: unknown
    try {
      stream = await Promise.race([creating, aborted])
    } catch (error) {
      void creating.then(closeStream, () => undefined)
      throw sdkFailure(error, call, this.secrets)
    }
    if (!isEventStream(stream)) throw new LlmError('invalid_output', 'the model provider answered a streaming request with a body that is not a stream')
    return stream
  }

  private async read(reader: ReadableStreamDefaultReader<unknown>, attempt: RetryAttempt, startedAt: number, aborted: Promise<never>): Promise<LlmResult> {
    const events = new InteractionReader()
    for (let first = true; ; first = false) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      if (first) attempt.outputStarted()
      events.push(value)
      if (events.failure !== undefined) throw eventError(events.failure.code, events.failure.message, this.secrets)
    }
    return interactionResult(events, this.modelId, startedAt, this.secrets)
  }

  private client(): Promise<GeminiClient> {
    this.pending ??= this.create()
    return this.pending
  }

  private async create(): Promise<GeminiClient> {
    const { GoogleGenAI } = await import('@google/genai')
    const { fetch, baseURL, apiKey } = this.options
    return new GoogleGenAI({
      apiKey,
      apiVersion: API_VERSION,
      vertexai: false,
      httpOptions: { baseUrl: baseURL ?? DEFAULT_BASE_URL, ...(fetch === undefined ? {} : { fetch: plainFetch(fetch) }) },
    })
  }
}
