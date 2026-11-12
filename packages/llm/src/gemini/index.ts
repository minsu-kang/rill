import type { ProviderDescriptor } from '../descriptor'
import { geminiExchange } from './exchange'
import { LIVE_CHECKS } from './live-checks'
import { GEMINI_MODELS } from './models'
import { GeminiProvider, type GeminiClient } from './provider'

export const geminiDescriptor: ProviderDescriptor = {
  id: 'gemini',
  label: 'Google Gemini',
  keyEnv: 'GEMINI_API_KEY',
  models: GEMINI_MODELS,
  liveChecks: LIVE_CHECKS,
  exchange: geminiExchange,
  create: (options) =>
    new GeminiProvider({
      model: options.model,
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.client === undefined ? {} : { client: options.client as GeminiClient }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    }),
}

export { geminiExchange } from './exchange'
export { LIVE_CHECKS } from './live-checks'
export { GEMINI_MODELS } from './models'
export { GeminiProvider, type GeminiClient, type GeminiProviderOptions } from './provider'
