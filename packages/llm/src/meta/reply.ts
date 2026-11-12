import { redactSecrets } from '../classify'
import type { SseEvent } from '../sse'
import { isTokenCount, normaliseUsage } from '../usage'
import { LlmError, type LlmErrorKind, type LlmResult, type LlmUsage } from '../types'

const MAX_DETAIL = 300
const ERROR_EVENTS: ReadonlySet<string> = new Set(['error', 'response.failed'])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export interface ChatReply {
  model: string | null
  finishReason: string
  content: string
  refusal: string
  usage: unknown
}

function streamErrorKind(label: string): LlmErrorKind {
  if (/rate_limit/.test(label)) return 'rate_limit'
  if (/content_policy/.test(label)) return 'refusal'
  if (/auth|permission|billing|invalid_api_key/.test(label)) return 'auth'
  if (/invalid_request/.test(label)) return 'invalid_request'
  if (/overload|unavailable|shutting_down|server_error/.test(label)) return 'overloaded'
  return 'connection'
}

function streamError(data: unknown, raw: string, secrets: readonly string[]): LlmError {
  const outer = isRecord(data) ? data : {}
  const inner = isRecord(outer['error']) ? outer['error'] : outer
  const code = text(inner['code'])
  const type = text(inner['type'])
  const message = text(inner['message']) ?? text(outer['error']) ?? (isRecord(data) ? '' : raw)
  const label = code ?? type
  const collapsed = redactSecrets(message, secrets).replace(/\s+/g, ' ').trim()
  const detail = collapsed.length > MAX_DETAIL ? `${collapsed.slice(0, MAX_DETAIL)}...` : collapsed
  return new LlmError(
    streamErrorKind(`${code ?? ''} ${type ?? ''}`.toLowerCase()),
    `the model provider ended the stream with an error${label === undefined ? '' : ` (${label})`}${detail === '' ? '' : `: ${detail}`}`,
    label === undefined ? {} : { category: label },
  )
}

export class ChatAccumulator {
  private model: string | null = null
  private finishReason: string | null = null
  private content = ''
  private refusal = ''
  private usage: unknown

  constructor(private readonly secrets: readonly string[] = []) {}

  push(event: SseEvent): void {
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      if (event.event !== undefined && ERROR_EVENTS.has(event.event)) throw streamError(undefined, event.data, this.secrets)
      throw new LlmError('invalid_output', 'the model provider sent a stream event that is not JSON')
    }
    if ((event.event !== undefined && ERROR_EVENTS.has(event.event)) || (isRecord(data) && data['error'] !== undefined && data['error'] !== null)) {
      throw streamError(data, event.data, this.secrets)
    }
    if (!isRecord(data)) return
    if (typeof data['model'] === 'string') this.model = data['model']
    if (isRecord(data['usage'])) this.usage = data['usage']
    const choices = Array.isArray(data['choices']) ? data['choices'] : []
    const choice = choices.find((entry): entry is Record<string, unknown> => isRecord(entry) && (entry['index'] === undefined || entry['index'] === 0))
    if (choice === undefined) return
    const delta = choice['delta']
    if (isRecord(delta)) {
      if (typeof delta['content'] === 'string') this.content += delta['content']
      if (typeof delta['refusal'] === 'string') this.refusal += delta['refusal']
    }
    if (typeof choice['finish_reason'] === 'string') this.finishReason = choice['finish_reason']
  }

  finish(): ChatReply {
    if (this.finishReason === null) throw new LlmError('connection', 'the stream ended before the model finished its reply')
    return { model: this.model, finishReason: this.finishReason, content: this.content, refusal: this.refusal, usage: this.usage }
  }
}

export type UsageReading = { usage: LlmUsage; problem?: undefined } | { usage?: undefined; problem: string }

function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined
  return isTokenCount(value) ? value : null
}

export function readUsage(raw: unknown): UsageReading {
  if (!isRecord(raw)) return { problem: 'the reply has no usage' }
  const prompt = raw['prompt_tokens']
  const completion = raw['completion_tokens']
  if (!isTokenCount(prompt)) return { problem: 'the reply has an invalid usage.prompt_tokens' }
  if (!isTokenCount(completion)) return { problem: 'the reply has an invalid usage.completion_tokens' }
  const promptDetails = isRecord(raw['prompt_tokens_details']) ? raw['prompt_tokens_details'] : {}
  const completionDetails = isRecord(raw['completion_tokens_details']) ? raw['completion_tokens_details'] : {}
  const cached = optionalCount(promptDetails['cached_tokens'])
  const reasoning = optionalCount(completionDetails['reasoning_tokens'])
  if (cached === null) return { problem: 'the reply has an invalid usage.prompt_tokens_details.cached_tokens' }
  if (reasoning === null) return { problem: 'the reply has an invalid usage.completion_tokens_details.reasoning_tokens' }
  try {
    return { usage: normaliseUsage({ input: prompt, cacheRead: cached ?? 0, cacheWrite: 0, output: Math.max(completion, reasoning ?? 0), inputIncludesCache: true }) }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : 'the reply has an impossible usage' }
  }
}

export function toResult(reply: ChatReply, requestedModel: string, startedAt: number): LlmResult {
  const reading = readUsage(reply.usage)
  const model = reply.model ?? requestedModel
  const billed = reading.usage === undefined ? { model } : { model, usage: reading.usage }
  if (reply.finishReason === 'length') {
    throw new LlmError('truncated', 'the model reply was cut off before it finished; reasoning counts toward maxTokens, so raise maxTokens, lower the effort or shorten the input', billed)
  }
  if (reply.finishReason === 'content_filter') throw new LlmError('refusal', 'the model declined this request (content filter)', { category: 'content_filter', ...billed })
  if (reply.finishReason === 'tool_calls' || reply.finishReason === 'function_call') {
    throw new LlmError('invalid_output', 'the model asked for a tool call, but this request offers no tools', billed)
  }
  if (reply.refusal !== '') throw new LlmError('refusal', 'the model declined this request', { category: 'refusal', ...billed })
  if (reading.usage === undefined) throw new LlmError('invalid_output', `the model provider did not report usable token usage: ${reading.problem}`, { model })
  if (reply.content === '') throw new LlmError('invalid_output', 'the model reply had no text', billed)
  let data: unknown
  try {
    data = JSON.parse(reply.content)
  } catch (error) {
    throw new LlmError('invalid_output', 'the model reply was not valid JSON', { cause: error, ...billed })
  }
  return {
    data,
    model,
    requestedModel,
    stopReason: reply.finishReason,
    durationMs: Date.now() - startedAt,
    fallbackUsed: false,
    usage: reading.usage,
  }
}
