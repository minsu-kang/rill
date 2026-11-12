import { classifyHttp, redactSecrets } from '../classify'
import type { SseEvent } from '../sse'
import { isTokenCount, normaliseUsage } from '../usage'
import { LlmError, type LlmErrorOptions, type LlmUsage } from '../types'

export type Json = Record<string, unknown>

export const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

export interface StreamEvent {
  type: string
  data: Json
}

export interface Terminal {
  type: string
  response: Json
}

const TERMINAL_TYPES: ReadonlySet<string> = new Set(['response.completed', 'response.incomplete', 'response.failed'])
const MAX_DETAIL = 300

export function readEvent(event: SseEvent): StreamEvent | undefined {
  let data: unknown
  try {
    data = JSON.parse(event.data)
  } catch {
    return event.event === 'error' ? { type: 'error', data: { message: event.data } } : undefined
  }
  if (!isRecord(data)) return event.event === 'error' ? { type: 'error', data: { message: event.data } } : undefined
  const type = typeof data.type === 'string' ? data.type : event.event
  return type === undefined ? undefined : { type, data }
}

export function terminalOf(event: StreamEvent): Terminal | undefined {
  if (!TERMINAL_TYPES.has(event.type)) return undefined
  return { type: event.type, response: isRecord(event.data.response) ? event.data.response : event.data }
}

function field(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!isTokenCount(value)) throw invalid(`the reply has an invalid usage.${name}`)
  return value
}

function details(value: unknown, name: string): Json {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw invalid(`the reply has an invalid usage.${name}`)
  return value
}

const invalid = (message: string, options: LlmErrorOptions = {}) => new LlmError('invalid_output', message, options)

export function readUsage(usage: unknown): LlmUsage {
  if (!isRecord(usage)) throw invalid('the reply has no usage')
  const input = field(usage.input_tokens, 'input_tokens')
  if (input === undefined) throw invalid('the reply has no usage.input_tokens')
  const output = field(usage.output_tokens, 'output_tokens')
  const total = field(usage.total_tokens, 'total_tokens')
  const cached = field(details(usage.input_tokens_details, 'input_tokens_details').cached_tokens, 'input_tokens_details.cached_tokens')
  const reasoning = field(details(usage.output_tokens_details, 'output_tokens_details').reasoning_tokens, 'output_tokens_details.reasoning_tokens')
  if (total === undefined && output === undefined) throw invalid('the reply has no usage.output_tokens')
  return normaliseUsage({
    input,
    cacheRead: cached ?? 0,
    cacheWrite: 0,
    output: total === undefined ? (output ?? 0) + (reasoning ?? 0) : total - input,
    inputIncludesCache: true,
  })
}

function tryUsage(usage: unknown): { usage: LlmUsage } | { problem: LlmError } {
  try {
    return { usage: readUsage(usage) }
  } catch (error) {
    return { problem: error as LlmError }
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined)

const STATUS_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/overload|unavailable|temporar|try again|busy|capacity/i, 503],
  [/rate.?limit|too many requests|quota/i, 429],
  [/unauthori|authentic|api key|credential|forbidden|permission/i, 401],
  [/context (?:length|window)|too long|maximum context|exceeds? (?:the )?(?:maximum )?(?:context|input)/i, 400],
]

function statusFor(code: string | undefined, probe: string): number | undefined {
  if (code !== undefined && /^[45]\d{2}$/.test(code)) return Number(code)
  return STATUS_PATTERNS.find(([pattern]) => pattern.test(probe))?.[1]
}

