import { describe, expect, it } from 'vitest'
import { PRICE_SCHEDULE, PRICE_TABLE, PRICE_TABLE_AS_OF, costUsd, estimateCallUsd, estimateWorstCallUsd, priceFor } from '../src/index'

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

describe('estimateWorstCallUsd', () => {
  it('prices every input token as a cache write when writes cost more than plain input', () => {
    const write = priceFor('claude-sonnet-5-5')!.cacheWrite
    expect(write).toBeGreaterThan(priceFor('claude-sonnet-5-5')!.input)
    expect(estimateWorstCallUsd('claude-sonnet-5-5', 4000, 2000)).toBeCloseTo((4000 * write + 2000 * priceFor('claude-sonnet-5-5')!.output) / 1e6, 12)
    expect(estimateWorstCallUsd('claude-sonnet-5-5', 4000, 2000)!).toBeGreaterThan(estimateCallUsd('claude-sonnet-5-5', 4000, 2000)!)
  })

  it('prices input at the plain rate when writes are free, so it never goes below the plain estimate', () => {
    expect(priceFor('grok-4.7')!.cacheWrite).toBe(0)
    expect(estimateWorstCallUsd('grok-4.7', 4000, 2000)).toBe(estimateCallUsd('grok-4.7', 4000, 2000))
    for (const model of Object.keys(PRICE_TABLE)) {
      expect(estimateWorstCallUsd(model, 5000, 700)!, model).toBeGreaterThanOrEqual(estimateCallUsd(model, 5000, 700)!)
    }
  })

  it('uses the long-context tier once the prompt is past its threshold, as costUsd does', () => {
    const price = priceFor('gpt-6-astra')!
    const above = price.longContext!.aboveInputTokens + 1
    const tier = price.longContext!
    expect(estimateWorstCallUsd('gpt-6-astra', above, 1000)).toBeCloseTo((above * Math.max(tier.input, tier.cacheWrite) + 1000 * tier.output) / 1e6, 12)
    const below = price.longContext!.aboveInputTokens
    expect(estimateWorstCallUsd('gpt-6-astra', below, 1000)).toBeCloseTo((below * Math.max(price.input, price.cacheWrite) + 1000 * price.output) / 1e6, 12)
  })

  it('follows the price in force on the date asked for, and is undefined for an unknown model', () => {
    expect(estimateWorstCallUsd('gemini-4-carbon', 1_000_000, 0, '2026-12-02')).toBeCloseTo(4, 10)
    expect(estimateWorstCallUsd('nope', 1, 1)).toBeUndefined()
  })
})

describe('dated prices', () => {
  it('switches on the stated day, on both sides of the boundary', () => {
    expect(priceFor('gemini-4-carbon', '2026-11-30')).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 })
    expect(priceFor('gemini-4-carbon', '2026-12-01')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 })
    expect(priceFor('gemini-3.8-flash', '2026-12-31')).toMatchObject({ input: 0.75, output: 3.75 })
    expect(priceFor('gemini-3.8-flash', '2027-01-01')).toMatchObject({ input: 1.5, output: 7.5 })
    expect(priceFor('gemini-4-carbon', new Date('2026-12-01T00:00:00Z'))?.input).toBe(4)
    expect(priceFor('gemini-4-carbon', '2026-12-01T23:59:59Z')?.input).toBe(4)
  })

  it('prices a call by the date it ran on', () => {
    const run = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    expect(costUsd('gemini-4-carbon', run, '2026-11-12')).toBeCloseTo(12, 10)
    expect(costUsd('gemini-4-carbon', run, '2026-12-02')).toBeCloseTo(24, 10)
    expect(estimateCallUsd('gemini-4-carbon', 1_000_000, 0, '2026-12-02')).toBeCloseTo(4, 10)
  })

  it('uses the price in force today when no date is given', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(priceFor('gemini-4-carbon')).toEqual(priceFor('gemini-4-carbon', today))
    expect(priceFor('claude-opus-5-5')).toBe(priceFor('claude-opus-5-5', '2026-01-01'))
  })

  it('exposes the table as of its date and rejects a malformed date', () => {
    expect(PRICE_TABLE['gemini-4-carbon']).toBe(priceFor('gemini-4-carbon', PRICE_TABLE_AS_OF))
    expect(() => priceFor('gemini-4-carbon', 'December')).toThrow(RangeError)
    expect(() => priceFor('gemini-4-carbon', new Date(Number.NaN))).toThrow(RangeError)
  })

  it('has no gap or overlap between the dated entries of one model', () => {
    for (const [id, entries] of Object.entries(PRICE_SCHEDULE)) {
      entries.forEach((entry, index) => {
        const next = entries[index + 1]
        if (next === undefined) return expect(entry.effectiveTo, id).toBeUndefined()
        const day = new Date(`${entry.effectiveTo}T00:00:00Z`)
        day.setUTCDate(day.getUTCDate() + 1)
        expect(next.effectiveFrom, id).toBe(day.toISOString().slice(0, 10))
      })
      expect(entries[0]?.effectiveFrom, id).toBeUndefined()
    }
  })
})

