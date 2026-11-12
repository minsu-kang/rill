import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCRIPTORS, MODEL_TABLE, providerDescriptor } from '../../src/index'
import { LIVE_CHECKS, grokDescriptor, grokExchange, GrokProvider } from '../../src/grok'
import { GROK_MODELS } from '../../src/grok/models'
import { createFakeTransport } from '../fake-transport'

describe('the grok descriptor', () => {
  it('is registered under grok with its key variable, models, live checks and exchange parser', () => {
    expect(providerDescriptor('grok')).toBe(grokDescriptor)
    expect(DEFAULT_DESCRIPTORS).toContain(grokDescriptor)
    expect(grokDescriptor.id).toBe('grok')
    expect(grokDescriptor.keyEnv).toBe('XAI_API_KEY')
    expect(grokDescriptor.models).toBe(GROK_MODELS)
    expect(MODEL_TABLE.filter((model) => model.provider === 'grok')).toEqual([...GROK_MODELS])
    expect(grokDescriptor.liveChecks).toBe(LIVE_CHECKS)
    expect(grokDescriptor.exchange).toBe(grokExchange)
  })

  it('creates a provider for the model and ignores an SDK client it does not use', () => {
    const transport = createFakeTransport()
    const provider = grokDescriptor.create({ model: 'grok-4.5', apiKey: transport.apiKey, fetch: transport.fetch, client: { unused: true }, baseURL: 'https://us.api.x.ai' })
    expect(provider).toBeInstanceOf(GrokProvider)
    expect(provider.capabilities?.effortMap.max).toBe('high')
  })
})

describe('LIVE_CHECKS', () => {
  const required = [
    'usage-output-total',
    'usage-cached-subset',
    'image-data-url',
    'effort-xhigh',
    'effort-none',
    'output-limits',
    'terminal-event-shape',
    'stream-error-shape',
    'context-too-long-error',
    'schema-limits',
    'incomplete-reasons',
    'cache-write-unreported',
    'served-model-id',
    'stream-idle-gap',
    'cache-hit',
  ]

  it('lists every unverified fact the adapter depends on, once each', () => {
    const ids = LIVE_CHECKS.map((check) => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of required) expect(ids, id).toContain(id)
  })

  it('has a readable id and a full sentence for each entry', () => {
    for (const check of LIVE_CHECKS) {
      expect(check.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(check.what.length).toBeGreaterThan(40)
      expect(Object.keys(check).sort()).toEqual(['id', 'what'])
    }
  })
})
