import type { ProviderId } from '../../shared/host-api'

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  grok: 'Grok (xAI)',
  meta: 'Meta',
}