export function streamError(source: Json, options: { secrets: readonly string[]; requestId?: string | undefined }): LlmError {
  const inner = isRecord(source.error) ? source.error : source
  const message = text(inner.message) ?? text(source.error) ?? text(source.message) ?? ''
  const code = text(inner.code) ?? text(source.code)
  const rawType = text(inner.type)
  const kind = rawType === 'error' ? undefined : rawType
  const probe = [code, kind, message].filter((part) => part !== undefined).join(' ')
  const status = statusFor(code, probe)
  const headers = options.requestId === undefined ? undefined : { 'x-request-id': options.requestId }
  if (status !== undefined) {
    return classifyHttp(status, JSON.stringify({ error: { message, ...(code === undefined ? {} : { code }), ...(kind === undefined ? {} : { type: kind }) } }), headers, { secrets: options.secrets })
  }
  const detail = redactSecrets(message, options.secrets).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL)
  return new LlmError('unknown', `the model provider ended the stream with an error${detail === '' ? '' : `: ${detail}`}`, {
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  })
}

export interface ReplyContext {
  secrets: readonly string[]
  requestId?: string | undefined
}

export interface Reply {
  data: unknown
  model: string | undefined
  usage: LlmUsage
}

const reasonOf = (response: Json): string | undefined => (isRecord(response.incomplete_details) ? text(response.incomplete_details.reason) : undefined)

export function stopReasonOf(reason: string | undefined): string | null {
  switch (reason) {
    case undefined:
      return null
    case 'max_output_tokens':
      return 'max_tokens'
    case 'max_time_limit':
      return 'time_limit'
    default:
      return reason
  }
}

function lastMessage(output: unknown): Json | undefined {
  if (!Array.isArray(output)) return undefined
  for (let index = output.length - 1; index >= 0; index--) {
    const item: unknown = output[index]
    if (isRecord(item) && item.type === 'message') return item
  }
  return undefined
}

export function readReply(terminal: Terminal, context: ReplyContext): Reply {
  const { response, type } = terminal
  const read = tryUsage(response.usage)
  const usage = 'usage' in read ? read.usage : undefined
  const model = typeof response.model === 'string' ? response.model : undefined
  const billed: LlmErrorOptions = {
    ...(usage === undefined ? {} : { usage }),
    ...(model === undefined ? {} : { model }),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  }
  if (isRecord(response.error)) throw streamError(response.error, context)
  const status = typeof response.status === 'string' ? response.status : undefined
  if (type === 'response.incomplete' || status === 'incomplete') {
    const reason = reasonOf(response)
    switch (reason) {
      case 'max_output_tokens':
        throw new LlmError('truncated', 'the model reply was cut off before it finished; raise maxTokens or shorten the input', { ...billed, category: reason })
      case 'content_filter':
        throw new LlmError('refusal', 'the model declined this request (content filter)', { ...billed, category: reason })
      case 'max_time_limit':
        throw new LlmError('timeout', 'the model provider stopped the reply at its own time limit', { ...billed, category: reason })
      case 'max_prompt_tokens':
        throw new LlmError('invalid_request', 'the input is too long for this model', { ...billed, category: 'context_too_long' })
      default:
        throw new LlmError('unknown', `the model reply was incomplete (${reason === undefined ? 'no reason given' : reason.slice(0, 64)})`, billed)
    }
  }
  if (type === 'response.failed' || status === 'failed') throw new LlmError('unknown', 'the model provider reported that the reply failed', billed)
  if (status !== undefined && status !== 'completed') throw invalid(`the final event has the unexpected status ${status.slice(0, 32)}`, billed)
  const message = lastMessage(response.output)
  if (message === undefined) throw invalid('the model reply had no message', billed)
  const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : []
  if (parts.some((part) => part.type === 'refusal')) throw new LlmError('refusal', 'the model declined this request', { ...billed, category: 'refusal' })
  const answer = parts
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  if (answer === '') throw invalid('the model reply had no text', billed)
  let data: unknown
  try {
    data = JSON.parse(answer)
  } catch (error) {
    throw invalid('the model reply was not valid JSON', { ...billed, cause: error })
  }
  if (!('usage' in read)) throw read.problem
  return { data, model, usage: read.usage }
}
