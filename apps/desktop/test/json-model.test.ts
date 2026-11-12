// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hostileValue } from '../src/fixtures/hostile'
import { summarize, TEMPLATE_REF, type JsonNode } from '../src/inspector/json-model'

const LIMITS = { maxDepth: 4, maxItems: 50, maxString: 500, maxRows: 300 }

function count(node: JsonNode): number {
  return node.kind === 'container' ? 1 + node.entries.reduce((sum, entry) => sum + count(entry.value), 0) : 1
}

describe('summarize', () => {
  it('describes primitives', () => {
    expect(summarize(null, LIMITS)).toEqual({ kind: 'scalar', text: 'null', tone: 'null' })
    expect(summarize(true, LIMITS)).toEqual({ kind: 'scalar', text: 'true', tone: 'boolean' })
    expect(summarize(12.5, LIMITS)).toEqual({ kind: 'scalar', text: '12.5', tone: 'number' })
    expect(summarize(undefined, LIMITS)).toMatchObject({ kind: 'scalar', text: 'undefined' })
    expect(summarize(10n, LIMITS)).toMatchObject({ kind: 'scalar', text: '10n' })
    expect(summarize(Symbol('s'), LIMITS)).toMatchObject({ kind: 'scalar', text: 'Symbol(s)' })
    expect(summarize(() => 1, LIMITS)).toMatchObject({ kind: 'scalar', text: '[function]' })
    expect(summarize(Number.NaN, LIMITS)).toMatchObject({ kind: 'scalar', text: 'NaN' })
  })

  it('keeps a short string whole and cuts a long one with the hidden count', () => {
    expect(summarize('abc', LIMITS)).toEqual({ kind: 'string', shown: 'abc', hidden: 0, full: 'abc' })
    const long = summarize('x'.repeat(1000), LIMITS)
    expect(long).toMatchObject({ kind: 'string', hidden: 500 })
    if (long.kind === 'string') {
      expect(long.shown).toHaveLength(500)
      expect(long.full).toHaveLength(1000)
    }
  })

  it('lists arrays by index and objects by own key', () => {
    const node = summarize({ a: [1, 2], b: 'x' }, LIMITS)
    expect(node).toMatchObject({ kind: 'container', array: false, size: 2, collapsed: false, hidden: 0 })
    if (node.kind !== 'container') throw new Error('not a container')
    expect(node.entries.map((entry) => entry.key)).toEqual(['a', 'b'])
    const inner = node.entries[0]!.value
    expect(inner).toMatchObject({ kind: 'container', array: true, size: 2 })
  })

  it('shows at most maxItems entries of a long array and counts the rest', () => {
    const node = summarize(Array.from({ length: 10_000 }, (_, index) => index), { ...LIMITS, maxItems: 20 })
    expect(node).toMatchObject({ kind: 'container', size: 10_000, hidden: 9980 })
    if (node.kind === 'container') expect(node.entries).toHaveLength(20)
  })

  it('shows at most maxItems keys of a wide object and counts the rest', () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`k${index}`, index]))
    const node = summarize(wide, { ...LIMITS, maxItems: 10 })
    expect(node).toMatchObject({ kind: 'container', size: 5000, hidden: 4990 })
  })

  it('collapses a container below maxDepth and keeps its size', () => {
    const node = summarize({ a: { b: { c: { d: 1 } } } }, { ...LIMITS, maxDepth: 2 })
    if (node.kind !== 'container') throw new Error('not a container')
    const a = node.entries[0]!.value
    if (a.kind !== 'container') throw new Error('not a container')
    const b = a.entries[0]!.value
    expect(b).toMatchObject({ kind: 'container', collapsed: true, size: 1, entries: [] })
  })

  it('never goes deeper than maxDepth for a 60 level value and for a value that contains itself', () => {
    let deep: unknown = 'bottom'
    for (let level = 0; level < 60; level += 1) deep = { inner: deep }
    expect(count(summarize(deep, LIMITS))).toBeLessThanOrEqual(LIMITS.maxDepth + 2)
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    expect(count(summarize(loop, LIMITS))).toBeLessThan(40)
    const list: unknown[] = []
    list.push(list, list)
    expect(count(summarize(list, LIMITS))).toBeLessThan(100)
  })

  it('stops after maxRows entries in total even when every level is wide', () => {
    const level = (depth: number): unknown => (depth === 0 ? 'leaf' : Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, level(depth - 1)])))
    const started = performance.now()
    const node = summarize(level(4), { ...LIMITS, maxDepth: 6 })
    expect(count(node)).toBeLessThanOrEqual(LIMITS.maxRows + 1)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('clamps an absurd maxDepth so a very deep value cannot overflow the stack', () => {
    let deep: unknown = 1
    for (let level = 0; level < 20_000; level += 1) deep = [deep]
    expect(() => summarize(deep, { ...LIMITS, maxDepth: 1_000_000 })).not.toThrow()
  })

  it('treats the keys __proto__, constructor and toString as ordinary own keys', () => {
    const node = summarize(JSON.parse('{"__proto__": 1, "constructor": 2, "toString": 3}'), LIMITS)
    if (node.kind !== 'container') throw new Error('not a container')
    expect(node.entries.map((entry) => entry.key)).toEqual(['__proto__', 'constructor', 'toString'])
    expect(node.entries.map((entry) => (entry.value.kind === 'scalar' ? entry.value.text : ''))).toEqual(['1', '2', '3'])
  })

  it('summarizes the hostile fixture within a second', () => {
    const started = performance.now()
    const node = summarize(hostileValue(), LIMITS)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(count(node)).toBeLessThanOrEqual(LIMITS.maxRows + 1)
  })

  it('does not copy a one megabyte string', () => {
    const big = 'y'.repeat(1_000_000)
    const node = summarize(big, LIMITS)
    expect(node).toMatchObject({ kind: 'string', hidden: 999_500 })
    if (node.kind === 'string') expect(node.full).toBe(big)
  })
})

describe('TEMPLATE_REF', () => {
  it('matches a reference to an upstream output field and nothing else', () => {
    const find = (text: string) => [...text.matchAll(TEMPLATE_REF)].map((match) => match[0])
    expect(find('a {{extract.output.amount}} b {{ watch.output.file }}')).toEqual(['{{extract.output.amount}}', '{{ watch.output.file }}'])
    expect(find('{{extract.output}}')).toEqual(['{{extract.output}}'])
    expect(find('{{ not a ref }} {{Bad.output.x}} {{a.input.x}} {{a.output.}}')).toEqual([])
  })

  it('stays linear on a hostile string of repeated openers', () => {
    const started = performance.now()
    const text = '{{ '.repeat(100_000)
    expect([...text.matchAll(TEMPLATE_REF)]).toEqual([])
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
