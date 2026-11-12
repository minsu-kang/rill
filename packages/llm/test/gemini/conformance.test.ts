import { describeProviderConformance } from '../conformance'
import { GeminiProvider } from '../../src/gemini'
import { GEMINI_MODEL, geminiWire } from './wire'

describeProviderConformance({
  name: 'Gemini',
  build: (transport) => new GeminiProvider({ model: GEMINI_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random }),
  wire: geminiWire(),
  effortPath: ['generation_config', 'thinking_level'],
})
