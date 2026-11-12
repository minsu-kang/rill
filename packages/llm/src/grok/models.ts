import { type LlmCapabilities, type ModelInfo } from '../capabilities'

const GROK_DATA_NOTE =
  'xAI keeps API requests and responses for 30 days for abuse monitoring and says it does not train on them without your permission.'

const GROK_CAPABILITIES: LlmCapabilities = {
  structuredOutput: 'strict',
  documents: 'none',
  images: ['image/png', 'image/jpeg'],
  cache: 'automatic',
  effortLevels: ['low', 'medium', 'high', 'xhigh'],
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
  reasoningCappedByMaxTokens: false,
  streaming: 'required',
  dataNote: GROK_DATA_NOTE,
}

const XHIGH_ACTS_AS_HIGH: LlmCapabilities = {
  ...GROK_CAPABILITIES,
  effortLevels: ['low', 'medium', 'high'],
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
}

const model = (id: string, tier: ModelInfo['tier'], label: string, contextTokens: number, capabilities = GROK_CAPABILITIES): ModelInfo => ({
  provider: 'grok',
  id,
  tier,
  label,
  capabilities,
  contextTokens,
})

export const GROK_MODELS: readonly ModelInfo[] = [
  model('grok-4.7', 'strong', 'Grok 4.7', 500_000),
  model('grok-4.6', 'strong', 'Grok 4.6', 500_000),
  model('grok-4.5', 'strong', 'Grok 4.5', 500_000, XHIGH_ACTS_AS_HIGH),
  model('grok-4.3', 'mid', 'Grok 4.3', 1_000_000),
]
