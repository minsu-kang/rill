import {
  ANTHROPIC_CAPABILITIES,
  LlmError,
  classifyHttp,
  normaliseUsage,
  postJson,
  postStream,
  startCall,
  withRetry,
  type FetchFn,
  type ImageMediaType,
  type LlmCallOptions,
  type LlmCapabilities,
  type LlmPart,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from '../src/index'

export type ReferenceFault =
  | 'retry-after-output'
  | 'leak-key'
  | 'ignore-effort'
  | 'no-dispose'
  | 'retry-invalid-request'
  | 'swallow-truncation'
  | 'wrong-usage'
  | 'abort-as-connection'
  | 'drop-pdf'
  | 'key-in-body'

export interface ReferenceOptions {
  apiKey: string
  fetch: FetchFn
  sleep: (ms: number) => Promise<void>
  random: () => number
  fault?: ReferenceFault
  capabilities?: LlmCapabilities
}

export const REFERENCE_ENDPOINT = 'https://acme.test/v1/respond'
export const REFERENCE_MODEL = 'acme-1'
export const REFERENCE_STREAM_ABOVE = 16_000

export const PLAIN_CAPABILITIES: LlmCapabilities = {
  ...ANTHROPIC_CAPABILITIES,
  documents: 'none',
  images: ['image/png', 'image/jpeg'],
  cache: 'automatic',
  effortLevels: ['low', 'medium', 'high'],
  effortMap: { low: 'low', medium: 'mid', high: 'high', xhigh: 'high', max: 'high' },
  dataNote: 'The plain reference vendor keeps nothing.',
}
delete (PLAIN_CAPABILITIES as { maxCacheBreakpoints?: number }).maxCacheBreakpoints

export const REFERENCE_CAPABILITIES: LlmCapabilities = {
  ...ANTHROPIC_CAPABILITIES,
  images: ['image/png', 'image/jpeg'],
  maxCacheBreakpoints: 3,
  effortLevels: ['low', 'medium', 'high'],
  effortMap: { low: 'low', medium: 'mid', high: 'high', xhigh: 'high', max: 'high' },
  dataNote: 'The reference vendor keeps nothing.',
}

interface Final {
  model: string
  status: 'done' | 'cut' | 'refused'
  text: string
  usage: { prompt: number; cached: number; written: number; output: number; thought: number }
}

const isFinal = (value: unknown): value is Final => typeof value === 'object' && value !== null && typeof (value as Final).status === 'string' && typeof (value as Final).usage === 'object'

function toPart(part: LlmPart, fault: ReferenceFault | undefined, flags: boolean): unknown {
  if (part.type === 'text') return { type: 'text', text: part.text, ...(part.cache === true && flags ? { cache: true } : {}) }
  if (part.type === 'document') return fault === 'drop-pdf' ? { type: 'text', text: '' } : { type: 'pdf', data: part.data }
  return { type: 'image', media_type: part.mediaType, data: part.data }
}

export class ReferenceProvider implements LlmProvider {
  readonly name = 'reference'
  readonly capabilities: LlmCapabilities

  constructor(private readonly options: ReferenceOptions) {
    this.capabilities = options.capabilities ?? REFERENCE_CAPABILITIES
  }

  async generate(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmResult> {
    const { fault } = this.options
    this.check(request)
    const maxTokens = request.maxTokens ?? 8000
    const streaming = maxTokens > REFERENCE_STREAM_ABOVE
    const system = typeof request.system === 'string' ? [{ text: request.system }] : request.system
    const flags = this.capabilities.cache === 'explicit'
    const effort = request.effort === undefined || fault === 'ignore-effort' ? undefined : this.capabilities.effortMap[request.effort]
    const body = {
      model: REFERENCE_MODEL,
      max_tokens: maxTokens,
      stream: streaming,
      ...(system === undefined ? {} : { system: system.map((block) => ({ text: block.text, ...(block.cache === true && flags ? { cache: true } : {}) })) }),
      input: request.messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : message.content.map((part) => toPart(part, fault, flags)),
      })),
      ...(effort === undefined ? {} : { reasoning: { level: effort } }),
      ...(flags && request.cache === true ? { cache: true } : {}),
      format: request.schema,
      ...(fault === 'key-in-body' ? { key: this.options.apiKey } : {}),
    }
    const call = startCall(callOptions.timeoutMs ?? 120_000, callOptions.signal)
    const startedAt = Date.now()
    const classify = (status: number, text: string, headers: Headers) => {
      if (fault === 'leak-key') return new LlmError(status === 401 ? 'auth' : 'invalid_request', text, { status })
      const error = classifyHttp(status, text, headers, { secrets: [this.options.apiKey] })
      if (fault === 'retry-invalid-request' && error.kind === 'invalid_request') return new LlmError('overloaded', error.message, { status })
      return error
    }
    try {
      const final = await withRetry(
        async (attempt) => {
          const send = { url: REFERENCE_ENDPOINT, headers: { 'x-acme-key': this.options.apiKey }, body, fetch: this.options.fetch, call, secrets: [this.options.apiKey], classify }
          try {
            if (!streaming) return await this.readJson(send)
            return await this.readStream(send, fault === 'retry-after-output' ? () => undefined : attempt.outputStarted)
          } catch (error) {
            if (fault === 'abort-as-connection' && error instanceof LlmError && (error.kind === 'aborted' || error.kind === 'timeout')) {
              throw new LlmError('connection', 'lost', { cause: error })
            }
            throw error
          }
        },
        { signal: call.signal, abortError: () => call.abortError(), sleep: this.options.sleep, random: this.options.random },
      )
      return this.toResult(final, Date.now() - startedAt)
    } finally {
      if (fault !== 'no-dispose') call.dispose()
    }
  }

  private check(request: LlmRequest): void {
    if (request.messages.at(-1)?.role !== 'user') throw new LlmError('invalid_request', 'the last message must come from the user')
    let flags = request.cache === true ? 1 : 0
    if (typeof request.system !== 'string') flags += request.system?.filter((block) => block.cache === true).length ?? 0
    for (const message of request.messages) {
      if (typeof message.content === 'string') continue
      flags += message.content.filter((part) => part.cache === true).length
      for (const part of message.content) {
        if (part.type === 'image' && !this.capabilities.images.includes(part.mediaType as ImageMediaType)) {
          throw new LlmError('invalid_request', `this provider does not take ${part.mediaType} images`)
        }
        if (part.type === 'document' && this.capabilities.documents === 'none') {
          throw new LlmError('invalid_request', 'this provider does not read PDF files')
        }
      }
    }
    const limit = this.capabilities.maxCacheBreakpoints
    if (this.capabilities.cache === 'explicit' && limit !== undefined && flags > limit) {
      throw new LlmError('invalid_request', `at most ${limit} cache flags are allowed, got ${flags}`)
    }
  }

  private async readJson(send: Parameters<typeof postJson>[0]): Promise<Final> {
    const { body } = await postJson(send)
    if (!isFinal(body)) throw new LlmError('invalid_output', 'the reply has an unexpected shape')
    return body
  }

  private async readStream(send: Parameters<typeof postStream>[0], onFirstEvent: () => void): Promise<Final> {
    const stream = await postStream(send, { onFirstEvent })
    try {
      let text = ''
      let final: Final | undefined
      for await (const event of stream.events) {
        const data = JSON.parse(event.data) as { type: string; text?: string } & Partial<Final>
        if (data.type === 'delta') text += data.text ?? ''
        else if (data.type === 'done' && isFinal(data)) final = { ...data, text: text === '' ? data.text : text }
      }
      if (final === undefined) throw new LlmError('connection', 'the stream ended without its final event')
      return final
    } finally {
      await stream.close()
    }
  }

  private toResult(final: Final, durationMs: number): LlmResult {
    const { fault } = this.options
    const { usage: raw } = final
    const usage = normaliseUsage({
      input: raw.prompt,
      cacheRead: raw.cached,
      cacheWrite: raw.written,
      output: raw.output,
      reasoning: raw.thought,
      inputIncludesCache: fault !== 'wrong-usage',
    })
    if (final.status === 'cut' && fault !== 'swallow-truncation') throw new LlmError('truncated', 'the reply was cut off', { usage, model: final.model })
    if (final.status === 'refused') throw new LlmError('refusal', 'the model declined', { usage, model: final.model })
    let data: unknown
    try {
      data = JSON.parse(final.text)
    } catch (error) {
      throw new LlmError('invalid_output', 'the reply was not valid JSON', { cause: error, usage, model: final.model })
    }
    return { data, usage, model: final.model, requestedModel: REFERENCE_MODEL, stopReason: final.status, durationMs, fallbackUsed: false }
  }
}
