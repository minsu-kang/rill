export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'document'; mediaType: 'application/pdf'; data: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string }

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmPart[]
}

export type JsonSchema = Record<string, unknown>

export interface LlmRequest {
  system?: string
  messages: LlmMessage[]
  schema: JsonSchema
  maxTokens?: number
  effort?: LlmEffort
  cache?: boolean
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export interface LlmResult {
  data: unknown
  usage: LlmUsage
  model: string
  requestedModel: string
  stopReason: string
  durationMs: number
  fallbackUsed: boolean
}

export interface LlmCallOptions {
  signal?: AbortSignal
}

export interface LlmProvider {
  readonly name: string
  generate(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult>
}

export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'connection'
  | 'timeout'
  | 'invalid_request'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'aborted'
  | 'unknown'

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(['rate_limit', 'overloaded', 'connection', 'timeout', 'invalid_output'])

export interface LlmErrorOptions extends ErrorOptions {
  status?: number
  requestId?: string
  retryAfterMs?: number
  category?: string
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly retryable: boolean
  readonly status: number | undefined
  readonly requestId: string | undefined
  readonly retryAfterMs: number | undefined
  readonly category: string | undefined

  constructor(kind: LlmErrorKind, message: string, options: LlmErrorOptions = {}) {
    const { status, requestId, retryAfterMs, category, ...errorOptions } = options
    super(message, errorOptions)
    this.name = 'LlmError'
    this.kind = kind
    this.retryable = RETRYABLE.has(kind)
    this.status = status
    this.requestId = requestId
    this.retryAfterMs = retryAfterMs
    this.category = category
  }
}
