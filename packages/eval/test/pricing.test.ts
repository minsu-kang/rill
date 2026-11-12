import { describe, expect, it } from 'vitest'
import { PRICE_TABLE, PRICE_TABLE_AS_OF, costUsd, estimateCallUsd, priceFor } from '../src/pricing'

const usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheCreationInputTokens,
})

describe('price table', () => {
  it('is dated and lists the three Claude models first', () => {
    expect(PRICE_TABLE_AS_OF).toBe('2026-11-13')
    expect(Object.keys(PRICE_TABLE).slice(0, 3)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  it('holds the stated prices per million tokens', () => {
    expect(PRICE_TABLE['claude-haiku-5-5']).toMatchObject({ input: 0.1, output: 0.5 })
    expect(PRICE_TABLE['claude-haiku-5-5']?.longContext).toMatchObject({ aboveInputTokens: 100_000, input: 0.5, output: 2.5 })
    expect(PRICE_TABLE['claude-sonnet-5-5']).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 })
    expect(PRICE_TABLE['claude-opus-5-5']).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 })
  })

  it('marks the assumed cache prices', () => {
    expect(PRICE_TABLE['claude-haiku-5-5']).toMatchObject({ cacheRead: 0.01, cacheWrite: 0.125, assumed: ['cacheRead', 'cacheWrite'] })
    expect(PRICE_TABLE['claude-sonnet-5-5']).toMatchObject({ cacheWrite: 2.5, assumed: ['cacheWrite'] })
    expect(PRICE_TABLE['claude-opus-5-5']).toMatchObject({ cacheWrite: 5, assumed: ['cacheWrite'] })
  })
})

describe('costUsd', () => {
  it('prices input and output tokens per million', () => {
    expect(costUsd('claude-haiku-5-5', usage(1000, 500))).toBeCloseTo(0.00035, 12)
    expect(costUsd('claude-opus-5-5', usage(1_000_000, 1_000_000))).toBeCloseTo(24, 10)
    expect(costUsd('claude-sonnet-5-5', usage(0, 0))).toBe(0)
  })

  it('prices cache reads and writes', () => {
    expect(costUsd('claude-sonnet-5-5', usage(2000, 100, 1000, 500))).toBeCloseTo(0.00635, 12)
    expect(costUsd('claude-opus-5-5', usage(0, 0, 1_000_000, 1_000_000))).toBeCloseTo(5.2, 10)
  })

  it('switches Haiku to the long-prompt tier only above 100000 prompt tokens', () => {
    expect(costUsd('claude-haiku-5-5', usage(100_000, 1000))).toBeCloseTo(0.0105, 12)
    expect(costUsd('claude-haiku-5-5', usage(100_001, 1000))).toBeCloseTo(0.0525005, 12)
    expect(costUsd('claude-haiku-5-5', usage(60_000, 0, 50_000))).toBeCloseTo(0.0325, 12)
  })

  it('has no long-prompt tier for Sonnet and Opus', () => {
    expect(costUsd('claude-sonnet-5-5', usage(200_000, 0))).toBeCloseTo(0.4, 12)
  })

  it('returns undefined for an unknown model instead of guessing', () => {
    expect(costUsd('claude-mystery-9', usage(1000, 1000))).toBeUndefined()
    expect(costUsd('constructor', usage(1000, 1000))).toBeUndefined()
    expect(costUsd('', usage(1000, 1000))).toBeUndefined()
  })

  it('prices a dated snapshot like its model but not a longer look-alike id', () => {
    expect(costUsd('claude-opus-5-5-20260301', usage(1_000_000, 0))).toBe(4)
    expect(priceFor('claude-opus-5-50')).toBeUndefined()
    expect(priceFor('claude-opus-5')).toBeUndefined()
  })
})

describe('estimateCallUsd', () => {
  it('prices a call with no cache tokens', () => {
    expect(estimateCallUsd('claude-sonnet-5-5', 4000, 2000)).toBeCloseTo(0.028, 12)
    expect(estimateCallUsd('claude-haiku-5-5', 4000, 2000)).toBeCloseTo(0.0014, 12)
    expect(estimateCallUsd('claude-opus-5-5', 4000, 2000)).toBeCloseTo(0.056, 12)
    expect(estimateCallUsd('nope', 1, 1)).toBeUndefined()
  })
})
