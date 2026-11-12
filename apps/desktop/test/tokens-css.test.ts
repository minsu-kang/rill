// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseTokenBlocks, readTokenBlocks } from './tokens-css'

describe('parseTokenBlocks', () => {
  it('reads the custom properties of each selector and trims names and values', () => {
    const blocks = parseTokenBlocks(`
      :root { --a:  1px ; --b: 'x: y' }
      [data-theme='light'] {
        --c: #fff;
      }
    `)
    expect([...blocks.keys()]).toEqual([':root', "[data-theme='light']"])
    expect([...blocks.get(':root')!]).toEqual([
      ['--a', '1px'],
      ['--b', "'x: y'"],
    ])
    expect([...blocks.get("[data-theme='light']")!]).toEqual([['--c', '#fff']])
  })

  it('leaves out declarations that are not custom properties and text without a colon', () => {
    const blocks = parseTokenBlocks(':root { color: red; --a: 1; nonsense; margin : 0 }')
    expect([...blocks.get(':root')!]).toEqual([['--a', '1']])
  })

  it('ignores comments, also ones that contain braces', () => {
    const blocks = parseTokenBlocks('/* .x { --no: 1 } */ :root { /* --also-no: 2; */ --a: 1 } /* tail */')
    expect([...blocks.keys()]).toEqual([':root'])
    expect([...blocks.get(':root')!]).toEqual([['--a', '1']])
  })

  it('skips a custom property that has no colon', () => {
    expect([...parseTokenBlocks(':root { --nocolon; --a: 1 }').get(':root')!]).toEqual([['--a', '1']])
  })

  it('merges two blocks of the same selector and normalizes the whitespace of a selector', () => {
    const blocks = parseTokenBlocks(':root { --a: 1 }\n  :root   { --b: 2 }\n .x   .y { --c: 3 }')
    expect([...blocks.get(':root')!]).toEqual([
      ['--a', '1'],
      ['--b', '2'],
    ])
    expect(blocks.has('.x .y')).toBe(true)
  })
})

describe('readTokenBlocks', () => {
  it('reads the real token file with a root block and both themes', () => {
    const blocks = readTokenBlocks()
    expect([...blocks.keys()]).toEqual([':root', "[data-theme='light']", "[data-theme='dark']"])
    expect(blocks.get(':root')!.get('--space-1')).toBe('4px')
    expect(blocks.get("[data-theme='light']")!.get('--surface-raised')).toBe('#ffffff')
  })
})
