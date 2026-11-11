import Anthropic from '@anthropic-ai/sdk'
import {
  AnthropicProvider,
  DEFAULT_TIMEOUT_MS,
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
}

export interface Recorder {
  fetch: FetchFn
  exchanges(): Exchange[]
}

interface ParsedBody {
  model: string | null
  stopReason: string | null
  usage: LlmUsage
  contentBlockTypes: string[]
  fallbackBlocks: number
  thinkingChars: number
}

export function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBody(text: string): ParsedBody {
  const parsed: ParsedBody = {
    model: null,
    stopReason: null,
    usage: zeroUsage(),
    contentBlockTypes: [],
    fallbackBlocks: 0,
    thinkingChars: 0,
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return parsed
  }
  if (!isRecord(body)) return parsed
  if (typeof body['model'] === 'string') parsed.model = body['model']
  if (typeof body['stop_reason'] === 'string') parsed.stopReason = body['stop_reason']
  const usage = body['usage']
  if (isRecord(usage)) {
    parsed.usage = {
      inputTokens: count(usage['input_tokens']),
      outputTokens: count(usage['output_tokens']),
      cacheReadInputTokens: count(usage['cache_read_input_tokens']),
      cacheCreationInputTokens: count(usage['cache_creation_input_tokens']),
    }
  }
  const content = body['content']
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || typeof block['type'] !== 'string') continue
      parsed.contentBlockTypes.push(block['type'])
      if (block['type'] === 'fallback') parsed.fallbackBlocks += 1
      if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') parsed.thinkingChars += block['thinking'].length
    }
  }
  return parsed
}

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

export function createRecorder(innerFetch: FetchFn = (input, init) => globalThis.fetch(input, init), clock: () => number = Date.now): Recorder {
  const recorded: Exchange[] = []
  const wrapped: FetchFn = async (input, init) => {
    const startedAtMs = clock()
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
      })
      throw error
    }
    let text = ''
    let bodyBytes = 0
    let failure: string | null = null
    try {
      const bytes = await response.clone().arrayBuffer()
      bodyBytes = bytes.byteLength
      text = new TextDecoder().decode(bytes)
    } catch (error) {
      failure = failureName(error)
    }
    recorded.push({
      startedAtMs,
      durationMs: clock() - startedAtMs,
      status: response.status,
      requestId: response.headers.get('request-id'),
      bodyBytes,
      failure,
      ...parseBody(text),
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

export function withEffort(provider: LlmProvider, effort: LlmEffort): LlmProvider {
  return {
    name: provider.name,
    generate: (request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> => provider.generate({ ...request, effort }, options),
  }
}

export function withSignal(provider: LlmProvider, signal: AbortSignal): LlmProvider {
  return {
    name: provider.name,
    generate: (request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> =>
      provider.generate(request, { ...options, signal: options?.signal ?? signal }),
  }
}

export interface EvalProviderOptions {
  model: string
  apiKey?: string
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
  const recorder = createRecorder(options.fetch, options.clock)
  const client = new Anthropic({
    maxRetries: 0,
    timeout: DEFAULT_TIMEOUT_MS,
    fetch: recorder.fetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  })
  const base = new AnthropicProvider({ model: options.model, refusalFallback: false, client })
  const withEffortApplied = options.effort === undefined ? base : withEffort(base, options.effort)
  const provider = options.signal === undefined ? withEffortApplied : withSignal(withEffortApplied, options.signal)
  return { provider, recorder }
}
