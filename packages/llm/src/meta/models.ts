import { EFFORT_LEVELS, type LlmCapabilities, type ModelInfo } from '../capabilities'

const META_DATA_NOTE =
  'Meta says it does not train on Standard-mode API content but keeps it as needed for service and safety review, and flagged content can be kept for up to two years.'

const META_CAPABILITIES: LlmCapabilities = {
  structuredOutput: 'strict',
  documents: 'native-pdf',
  images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  maxRequestBytes: 50_000_000,
  cache: 'automatic',
  effortLevels: EFFORT_LEVELS,
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  reasoningCappedByMaxTokens: true,
  streaming: 'required',
  dataNote: META_DATA_NOTE,
}

const WITHOUT_MAX: LlmCapabilities = {
  ...META_CAPABILITIES,
  effortLevels: ['low', 'medium', 'high', 'xhigh'],
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
}

const WONDER: LlmCapabilities = {
  ...META_CAPABILITIES,
  dataNote: `${META_DATA_NOTE} Muse Wonder is a preview model and is not available in South Korea.`,
}

const EMBER: LlmCapabilities = { ...META_CAPABILITIES, maxOutputTokens: 524_288 }

const model = (id: string, tier: ModelInfo['tier'], label: string, capabilities: LlmCapabilities): ModelInfo => ({
  provider: 'meta',
  id,
  tier,
  label,
  capabilities,
  contextTokens: 1_048_576,
})

export const META_MODELS: readonly ModelInfo[] = [
  model('muse-wonder-1.0', 'strong', 'Muse Wonder 1.0 (preview)', WONDER),
  model('muse-spark-1.3', 'mid', 'Muse Spark 1.3', META_CAPABILITIES),
  model('muse-spark-1.2', 'mid', 'Muse Spark 1.2', WITHOUT_MAX),
  model('muse-spark-1.1', 'mid', 'Muse Spark 1.1', WITHOUT_MAX),
  model('muse-ember-1.0', 'cheap', 'Muse Ember 1.0', EMBER),
]
