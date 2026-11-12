import { describe, expect, it } from 'vitest'
import { contrastRatio } from './contrast'
import { readTokenBlocks, type TokenBlock } from './tokens-css'

const blocks = readTokenBlocks()
const light = blocks.get("[data-theme='light']")
const dark = blocks.get("[data-theme='dark']")
const themes: Array<[string, TokenBlock]> = [
  ['light', light ?? new Map()],
  ['dark', dark ?? new Map()],
]

const STATUSES = ['idle', 'running', 'succeeded', 'failed', 'abandoned', 'skipped', 'continued']

function names(block: TokenBlock, prefix: string): string[] {
  return [...block.keys()].filter((name) => name.startsWith(prefix))
}

describe('tokens.css', () => {
  it('defines a light and a dark theme block', () => {
    expect(light?.size).toBeGreaterThan(0)
    expect(dark?.size).toBeGreaterThan(0)
  })

  it('defines the same custom properties in both themes', () => {
    expect([...(dark?.keys() ?? [])].sort()).toEqual([...(light?.keys() ?? [])].sort())
  })

  it('keeps theme independent tokens out of the theme blocks', () => {
    const root = blocks.get(':root')
    expect(root).toBeDefined()
    for (const name of root?.keys() ?? []) {
      expect(light?.has(name), name).toBe(false)
      expect(dark?.has(name), name).toBe(false)
    }
    for (const name of ['--space-1', '--radius-md', '--font-ui', '--font-mono']) expect(root?.has(name), name).toBe(true)
  })

  it('has surface, text, border, accent and edge tokens', () => {
    for (const [, block] of themes) {
      for (const name of [
        '--surface-base',
        '--surface-raised',
        '--surface-sunken',
        '--surface-overlay',
        '--text-primary',
        '--text-secondary',
        '--text-muted',
        '--text-accent',
        '--border-subtle',
        '--border-default',
        '--border-strong',
        '--accent',
        '--accent-hover',
        '--accent-subtle',
        '--on-accent',
        '--focus-ring',
        '--edge-default',
        '--edge-active',
      ]) {
        expect(block.has(name), name).toBe(true)
      }
    }
  })

  it('has background, text and border colors for idle plus the six step statuses', () => {
    for (const [theme, block] of themes) {
      for (const status of STATUSES) {
        for (const part of ['bg', 'text', 'border']) expect(block.has(`--status-${status}-${part}`), `${theme} ${status} ${part}`).toBe(true)
      }
    }
  })

  it('uses plain hex colors for every color token so contrast can be computed', () => {
    for (const [theme, block] of themes) {
      for (const [name, value] of block) {
        if (name.startsWith('--shadow')) continue
        expect(value, `${theme} ${name}`).toMatch(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/)
      }
    }
  })
})

describe('contrast', () => {
  it('has a plausible contrast function', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })

  it('keeps every --text-* token at 4.5:1 on every --surface-* token in both themes', () => {
    for (const [theme, block] of themes) {
      const texts = names(block, '--text-')
      const surfaces = names(block, '--surface-')
      expect(texts.length).toBeGreaterThanOrEqual(3)
      expect(surfaces.length).toBeGreaterThanOrEqual(3)
      for (const text of texts) {
        for (const surface of surfaces) {
          const ratio = contrastRatio(block.get(text)!, block.get(surface)!)
          expect(ratio, `${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps every --*-text token at 4.5:1 on the --*-bg token with the same prefix', () => {
    for (const [theme, block] of themes) {
      const pairs = [...block.keys()].filter((name) => name.endsWith('-text') && block.has(name.replace(/-text$/, '-bg')))
      expect(pairs.length).toBeGreaterThanOrEqual(STATUSES.length)
      for (const text of pairs) {
        const bg = text.replace(/-text$/, '-bg')
        expect(contrastRatio(block.get(text)!, block.get(bg)!), `${theme} ${text} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the accent text on the accent background at 4.5:1', () => {
    for (const [theme, block] of themes) {
      expect(contrastRatio(block.get('--on-accent')!, block.get('--accent')!), theme).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the focus ring, accent and edges at 3:1 on every surface', () => {
    for (const [theme, block] of themes) {
      for (const token of ['--focus-ring', '--accent', '--edge-default', '--edge-active']) {
        for (const surface of names(block, '--surface-')) {
          expect(contrastRatio(block.get(token)!, block.get(surface)!), `${theme} ${token} on ${surface}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
})