describe('vendor prices', () => {
  const run = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) =>
    usage(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens)

  it('holds the documented standard prices', () => {
    expect(priceFor('gpt-6-astra')).toMatchObject({ input: 10, cacheRead: 1, output: 50, cacheWrite: 12.5, assumed: [] })
    expect(priceFor('gpt-6.1-sol')).toMatchObject({ input: 2, cacheRead: 0.1, output: 10, cacheWrite: 2.5 })
    expect(priceFor('gpt-6.1-terra')).toMatchObject({ input: 1, cacheRead: 0.05, output: 5, cacheWrite: 1.25 })
    expect(priceFor('gpt-6-luna')).toMatchObject({ input: 0.1, cacheRead: 0.01, output: 0.5, cacheWrite: 0.125 })
    expect(priceFor('grok-4.7')).toMatchObject({ input: 2, cacheRead: 0.5, output: 6 })
    expect(priceFor('grok-4.3')).toMatchObject({ input: 1.25, cacheRead: 0.2, output: 2.5 })
    expect(priceFor('muse-spark-1.3')).toMatchObject({ input: 1.25, cacheRead: 0.15, output: 4.25 })
    expect(priceFor('muse-ember-1.0')).toMatchObject({ input: 0.1, cacheRead: 0.004, output: 0.5 })
    expect(priceFor('gemini-3.5-flash-lite')).toMatchObject({ input: 0.3, cacheRead: 0.03, output: 2.5 })
  })

  it('prices cache writes and reads on OpenAI, with uncached input counted apart', () => {
    expect(costUsd('gpt-6.1-sol', run(4700, 1450, 0, 5100))).toBeCloseTo((4700 * 2 + 5100 * 2.5 + 1450 * 10) / 1e6, 12)
  })

  it('switches to the long-prompt rates above the documented size, counting cached tokens', () => {
    expect(costUsd('gpt-6.1-sol', run(272_000, 1000))).toBeCloseTo((272_000 * 2 + 1000 * 10) / 1e6, 12)
    expect(costUsd('gpt-6.1-sol', run(272_001, 1000))).toBeCloseTo((272_001 * 4 + 1000 * 15) / 1e6, 12)
    expect(costUsd('gpt-6.1-sol', run(200_000, 0, 72_001))).toBeCloseTo((200_000 * 4 + 72_001 * 0.2) / 1e6, 12)
    expect(costUsd('grok-4.7', run(199_999, 0))).toBeCloseTo(199_999 * 2 / 1e6, 12)
    expect(costUsd('grok-4.7', run(100_000, 1000, 100_000))).toBeCloseTo((100_000 * 4 + 1000 * 12 + 100_000 * 1) / 1e6, 12)
    expect(costUsd('muse-ember-1.0', run(200_001, 1000))).toBeCloseTo((200_001 * 0.3 + 1000 * 1.5) / 1e6, 12)
    expect(priceFor('muse-wonder-1.0')?.longContext).toBeUndefined()
  })

  it('marks what the reports do not document', () => {
    expect(priceFor('grok-4.7')?.assumed).toContain('cacheWrite')
    expect(priceFor('gpt-6.1-sol')?.assumed).toEqual(['longContext'])
    expect(priceFor('muse-spark-1.2')?.assumed).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(priceFor('gemini-3.1-pro-preview')?.assumed).toEqual(['cacheRead', 'longContext'])
    expect(priceFor('gemini-4-argon', '2026-12-02')?.assumed).toContain('input')
    expect(priceFor('gemini-4-argon', '2026-11-12')?.assumed).toEqual([])
  })

  it('matches the longest known id and a dated snapshot, never a look-alike', () => {
    expect(priceFor('gpt-6.1-sol-2026-09-29')?.input).toBe(2)
    expect(priceFor('grok-4.20-0309-non-reasoning')?.input).toBe(1.25)
    expect(priceFor('gpt-6.1')).toBeUndefined()
    expect(priceFor('gpt-6.1-sol2')).toBeUndefined()
    expect(priceFor('muse-spark-1.30')).toBeUndefined()
  })

  it('never prices a contributor id, which would be cheaper only because it trains on your data', () => {
    expect(priceFor('muse-spark-1.3-contributor')).toBeUndefined()
    expect(costUsd('muse-spark-1.3-contributor', run(1, 1))).toBeUndefined()
  })

  it('holds only finite, non-negative numbers', () => {
    for (const [id, entries] of Object.entries(PRICE_SCHEDULE)) {
      for (const entry of entries) {
        for (const value of [entry.input, entry.output, entry.cacheRead, entry.cacheWrite, ...(entry.longContext === undefined ? [] : [entry.longContext.input, entry.longContext.output, entry.longContext.cacheRead, entry.longContext.cacheWrite, entry.longContext.aboveInputTokens])]) {
          expect(Number.isFinite(value) && value >= 0, id).toBe(true)
        }
      }
    }
  })
})

