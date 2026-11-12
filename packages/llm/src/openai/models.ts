import { EFFORT_LEVELS, type LlmCapabilities, type ModelInfo } from '../capabilities'

const OPENAI_DATA_NOTE =
  'OpenAI says API data is not used to train its models and may be kept for up to 30 days for abuse monitoring, unless your organization has zero data retention.'

const OPENAI_CAPABILITIES: LlmCapabilities = {
  structuredOutput: 'strict',
  documents: 'native-pdf',
  images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  maxRequestBytes: 50_000_000,
  cache: 'explicit',
  maxCacheBreakpoints: 3,
  effortLevels: EFFORT_LEVELS,
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  reasoningCappedByMaxTokens: true,
  streaming: 'optional',
  maxOutputTokens: 128_000,
  dataNote: OPENAI_DATA_NOTE,
}

const model = (id: string, tier: ModelInfo['tier'], label: string): ModelInfo => ({
  provider: 'openai',
  id,
  tier,
  label,
  capabilities: OPENAI_CAPABILITIES,
  contextTokens: 1_050_000,
})

export const OPENAI_MODELS: readonly ModelInfo[] = [
  model('gpt-6-astra', 'strong', 'GPT-6 Astra'),
  model('gpt-6.1-sol', 'mid', 'GPT-6.1 Sol'),
  model('gpt-6.1-terra', 'mid', 'GPT-6.1 Terra'),
  model('gpt-6-luna', 'cheap', 'GPT-6 Luna'),
]
