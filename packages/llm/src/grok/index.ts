import type { ProviderDescriptor } from '../descriptor'
import { grokExchange } from './exchange'
import { LIVE_CHECKS } from './live-checks'
import { GROK_MODELS } from './models'
import { GrokProvider } from './provider'

export { grokExchange } from './exchange'
export { LIVE_CHECKS } from './live-checks'
export { GROK_DEFAULT_BASE_URL, GROK_DEFAULT_MAX_TOKENS, GROK_DEFAULT_TIMEOUT_MS, GrokProvider, type GrokProviderOptions } from './provider'

export const grokDescriptor: ProviderDescriptor = {
  id: 'grok',
  label: 'xAI Grok',
  keyEnv: 'XAI_API_KEY',
  models: GROK_MODELS,
  liveChecks: LIVE_CHECKS,
  exchange: grokExchange,
  create: (options) =>
    new GrokProvider({
      model: options.model,
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    }),
}
