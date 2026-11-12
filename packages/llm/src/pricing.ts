import type { LlmUsage } from './types'

export const PRICE_TABLE_AS_OF = '2026-11-13'

export type PriceField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'longContext'

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

export interface DatedPrice extends ModelPrice {
  effectiveFrom?: string
  effectiveTo?: string
}

type Long = NonNullable<ModelPrice['longContext']>

const tier = (input: number, cacheRead: number, output: number, cacheWrite = 0): PriceTier => ({ input, output, cacheRead, cacheWrite })

const price = (base: PriceTier, assumed: readonly PriceField[] = [], longContext?: Long): ModelPrice => ({
  ...base,
  assumed,
  ...(longContext === undefined ? {} : { longContext }),
})

const long = (aboveInputTokens: number, base: PriceTier): Long => ({ aboveInputTokens, ...base })

const dated = (entry: ModelPrice, effectiveFrom?: string, effectiveTo?: string): DatedPrice => ({
  ...entry,
  ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
  ...(effectiveTo === undefined ? {} : { effectiveTo }),
})

const OPENAI_LONG_PROMPT = 272_000
const openai = (input: number, cacheRead: number, output: number, cacheWrite: number, documentedLong: boolean): ModelPrice =>
  price(tier(input, cacheRead, output, cacheWrite), documentedLong ? [] : ['longContext'], long(OPENAI_LONG_PROMPT, tier(input * 2, cacheRead * 2, output * 1.5, cacheWrite * 2)))

const GROK_LONG_PROMPT = 199_999
const grok = (input: number, cacheRead: number, output: number): ModelPrice =>
  price(tier(input, cacheRead, output), ['cacheWrite'], long(GROK_LONG_PROMPT, tier(input * 2, cacheRead * 2, output * 2)))

const GEMINI_CARBON_UNTIL = '2026-11-30'
const GEMINI_CARBON_FROM = '2026-12-01'
const GEMINI_FLASH_UNTIL = '2026-12-31'
const GEMINI_FLASH_FROM = '2027-01-01'
const carbon = (assumed: readonly PriceField[]): DatedPrice[] => [
  dated(price(tier(2, 0.1, 10)), undefined, GEMINI_CARBON_UNTIL),
  dated(price(tier(4, 0.2, 20), assumed), GEMINI_CARBON_FROM),
]
const flash = (assumed: readonly PriceField[]): DatedPrice[] => [
  dated(price(tier(0.75, 0.075, 3.75)), undefined, GEMINI_FLASH_UNTIL),
  dated(price(tier(1.5, 0.15, 7.5), assumed), GEMINI_FLASH_FROM),
]

const spark = (assumed: readonly PriceField[]): DatedPrice[] => [dated(price(tier(1.25, 0.15, 4.25), assumed))]

