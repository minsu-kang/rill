import Anthropic from '@anthropic-ai/sdk'
import { classifyError } from './classify'
import {
  LlmError,
  type LlmCallOptions,
  type LlmEffort,
  type LlmMessage,
  type LlmPart,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from './types'

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_TIMEOUT_MS = 120_000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export interface AnthropicProviderOptions {
  model?: string
  effort?: LlmEffort
  maxTokens?: number
  refusalFallback?: boolean
  apiKey?: string
  baseURL?: string
  maxRetries?: number
  timeoutMs?: number
  client?: Anthropic
}

interface Reply {
  model: string
  stop_reason: string | null
  stop_details?: { category?: string | null } | null
  content: ReadonlyArray<{ type: string; text?: string }>
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
    iterations?: ReadonlyArray<{ type: string }> | null
  }
}

function isReply(value: unknown): value is Reply {
  if (typeof value !== 'object' || value === null) return false
  const reply = value as { content?: unknown; usage?: unknown }
  if (!Array.isArray(reply.content)) return false
  const usage = reply.usage as { input_tokens?: unknown; output_tokens?: unknown } | null | undefined
  return typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number'
}

function toBlock(part: LlmPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'document':
      return { type: 'document', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
  }
}

function toMessage(message: LlmMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map(toBlock),
  }
}

function toResult(reply: unknown, requestedModel: string, startedAt: number): LlmResult {
  if (!isReply(reply)) {
    throw new LlmError('invalid_output', 'the model provider returned an unexpected response')
  }
  if (reply.stop_reason === 'refusal') {
    const category = reply.stop_details?.category ?? undefined
    throw new LlmError('refusal', `the model declined this request${category ? ` (${category})` : ''}`, { category })
  }
  if (reply.stop_reason === 'max_tokens' || reply.stop_reason === 'model_context_window_exceeded') {
    throw new LlmError('truncated', 'the model reply was cut off before it finished; raise maxTokens or shorten the input')
  }
  const lastFallback = reply.content.map((block) => block.type).lastIndexOf('fallback')
  const text = reply.content
    .slice(lastFallback + 1)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  if (text === '') throw new LlmError('invalid_output', 'the model reply had no text')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new LlmError('invalid_output', 'the model reply was not valid JSON', { cause: error })
  }
  return {
    data,
    model: reply.model,
    requestedModel,
    stopReason: reply.stop_reason ?? 'unknown',
    durationMs: Date.now() - startedAt,
    fallbackUsed: lastFallback >= 0 || (reply.usage.iterations ?? []).some((entry) => entry.type === 'fallback_message'),
    usage: {
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
      cacheReadInputTokens: reply.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: reply.usage.cache_creation_input_tokens ?? 0,
    },
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  private readonly options: AnthropicProviderOptions
  private readonly modelId: string
  private readonly effort: LlmEffort
  private readonly maxTokens: number
  private readonly timeout: number
  private readonly refusalFallback: boolean
  private instance: Anthropic | undefined

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options
    this.modelId = options.model ?? DEFAULT_MODEL
    this.effort = options.effort ?? 'medium'
    this.maxTokens = options.maxTokens ?? 16_000
    this.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.refusalFallback = options.refusalFallback ?? !this.modelId.startsWith('claude-haiku')
    this.instance = options.client
  }

  get model(): string {
    return this.modelId
  }

  get timeoutMs(): number {
    return this.timeout
  }

  async generate(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmResult> {
    if (request.messages.at(-1)?.role !== 'user') {
      throw new LlmError('invalid_request', 'the last message must come from the user (assistant prefill is not supported)')
    }
    const base = {
      model: this.modelId,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages: request.messages.map(toMessage),
      output_config: {
        effort: request.effort ?? this.effort,
        format: { type: 'json_schema' as const, schema: request.schema },
      },
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(request.cache === true ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }
    const requestOptions = { signal: callOptions.signal }
    const startedAt = Date.now()
    let reply: unknown
    try {
      const client = this.client()
      reply = this.refusalFallback
        ? await client.beta.messages.create(
            { ...base, betas: [FALLBACK_BETA], fallbacks: 'default' } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
            requestOptions,
          )
        : await client.messages.create(base, requestOptions)
    } catch (error) {
      throw classifyError(error)
    }
    return toResult(reply, this.modelId, startedAt)
  }

  private client(): Anthropic {
    this.instance ??= new Anthropic({
      timeout: this.timeout,
      ...(this.options.apiKey === undefined ? {} : { apiKey: this.options.apiKey }),
      ...(this.options.baseURL === undefined ? {} : { baseURL: this.options.baseURL }),
      ...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
    })
    return this.instance
  }
}
