import type { ProviderDescriptor } from '../descriptor'
import { metaExchange } from './exchange'
import { LIVE_CHECKS } from './live-checks'
import { META_MODELS } from './models'
import { MetaProvider } from './provider'

export { LIVE_CHECKS, MetaProvider, metaExchange }

export const metaDescriptor: ProviderDescriptor = {
  id: 'meta',
  label: 'Meta (Muse)',
  keyEnv: 'META_API_KEY',
  models: META_MODELS,
  liveChecks: LIVE_CHECKS,
  exchange: metaExchange,
  create: (options) =>
    new MetaProvider({
      model: options.model,
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
    }),
}
