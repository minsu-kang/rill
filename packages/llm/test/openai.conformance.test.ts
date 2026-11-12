import { openaiDescriptor } from '../src/index'
import { describeProviderConformance } from './conformance'
import { OPENAI_MODEL, openaiWire } from './openai-wire'

describeProviderConformance({
  name: 'openai provider',
  build: (transport) =>
    openaiDescriptor.create({ model: OPENAI_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random }),
  wire: [openaiWire(false), openaiWire(true)],
  effortPath: ['reasoning', 'effort'],
})
