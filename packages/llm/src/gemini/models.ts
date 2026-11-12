import { type LlmCapabilities, type ModelInfo } from '../capabilities'

const INLINE_LIMIT_BASE64_BYTES = 100_000_000

const GEMINI_DATA_NOTE =
  'With a free Gemini key Google may use your content for training and human review; paid keys are not used for training but are logged for a limited time to catch abuse.'

const GEMINI_CAPABILITIES: LlmCapabilities = {
  structuredOutput: 'strict',
  documents: 'native-pdf',
  images: ['image/png', 'image/jpeg', 'image/webp'],
  maxRequestBytes: Math.floor((INLINE_LIMIT_BASE64_BYTES * 3) / 4),
  cache: 'automatic',
  effortLevels: ['low', 'medium', 'high'],
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
  reasoningCappedByMaxTokens: true,
  streaming: 'required',
  maxOutputTokens: 65_536,
  dataNote: GEMINI_DATA_NOTE,
}

const model = (id: string, tier: ModelInfo['tier'], label: string): ModelInfo => ({
  provider: 'gemini',
  id,
  tier,
  label,
  capabilities: GEMINI_CAPABILITIES,
  contextTokens: 1_048_576,
})

export const GEMINI_MODELS: readonly ModelInfo[] = [
  model('gemini-4-carbon', 'strong', 'Gemini 4 Carbon'),
  model('gemini-4-argon', 'strong', 'Gemini 4 Argon'),
  model('gemini-3.8-flash', 'mid', 'Gemini 3.8 Flash'),
  model('gemini-3.5-flash-lite', 'cheap', 'Gemini 3.5 Flash-Lite'),
]
