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
  type LlmSystemBlock,
  type LlmUsage,
} from './types'

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_CACHE_BREAKPOINTS = 4
export const MAX_CALL_TIMEOUT_MS = 2_147_483_647
export const STREAMING_ABOVE_MAX_TOKENS = 16_000
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
    iterations?: unknown
  }
}

interface Iteration {
  type: string
  model: string | null
  usage: LlmUsage
}

function isReply(value: unknown): value is Reply {
  if (typeof value !== 'object' || value === null) return false
  const reply = value as { content?: unknown; usage?: unknown }
  if (!Array.isArray(reply.content)) return false
  const usage = reply.usage as { input_tokens?: unknown; output_tokens?: unknown } | null | undefined
  return typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number'
}

function cacheControl(cache: boolean | undefined) {
  return cache === true ? { cache_control: { type: 'ephemeral' as const } } : {}
}

const SERVING_ITERATIONS: ReadonlySet<string> = new Set(['message', 'fallback_message'])

const iterationType = (entry: unknown): unknown =>
  typeof entry === 'object' && entry !== null ? (entry as { type?: unknown }).type : undefined

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function rawIterations(reply: Reply): unknown[] {
  return Array.isArray(reply.usage.iterations) ? reply.usage.iterations : []
}

function readIteration(entry: unknown): Iteration | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const fields = entry as Record<string, unknown>
  if (!isCount(fields.input_tokens) || !isCount(fields.output_tokens)) return undefined
  return {
    type: typeof fields.type === 'string' ? fields.type : '',
    model: typeof fields.model === 'string' ? fields.model : null,
    usage: {
      inputTokens: fields.input_tokens,
      outputTokens: fields.output_tokens,
      cacheReadInputTokens: isCount(fields.cache_read_input_tokens) ? fields.cache_read_input_tokens : 0,
      cacheCreationInputTokens: isCount(fields.cache_creation_input_tokens) ? fields.cache_creation_input_tokens : 0,
    },
  }
}

function usageOf(reply: Reply): { usage: LlmUsage; servedModels: string[] } {
  const iterations = rawIterations(reply).flatMap((entry) => readIteration(entry) ?? [])
  if (iterations.length === 0) {
    return {
      servedModels: [reply.model],
      usage: {
        inputTokens: reply.usage.input_tokens,
        outputTokens: reply.usage.output_tokens,
        cacheReadInputTokens: reply.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: reply.usage.cache_creation_input_tokens ?? 0,
      },
    }
  }
  const served = iterations
    .filter((entry) => SERVING_ITERATIONS.has(entry.type) && entry.usage.outputTokens > 0)
    .flatMap((entry) => entry.model ?? [])
    .reverse()
  return {
    servedModels: served.length === 0 ? [reply.model] : [...new Set(served)],
    usage: {
      inputTokens: iterations.reduce((sum, entry) => sum + entry.usage.inputTokens, 0),
      outputTokens: iterations.reduce((sum, entry) => sum + entry.usage.outputTokens, 0),
      cacheReadInputTokens: iterations.reduce((sum, entry) => sum + entry.usage.cacheReadInputTokens, 0),
      cacheCreationInputTokens: iterations.reduce((sum, entry) => sum + entry.usage.cacheCreationInputTokens, 0),
    },
  }
}

function toBlock(part: LlmPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, ...cacheControl(part.cache) }
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: part.mediaType, data: part.data },
        ...cacheControl(part.cache),
      }
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.data },
        ...cacheControl(part.cache),
      }
  }
}

function toSystemBlock(block: LlmSystemBlock): Anthropic.TextBlockParam {
  return { type: 'text', text: block.text, ...cacheControl(block.cache) }
}

function systemParam(system: LlmRequest['system']): { system?: string | Anthropic.TextBlockParam[] } {
  if (system === undefined) return {}
  if (typeof system === 'string') return { system }
  return system.length === 0 ? {} : { system: system.map(toSystemBlock) }
}

function countBreakpoints(request: LlmRequest): number {
  let count = request.cache === true ? 1 : 0
  if (request.system !== undefined && typeof request.system !== 'string') {
    count += request.system.filter((block) => block.cache === true).length
  }
  for (const message of request.messages) {
    if (typeof message.content !== 'string') count += message.content.filter((part) => part.cache === true).length
  }
  return count
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
  const { usage, servedModels } = usageOf(reply)
  return {
    data,
    model: reply.model,
    requestedModel,
    stopReason: reply.stop_reason ?? 'unknown',
    durationMs: Date.now() - startedAt,
    fallbackUsed: lastFallback >= 0 || rawIterations(reply).some((entry) => iterationType(entry) === 'fallback_message'),
    usage,
    servedModels,
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
    const breakpoints = countBreakpoints(request)
    if (breakpoints > MAX_CACHE_BREAKPOINTS) {
      throw new LlmError(
        'invalid_request',
        `a request can carry at most ${MAX_CACHE_BREAKPOINTS} cache breakpoints (system blocks, content parts and the cache flag together), got ${breakpoints}`,
      )
    }
    const { timeoutMs } = callOptions
    if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_CALL_TIMEOUT_MS)) {
      throw new LlmError('invalid_request', `timeoutMs must be a number of milliseconds between 1 and ${MAX_CALL_TIMEOUT_MS}, got ${timeoutMs}`)
    }
    const maxTokens = request.maxTokens ?? this.maxTokens
    const base = {
      model: this.modelId,
      max_tokens: maxTokens,
      messages: request.messages.map(toMessage),
      output_config: {
        effort: request.effort ?? this.effort,
        format: { type: 'json_schema' as const, schema: request.schema },
      },
      ...systemParam(request.system),
      ...cacheControl(request.cache),
    }
    const requestOptions = { signal: callOptions.signal, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }
    const streaming = maxTokens > STREAMING_ABOVE_MAX_TOKENS
    const startedAt = Date.now()
    let reply: unknown
    try {
      const client = this.client()
      if (this.refusalFallback) {
        const params = { ...base, betas: [FALLBACK_BETA], fallbacks: 'default' } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
        reply = streaming
          ? await client.beta.messages.stream(params, requestOptions).finalMessage()
          : await client.beta.messages.create(params, requestOptions)
      } else {
        reply = streaming
          ? await client.messages.stream(base, requestOptions).finalMessage()
          : await client.messages.create(base, requestOptions)
      }
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
