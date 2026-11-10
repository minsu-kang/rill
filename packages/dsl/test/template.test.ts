import { describe, expect, it } from 'vitest'
import { TemplateError, extractRefs, resolveTemplates } from '../src/template'

const outputs = {
  t1: { file: '/tmp/a.pdf' },
  n1: { amount: 12.5, tags: ['x', 'y'], nested: { deep: true } },
}

describe('extractRefs', () => {
  it('finds references anywhere inside a config value', () => {
    const config = {
      a: '{{n1.output.amount}}',
      b: ['plain', 'sum {{ n1.output.amount }} and {{t1.output.file}}'],
      c: { d: '{{n1.output}}' },
      e: 3,
    }
    expect(extractRefs(config)).toEqual([
      { nodeId: 'n1', path: ['amount'] },
      { nodeId: 'n1', path: ['amount'] },
      { nodeId: 't1', path: ['file'] },
      { nodeId: 'n1', path: [] },
    ])
  })

  it('returns nothing for values without references', () => {
    expect(extractRefs({ a: 'no refs', b: [1, true, null] })).toEqual([])
  })
})

describe('resolveTemplates', () => {
  it('keeps the original type when the whole string is one reference', () => {
    expect(resolveTemplates('{{n1.output.amount}}', outputs)).toBe(12.5)
    expect(resolveTemplates('{{n1.output.nested}}', outputs)).toEqual({ deep: true })
    expect(resolveTemplates('{{ n1.output.tags.1 }}', outputs)).toBe('y')
  })

  it('interpolates references into longer strings', () => {
    expect(resolveTemplates('Total {{n1.output.amount}} USD from {{t1.output.file}}', outputs)).toBe(
      'Total 12.5 USD from /tmp/a.pdf',
    )
    expect(resolveTemplates('nested={{n1.output.nested}}', outputs)).toBe('nested={"deep":true}')
  })

  it('resolves inside nested objects and arrays', () => {
    expect(resolveTemplates({ row: ['{{n1.output.amount}}', 'x'], meta: { f: '{{t1.output.file}}' } }, outputs)).toEqual({
      row: [12.5, 'x'],
      meta: { f: '/tmp/a.pdf' },
    })
  })

  it('passes non-string values through', () => {
    expect(resolveTemplates(5, outputs)).toBe(5)
    expect(resolveTemplates(null, outputs)).toBeNull()
    expect(resolveTemplates(true, outputs)).toBe(true)
  })

  it('throws TemplateError for unknown nodes and missing fields', () => {
    expect(() => resolveTemplates('{{ghost.output.x}}', outputs)).toThrow(TemplateError)
    expect(() => resolveTemplates('{{n1.output.missing}}', outputs)).toThrow('unresolved reference: n1.output.missing')
    expect(() => resolveTemplates('{{n1.output.amount.deeper}}', outputs)).toThrow(TemplateError)
  })
})
