import { redactSecrets } from '../classify'
import { isTokenCount, normaliseUsage } from '../usage'
import { LlmError, type LlmErrorKind, type LlmErrorOptions, type LlmResult, type LlmUsage } from '../types'

const MAX_DETAIL = 300

type Obj = Record<string, unknown>

export const isRecord = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

const REFUSAL_CODES: ReadonlySet<string> = new Set(['bio_policy', 'misalignment_policy_violation', 'image_content_policy_violation'])
const INVALID_REQUEST_CODES: ReadonlySet<string> = new Set(['invalid_prompt', 'data_residency_mismatch'])
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['rate_limit_exceeded', 'slow_down'])
const OVERLOADED_CODES: ReadonlySet<string> = new Set(['server_error', 'server_is_overloaded', 'service_unavailable_error'])

function kindForCode(code: string | null | undefined): LlmErrorKind {
  if (code === undefined || code === null) return 'unknown'
  if (REFUSAL_CODES.has(code)) return 'refusal'
  if (RATE_LIMIT_CODES.has(code)) return 'rate_limit'
  if (OVERLOADED_CODES.has(code)) return 'overloaded'
  if (INVALID_REQUEST_CODES.has(code) || code.includes('image')) return 'invalid_request'
  return 'unknown'
}

export function clip(text: string, secrets: readonly string[]): string {
  const collapsed = redactSecrets(text, secrets).replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_DETAIL ? `${collapsed.slice(0, MAX_DETAIL)}...` : collapsed
}

export function codeError(code: string | null | undefined, message: string | null | undefined, secrets: readonly string[], options: LlmErrorOptions = {}): LlmError {
  const detail = clip(message ?? '', secrets)
  const label = code === undefined || code === null || code === '' ? '' : ` (${code})`
  return new LlmError(kindForCode(code), `the model provider could not finish the reply${label}${detail === '' ? '' : `: ${detail}`}`, {
    ...(code === undefined || code === null || code === '' ? {} : { category: code }),
    ...options,
  })
}

interface UsageCounts {
  input_tokens?: unknown
  output_tokens?: unknown
  input_tokens_details?: unknown
}

export function usageOf(raw: unknown): LlmUsage {
  if (!isRecord(raw)) throw new LlmError('invalid_output', 'the model provider reported no token usage')
  const counts = raw as UsageCounts
  const details = isRecord(counts.input_tokens_details) ? counts.input_tokens_details : {}
  const optional = (value: unknown): number => (value === undefined || value === null ? 0 : (value as number))
  if (!isTokenCount(counts.input_tokens) || !isTokenCount(counts.output_tokens)) {
    throw new LlmError('invalid_output', 'the model provider reported an unreadable token usage')
  }
  return normaliseUsage({
    input: counts.input_tokens,
    cacheRead: optional(details.cached_tokens),
    cacheWrite: optional(details.cache_write_tokens),
    output: counts.output_tokens,
    inputIncludesCache: true,
  })
}

function looseUsage(raw: unknown): LlmUsage | undefined {
  try {
    return usageOf(raw)
  } catch {
    return undefined
  }
}

export interface ResponseView {
  status: string
  incompleteReason: string | null
  error: { code: string | null; message: string | null } | null
  parts: Obj[]
  model: string | null
}

export function viewOf(raw: unknown): ResponseView | undefined {
  if (!isRecord(raw) || (!Array.isArray(raw.output) && typeof raw.status !== 'string')) return undefined
  const output: unknown[] = Array.isArray(raw.output) ? raw.output : []
  const messages = output.filter((item): item is Obj => isRecord(item) && item.type === 'message' && item.phase !== 'commentary')
  const parts = messages.flatMap((message) => (Array.isArray(message.content) ? message.content.filter(isRecord) : []))
  const details = isRecord(raw.incomplete_details) ? raw.incomplete_details : undefined
  const error = isRecord(raw.error) ? raw.error : undefined
  return {
    status: typeof raw.status === 'string' ? raw.status : 'completed',
    incompleteReason: typeof details?.reason === 'string' ? details.reason : null,
    error:
      error === undefined
        ? null
        : { code: typeof error.code === 'string' ? error.code : null, message: typeof error.message === 'string' ? error.message : null },
    parts,
    model: typeof raw.model === 'string' ? raw.model : null,
  }
}

export function stopReasonOf(view: ResponseView): string {
  if (view.status === 'completed') return view.parts.some((part) => part.type === 'refusal') ? 'refusal' : 'end_turn'
  if (view.status === 'incomplete') {
    if (view.incompleteReason === 'max_output_tokens') return 'max_tokens'
    if (view.incompleteReason === 'content_filter') return 'content_filter'
  }
  return view.status
}

export interface ReadContext {
  requestedModel: string
  secrets: readonly string[]
  restore(data: unknown): unknown
  startedAt: number
}

export function readResponse(raw: unknown, context: ReadContext): LlmResult {
  const view = viewOf(raw)
  if (view === undefined) {
    const usage = isRecord(raw) ? looseUsage(raw.usage) : undefined
    const model = isRecord(raw) && typeof raw.model === 'string' ? raw.model : undefined
    throw new LlmError('invalid_output', 'the model provider returned an unexpected response', usage === undefined || model === undefined ? {} : { usage, model, servedModels: [model] })
  }
  const rawUsage = (raw as Obj).usage
  const usage = looseUsage(rawUsage)
  const model = view.model ?? context.requestedModel
  const billed: Pick<LlmErrorOptions, 'usage' | 'model' | 'servedModels'> = usage === undefined ? {} : { usage, model, servedModels: [model] }
  if (view.status === 'failed') throw codeError(view.error?.code, view.error?.message, context.secrets, billed)
  if (view.status === 'cancelled') throw new LlmError('unknown', 'the model provider cancelled the reply before it finished', billed)
  if (view.status === 'incomplete') {
    if (view.incompleteReason === 'max_output_tokens') {
      throw new LlmError('truncated', 'the model reply was cut off before it finished; raise maxTokens or shorten the input', billed)
    }
    if (view.incompleteReason === 'content_filter') throw new LlmError('refusal', 'the model provider filtered this reply (content_filter)', { category: 'content_filter', ...billed })
    throw new LlmError('unknown', `the model reply was incomplete${view.incompleteReason === null ? '' : ` (${view.incompleteReason})`}`, billed)
  }
  if (view.status !== 'completed') {
    throw new LlmError('invalid_output', `the model reply had not finished (status ${view.status})`, billed)
  }
  if (view.parts.some((part) => part.type === 'refusal')) throw new LlmError('refusal', 'the model declined this request', billed)
  const counted = usage ?? usageOf(rawUsage)
  const text = view.parts
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  if (text === '') throw new LlmError('invalid_output', 'the model reply had no text', billed)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new LlmError('invalid_output', 'the model reply was not valid JSON', { cause: error, ...billed })
  }
  return {
    data: context.restore(data),
    model,
    requestedModel: context.requestedModel,
    stopReason: stopReasonOf(view),
    durationMs: Date.now() - context.startedAt,
    fallbackUsed: false,
    usage: counted,
    servedModels: [model],
  }
}
