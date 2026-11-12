// @vitest-environment node
import type { RecipeParamInfo } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { initialValues, toRequestValues, valueErrorKey, visibleConnections, type HostConnection } from '../src/recipes/model/values'

const LABEL = { ko: '라벨', en: 'Label' }
const param = (overrides: Partial<RecipeParamInfo> & Pick<RecipeParamInfo, 'id' | 'kind'>): RecipeParamInfo => ({ label: LABEL, required: true, ...overrides })

const FOLDER = param({ id: 'folder', kind: 'folder' })
const GLOB = param({ id: 'glob', kind: 'glob', required: false, default: '*.pdf' })
const NUMBER = param({ id: 'threshold', kind: 'number', min: 0, max: 1000 })
const OPTIONAL_TEXT = param({ id: 'note', kind: 'text', required: false, default: 'hello' })

describe('initialValues', () => {
  it('fills the defaults as text and leaves the other params empty', () => {
    expect(initialValues([FOLDER, GLOB, param({ id: 'n', kind: 'number', required: false, default: 100000 })])).toEqual({ folder: '', glob: '*.pdf', n: '100000' })
  })

  it('holds every param id, also for no params', () => {
    expect(initialValues([])).toEqual({})
    expect(Object.keys(initialValues([FOLDER, NUMBER]))).toEqual(['folder', 'threshold'])
  })
})

describe('toRequestValues text rules', () => {
  it('sends text as text and omits an empty optional field so the default applies', () => {
    expect(toRequestValues([FOLDER, GLOB], { folder: '/Users/demo', glob: '' })).toEqual({ ok: true, values: { folder: '/Users/demo' } })
    expect(toRequestValues([FOLDER, GLOB], { folder: '/Users/demo', glob: '*.png' })).toEqual({ ok: true, values: { folder: '/Users/demo', glob: '*.png' } })
  })

  it('reports a required field that is empty or only spaces', () => {
    expect(toRequestValues([FOLDER], { folder: '' })).toEqual({ ok: false, errors: { folder: 'required' } })
    expect(toRequestValues([FOLDER], { folder: '   ' })).toEqual({ ok: false, errors: { folder: 'required' } })
    expect(toRequestValues([FOLDER], {})).toEqual({ ok: false, errors: { folder: 'required' } })
  })

  it('treats an optional field with spaces only as empty', () => {
    expect(toRequestValues([GLOB], { glob: '  ' })).toEqual({ ok: true, values: {} })
  })

  it('does not trim the text it sends, so the server can judge surrounding spaces', () => {
    expect(toRequestValues([FOLDER], { folder: ' /Users/demo ' })).toEqual({ ok: true, values: { folder: ' /Users/demo ' } })
  })

  it('allows 500 characters and rejects 501, counting a character outside the BMP once', () => {
    expect(toRequestValues([OPTIONAL_TEXT], { note: 'a'.repeat(500) }).ok).toBe(true)
    expect(toRequestValues([OPTIONAL_TEXT], { note: 'a'.repeat(501) })).toEqual({ ok: false, errors: { note: 'too_long' } })
    expect(toRequestValues([OPTIONAL_TEXT], { note: '😀'.repeat(500) }).ok).toBe(true)
    expect(toRequestValues([OPTIONAL_TEXT], { note: '😀'.repeat(501) })).toEqual({ ok: false, errors: { note: 'too_long' } })
  })

  it('rejects text with {{ or }} in every text kind and in an optional field', () => {
    for (const note of ['{{a.output}}', 'x }} y', '{{', '}}']) {
      expect(toRequestValues([OPTIONAL_TEXT], { note }), note).toEqual({ ok: false, errors: { note: 'template_text' } })
    }
    expect(toRequestValues([OPTIONAL_TEXT], { note: '{ single } braces' }).ok).toBe(true)
    expect(toRequestValues([param({ id: 'url', kind: 'url' })], { url: 'https://x.test/{{a}}' })).toEqual({ ok: false, errors: { url: 'template_text' } })
  })

  it('reports every bad field, not only the first', () => {
    expect(toRequestValues([FOLDER, NUMBER, OPTIONAL_TEXT], { folder: '', threshold: 'abc', note: '{{' })).toEqual({
      ok: false,
      errors: { folder: 'required', threshold: 'not_a_number', note: 'template_text' },
    })
  })

  it('ignores a form value that no param owns', () => {
    expect(toRequestValues([FOLDER], { folder: '/a', stray: 'x' })).toEqual({ ok: true, values: { folder: '/a' } })
  })
})

