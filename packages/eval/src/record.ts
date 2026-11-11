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
  badReply: string | null
  requestMaxTokens: number | null
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
  badReply: string | null
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000
export const MAX_USAGE_TOKENS = 1e9

export function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

export function isValidTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < MAX_USAGE_TOKENS
}

function count(value: unknown): number {
  return isValidTokenCount(value) ? value : 0
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const

function usageProblem(usage: unknown): string | null {
  if (!isRecord(usage)) return 'the reply has no usage'
  for (const key of USAGE_KEYS) {
    const value = usage[key]
    const optional = key !== 'input_tokens' && key !== 'output_tokens'
    if (optional && (value === undefined || value === null)) continue
    if (!isValidTokenCount(value)) return `the reply has an invalid usage.${key}`
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBody(text: string, success: boolean): ParsedBody {
  const parsed: ParsedBody = {
    model: null,
    stopReason: null,
    usage: zeroUsage(),
    contentBlockTypes: [],
    fallbackBlocks: 0,
    thinkingChars: 0,
    badReply: null,
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    if (success) parsed.badReply = text.trim() === '' ? 'the reply body is empty' : 'the reply is not JSON'
    return parsed
  }
  if (!isRecord(body)) {
    if (success) parsed.badReply = 'the reply is not a JSON object'
    return parsed
  }
  if (success) {
    parsed.badReply = Array.isArray(body['content']) ? usageProblem(body['usage']) : 'the reply has no content array'
    if (parsed.badReply !== null) return parsed
  }
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

function requestMaxTokens(init: RequestInit | undefined): number | null {
  if (typeof init?.body !== 'string') return null
  try {
    const body: unknown = JSON.parse(init.body)
    return isRecord(body) && typeof body['max_tokens'] === 'number' ? body['max_tokens'] : null
  } catch {
    return null
  }
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

export function createRecorder(innerFetch: FetchFn = (input, init) => globalThis.fetch(input, init), clock: () => number = Date.now): Recorder {
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
      requestMaxTokens: maxTokens,
      ...parseBody(text, failure === null && isSuccessStatus(response.status)),
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
