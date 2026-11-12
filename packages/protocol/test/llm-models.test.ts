import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { LlmModelInfoSchema, LlmModelsResultSchema, METHODS, validateParams } from '../src/index'

const capabilities = {
  structuredOutput: 'strict',
  documents: 'native-pdf',
  images: ['image/png', 'image/jpeg'],
  maxRequestBytes: 50_000_000,
  cache: 'explicit',
  maxCacheBreakpoints: 4,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  reasoningCappedByMaxTokens: true,
  streaming: 'optional',
  maxOutputTokens: 128_000,
  dataNote: 'Your content is sent to the provider.',
}

const model = { provider: 'openai', id: 'gpt-6.1-sol', tier: 'mid', label: 'GPT-6.1 Sol', contextTokens: 1_000_000, capabilities }
const provider = { id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', configured: true }
const result = { models: [model], providers: [provider], active: { provider: 'openai', model: 'gpt-6.1-sol' } }

describe('llmModels', () => {
  it('takes no parameters', () => {
    expect(validateParams('llmModels', {})).toEqual({ ok: true, method: 'llmModels', params: {} })
    expect(validateParams('llmModels', undefined).ok).toBe(true)
    expect(validateParams('llmModels', { provider: 'openai' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('accepts a result with an active model and one without', () => {
    expect(Value.Check(METHODS.llmModels.result, result)).toBe(true)
    expect(Value.Check(METHODS.llmModels.result, { ...result, active: null })).toBe(true)
    expect(Value.Check(METHODS.llmModels.result, { models: [], providers: [], active: null })).toBe(true)
  })

  it('accepts a model without the optional limits', () => {
    const bare = Object.fromEntries(Object.entries(capabilities).filter(([key]) => !['maxRequestBytes', 'maxCacheBreakpoints', 'maxOutputTokens'].includes(key)))
    expect(Value.Check(LlmModelInfoSchema, { ...model, capabilities: bare })).toBe(true)
  })

  it('needs the configured flag as a boolean and the active model as a pair', () => {
    expect(Value.Check(LlmModelsResultSchema, { ...result, providers: [{ ...provider, configured: 'yes' }] })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, providers: [{ id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY' }] })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, active: { provider: 'openai' } })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, active: { provider: 'other', model: 'x' } })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { models: result.models, providers: result.providers })).toBe(false)
  })

  it('is closed, so a key or any other extra field cannot ride along', () => {
    expect(Value.Check(LlmModelsResultSchema, { ...result, apiKey: 'sk-secret' })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, providers: [{ ...provider, apiKey: 'sk-secret' }] })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, models: [{ ...model, apiKey: 'sk-secret' }] })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, models: [{ ...model, capabilities: { ...capabilities, headers: {} } }] })).toBe(false)
    expect(Value.Check(LlmModelsResultSchema, { ...result, active: { provider: 'openai', model: 'x', apiKey: 'sk-secret' } })).toBe(false)
  })

  it('rejects unknown tiers, providers and capability values', () => {
    expect(Value.Check(LlmModelInfoSchema, { ...model, tier: 'free' })).toBe(false)
    expect(Value.Check(LlmModelInfoSchema, { ...model, provider: 'ollama' })).toBe(false)
    expect(Value.Check(LlmModelInfoSchema, { ...model, capabilities: { ...capabilities, cache: 'sometimes' } })).toBe(false)
    expect(Value.Check(LlmModelInfoSchema, { ...model, capabilities: { ...capabilities, images: ['image/bmp'] } })).toBe(false)
    expect(Value.Check(LlmModelInfoSchema, { ...model, capabilities: { ...capabilities, effortMap: { low: 'low' } } })).toBe(false)
    expect(Value.Check(LlmModelInfoSchema, { ...model, contextTokens: 'big' })).toBe(false)
  })
})