describe('toRequestValues numbers', () => {
  const send = (text: string) => toRequestValues([NUMBER], { threshold: text })

  it('sends a number as a number', () => {
    expect(send('250')).toEqual({ ok: true, values: { threshold: 250 } })
    expect(send(' 12.5 ')).toEqual({ ok: true, values: { threshold: 12.5 } })
    expect(send('1e3')).toEqual({ ok: true, values: { threshold: 1000 } })
    expect(send('.5')).toEqual({ ok: true, values: { threshold: 0.5 } })
    expect(typeof (send('250') as { values: Record<string, unknown> }).values.threshold).toBe('number')
  })

  it('reports an empty required number as required', () => {
    expect(send('')).toEqual({ ok: false, errors: { threshold: 'required' } })
  })

  it('rejects text, NaN, Infinity, hex and numbers too large to hold', () => {
    for (const text of ['abc', 'NaN', 'Infinity', '-Infinity', '0x10', '1,000', '12px', '1e999', '--1', '1.2.3']) {
      expect(send(text), text).toEqual({ ok: false, errors: { threshold: 'not_a_number' } })
    }
  })

  it('checks the range and accepts the exact bounds', () => {
    expect(send('-1')).toEqual({ ok: false, errors: { threshold: 'below_min' } })
    expect(send('1000.5')).toEqual({ ok: false, errors: { threshold: 'above_max' } })
    expect(send('0')).toEqual({ ok: true, values: { threshold: 0 } })
    expect(send('1000')).toEqual({ ok: true, values: { threshold: 1000 } })
  })

  it('sends -0 as 0', () => {
    const result = send('-0') as { ok: true; values: { threshold: number } }
    expect(Object.is(result.values.threshold, 0)).toBe(true)
  })

  it('has no range when the param declares none', () => {
    expect(toRequestValues([param({ id: 'n', kind: 'number' })], { n: '-99999999' }).ok).toBe(true)
  })

  it('omits an empty optional number so the default applies', () => {
    expect(toRequestValues([param({ id: 'n', kind: 'number', required: false, default: 5 })], { n: '' })).toEqual({ ok: true, values: {} })
  })
})

describe('toRequestValues value cap', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => param({ id: `p${index}`, kind: 'text' }))
  const filled = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, 'x']))

  it('allows 20 values', () => {
    const result = toRequestValues(many(20), filled(20))
    expect(result.ok).toBe(true)
    expect(Object.keys((result as { values: object }).values)).toHaveLength(20)
  })

  it('refuses the values past the 20th and names them', () => {
    const result = toRequestValues(many(23), filled(23))
    expect(result).toEqual({ ok: false, errors: { p20: 'too_many', p21: 'too_many', p22: 'too_many' } })
  })

  it('does not count omitted optional fields', () => {
    const params = [...many(20), param({ id: 'extra', kind: 'text', required: false, default: 'x' })]
    expect(toRequestValues(params, { ...filled(20), extra: '' }).ok).toBe(true)
  })
})

describe('valueErrorKey', () => {
  it('gives every client error an existing message key', () => {
    for (const error of ['required', 'too_long', 'not_a_number', 'below_min', 'above_max', 'template_text', 'too_many'] as const) {
      expect(valueErrorKey(error)).toMatch(/^recipes\./)
    }
  })
})

describe('visibleConnections', () => {
  const connections: HostConnection[] = [
    { name: 'slack-ops', kind: 'slack' },
    { name: 'slack-dev', kind: 'slack' },
    { name: 'api', kind: 'http' },
    { name: 'secret', kind: 'webhookSecret' },
  ]

  it('keeps the connections of the kind the param asks for', () => {
    expect(visibleConnections(param({ id: 'c', kind: 'connection', connectionKind: 'slack' }), connections).map((item) => item.name)).toEqual(['slack-ops', 'slack-dev'])
    expect(visibleConnections(param({ id: 'c', kind: 'connection', connectionKind: 'http' }), connections).map((item) => item.name)).toEqual(['api'])
  })

  it('keeps every connection when the param names no kind, and none for a param that is not a connection', () => {
    expect(visibleConnections(param({ id: 'c', kind: 'connection' }), connections)).toHaveLength(4)
    expect(visibleConnections(param({ id: 'c', kind: 'text', connectionKind: 'slack' }), connections)).toEqual([])
  })

  it('gives an empty list when none match', () => {
    expect(visibleConnections(param({ id: 'c', kind: 'connection', connectionKind: 'webhookSecret' }), [connections[0]!])).toEqual([])
  })
})