describe('long-context thresholds', () => {
  const THRESHOLDS: Record<string, number> = {
    'claude-haiku-5-5': 100_000,
    'gpt-6-astra': 272_000,
    'gpt-6.1-sol': 272_000,
    'gpt-6.1-terra': 272_000,
    'gpt-6-luna': 272_000,
    'gpt-5.6-terra': 272_000,
    'gemini-3.1-pro-preview': 200_000,
    'grok-4.7': 199_999,
    'grok-4.6': 199_999,
    'grok-4.5': 199_999,
    'grok-4.3': 199_999,
    'grok-4.20-0309-reasoning': 199_999,
    'grok-4.20-0309-non-reasoning': 199_999,
    'grok-build-0.1': 199_999,
    'muse-ember-1.0': 200_000,
  }

  it('lists exactly the models that have a long-context tier, with the threshold the vendor states', () => {
    const found = Object.fromEntries(Object.entries(PRICE_TABLE).flatMap(([id, entry]) => (entry.longContext === undefined ? [] : [[id, entry.longContext.aboveInputTokens]])))
    expect(found).toEqual(THRESHOLDS)
  })

  it.each(Object.entries(THRESHOLDS))('%s switches to the long tier one token past %i', (model, above) => {
    const base = priceFor(model)!
    const tier = base.longContext!
    const at = costUsd(model, usage(above, 1000))!
    const past = costUsd(model, usage(above + 1, 1000))!
    expect(at).toBeCloseTo((above * base.input + 1000 * base.output) / 1e6, 9)
    expect(past).toBeCloseTo(((above + 1) * tier.input + 1000 * tier.output) / 1e6, 9)
    expect(past).toBeGreaterThan(at)
  })

  it('counts cached tokens toward the prompt size', () => {
    const base = priceFor('gpt-6-astra')!
    expect(costUsd('gpt-6-astra', usage(100_000, 0, 172_001, 0))!).toBeCloseTo((100_000 * base.longContext!.input + 172_001 * base.longContext!.cacheRead) / 1e6, 9)
    expect(costUsd('gpt-6-astra', usage(100_000, 0, 0, 172_001))!).toBeCloseTo((100_000 * base.longContext!.input + 172_001 * base.longContext!.cacheWrite) / 1e6, 9)
  })
})

describe('price ids', () => {
  it('has no id that is a dash-prefix of another, so the longest-match rule never has two candidates', () => {
    const ids = Object.keys(PRICE_SCHEDULE)
    for (const id of ids) expect(ids.filter((other) => other !== id && id.startsWith(`${other}-`)), id).toEqual([])
  })

  it('matches a dated snapshot of a known id and nothing that merely starts with it', () => {
    expect(priceFor('claude-sonnet-5-5-20261001')).toBe(priceFor('claude-sonnet-5-5'))
    expect(priceFor('claude-sonnet-5-55')).toBeUndefined()
  })
})
