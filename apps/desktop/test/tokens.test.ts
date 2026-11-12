import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { contrastRatio } from './contrast'
import { colorRules, moduleColorRules } from './css-colors'
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

describe('colors used by the component styles', () => {
  const rules = moduleColorRules(join(import.meta.dirname, '../src'))

  it('reads the color and background tokens of a rule and nothing else', () => {
    const found = colorRules(`
      /* color: var(--commented-out); */
      .a { color: var(--text-primary); background: var(--surface-raised); border-color: var(--border-default); }
      .b, .c:hover { background-color: var(--accent-subtle); outline-color: var(--focus-ring) }
      .d { color: #fff; background: linear-gradient(red, blue); }
      @media (prefers-reduced-motion: reduce) { .e { color: var(--text-muted) } }
      .f
        .g {
          color: var(--text-primary)
        }
    `)
    expect(found).toEqual([
      { selector: '.a', text: ['--text-primary'], background: ['--surface-raised'] },
      { selector: '.b, .c:hover', text: [], background: ['--accent-subtle'] },
      { selector: '.e', text: ['--text-muted'], background: [] },
      { selector: '.f .g', text: ['--text-primary'], background: [] },
    ])
  })

  it('finds the rules of the component modules, including the ones this check exists for', () => {
    expect(rules.length).toBeGreaterThan(30)
    const has = (file: string, text: string, background?: string) =>
      rules.some((rule) => rule.file === file && rule.text.includes(text) && (background === undefined || rule.background.includes(background)))
    expect(has('JsonView.module.css', '--text-accent', '--accent-subtle')).toBe(true)
    expect(has('RunHistory.module.css', '--status-failed-text')).toBe(true)
    expect(has('JsonView.module.css', '--status-running-text')).toBe(true)
    expect(has('NodeCard.module.css', '--badge-external-text', '--badge-external-bg')).toBe(true)
  })

  it('keeps the text of a rule with its own background at 4.5:1 on that background', () => {
    for (const [theme, block] of themes) {
      for (const rule of rules) {
        for (const text of rule.text) {
          for (const background of rule.background) {
            expect(contrastRatio(block.get(text)!, block.get(background)!), `${theme} ${rule.file} ${rule.selector}: ${text} on ${background}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })

  it('keeps the text of a rule without a background at 4.5:1 on every surface and on the selected row', () => {
    for (const [theme, block] of themes) {
      const grounds = [...names(block, '--surface-'), '--accent-subtle']
      for (const rule of rules.filter((item) => item.background.length === 0)) {
        for (const text of rule.text) {
          for (const ground of grounds) {
            expect(contrastRatio(block.get(text)!, block.get(ground)!), `${theme} ${rule.file} ${rule.selector}: ${text} on ${ground}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })

  it('keeps every --text-* token at 4.5:1 on the selected row color too', () => {
    for (const [theme, block] of themes) {
      for (const text of names(block, '--text-')) {
        expect(contrastRatio(block.get(text)!, block.get('--accent-subtle')!), `${theme} ${text} on --accent-subtle`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('only uses tokens that both themes define', () => {
    for (const [theme, block] of themes) {
      for (const rule of rules) {
        for (const token of [...rule.text, ...rule.background]) expect(block.has(token), `${theme} ${rule.file} ${token}`).toBe(true)
      }
    }
  })
})
