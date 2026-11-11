import type { LlmUsage } from '@rill/llm'

export const PRICE_TABLE_AS_OF = '2026-11-03'

export type PriceField = 'cacheRead' | 'cacheWrite'

export interface PriceTier {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelPrice extends PriceTier {
  assumed: readonly PriceField[]
  longContext?: PriceTier & { aboveInputTokens: number }
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    assumed: ['cacheRead', 'cacheWrite'],
    longContext: {
      aboveInputTokens: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    },
  },
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    assumed: ['cacheWrite'],
  },
  'claude-opus-5-5': {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
    assumed: ['cacheWrite'],
  },
}

const PER_MILLION = 1_000_000

export function priceFor(model: string): ModelPrice | undefined {
  const id = Object.keys(PRICE_TABLE).find((known) => model === known || model.startsWith(`${known}-`))
  return id === undefined ? undefined : PRICE_TABLE[id]
}

export function costUsd(model: string, usage: LlmUsage): number | undefined {
  const price = priceFor(model)
  if (price === undefined) return undefined
  const promptTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
  const tier = price.longContext !== undefined && promptTokens > price.longContext.aboveInputTokens ? price.longContext : price
  return (
    (usage.inputTokens * tier.input +
      usage.outputTokens * tier.output +
      usage.cacheReadInputTokens * tier.cacheRead +
      usage.cacheCreationInputTokens * tier.cacheWrite) /
    PER_MILLION
  )
}

export function estimateCallUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  return costUsd(model, { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
}
