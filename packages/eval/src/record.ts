import Anthropic from '@anthropic-ai/sdk'
import {
  AnthropicProvider,
  DEFAULT_TIMEOUT_MS,
  anthropicExchange,
  type ExchangeParser,
  type LlmCallOptions,
  type LlmEffort,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from '@rill/llm'

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface Exchange {
  startedAtMs: number
  durationMs: number
  status: number | null
  requestId: string | null
  model: string | null
  stopReason: string | null
  usage: LlmUsage
  contentBlockTypes: string[]
  fallbackBlocks: number
  thinkingChars: number
  bodyBytes: number
  failure: string | null
  badReply: string | null
  requestMaxTokens: number | null
}

export interface Recorder {
  fetch: FetchFn
  exchanges(): Exchange[]
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000
export const MAX_USAGE_TOKENS = 1e9

export function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

export function isValidTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < MAX_USAGE_TOKENS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

function tokenLimitOf(body: Record<string, unknown>): number | null {
  const nested = body['generation_config']
  const candidates = [body['max_tokens'], body['max_output_tokens'], body['max_completion_tokens'], isRecord(nested) ? nested['max_output_tokens'] : undefined]
  const found = candidates.find((value) => typeof value === 'number')
  return found === undefined ? null : (found as number)
}

function requestMaxTokens(init: RequestInit | undefined): number | null {
  if (typeof init?.body !== 'string') return null
  try {
    const body: unknown = JSON.parse(init.body)
    return isRecord(body) ? tokenLimitOf(body) : null
  } catch {
    return null
  }
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

interface BodyRead {
  text: string
  bytes: number
  failure: string | null
}

function abortedBy(signal: AbortSignal): { promise: Promise<'aborted'>; dispose: () => void } {
  let listener: (() => void) | undefined
  const promise = new Promise<'aborted'>((resolve) => {
    listener = () => resolve('aborted')
    if (signal.aborted) listener()
    else signal.addEventListener('abort', listener, { once: true })
  })
  return { promise, dispose: () => listener !== undefined && signal.removeEventListener('abort', listener) }
}

async function readBody(response: Response, signal: AbortSignal | null | undefined): Promise<BodyRead> {
  const clone = response.clone()
  const read = clone.arrayBuffer().then(
    (bytes): BodyRead => ({ text: new TextDecoder().decode(bytes), bytes: bytes.byteLength, failure: null }),
    (error: unknown): BodyRead => ({ text: '', bytes: 0, failure: failureName(error) }),
  )
  if (signal === undefined || signal === null) return read
  const aborted = abortedBy(signal)
  try {
    const first = await Promise.race([read, aborted.promise])
    if (first !== 'aborted') return first
    void clone.body?.cancel().catch(() => undefined)
    return { text: '', bytes: 0, failure: 'AbortError' }
  } finally {
    aborted.dispose()
  }
}

export function createRecorder(
  innerFetch: FetchFn = (input, init) => globalThis.fetch(input, init),
  clock: () => number = Date.now,
  parser: ExchangeParser = anthropicExchange,
): Recorder {
  const recorded: Exchange[] = []
  const wrapped: FetchFn = async (input, init) => {
    const startedAtMs = clock()
    const maxTokens = requestMaxTokens(init)
    let response: Response
    try {
      response = await innerFetch(input, init)
    } catch (error) {
      recorded.push({
        startedAtMs,
        durationMs: clock() - startedAtMs,
        status: null,
        requestId: null,
        model: null,
        stopReason: null,
        usage: zeroUsage(),
        contentBlockTypes: [],
        fallbackBlocks: 0,
        thinkingChars: 0,
        bodyBytes: 0,
        failure: failureName(error),
        badReply: null,
        requestMaxTokens: maxTokens,
      })
      throw error
    }
    const { text, bytes: bodyBytes, failure } = await readBody(response, init?.signal)
    recorded.push({
      startedAtMs,
      durationMs: clock() - startedAtMs,
      status: response.status,
      requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id'),
      bodyBytes,
      failure,
      requestMaxTokens: maxTokens,
      ...parser.parse(text, failure === null && isSuccessStatus(response.status)),
    })
    return response
  }
  return {
    fetch: wrapped,
    exchanges: () =>
      recorded.map((exchange) => ({
        ...exchange,
        usage: { ...exchange.usage },
        contentBlockTypes: [...exchange.contentBlockTypes],
      })),
  }
}

export function wrapProvider(provider: LlmProvider, generate: LlmProvider['generate']): LlmProvider {
  return provider.capabilities === undefined ? { name: provider.name, generate } : { name: provider.name, capabilities: provider.capabilities, generate }
}

export function withEffort(provider: LlmProvider, effort: LlmEffort): LlmProvider {
  return wrapProvider(provider, (request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> => provider.generate({ ...request, effort }, options))
}

export function withSignal(provider: LlmProvider, signal: AbortSignal): LlmProvider {
  return wrapProvider(provider, (request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> =>
    provider.generate(request, { ...options, signal: options?.signal ?? signal }),
  )
}

export function withDefaults(provider: LlmProvider, defaults: { maxTokens?: number; timeoutMs?: number }): LlmProvider {
  return wrapProvider(provider, (request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> =>
    provider.generate(
      defaults.maxTokens === undefined || request.maxTokens !== undefined ? request : { ...request, maxTokens: defaults.maxTokens },
      defaults.timeoutMs === undefined || options?.timeoutMs !== undefined ? options : { ...options, timeoutMs: defaults.timeoutMs },
    ),
  )
}

export interface EvalProviderOptions {
  model: string
  apiKey: string
  maxTokens?: number
  timeoutMs?: number
  baseURL?: string
  effort?: LlmEffort
  fetch?: FetchFn
  signal?: AbortSignal
  clock?: () => number
}

export interface EvalProvider {
  provider: LlmProvider
  recorder: Recorder
}

export function createEvalProvider(options: EvalProviderOptions): EvalProvider {
  if (options.apiKey.trim() === '') throw new Error('createEvalProvider needs a non-empty apiKey')
  const recorder = createRecorder(options.fetch, options.clock)
  const client = new Anthropic({
    maxRetries: 0,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: recorder.fetch,
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  })
  const base = new AnthropicProvider({
    model: options.model,
    refusalFallback: false,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    client,
  })
  const withEffortApplied = options.effort === undefined ? base : withEffort(base, options.effort)
  const provider = options.signal === undefined ? withEffortApplied : withSignal(withEffortApplied, options.signal)
  return { provider, recorder }
}
