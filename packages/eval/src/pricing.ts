import {
  costUsd as costUsdOf,
  estimateCallUsd as estimateCallUsdOf,
  priceFor as priceForModel,
  type LlmUsage,
  type ModelPrice,
} from '@rill/llm'
import { modelIdOf } from './spec'

export { PRICE_TABLE, PRICE_TABLE_AS_OF, type ModelPrice, type PriceField, type PriceTier } from '@rill/llm'

export function priceFor(spec: string, at?: string | Date): ModelPrice | undefined {
  return priceForModel(modelIdOf(spec), at)
}

export function costUsd(spec: string, usage: LlmUsage, at?: string | Date): number | undefined {
  return costUsdOf(modelIdOf(spec), usage, at)
}

export function estimateCallUsd(spec: string, inputTokens: number, outputTokens: number, at?: string | Date): number | undefined {
  return estimateCallUsdOf(modelIdOf(spec), inputTokens, outputTokens, at)
}
