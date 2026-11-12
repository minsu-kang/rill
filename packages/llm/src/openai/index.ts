import type { ProviderDescriptor } from '../descriptor'
import { openaiExchange } from './exchange'
import { LIVE_CHECKS } from './live-checks'
import { OPENAI_MODELS } from './models'
import { OpenAiProvider, type OpenAiProviderOptions } from './provider'

export { LIVE_CHECKS } from './live-checks'
export { openaiExchange } from './exchange'
export { OpenAiProvider, createOpenAiClient, type OpenAiProviderOptions } from './provider'
export { OPENAI_MODELS } from './models'

export const openaiDescriptor: ProviderDescriptor = {
  id: 'openai',
  label: 'OpenAI',
  keyEnv: 'OPENAI_API_KEY',
  models: OPENAI_MODELS,
  liveChecks: LIVE_CHECKS,
  exchange: openaiExchange,
  create: (options) =>
    new OpenAiProvider({
      model: options.model,
      apiKey: options.apiKey,
      ...(options.client === undefined ? {} : { client: options.client as OpenAiProviderOptions['client'] }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
    }),
}
