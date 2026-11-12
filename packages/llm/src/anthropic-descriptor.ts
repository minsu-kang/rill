import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider, DEFAULT_TIMEOUT_MS } from './anthropic'
import { ANTHROPIC_CAPABILITIES, type ModelInfo } from './capabilities'
import { emptyExchange, type ExchangeParser, type ParsedExchange, type ProviderDescriptor } from './descriptor'
import { isTokenCount, zeroUsage } from './usage'

const model = (id: string, tier: ModelInfo['tier'], label: string): ModelInfo => ({
  provider: 'anthropic',
  id,
  tier,
  label,
  capabilities: ANTHROPIC_CAPABILITIES,
  contextTokens: 1_000_000,
})

export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  model('claude-haiku-5-5', 'cheap', 'Claude Haiku 5.5'),
  model('claude-sonnet-5-5', 'mid', 'Claude Sonnet 5.5'),
  model('claude-opus-5-5', 'strong', 'Claude Opus 5.5'),
]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const

function usageProblem(usage: unknown): string | null {
  if (!isRecord(usage)) return 'the reply has no usage'
  for (const key of USAGE_KEYS) {
    const value = usage[key]
    const optional = key !== 'input_tokens' && key !== 'output_tokens'
    if (optional && (value === undefined || value === null)) continue
    if (!isTokenCount(value)) return `the reply has an invalid usage.${key}`
  }
  return null
}

const count = (value: unknown): number => (isTokenCount(value) ? value : 0)

function parseAnthropicBody(text: string, success: boolean): ParsedExchange {
  const parsed = emptyExchange(null)
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
      ...zeroUsage(),
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

export const anthropicExchange: ExchangeParser = { parse: parseAnthropicBody }

export const anthropicDescriptor: ProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  keyEnv: 'ANTHROPIC_API_KEY',
  models: ANTHROPIC_MODELS,
  liveChecks: [],
  exchange: anthropicExchange,
  create: (options) => {
    const client =
      options.client !== undefined
        ? (options.client as Anthropic)
        : options.fetch === undefined
          ? undefined
          : new Anthropic({
              apiKey: options.apiKey,
              maxRetries: 0,
              timeout: DEFAULT_TIMEOUT_MS,
              fetch: options.fetch,
              ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
            })
    return new AnthropicProvider({
      model: options.model,
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(client === undefined ? {} : { client }),
    })
  },
}
