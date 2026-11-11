import { describe, expect, it } from 'vitest'
import { clusterBootstrapDelta, mean, mulberry32, percentile, shuffle, wilson } from '../src/stats'

describe('wilson', () => {
  it.each([
    [8, 10, 0.8, 0.4902, 0.9433],
    [50, 100, 0.5, 0.4038, 0.5962],
    [1, 2, 0.5, 0.0945, 0.9055],
    [0, 10, 0, 0, 0.2775],
    [10, 10, 1, 0.7225, 1],
  ])('%d of %d', (k, n, p, lo, hi) => {
    const interval = wilson(k, n)
    expect(interval?.p).toBeCloseTo(p, 10)
    expect(interval?.lo).toBeCloseTo(lo, 4)
    expect(interval?.hi).toBeCloseTo(hi, 4)
  })

  it('stays inside 0..1 at the edges', () => {
    expect(wilson(0, 5)?.lo).toBe(0)
    expect(wilson(5, 5)?.hi).toBe(1)
  })

  it('accepts another z and returns null when there are no trials', () => {
    const narrow = wilson(50, 100, 1)
    expect(narrow?.lo).toBeCloseTo(0.4503, 3)
    expect(narrow?.hi).toBeCloseTo(0.5497, 3)
    expect(wilson(0, 0)).toBeNull()
  })

  it('rejects impossible counts', () => {
    expect(() => wilson(3, 2)).toThrow(RangeError)
    expect(() => wilson(-1, 2)).toThrow(RangeError)
    expect(() => wilson(0.5, 2)).toThrow(RangeError)
  })
})

describe('mulberry32', () => {
  it('matches the reference sequence', () => {
    const random = mulberry32(1)
    expect(random()).toBeCloseTo(0.6270739405881613, 15)
    expect(random()).toBeCloseTo(0.002735721180215478, 15)
    expect(random()).toBeCloseTo(0.5274470399599522, 15)
    const other = mulberry32(42)
    expect(other()).toBeCloseTo(0.6011037519201636, 15)
  })

  it('is deterministic per seed and stays in [0, 1)', () => {
    const first = mulberry32(7)
    const second = mulberry32(7)
    const draws = Array.from({ length: 1000 }, () => first())
    expect(draws).toEqual(Array.from({ length: 1000 }, () => second()))
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true)
    expect(mean(draws)).toBeGreaterThan(0.45)
    expect(mean(draws)).toBeLessThan(0.55)
    expect(mulberry32(8)()).not.toBe(mulberry32(7)())
  })
})

describe('shuffle', () => {
  it('follows Fisher-Yates for a fixed generator', () => {
    expect(shuffle([1, 2, 3, 4], () => 0)).toEqual([2, 3, 4, 1])
    expect(shuffle([1, 2, 3, 4], () => 0.999)).toEqual([1, 2, 3, 4])
  })

  it('returns a permutation, leaves the input alone and repeats for the same seed', () => {
    const input = Array.from({ length: 50 }, (_, index) => index)
    const copy = [...input]
    const shuffled = shuffle(input, mulberry32(3))
    expect(input).toEqual(copy)
    expect([...shuffled].sort((left, right) => left - right)).toEqual(input)
    expect(shuffled).toEqual(shuffle(input, mulberry32(3)))
    expect(shuffled).not.toEqual(shuffle(input, mulberry32(4)))
    expect(shuffled).not.toEqual(input)
  })

  it('handles empty and single-item arrays', () => {
    expect(shuffle([], () => 0.5)).toEqual([])
    expect(shuffle(['a'], () => 0.5)).toEqual(['a'])
  })
})

describe('mean and percentile', () => {
  it('computes the mean and returns null for no values', () => {
    expect(mean([1, 2, 6])).toBe(3)
    expect(mean([])).toBeNull()
  })

  it('interpolates linearly between ranks', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1)
    expect(percentile([1, 2, 3, 4], 100)).toBe(4)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentile([1, 2, 3, 4], 25)).toBe(1.75)
    expect(percentile([4, 1, 3, 2], 75)).toBe(3.25)
    expect(percentile([10, 20, 30], 50)).toBe(20)
    expect(percentile([5], 97.5)).toBe(5)
  })

  it('returns null for no values and clamps p to 0..100', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([1, 2, 3], -5)).toBe(1)
    expect(percentile([1, 2, 3], 120)).toBe(3)
  })
})

interface Row {
  group: string
  caseId: string
  rep: number
  value: number
}

const row = (group: string, caseId: string, rep: number, value: number): Row => ({ group, caseId, rep, value })
const average = (rows: readonly Row[]): number | null => mean(rows.map((entry) => entry.value))

