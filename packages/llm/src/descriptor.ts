import type { LlmCapabilities, ModelInfo, ProviderId } from './capabilities'
import type { FetchFn } from './http'
import type { LlmProvider, LlmUsage } from './types'

export interface LiveCheck {
  id: string
  what: string
}

export interface ParsedExchange {
  model: string | null
  stopReason: string | null
  usage: LlmUsage
  contentBlockTypes: string[]
  fallbackBlocks: number
  thinkingChars: number
  badReply: string | null
}

export interface ExchangeParser {
  parse(body: string, success: boolean): ParsedExchange
}

export interface ProviderFactoryOptions {
  model: string
  apiKey: string
  fetch?: FetchFn
  client?: unknown
  baseURL?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxRetries?: number
}

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  keyEnv: string
  models: readonly ModelInfo[]
  liveChecks: readonly LiveCheck[]
  create(options: ProviderFactoryOptions): LlmProvider
  exchange: ExchangeParser
}

export function emptyExchange(badReply: string | null): ParsedExchange {
  return {
    model: null,
    stopReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    contentBlockTypes: [],
    fallbackBlocks: 0,
    thinkingChars: 0,
    badReply,
  }
}

export function stubDescriptor(base: Pick<ProviderDescriptor, 'id' | 'label' | 'keyEnv' | 'models'>): ProviderDescriptor {
  return {
    ...base,
    liveChecks: [],
    create: () => {
      throw new Error(`the ${base.label} provider is not implemented yet`)
    },
    exchange: { parse: () => emptyExchange(`the ${base.label} exchange parser is not implemented yet`) },
  }
}

export function modelCapabilities(models: readonly ModelInfo[], id: string): LlmCapabilities {
  const found = models.find((model) => model.id === id)
  if (found === undefined) throw new Error(`unknown model ${id}`)
  return found.capabilities
}
