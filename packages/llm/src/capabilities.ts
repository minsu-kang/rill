import type { ImageMediaType, LlmEffort, LlmProvider } from './types'

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'grok' | 'meta'

export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini', 'grok', 'meta']

export const EFFORT_LEVELS: readonly LlmEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface LlmCapabilities {
  structuredOutput: 'strict' | 'best-effort'
  documents: 'native-pdf' | 'none'
  images: readonly ImageMediaType[]
  maxRequestBytes?: number
  cache: 'explicit' | 'automatic' | 'none'
  maxCacheBreakpoints?: number
  effortLevels: readonly LlmEffort[]
  effortMap: Readonly<Record<LlmEffort, string>>
  reasoningCappedByMaxTokens: boolean
  streaming: 'required' | 'optional'
  maxOutputTokens?: number
  dataNote: string
}

export interface ModelInfo {
  provider: ProviderId
  id: string
  tier: 'strong' | 'mid' | 'cheap'
  label: string
  capabilities: LlmCapabilities
  contextTokens: number
}

export const ANTHROPIC_CAPABILITIES: LlmCapabilities = {
  structuredOutput: 'strict',
  documents: 'native-pdf',
  images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  cache: 'explicit',
  maxCacheBreakpoints: 4,
  effortLevels: EFFORT_LEVELS,
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  reasoningCappedByMaxTokens: true,
  streaming: 'optional',
  maxOutputTokens: 128_000,
  dataNote: 'Your content is sent to the Anthropic API and handled under your Anthropic account terms.',
}

export function capabilitiesOf(provider: LlmProvider): LlmCapabilities {
  return provider.capabilities ?? ANTHROPIC_CAPABILITIES
}