export const PRICE_SCHEDULE: Readonly<Record<string, readonly DatedPrice[]>> = {
  'claude-haiku-5-5': [
    dated(price(tier(0.1, 0.01, 0.5, 0.125), ['cacheRead', 'cacheWrite'], long(100_000, tier(0.5, 0.05, 2.5, 0.625)))),
  ],
  'claude-sonnet-5-5': [dated(price(tier(2, 0.1, 10, 2.5), ['cacheWrite']))],
  'claude-opus-5-5': [dated(price(tier(4, 0.2, 20, 5), ['cacheWrite']))],

  'gpt-6-astra': [dated(openai(10, 1, 50, 12.5, true))],
  'gpt-6.1-sol': [dated(openai(2, 0.1, 10, 2.5, false))],
  'gpt-6.1-terra': [dated(openai(1, 0.05, 5, 1.25, false))],
  'gpt-6-luna': [dated(openai(0.1, 0.01, 0.5, 0.125, false))],
  'gpt-5.6-terra': [dated(openai(2, 0.2, 12, 2.5, false))],

  'gemini-4-carbon': carbon([]),
  'gemini-4-argon': carbon(['input', 'output', 'cacheRead']),
  'gemini-3.8-flash': flash([]),
  'gemini-3.6-flash': flash(['input', 'output', 'cacheRead']),
  'gemini-3.5-flash-lite': [dated(price(tier(0.3, 0.03, 2.5)))],
  'gemini-3.1-flash-lite': [dated(price(tier(0.25, 0.025, 1.5)))],
  'gemini-3.1-pro-preview': [dated(price(tier(2, 0.2, 12), ['cacheRead', 'longContext'], long(200_000, tier(4, 0.4, 18))))],
  'gemini-2.5-flash-lite': [dated(price(tier(0.1, 0.01, 0.4), ['cacheRead']))],

  'grok-4.7': [dated(grok(2, 0.5, 6))],
  'grok-4.6': [dated(grok(2, 0.5, 6))],
  'grok-4.5': [dated(grok(2, 0.3, 6))],
  'grok-4.3': [dated(grok(1.25, 0.2, 2.5))],
  'grok-4.20-0309-reasoning': [dated(grok(1.25, 0.2, 2.5))],
  'grok-4.20-0309-non-reasoning': [dated(grok(1.25, 0.2, 2.5))],
  'grok-build-0.1': [dated(grok(1, 0.2, 2))],

  'muse-wonder-1.0': [dated(price(tier(4, 0.2, 20), ['cacheWrite']))],
  'muse-spark-1.3': spark(['cacheWrite']),
  'muse-spark-1.2': spark(['input', 'output', 'cacheRead', 'cacheWrite']),
  'muse-spark-1.1': spark(['input', 'output', 'cacheRead', 'cacheWrite']),
  'muse-ember-1.0': [dated(price(tier(0.1, 0.004, 0.5), ['cacheWrite'], long(200_000, tier(0.3, 0.012, 1.5))))],
}

const DATE = /^\d{4}-\d{2}-\d{2}/

function dayOf(at: string | Date | undefined): string {
  if (at === undefined) return new Date().toISOString().slice(0, 10)
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) throw new RangeError('priceFor needs a valid date')
    return at.toISOString().slice(0, 10)
  }
  if (!DATE.test(at)) throw new RangeError(`priceFor needs a date like 2026-11-13, got ${JSON.stringify(at)}`)
  return at.slice(0, 10)
}

function knownId(model: string): string | undefined {
  if (model.toLowerCase().endsWith('-contributor')) return undefined
  let best: string | undefined
  for (const known of Object.keys(PRICE_SCHEDULE)) {
    if ((model === known || model.startsWith(`${known}-`)) && (best === undefined || known.length > best.length)) best = known
  }
  return best
}

export function priceFor(model: string, at?: string | Date): ModelPrice | undefined {
  const id = knownId(model)
  if (id === undefined) return undefined
  const day = dayOf(at)
  return PRICE_SCHEDULE[id]?.find((entry) => (entry.effectiveFrom ?? '') <= day && day <= (entry.effectiveTo ?? '9999-12-31'))
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = Object.fromEntries(
  Object.keys(PRICE_SCHEDULE).flatMap((id) => {
    const entry = priceFor(id, PRICE_TABLE_AS_OF)
    return entry === undefined ? [] : [[id, entry] as const]
  }),
)

const PER_MILLION = 1_000_000

export function costUsd(model: string, usage: LlmUsage, at?: string | Date): number | undefined {
  const price = priceFor(model, at)
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

export function estimateCallUsd(model: string, inputTokens: number, outputTokens: number, at?: string | Date): number | undefined {
  return costUsd(model, { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, at)
}

export function estimateWorstCallUsd(model: string, inputTokens: number, outputTokens: number, at?: string | Date): number | undefined {
  const price = priceFor(model, at)
  if (price === undefined) return undefined
  const tier = price.longContext !== undefined && inputTokens > price.longContext.aboveInputTokens ? price.longContext : price
  return (inputTokens * Math.max(tier.input, tier.cacheWrite) + outputTokens * tier.output) / PER_MILLION
}