describe('clusterBootstrapDelta', () => {
  it('reports B minus A, and a degenerate interval when every pair differs by the same amount', () => {
    const rowsA = [row('g1', 'a', 0, 0.5), row('g1', 'a', 1, 0.75), row('g2', 'b', 0, 0.25), row('g3', 'c', 0, 1)]
    const rowsB = rowsA.map((entry) => ({ ...entry, value: entry.value - 0.25 }))
    const result = clusterBootstrapDelta(rowsA, rowsB, average, { resamples: 200, seed: 1 })
    expect(result.delta).toBeCloseTo(-0.25, 12)
    expect(result.lo).toBeCloseTo(-0.25, 12)
    expect(result.hi).toBeCloseTo(-0.25, 12)
    expect(result).toMatchObject({ groups: 3, pairs: 4, resamples: 200 })
  })

  it('brackets the point estimate with the exact two-cluster bootstrap distribution', () => {
    const rowsA = [row('g1', 'a', 0, 0), row('g2', 'b', 0, 0)]
    const rowsB = [row('g1', 'a', 0, 0), row('g2', 'b', 0, 1)]
    const result = clusterBootstrapDelta(rowsA, rowsB, average, { resamples: 10_000, seed: 5 })
    expect(result.delta).toBe(0.5)
    expect(result.lo).toBe(0)
    expect(result.hi).toBe(1)
  })

  it('is deterministic for a seed and changes with another seed', () => {
    const rowsA = Array.from({ length: 12 }, (_, index) => row(`g${index}`, `c${index}`, 0, index % 3))
    const rowsB = Array.from({ length: 12 }, (_, index) => row(`g${index}`, `c${index}`, 0, (index * 7) % 5))
    const first = clusterBootstrapDelta(rowsA, rowsB, average, { resamples: 500, seed: 9 })
    expect(clusterBootstrapDelta(rowsA, rowsB, average, { resamples: 500, seed: 9 })).toEqual(first)
    expect(clusterBootstrapDelta(rowsA, rowsB, average, { resamples: 500, seed: 10 })).not.toEqual(first)
    expect(clusterBootstrapDelta([...rowsA].reverse(), [...rowsB].reverse(), average, { resamples: 500, seed: 9 })).toEqual(first)
  })

  it('defaults to ten thousand resamples', () => {
    const rowsA = [row('g1', 'a', 0, 1), row('g2', 'b', 0, 0)]
    expect(clusterBootstrapDelta(rowsA, rowsA, average, { seed: 1 }).resamples).toBe(10_000)
  })

  it('drops groups that appear on one side only, and rows without a partner', () => {
    const rowsA = [row('g1', 'a', 0, 1), row('g2', 'b', 0, 0), row('g2', 'b', 1, 0), row('g4', 'z', 0, 9)]
    const rowsB = [row('g1', 'a', 0, 0), row('g2', 'b', 0, 0), row('g2', 'b2', 0, 5), row('g3', 'c', 0, 9)]
    const result = clusterBootstrapDelta(rowsA, rowsB, average, { resamples: 50, seed: 2 })
    expect(result.groups).toBe(2)
    expect(result.pairs).toBe(2)
    expect(result.delta).toBe(-0.5)
  })

  it('returns nulls when nothing pairs up', () => {
    expect(clusterBootstrapDelta([], [], average, { seed: 1 })).toEqual({ delta: null, lo: null, hi: null, groups: 0, pairs: 0, resamples: 0 })
    expect(clusterBootstrapDelta([row('g1', 'a', 0, 1)], [row('g2', 'a', 0, 1)], average, { seed: 1 }).delta).toBeNull()
  })

  it('skips resamples where the metric is undefined', () => {
    const rowsA = [row('g1', 'a', 0, 1), row('g2', 'b', 0, 0)]
    const rowsB = [row('g1', 'a', 0, 1), row('g2', 'b', 0, 1)]
    const onlyIfG1 = (rows: readonly Row[]): number | null => {
      const ones = rows.filter((entry) => entry.group === 'g1')
      return ones.length === 0 ? null : mean(ones.map((entry) => entry.value))
    }
    const result = clusterBootstrapDelta(rowsA, rowsB, onlyIfG1, { resamples: 400, seed: 3 })
    expect(result.resamples).toBeLessThan(400)
    expect(result.resamples).toBeGreaterThan(200)
    expect(result.delta).toBe(0)
  })

  it('rejects duplicate keys instead of silently overwriting one', () => {
    const rows = [row('g1', 'a', 0, 1), row('g1', 'a', 0, 2)]
    expect(() => clusterBootstrapDelta(rows, rows, average, { seed: 1 })).toThrow(/duplicate/)
  })
})
