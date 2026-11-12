import { DEFAULT_TIMEOUT_MS } from '../anthropic'
import type { LlmCapabilities } from '../capabilities'
import { classifyHttp } from '../classify'
import { modelCapabilities } from '../descriptor'
import { postStream, startCall, type FetchFn, type HttpClassifier, type LlmCall } from '../http'
import { withRetry, type RetryAttempt } from '../retry'
import { LlmError, type LlmCallOptions, type LlmEffort, type LlmProvider, type LlmRequest, type LlmResult } from '../types'
import { META_MODELS } from './models'
import { ChatAccumulator, toResult, type ChatReply } from './reply'
import { META_BASE_URL, buildChatRequest, type ChatBody } from './request'

const DEFAULT_MAX_TOKENS = 16_000
const FORBIDDEN_HINT = 'the API key may not include this model, or the model is not offered in your region'

export interface MetaProviderOptions {
  model: string
  apiKey: string
  fetch?: FetchFn
  baseURL?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxRetries?: number
  maxTokens?: number
  timeoutMs?: number
}

function defaultEffort(model: string): LlmEffort {
  return model === 'muse-ember-1.0' ? 'medium' : 'high'
}

function classifier(apiKey: string): HttpClassifier {
  return (status, body, headers) => {
    const error = classifyHttp(status, body, headers, {
      secrets: [apiKey],
      kindFor: (info) => (info.code === 'content_policy_violation' ? 'refusal' : info.status === 403 ? 'auth' : undefined),
    })
    if (status !== 403) return error
    return new LlmError(error.kind, `${error.message}; ${FORBIDDEN_HINT}`, {
      status,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.category === undefined ? {} : { category: error.category }),
    })
  }
}

export class MetaProvider implements LlmProvider {
  readonly name = 'meta'
  readonly capabilities: LlmCapabilities
  private readonly modelId: string
  private readonly url: string
  private readonly maxTokens: number
  private readonly timeout: number
  private readonly fetchFn: FetchFn
  private readonly classify: HttpClassifier

  constructor(private readonly options: MetaProviderOptions) {
    const model = options.model
    if (model.toLowerCase().endsWith('-contributor')) {
      throw new LlmError('invalid_request', `'${model}' is a contributor model that trains on your content, so it is never used`)
    }
    if (!META_MODELS.some((entry) => entry.id === model)) {
      throw new LlmError('invalid_request', `unknown Meta model '${model}'; known models: ${META_MODELS.map((entry) => entry.id).join(', ')}`)
    }
    this.modelId = model
    this.capabilities = modelCapabilities(META_MODELS, model)
    this.url = `${(options.baseURL ?? META_BASE_URL).replace(/\/+$/, '')}/chat/completions`
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.classify = classifier(options.apiKey)
  }

  get model(): string {
    return this.modelId
  }

  async generate(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmResult> {
    const body = buildChatRequest({
      model: this.modelId,
      capabilities: this.capabilities,
      request,
      maxTokens: request.maxTokens ?? this.maxTokens,
      defaultEffort: defaultEffort(this.modelId),
    })
    const call = startCall(callOptions.timeoutMs ?? this.timeout, callOptions.signal)
    const startedAt = Date.now()
    try {
      const reply = await withRetry((attempt) => this.attempt(body, call, attempt), {
        signal: call.signal,
        abortError: () => call.abortError(),
        remainingMs: () => call.remainingMs(),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
        ...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
      })
      return toResult(reply, this.modelId, startedAt)
    } finally {
      call.dispose()
    }
  }

  private async attempt(body: ChatBody, call: LlmCall, attempt: RetryAttempt): Promise<ChatReply> {
    const { apiKey } = this.options
    const stream = await postStream(
      { url: this.url, headers: { authorization: `Bearer ${apiKey}` }, body, fetch: this.fetchFn, call, classify: this.classify },
      { onFirstEvent: () => attempt.outputStarted() },
    )
    try {
      const accumulator = new ChatAccumulator([apiKey])
      for await (const event of stream.events) accumulator.push(event)
      return accumulator.finish()
    } finally {
      await stream.close()
    }
  }
}
