import { describe, expect, it, vi } from 'vitest'

vi.mock('pdfkit', () => {
  throw new Error('pdfkit must not load when the index is imported')
})
vi.mock('@napi-rs/canvas', () => {
  throw new Error('@napi-rs/canvas must not load when the index is imported')
})

const MODULES = [
  './budget',
  './check-provider',
  './cli-providers',
  './normalize',
  './pilot',
  './pricing',
  './provider-report',
  './providers',
  './record',
  './reestimate',
  './reestimate-text',
  './runner',
  './spec',
  './score',
  './stats',
  './sent',
  './results',
  './report',
  './suites/extract/baselines',
  './suites/extract/fields',
  './suites/extract/fixtures',
  './suites/extract/injection',
  './suites/extract/render-text',
  './suites/extract/seed',
  './suites/extract/suite',
] as const

describe('the package index', () => {
  it('imports without loading pdfkit or canvas', async () => {
    const index = await import('../src/index')
    expect(typeof index.createExtractSuite).toBe('function')
    expect(typeof index.generateFixtures).toBe('function')
  })

  it('re-exports every runtime export of every module, under the same or a prefixed name', async () => {
    const index = (await import('../src/index')) as Record<string, unknown>
    const exported = new Set(Object.values(index))
    for (const path of MODULES) {
      const module = (await import(/* @vite-ignore */ `../src/${path.slice(2)}`)) as Record<string, unknown>
      for (const [name, value] of Object.entries(module)) {
        expect(exported.has(value), `${path} exports ${name} but the index does not`).toBe(true)
      }
    }
  })

  it('exports no undefined value and renames the generic extract names with a prefix', async () => {
    const index = (await import('../src/index')) as Record<string, unknown>
    for (const [name, value] of Object.entries(index)) expect(value, name).not.toBeUndefined()
    for (const name of ['EXTRACT_BASELINES', 'EXTRACT_FIXTURES_DIR', 'EXTRACT_SEEDS_PATH', 'EXTRACT_SUITE_NAME', 'loadExtractSeeds', 'EXTRACT_DIFFICULTIES']) {
      expect(index, name).toHaveProperty(name)
    }
    for (const name of ['BASELINES', 'FIXTURES_DIR', 'SEEDS_PATH', 'SUITE_NAME', 'loadSeeds', 'DIFFICULTIES']) {
      expect(index, name).not.toHaveProperty(name)
    }
  })
})
