import { describe, expect, it } from 'vitest'
import { providerDescriptor, type ProviderId } from '../src/index'
import { CONFORMANCE_API_KEY, CONFORMANCE_SCHEMA, type ConformanceWire } from './conformance'
import { createFakeTransport } from './fake-transport'
import { GEMINI_MODEL, geminiWire } from './gemini/wire'
import { GROK_MODEL, grokWire } from './grok/wire'
import { META_TEST_MODEL, metaWire } from './meta-wire'
import { OPENAI_MODEL, openaiWire } from './openai-wire'

const adapters: [ProviderId, string, ConformanceWire][] = [
  ['openai', OPENAI_MODEL, openaiWire(false)],
  ['gemini', GEMINI_MODEL, geminiWire()],
  ['grok', GROK_MODEL, grokWire()],
  ['meta', META_TEST_MODEL, metaWire],
]

async function requestsMade(id: ProviderId, model: string, wire: ConformanceWire, maxRetries: number | undefined): Promise<number> {
  const transport = createFakeTransport({ apiKey: CONFORMANCE_API_KEY })
  transport.script(wire.overloaded)
  const provider = providerDescriptor(id).create({
    model,
    apiKey: transport.apiKey,
    fetch: transport.fetch,
    sleep: transport.sleep,
    random: transport.random,
    ...(maxRetries === undefined ? {} : { maxRetries }),
  })
  await provider.generate({ schema: CONFORMANCE_SCHEMA, messages: [{ role: 'user', content: 'go' }] }).catch(() => undefined)
  return transport.requests.length
}

describe.each(adapters)('%s maxRetries', (id, model, wire) => {
  it('retries twice by default', async () => {
    expect(await requestsMade(id, model, wire, undefined)).toBe(3)
  })

  it('does not retry at all when it is 0, so a caller that owns retries counts every request', async () => {
    expect(await requestsMade(id, model, wire, 0)).toBe(1)
  })

  it('retries as often as it is told, up to the number given', async () => {
    expect(await requestsMade(id, model, wire, 1)).toBe(2)
  })
})
