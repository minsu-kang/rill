import { describeProviderConformance } from './conformance'
import { META_TEST_MODEL, metaWire } from './meta-wire'
import { MetaProvider } from '../src/meta/provider'

describeProviderConformance({
  name: 'meta provider',
  build: (transport) =>
    new MetaProvider({ model: META_TEST_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random }),
  wire: metaWire,
  effortPath: ['reasoning_effort'],
  effortWhenUnset: 'high',
})
