import { describe, expect, it } from 'vitest'
import { formatUsdPlain, guardReserveUsd, money, plural, roundUpBudget, worstCallUsd } from '../src/budget'
import type { EvalCase, Suite } from '../src/suite'
import { HAIKU, OPUS, SONNET } from './fake-run'

function suiteOf(inputs: readonly number[]): Suite<EvalCase, unknown> {
  const cases: EvalCase[] = inputs.map((_, index) => ({ id: `c${index}`, group: `g${index}`, category: 'easy', tags: [], kind: 'text' }))
  return {
    name: 'extract',
    version: 'v',
    fields: [],
    cases: () => cases,
    run: () => Promise.reject(new Error('not used')),
    score: () => {
      throw new Error('not used')
    },
    estimateInputTokens: (testCase) => inputs[Number(testCase.id.slice(1))] ?? 0,
  }
}

describe('roundUpBudget', () => {
  it('rounds up to the next cent and never to zero', () => {
    expect(roundUpBudget(0.1552)).toBe(0.16)
    expect(roundUpBudget(0.16)).toBe(0.16)
    expect(roundUpBudget(10.481)).toBe(10.49)
    expect(roundUpBudget(0)).toBe(0.01)
    expect(roundUpBudget(-1)).toBe(0.01)
    expect(roundUpBudget(Number.NaN)).toBe(0.01)
  })

  it('keeps two significant digits below a cent, rounded up', () => {
    expect(roundUpBudget(0.0083)).toBe(0.0083)
    expect(roundUpBudget(0.00831)).toBe(0.0084)
    expect(roundUpBudget(0.000154)).toBe(0.00016)
  })
})

describe('formatUsdPlain, money and plural', () => {
  it('prints cents with two digits and keeps the digits of smaller amounts', () => {
    expect(formatUsdPlain(3.2)).toBe('3.20')
    expect(formatUsdPlain(0.0083)).toBe('0.0083')
    expect(formatUsdPlain(1e-7)).toBe('0.0000001')
  })

  it('shows n/a, four decimals below a dollar, two above, and exact digits below 0.0001', () => {
    expect(money(undefined)).toBe('n/a')
    expect(money(0.00005)).toBe('$0.00005')
    expect(money(0)).toBe('$0.0000')
    expect(money(0.5)).toBe('$0.5000')
    expect(money(12.5)).toBe('$12.50')
  })

  it('pluralises by count', () => {
    expect(plural(1, 'call')).toBe('1 call')
    expect(plural(0, 'call')).toBe('0 calls')
    expect(plural(2, 'seed')).toBe('2 seeds')
  })
})

describe('worstCallUsd and guardReserveUsd', () => {
  it('is the dearest call over every model and case at the output cap, from the input estimate of the suite', () => {
    const suite = suiteOf([800, 2400, 2000])
    expect(worstCallUsd(suite, [HAIKU], 1000)).toBeCloseTo((2400 * 0.1 + 1000 * 0.5) / 1e6, 12)
    expect(worstCallUsd(suite, [HAIKU, SONNET], 1000)).toBeCloseTo((2400 * 2 + 1000 * 10) / 1e6, 12)
    expect(worstCallUsd(suite, [HAIKU, SONNET, OPUS], 4000)).toBeCloseTo((2400 * 4 + 4000 * 20) / 1e6, 12)
  })

  it('is undefined when any model has no price', () => {
    expect(worstCallUsd(suiteOf([800]), [HAIKU, 'claude-mystery-9'], 1000)).toBeUndefined()
  })

  it('holds back the worst case for as many calls as can be in flight, never more than the run has', () => {
    expect(guardReserveUsd(0.3, 4, 972)).toBeCloseTo(1.2, 12)
    expect(guardReserveUsd(0.3, 4, 3)).toBeCloseTo(0.9, 12)
    expect(guardReserveUsd(0.3, 4, 4)).toBeCloseTo(1.2, 12)
    expect(guardReserveUsd(undefined, 4, 972)).toBe(0)
  })
})
