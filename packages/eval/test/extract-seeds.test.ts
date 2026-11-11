import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Value from 'typebox/value'
import { SEEDS_PATH, loadSeeds, parseSeeds, seedSchema, type Seed } from '../src/suites/extract/seed'

const normalise = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

const length = (s: string): number => [...s].length

const seeds = loadSeeds()
const raw: unknown = JSON.parse(readFileSync(SEEDS_PATH, 'utf8'))

const withAliases = (aliases: string[]): unknown => {
  const first = structuredClone(seeds[0])
  if (!first) throw new Error('no seeds')
  return [{ ...first, vendorAliases: aliases }]
}

describe('extraction seeds', () => {
  it('loads and validates all 36 seeds', () => {
    expect(seeds).toHaveLength(36)
    expect(parseSeeds(raw)).toEqual(seeds)
  })

  it.each(seeds.map((s) => [s.id, s] as const))('%s validates against the schema', (_id, seed) => {
    expect(Value.Check(seedSchema, seed)).toBe(true)
  })

  it('has unique ids and a trailing newline in the data file', () => {
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length)
    expect(readFileSync(SEEDS_PATH, 'utf8').endsWith('\n')).toBe(true)
  })

  it.each([
    ['an unknown key', (seed: Seed) => Object.assign(seed, { extra: 1 })],
    ['an unknown template', (seed: Seed) => Object.assign(seed, { template: 'receipt' })],
    ['a missing vendorAliases field', (seed: Seed) => Reflect.deleteProperty(seed, 'vendorAliases')],
    ['a bad date', (seed: Seed) => Object.assign(seed.data, { date: '11/11/2026' })],
    ['an unknown label key', (seed: Seed) => Object.assign(seed.render.labels, { grandTotal: 'x' })],
  ])('rejects %s', (_name, corrupt) => {
    const copy = structuredClone(seeds)
    const first = copy[0]
    if (!first) throw new Error('no seeds')
    corrupt(first)
    expect(() => parseSeeds(copy)).toThrow(/invalid extraction seeds/)
  })
})

describe('vendorAliases', () => {
  it.each(seeds.map((s) => [s.id, s] as const))('%s has only acceptable aliases', (_id, seed) => {
    const full = seed.expected.vendor
    if (full === null) {
      expect(seed.vendorAliases).toEqual([])
      return
    }
    const fullNormalised = normalise(full)
    for (const alias of seed.vendorAliases) {
      expect(length(alias), `${alias} is shorter than 4 characters`).toBeGreaterThanOrEqual(4)
      expect(length(normalise(alias)), `${alias} is shorter than 4 characters once normalised`).toBeGreaterThanOrEqual(4)
      expect(alias, `${alias} equals the full name`).not.toBe(full)
      expect(fullNormalised, `${alias} is not part of ${full}`).toContain(normalise(alias))
      expect(length(normalise(alias)), `${alias} is not shorter than ${full}`).toBeLessThan(length(fullNormalised))
    }
    expect(new Set(seed.vendorAliases).size).toBe(seed.vendorAliases.length)
  })

  it('never lists the same alias for two seeds', () => {
    const all = seeds.flatMap((s) => s.vendorAliases.map(normalise))
    expect(new Set(all).size).toBe(all.length)
  })

  it('drops the Korean branch word (a trailing word ending in 점)', () => {
    const branchNames = seeds.filter((s) => s.expected.vendor !== null && /^.*\S\s+\S+점$/.test(s.expected.vendor))
    expect(branchNames.length).toBeGreaterThanOrEqual(8)
    for (const seed of branchNames) {
      const full = seed.expected.vendor ?? ''
      expect(seed.vendorAliases, seed.id).toContain(full.replace(/\s+\S+점$/, ''))
    }
  })

  it('rejects aliases that are too short or empty', () => {
    expect(() => parseSeeds(withAliases(['abc']))).toThrow(/invalid extraction seeds/)
    expect(() => parseSeeds(withAliases(['']))).toThrow(/invalid extraction seeds/)
    expect(parseSeeds(withAliases(['abcd']))).toHaveLength(1)
  })
})
