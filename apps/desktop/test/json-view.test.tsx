import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hostileValue } from '../src/fixtures/hostile'
import { CappedText, JsonView } from '../src/inspector/JsonView'
import { ko } from '../src/i18n/ko'
import { renderThemed } from './render'

const more = (count: number) => ko['json.more'].replace('{count}', count.toLocaleString('en-US'))
const moreCharacters = (count: number) => ko['json.moreCharacters.other'].replace('{count}', count.toLocaleString('en-US'))
const entries = (container: HTMLElement) => container.querySelectorAll('[data-entry]')

describe('JsonView', () => {
  it('shows primitives as text', () => {
    for (const [value, text] of [
      ['hello', 'hello'],
      [42, '42'],
      [-0.5, '-0.5'],
      [true, 'true'],
      [false, 'false'],
      [null, 'null'],
    ] as const) {
      const { container, unmount } = renderThemed(<JsonView value={value} />)
      expect(container.textContent, String(value)).toBe(text)
      unmount()
    }
  })

  it('shows nested objects and arrays with their keys and indexes', () => {
    const { container } = renderThemed(<JsonView value={{ vendor: 'Cafe Mori', amount: 12800, tags: ['a', 'b'], meta: { ok: true } }} />)
    const text = container.textContent!
    for (const part of ['vendor', 'Cafe Mori', 'amount', '12800', 'tags', '0', 'a', '1', 'b', 'meta', 'ok', 'true']) expect(text).toContain(part)
    expect(entries(container).length).toBe(4 + 2 + 1)
  })

  it('renders empty containers as braces', () => {
    const { container } = renderThemed(<JsonView value={{ a: {}, b: [] }} />)
    expect(container.textContent).toContain('{}')
    expect(container.textContent).toContain('[]')
  })

  it('shows at most maxItems entries of a 10,000 element array and a visible marker for the rest', () => {
    const { container } = renderThemed(<JsonView value={Array.from({ length: 10_000 }, (_, index) => index)} maxItems={25} />)
    expect(entries(container)).toHaveLength(25)
    expect(screen.getByText(more(9975))).toBeTruthy()
  })

  it('cuts a string above maxString with a marker and reveals all of it on show more', () => {
    const long = `${'a'.repeat(30)}${'b'.repeat(70)}`
    const { container } = renderThemed(<JsonView value={long} maxString={30} />)
    expect(container.textContent).toContain('a'.repeat(30))
    expect(container.textContent).not.toContain('b')
    expect(screen.getByText(moreCharacters(70))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: ko['json.showMore'] }))
    expect(container.textContent).toContain(long)
    expect(screen.queryByText(moreCharacters(70))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: ko['json.showLess'] }))
    expect(container.textContent).not.toContain('b')
  })

  it('does not offer show more for a string that fits', () => {
    renderThemed(<JsonView value="short" maxString={30} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('stops at maxDepth with a collapsed marker and never prints the bottom of a 60 level value', () => {
    let deep: unknown = 'bottom-of-the-pit'
    for (let level = 0; level < 60; level += 1) deep = { inner: deep }
    const { container } = renderThemed(<JsonView value={deep} maxDepth={3} />)
    expect(container.textContent).not.toContain('bottom-of-the-pit')
    expect(container.textContent).toContain('{…}')
    expect(entries(container).length).toBeLessThanOrEqual(3)
  })

  it('does not hang on a value that contains itself', () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    const started = performance.now()
    const { container } = renderThemed(<JsonView value={loop} />)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(container.textContent).toContain('loop')
  })

  it('highlights template references with a span and leaves the rest as plain text', () => {
    const { container } = renderThemed(<JsonView value="Total {{extract.output.amount}} yen, not {{ nothing }}" />)
    const refs = container.querySelectorAll('span[data-template-ref]')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.textContent).toBe('{{extract.output.amount}}')
    expect(container.textContent).toContain('Total {{extract.output.amount}} yen, not {{ nothing }}')
  })

  it('shows hostile strings as text and creates no img, script, anchor or svg element from them', () => {
    const { container } = renderThemed(<JsonView value={hostileValue()} maxString={200} />)
    const text = container.textContent!
    expect(text).toContain('<img src=x onerror="window.__pwned = 1">')
    expect(text).toContain('<script>window.__pwned = 1</script>')
    expect(text).toContain('<a href="javascript:window.__pwned = 1">open</a>')
    expect(text).toContain('"><svg onload=alert(1)>')
    expect(container.querySelector('img, script, a, iframe, object, embed, [onerror], [onload], [href]')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
  })

  it('shows hostile keys as text', () => {
    const { container } = renderThemed(<JsonView value={{ '<img src=x onerror=alert(1)>': 1, __proto__x: 2 }} />)
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the hostile fixture and a one megabyte string quickly', () => {
    const started = performance.now()
    renderThemed(<JsonView value={hostileValue()} />).unmount()
    renderThemed(<JsonView value={'z'.repeat(1_000_000)} />).unmount()
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('caps the rows of a value that is wide at every level', () => {
    const level = (depth: number): unknown => (depth === 0 ? 'leaf' : Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, level(depth - 1)])))
    const value = level(4)
    const started = performance.now()
    const { container } = renderThemed(<JsonView value={value} maxDepth={6} maxRows={120} />)
    expect(entries(container).length).toBeLessThanOrEqual(120)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('renders values that are not JSON without throwing', () => {
    const { container } = renderThemed(<JsonView value={{ a: undefined, b: 10n, c: () => 1, d: Symbol('s'), e: Number.NaN }} />)
    for (const part of ['undefined', '10n', '[function]', 'Symbol(s)', 'NaN']) expect(container.textContent).toContain(part)
  })

  it('shows English markers when the language is English', () => {
    renderThemed(<JsonView value={Array.from({ length: 10 }, (_, index) => index)} maxItems={3} />, { locale: 'en' })
    expect(screen.getByText('7 more')).toBeTruthy()
  })
})

describe('JsonView with hidden characters', () => {
  it('writes a bidi override of a string value as a visible code point and keeps the raw character out of the page', () => {
    const { container } = renderThemed(<JsonView value={{ file: 'invoice ‮txt.exe' }} />)
    expect(container.textContent).toContain('invoice ‹U+202E›txt.exe')
    expect(container.textContent).not.toContain('‮')
    const mark = container.querySelector('[data-invisible]')!
    expect(mark.textContent).toBe('‹U+202E›')
    expect(mark.getAttribute('title')).toBe('U+202E')
  })

  it('does the same for zero width characters, a key and the hostile fixture', () => {
    const { container } = renderThemed(<JsonView value={{ 'pa​ss': 'a​b', again: hostileValue() }} maxString={200} />)
    expect(container.textContent).not.toMatch(/\p{Cf}/u)
    expect(container.textContent).toContain('pa‹U+200B›ss')
    expect(container.textContent).toContain('a‹U+200B›b')
    expect(container.textContent).toContain('invoice ‹U+202E›txt.exe')
  })

  it('isolates a string value so that its direction cannot reach the text around it', () => {
    const { container } = renderThemed(<JsonView value={{ name: 'שלום' }} />)
    const isolated = [...container.querySelectorAll('bdi')].map((item) => item.textContent)
    expect(isolated).toContain('שלום')
    expect(isolated).toContain('name')
  })

  it('still highlights a template reference next to a hidden character', () => {
    const { container } = renderThemed(<JsonView value={'​{{extract.output.amount}}​'} />)
    expect(container.querySelectorAll('span[data-template-ref]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-invisible]')).toHaveLength(2)
  })

  it('also covers the part of a long string that is revealed by show more', () => {
    const long = `${'a'.repeat(30)}${'‮'}${'b'.repeat(70)}`
    const { container } = renderThemed(<JsonView value={long} maxString={30} />)
    fireEvent.click(screen.getByRole('button', { name: ko['json.showMore'] }))
    expect(container.textContent).toContain('‹U+202E›')
    expect(container.textContent).not.toContain('‮')
  })
})

describe('JsonView defaults and markers', () => {
  const wide = (depth: number): unknown => (depth === 0 ? 'leaf' : Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, wide(depth - 1)])))

  it('opens four levels by default', () => {
    const { container } = renderThemed(<JsonView value={{ a1: { b1: { c1: { d1: { e1: 'deep' } } } } }} />)
    expect(container.textContent).toContain('d1')
    expect(container.textContent).toContain('{…}')
    expect(container.textContent).not.toContain('e1')
  })

  it('shows fifty entries by default and counts the rest', () => {
    const { container } = renderThemed(<JsonView value={Array.from({ length: 60 }, (_, index) => index)} />)
    expect(entries(container)).toHaveLength(50)
    expect(screen.getByText(more(10))).toBeTruthy()
  })

  it('cuts a string above 500 characters by default and keeps one of exactly 500', () => {
    const exact = renderThemed(<JsonView value={'s'.repeat(500)} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(exact.container.textContent).toBe('s'.repeat(500))
    exact.unmount()
    renderThemed(<JsonView value={'s'.repeat(501)} />)
    expect(screen.getByText(moreCharacters(1))).toBeTruthy()
    expect(screen.getByRole('button', { name: ko['json.showMore'] })).toBeTruthy()
  })

  it('stops after 300 rows by default', () => {
    const { container } = renderThemed(<JsonView value={wide(2)} />)
    expect(entries(container)).toHaveLength(299)
  })

  it('writes the count of what a collapsed container holds and nothing for an empty one', () => {
    const first = renderThemed(<JsonView value={{ a: { b: 1 } }} maxDepth={1} />)
    expect(first.container.textContent).toContain('{…}')
    expect(screen.getByText(more(1))).toBeTruthy()
    first.unmount()
    const second = renderThemed(<JsonView value={{ a: {} }} maxDepth={1} />)
    expect(second.container.textContent).toContain('{…}')
    expect(second.container.textContent).not.toContain(ko['json.more'].replace('{count}', '0'))
    expect(second.container.textContent).not.toContain('개 더 있음')
  })

  it('draws an empty container as a pair of braces without a block for its children', () => {
    const { container } = renderThemed(<JsonView value={{ a: {}, b: [] }} />)
    expect(container.querySelectorAll('[class*="children"]')).toHaveLength(1)
  })

  it('shows the count of hidden entries only when something is hidden', () => {
    const none = renderThemed(<JsonView value={{ a: [1, 2] }} />)
    expect(none.container.textContent).not.toContain('개 더 있음')
    none.unmount()
    renderThemed(<JsonView value={[1, 2, 3]} maxItems={2} />)
    expect(screen.getByText(more(1))).toBeTruthy()
  })

  it('puts a colon between a key and its value', () => {
    const { container } = renderThemed(<JsonView value={{ vendor: 'Cafe Mori' }} />)
    expect(container.textContent).toContain('vendor: Cafe Mori')
  })

  it('cuts a capped text at its own limit and does not mark references in it', () => {
    const first = renderThemed(<CappedText text={'e'.repeat(100)} maxString={10} />)
    expect(first.container.textContent).toContain('e'.repeat(10))
    expect(screen.getByText(moreCharacters(90))).toBeTruthy()
    first.unmount()
    const second = renderThemed(<CappedText text="failed {{extract.output.amount}}" />)
    expect(second.container.textContent).toContain('failed {{extract.output.amount}}')
    expect(second.container.querySelector('[data-template-ref]')).toBeNull()
  })

  it('cuts a capped text at 500 characters by default', () => {
    renderThemed(<CappedText text={'e'.repeat(501)} />)
    expect(screen.getByText(moreCharacters(1))).toBeTruthy()
  })

  it('writes a hidden character of a capped text as a visible code point', () => {
    const { container } = renderThemed(<CappedText text={'bad \u202ename \u200b!'} />)
    expect(container.textContent).toBe('bad ‹U+202E›name ‹U+200B›!')
    expect(container.querySelectorAll('[data-invisible]')).toHaveLength(2)
  })
})
