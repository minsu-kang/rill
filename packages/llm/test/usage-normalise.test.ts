import { describe, expect, it } from 'vitest'
import { LlmError, normaliseUsage } from '../src/index'

const parts = { input: 1000, cacheRead: 300, cacheWrite: 200, output: 400, inputIncludesCache: true }

describe('normaliseUsage', () => {
  it('takes the cache buckets out of an input count that includes them', () => {
    expect(normaliseUsage(parts)).toEqual({ inputTokens: 500, outputTokens: 400, cacheReadInputTokens: 300, cacheCreationInputTokens: 200 })
  })

  it('keeps the input as is when the vendor reports it without the cache buckets', () => {
    expect(normaliseUsage({ ...parts, inputIncludesCache: false })).toEqual({
      inputTokens: 1000,
      outputTokens: 400,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 200,
    })
  })

  it('adds reasoning tokens that are reported next to the output', () => {
    expect(normaliseUsage({ ...parts, reasoning: 250 }).outputTokens).toBe(650)
  })

  it('accepts a call that was entirely cached and a zero reply', () => {
    expect(normaliseUsage({ input: 700, cacheRead: 500, cacheWrite: 200, output: 0, inputIncludesCache: true }).inputTokens).toBe(0)
    expect(normaliseUsage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, inputIncludesCache: true })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })

  it.each([
    ['input', { input: -1 }],
    ['cacheRead', { cacheRead: -1 }],
    ['cacheWrite', { cacheWrite: -5 }],
    ['output', { output: -1 }],
    ['reasoning', { reasoning: -1 }],
    ['input', { input: Number.NaN }],
    ['output', { output: Number.POSITIVE_INFINITY }],
    ['cacheRead', { cacheRead: 12.5 }],
    ['output', { output: 2e9 }],
  ])('rejects an impossible %s count', (field, change) => {
    const act = () => normaliseUsage({ ...parts, ...change })
    expect(act).toThrow(LlmError)
    expect(act).toThrow(field)
    try {
      act()
    } catch (error) {
      expect((error as LlmError).kind).toBe('invalid_output')
    }
  })

  it('rejects cache buckets larger than the input that is said to include them', () => {
    expect(() => normaliseUsage({ ...parts, input: 400 })).toThrow(/cache/)
    expect(normaliseUsage({ ...parts, input: 400, inputIncludesCache: false }).inputTokens).toBe(400)
  })
})

describe('the largest token count it believes', () => {
  it('takes a count just under one billion and refuses one billion', () => {
    expect(normaliseUsage({ ...parts, input: 999_999_999, cacheRead: 0, cacheWrite: 0 }).inputTokens).toBe(999_999_999)
    expect(() => normaliseUsage({ ...parts, input: 1_000_000_000, cacheRead: 0, cacheWrite: 0 })).toThrow(LlmError)
  })
})
