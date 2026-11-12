import { GrokProvider } from '../../src/grok'
import { GROK_MODELS } from '../../src/grok/models'
import { describeProviderConformance } from '../conformance'
import { grokWire } from './wire'

for (const { id } of GROK_MODELS) {
  describeProviderConformance({
    name: `grok ${id}`,
    build: (transport) => new GrokProvider({ model: id, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random }),
    wire: grokWire(id),
    effortPath: ['reasoning', 'effort'],
    effortWhenUnset: 'medium',
  })
}
