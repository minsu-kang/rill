import { describe, expect, it } from 'vitest'
import { extractRefs, findMalformedTemplates, resolveTemplates } from '../src/template'

describe('hyphenated path segments', () => {
  it('are extracted and resolved', () => {
    const outputs = { h: { headers: { 'content-type': 'application/json' } } }
    expect(extractRefs('{{h.output.headers.content-type}}')).toEqual([
      { nodeId: 'h', path: ['headers', 'content-type'] },
    ])
    expect(resolveTemplates('{{h.output.headers.content-type}}', outputs)).toBe('application/json')
  })
})

describe('findMalformedTemplates', () => {
  it('returns every span that is not a valid reference', () => {
    expect(findMalformedTemplates({ a: '{{h.outputs.v}}', b: ['ok {{h.output.v}}', '{{H.output.v}}'], c: 3 })).toEqual([
      '{{h.outputs.v}}',
      '{{H.output.v}}',
    ])
  })

  it('accepts valid references with spaces and ignores text without a double brace span', () => {
    expect(findMalformedTemplates('{{ h.output.a }} and plain')).toEqual([])
    expect(findMalformedTemplates('a single { brace } and a lone {{')).toEqual([])
    expect(findMalformedTemplates(null)).toEqual([])
  })
})
