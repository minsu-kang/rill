import { ANTHROPIC_CAPABILITIES } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { costUsd, estimateCallUsd, priceFor } from '../src/pricing'
import { SOFT_CAP_RESERVE_FACTOR, capabilitiesOfSpec, modelIdOf, providerOfSpec, softCapFactor, unsupportedMediaReason } from '../src/spec'

describe('model specs', () => {
  it('takes the model id out of a provider:model spec and leaves a bare id alone', () => {
    expect(modelIdOf('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(modelIdOf('anthropic:claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(modelIdOf('openai:gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(modelIdOf('gemini:gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(modelIdOf('grok:grok-4.7')).toBe('grok-4.7')
    expect(modelIdOf('meta:muse-spark-1.3')).toBe('muse-spark-1.3')
  })

  it('does not treat an unknown prefix as a provider', () => {
    expect(modelIdOf('weird:model')).toBe('weird:model')
    expect(providerOfSpec('weird:model')).toBeUndefined()
  })

  it('reads the provider of a spec, a bare id being Anthropic', () => {
    expect(providerOfSpec('claude-haiku-5-5')).toBe('anthropic')
    expect(providerOfSpec('openai:gpt-6.1-sol')).toBe('openai')
    expect(providerOfSpec('meta:muse-spark-1.3')).toBe('meta')
  })

  it('looks up the capabilities of the model, and the Anthropic defaults for an id it does not know', () => {
    expect(capabilitiesOfSpec('grok:grok-4.7').documents).toBe('none')
    expect(capabilitiesOfSpec('gemini:gemini-3.8-flash').images).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(capabilitiesOfSpec('claude-sonnet-5-5')).toBe(ANTHROPIC_CAPABILITIES)
    expect(capabilitiesOfSpec('claude-future-9')).toBe(ANTHROPIC_CAPABILITIES)
  })

  it('reserves more for a model whose hidden reasoning is not capped by max tokens', () => {
    expect(SOFT_CAP_RESERVE_FACTOR).toBe(2)
    expect(softCapFactor('grok:grok-4.7')).toBe(SOFT_CAP_RESERVE_FACTOR)
    expect(softCapFactor('grok:grok-4.3')).toBe(SOFT_CAP_RESERVE_FACTOR)
    for (const spec of ['claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'gemini:gemini-3.8-flash', 'meta:muse-spark-1.3']) expect(softCapFactor(spec)).toBe(1)
  })
})

describe('unsupportedMediaReason', () => {
  it('names a PDF for a model that reads none and an image type outside its list', () => {
    expect(unsupportedMediaReason('grok:grok-4.7', ['application/pdf'])).toBe('grok:grok-4.7 reads no PDF files')
    expect(unsupportedMediaReason('gemini:gemini-3.8-flash', ['image/gif'])).toBe('gemini:gemini-3.8-flash does not take image/gif images')
    expect(unsupportedMediaReason('grok:grok-4.7', ['image/png', 'image/webp'])).toBe('grok:grok-4.7 does not take image/webp images')
  })

  it('says nothing about types the model takes, or about types that are neither PDF nor image', () => {
    expect(unsupportedMediaReason('openai:gpt-6.1-sol', ['application/pdf', 'image/gif', 'image/webp'])).toBeUndefined()
    expect(unsupportedMediaReason('grok:grok-4.7', ['image/png', 'image/jpeg', 'text/plain'])).toBeUndefined()
    expect(unsupportedMediaReason('claude-sonnet-5-5', [])).toBeUndefined()
  })
})

describe('eval prices for provider:model specs', () => {
  it('prices a spec like its bare model id', () => {
    expect(priceFor('openai:gpt-6.1-sol')).toEqual(priceFor('gpt-6.1-sol'))
    expect(priceFor('openai:gpt-6.1-sol')).toBeDefined()
    expect(costUsd('grok:grok-4.7', { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toBe(
      costUsd('grok-4.7', { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }),
    )
    expect(estimateCallUsd('meta:muse-spark-1.3', 5000, 400)).toBe(estimateCallUsd('muse-spark-1.3', 5000, 400))
  })

  it('has no price for an unknown model or provider prefix', () => {
    expect(priceFor('openai:gpt-9')).toBeUndefined()
    expect(priceFor('weird:model')).toBeUndefined()
  })

  it('follows the dated table on both sides of a price change', () => {
    const before = priceFor('gemini:gemini-4-carbon', '2026-11-30')
    const after = priceFor('gemini:gemini-4-carbon', '2026-12-01')
    expect(before?.input).toBe(2)
    expect(after?.input).toBe(4)
    expect(estimateCallUsd('gemini:gemini-4-carbon', 1_000_000, 0, '2026-12-01')).toBe(4)
  })

  it('keeps pricing a bare id exactly as before', () => {
    expect(estimateCallUsd('claude-haiku-5-5', 1000, 500)).toBeCloseTo(0.00035, 12)
  })
})
