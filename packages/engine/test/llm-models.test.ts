import { MODEL_TABLE, PROVIDER_IDS, providerDescriptor } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { LlmModelsResultSchema } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { configuredProviders, llmModelsResult } from '../src/llm-models'
import { MARKER_KEYS, MARKER_VALUES, isolateKeyEnvironment, mentionsAny } from './llm-env'

isolateKeyEnvironment()

function functionsIn(value: unknown, path = 'result'): string[] {
  if (typeof value === 'function') return [path]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => functionsIn(item, `${path}.${key}`))
}

describe('configuredProviders', () => {
  it('lists a provider when the variable named by its descriptor has a value', () => {
    expect(configuredProviders({})).toEqual([])
    for (const id of PROVIDER_IDS) {
      expect(configuredProviders({ [providerDescriptor(id).keyEnv]: 'some-value' }), id).toEqual([id])
    }
  })

  it('keeps the provider order and lists every provider that has a key', () => {
    const env = { META_API_KEY: 'm', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', XAI_API_KEY: 'x', GEMINI_API_KEY: 'g' }
    expect(configuredProviders(env)).toEqual(['anthropic', 'openai', 'gemini', 'grok', 'meta'])
  })

  it('ignores empty and blank values, other variables and the wrong variable for a provider', () => {
    expect(configuredProviders({ OPENAI_API_KEY: '', GEMINI_API_KEY: '   ', XAI_API_KEY: undefined, META_API_KEY: '\t\n' })).toEqual([])
    expect(configuredProviders({ OPENAI_KEY: 'x', GROK_API_KEY: 'x', GOOGLE_API_KEY: 'x', PATH: '/bin' })).toEqual([])
    expect(configuredProviders({ GEMINI_API_KEY: 'x' })).not.toContain('openai')
  })

  it('counts ANTHROPIC_AUTH_TOKEN for Anthropic, because the Anthropic SDK accepts it', () => {
    expect(configuredProviders({ ANTHROPIC_AUTH_TOKEN: 'token' })).toEqual(['anthropic'])
    expect(configuredProviders({ ANTHROPIC_AUTH_TOKEN: ' ' })).toEqual([])
  })

  it('never reads the process environment', () => {
    process.env.OPENAI_API_KEY = 'would-be-a-real-key'
    expect(configuredProviders({})).toEqual([])
  })
})

describe('llmModelsResult', () => {
  it('lists every model in the registry and every provider, none configured and none active by default', () => {
    const result = llmModelsResult(undefined)
    expect(result.models.map((model) => `${model.provider}:${model.id}`)).toEqual(MODEL_TABLE.map((model) => `${model.provider}:${model.id}`))
    expect(result.providers.map((entry) => entry.id)).toEqual([...PROVIDER_IDS])
    expect(result.providers.every((entry) => !entry.configured)).toBe(true)
    expect(result.active).toBeNull()
  })

  it('takes label and key variable name from the provider descriptors', () => {
    const result = llmModelsResult(undefined)
    for (const entry of result.providers) {
      const descriptor = providerDescriptor(entry.id)
      expect(entry).toEqual({ id: entry.id, label: descriptor.label, keyEnv: descriptor.keyEnv, configured: false })
    }
  })

  it('marks the configured providers and reports the active model', () => {
    const result = llmModelsResult({ configured: ['openai', 'meta'], active: { provider: 'openai', model: 'gpt-6.1-sol' } })
    expect(result.providers.filter((entry) => entry.configured).map((entry) => entry.id)).toEqual(['openai', 'meta'])
    expect(result.active).toEqual({ provider: 'openai', model: 'gpt-6.1-sol' })
  })

  it('produces data only: no functions, and it matches the protocol schema', () => {
    const result = llmModelsResult({ configured: ['anthropic'], active: null })
    expect(functionsIn(result)).toEqual([])
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(Value.Check(LlmModelsResultSchema, result)).toBe(true)
  })

  it('carries each model capabilities from the registry', () => {
    const result = llmModelsResult(undefined)
    for (const [index, source] of MODEL_TABLE.entries()) {
      const shown = result.models[index]!
      expect(shown).toMatchObject({ provider: source.provider, id: source.id, tier: source.tier, label: source.label, contextTokens: source.contextTokens })
      expect(shown.capabilities).toEqual({ ...source.capabilities, images: [...source.capabilities.images], effortLevels: [...source.capabilities.effortLevels], effortMap: { ...source.capabilities.effortMap } })
    }
    const grok = result.models.find((model) => model.provider === 'grok')!
    expect(grok.capabilities.documents).toBe('none')
    expect(result.models.find((model) => model.provider === 'gemini')!.capabilities.dataNote).toMatch(/free Gemini key.*training/i)
  })

  it('hands out copies, so a caller cannot change the registry', () => {
    const first = llmModelsResult(undefined)
    first.models[0]!.capabilities.images.push('image/gif')
    first.models[0]!.capabilities.effortLevels.length = 0
    first.models[0]!.capabilities.effortMap.low = 'changed'
    first.models.length = 0
    const second = llmModelsResult(undefined)
    expect(second.models).toHaveLength(MODEL_TABLE.length)
    expect(second.models[0]!.capabilities.effortLevels).toEqual([...MODEL_TABLE[0]!.capabilities.effortLevels])
    expect(second.models[0]!.capabilities.effortMap.low).toBe(MODEL_TABLE[0]!.capabilities.effortMap.low)
  })

  it('carries no key, and no part of a key, when every key is set', () => {
    const configured = configuredProviders({ ...MARKER_KEYS, ANTHROPIC_AUTH_TOKEN: 'sk-ant-MARKER-token-77' })
    const text = JSON.stringify(llmModelsResult({ configured, active: { provider: 'openai', model: 'gpt-6.1-sol' } }))
    expect(configured).toHaveLength(5)
    expect(mentionsAny(text, [...MARKER_VALUES, 'MARKER'])).toBeUndefined()
  })
})

describe('Engine.llmModels', () => {
  const make = (options: Partial<ConstructorParameters<typeof Engine>[0]> = {}) => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), ...options })

  it('reports no configured provider and no active model when the engine is given no information', () => {
    const result = make().llmModels()
    expect(result.providers.every((entry) => !entry.configured)).toBe(true)
    expect(result.active).toBeNull()
    expect(result.models).toHaveLength(MODEL_TABLE.length)
  })

  it('reports the information the engine was started with', () => {
    const engine = make({ llmInfo: { configured: ['gemini'], active: { provider: 'gemini', model: 'gemini-3.8-flash' } } })
    const result = engine.llmModels()
    expect(result.providers.filter((entry) => entry.configured).map((entry) => entry.id)).toEqual(['gemini'])
    expect(result.active).toEqual({ provider: 'gemini', model: 'gemini-3.8-flash' })
    expect(Value.Check(LlmModelsResultSchema, result)).toBe(true)
  })

  it('does not follow later changes to the object it was given', () => {
    const configured: Array<'openai'> = ['openai']
    const active = { provider: 'openai' as const, model: 'gpt-6.1-sol' }
    const engine = make({ llmInfo: { configured, active } })
    configured.length = 0
    active.model = 'changed'
    const result = engine.llmModels()
    expect(result.providers.find((entry) => entry.id === 'openai')!.configured).toBe(true)
    expect(result.active?.model).toBe('gpt-6.1-sol')
  })
})
