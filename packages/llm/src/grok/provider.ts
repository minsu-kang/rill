import type { LlmCapabilities } from '../capabilities'
import { startCall, postStream, type FetchFn, type LlmCall } from '../http'
import { withRetry, type RetryAttempt } from '../retry'
import { LlmError, type LlmCallOptions, type LlmEffort, type LlmProvider, type LlmRequest, type LlmResult } from '../types'
import { GROK_MODELS } from './models'
import { GROK_DEFAULT_MAX_TOKENS, buildBody } from './request'
import { readEvent, readReply, streamError, terminalOf, type Terminal } from './reply'

export { GROK_DEFAULT_MAX_TOKENS } from './request'
export const GROK_DEFAULT_TIMEOUT_MS = 900_000
export const GROK_DEFAULT_BASE_URL = 'https://api.x.ai'

export interface GrokProviderOptions {
  model: string
  apiKey: string
  fetch?: FetchFn
  baseURL?: string
  effort?: LlmEffort
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxRetries?: number
}

interface Finished {
  terminal: Terminal
  requestId: string | undefined
}

function endpointOf(baseURL: string): string {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new LlmError('invalid_request', 'the baseURL option is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LlmError('invalid_request', 'the baseURL option must be an http or https URL')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? `${path}/responses` : `${path}/v1/responses`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class GrokProvider implements LlmProvider {
  readonly name = 'grok'
  readonly capabilities: LlmCapabilities
  private readonly url: string
  private readonly fetchFn: FetchFn
  private readonly effort: LlmEffort

  constructor(private readonly options: GrokProviderOptions) {
    const found = GROK_MODELS.find((entry) => entry.id === options.model)
    if (found === undefined) {
      throw new LlmError('invalid_request', `unknown Grok model '${options.model}'; known models: ${GROK_MODELS.map((entry) => entry.id).join(', ')}`)
    }
    this.capabilities = found.capabilities
    this.url = endpointOf(options.baseURL ?? GROK_DEFAULT_BASE_URL)
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.effort = options.effort ?? 'medium'
  }

  get model(): string {
    return this.options.model
  }

  get timeoutMs(): number {
    return GROK_DEFAULT_TIMEOUT_MS
  }

  async generate(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmResult> {
    const body = buildBody(request, this.capabilities, { model: this.options.model, maxTokens: GROK_DEFAULT_MAX_TOKENS, effort: this.effort })
    const call = startCall(callOptions.timeoutMs ?? GROK_DEFAULT_TIMEOUT_MS, callOptions.signal)
    const startedAt = Date.now()
    try {
      const { terminal, requestId } = await withRetry((attempt) => this.attempt(body, call, attempt), {
        signal: call.signal,
        abortError: () => call.abortError(),
        remainingMs: () => call.remainingMs(),
        sleep: this.options.sleep,
        random: this.options.random,
        ...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
      })
      const reply = readReply(terminal, { secrets: [this.options.apiKey], requestId })
      return {
        data: reply.data,
        usage: reply.usage,
        model: reply.model ?? this.options.model,
        requestedModel: this.options.model,
        stopReason: 'end_turn',
        durationMs: Date.now() - startedAt,
        fallbackUsed: false,
      }
    } finally {
      call.dispose()
    }
  }

  private async attempt(body: Record<string, unknown>, call: LlmCall, attempt: RetryAttempt): Promise<Finished> {
    const secrets = [this.options.apiKey]
    const stream = await postStream(
      { url: this.url, headers: { authorization: `Bearer ${this.options.apiKey}` }, body, fetch: this.fetchFn, call, secrets },
      { onFirstEvent: () => attempt.outputStarted() },
    )
    const requestId = stream.headers.get('x-request-id') ?? undefined
    try {
      for await (const raw of stream.events) {
        const event = readEvent(raw)
        if (event === undefined) continue
        if (event.type === 'error') throw streamError(event.data, { secrets, requestId })
        const terminal = terminalOf(event)
        if (terminal !== undefined) return { terminal, requestId }
      }
      throw new LlmError('connection', 'the stream ended without a final event', { ...(requestId === undefined ? {} : { requestId }) })
    } finally {
      await stream.close()
    }
  }
}
