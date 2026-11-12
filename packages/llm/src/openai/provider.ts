import OpenAI, { APIConnectionError, APIError } from 'openai'
import { DEFAULT_TIMEOUT_MS, STREAMING_ABOVE_MAX_TOKENS } from '../anthropic'
import type { LlmCapabilities } from '../capabilities'
import { modelCapabilities } from '../descriptor'
import { startCall, type FetchFn, type LlmCall } from '../http'
import { withRetry, type RetryAttempt } from '../retry'
import { LlmError, type LlmCallOptions, type LlmProvider, type LlmRequest, type LlmResult } from '../types'
import { classifyOpenAiError, streamFailure } from './errors'
import { OPENAI_MODELS } from './models'
import { buildRequest } from './request'
import { codeError, readResponse } from './reply'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MAX_TOKENS = 16_000

type CreateBody = OpenAI.Responses.ResponseCreateParamsNonStreaming
type StreamingBody = OpenAI.Responses.ResponseCreateParamsStreaming
type Reply = OpenAI.Responses.Response

export interface OpenAiProviderOptions {
  model: string
  apiKey: string
  client?: OpenAI
  fetch?: FetchFn
  baseURL?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  timeoutMs?: number
  maxTokens?: number
}

const OWN_HEADERS = /^(?:accept|authorization|content-type|user-agent|x-stainless-[a-z-]+)$/

function ownHeadersOnly(inner: FetchFn | undefined): FetchFn {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    for (const name of [...headers.keys()]) if (!OWN_HEADERS.test(name)) headers.delete(name)
    return (inner ?? globalThis.fetch)(input, { ...init, headers })
  }
}

export function createOpenAiClient(options: { apiKey: string; fetch?: FetchFn; baseURL?: string; timeoutMs?: number }): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? OPENAI_BASE_URL,
    maxRetries: 0,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    organization: null,
    project: null,
    webhookSecret: null,
    adminAPIKey: null,
    logLevel: 'off',
    fetch: ownHeadersOnly(options.fetch),
  })
}

const isFrameError = (error: unknown): boolean => error instanceof APIError && !(error instanceof APIConnectionError) && error.status === undefined

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai'
  readonly capabilities: LlmCapabilities
  private readonly modelId: string
  private readonly client: OpenAI
  private readonly secrets: readonly string[]
  private readonly timeout: number
  private readonly maxTokens: number
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
  private readonly random: (() => number) | undefined

  constructor(options: OpenAiProviderOptions) {
    if (!OPENAI_MODELS.some((entry) => entry.id === options.model)) {
      throw new LlmError('invalid_request', `unknown OpenAI model '${options.model}'; known models: ${OPENAI_MODELS.map((entry) => entry.id).join(', ')}`)
    }
    this.modelId = options.model
    this.capabilities = modelCapabilities(OPENAI_MODELS, options.model)
    this.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.secrets = [options.apiKey]
    this.sleep = options.sleep
    this.random = options.random
    this.client =
      options.client ??
      createOpenAiClient({
        apiKey: options.apiKey,
        timeoutMs: this.timeout,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      })
  }

  get model(): string {
    return this.modelId
  }

  async generate(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmResult> {
    const built = buildRequest(request, { model: this.modelId, caps: this.capabilities, defaultMaxTokens: this.maxTokens })
    const streaming = built.maxTokens > STREAMING_ABOVE_MAX_TOKENS
    const call = startCall(callOptions.timeoutMs ?? this.timeout, callOptions.signal)
    const startedAt = Date.now()
    try {
      const reply = await withRetry((attempt) => this.attempt(built.body, streaming, call, attempt), {
        signal: call.signal,
        abortError: call.abortError,
        remainingMs: call.remainingMs,
        ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
        ...(this.random === undefined ? {} : { random: this.random }),
      })
      return readResponse(reply, { requestedModel: this.modelId, secrets: this.secrets, restore: built.restore, startedAt })
    } finally {
      call.dispose()
    }
  }

  private async attempt(body: CreateBody, streaming: boolean, call: LlmCall, attempt: RetryAttempt): Promise<Reply> {
    if (call.signal.aborted) throw call.abortError()
    const options = { signal: call.signal, timeout: call.timeoutMs, maxRetries: 0 }
    try {
      if (!streaming) return await this.client.responses.create(body, options)
      const events = await this.client.responses.create({ ...body, stream: true } satisfies StreamingBody, options)
      try {
        for await (const event of events) {
          attempt.outputStarted()
          if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') return event.response
          if (event.type === 'error') throw codeError(event.code, event.message, this.secrets)
        }
      } catch (error) {
        if (isFrameError(error)) attempt.outputStarted()
        throw streamFailure(error, call, this.secrets)
      }
      if (call.signal.aborted) throw call.abortError()
      throw new LlmError('connection', 'the model reply stream ended before its final event')
    } catch (error) {
      throw classifyOpenAiError(error, call, this.secrets)
    }
  }
}
