import { describe, expect, it } from 'vitest'
import {
  GENERAL_RULES,
  MAX_PARAM_STRING_CHARS,
  MAX_PARAM_VALUES,
  PARAM_KINDS,
  PARAM_RULES,
  checkParams,
  checkValue,
  type ParamKind,
  type ParamRule,
  type Recipe,
  type RecipeParam,
} from '../src/index'

const label = { ko: '라벨', en: 'Label' }

function param(kind: ParamKind, extra: Partial<RecipeParam> = {}): RecipeParam {
  return { id: 'value', kind, label, required: true, ...(kind === 'number' ? { min: 0, max: 100 } : {}), ...extra }
}

const MARKER = 'MARKER-7c41d9'

const ACCEPTS: Record<ParamKind, unknown[]> = {
  folder: ['/Users/demo/Receipts', '~/Receipts', '/', '/Users/demo/a..b', '/Users/demo/영수증', '/' + 'a'.repeat(499)],
  file: ['/Users/demo/Receipts/ledger.csv', '~/ledger.csv', '/Users/demo/.hidden/file'],
  glob: ['*.pdf', '*', 'receipt-??.png', '영수증*.pdf'],
  text: ['hello', '월말 정산 확인', 'a'.repeat(500), '😀'.repeat(500), 'a { b } c', 'a {b}', '{"a":1}', '$param', 'family 👨‍👩‍👧'],
  number: [0, 1, 100, 99.5, 0.0001],
  cron: ['0 9 * * 1-5', '*/15 * * * *', '0 9 1 * *', '0 0 * * 0', '5 4 * * sun'],
  url: ['https://example.test/health', 'http://example.test', 'https://example.test:8443/a/b?x=1#y', 'http://127.0.0.1:3000/ping'],
  connection: ['slack-ops', 'Team Alerts', '팀 알림', 'a'.repeat(500)],
}

const REJECTS: Record<ParamKind, Array<[ParamRule, unknown]>> = {
  folder: [
    ['wrong_type', 5],
    ['wrong_type', null],
    ['wrong_type', ['/Users/demo']],
    ['wrong_type', { path: '/Users/demo' }],
    ['empty', ''],
    ['empty', '   '],
    ['too_long', '/' + 'a'.repeat(500)],
    ['too_long', '😀'.repeat(501)],
    ['control_character', '/Users/demo/\nx'],
    ['control_character', '/Users/demo/x\u0000'],
    ['control_character', '/Users/demo/\tx'],
    ['control_character', '/Users/demo/\u007fx'],
    ['control_character', '/Users/demo/\u0085x'],
    ['line_separator', '/Users/demo/ x'],
    ['line_separator', '/Users/demo/ x'],
    ['bidi_format', '/Users/demo/‮x'],
    ['bidi_format', '/Users/demo/‏x'],
    ['bidi_format', '/Users/demo/⁦x'],
    ['bidi_format', '/Users/demo/؜x'],
    ['format_character', '/Users/demo/​x'],
    ['format_character', '/Users/demo/­x'],
    ['format_character', '/Users/demo/⁠x'],
    ['format_character', '/Users/demo/﻿x'],
    ['format_character', '/Users/demo/‍x'],
    ['format_character', '/Users/demo/‌x'],
    ['format_character', '/Users/demo/\u{e0041}x'],
    ['format_character', '/Users/demo/\u{e0100}x'],
    ['template_text', '/Users/demo/{{t1.output.file}}'],
    ['template_text', '/Users/demo/}}'],
    ['template_text', '{{x}}'],
    ['not_absolute_path', 'Receipts'],
    ['not_absolute_path', './Receipts'],
    ['not_absolute_path', '../Receipts'],
    ['not_absolute_path', '~'],
    ['not_absolute_path', '~/'],
    ['not_absolute_path', '~user/Receipts'],
    ['not_absolute_path', ' /Users/demo'],
    ['not_absolute_path', 'file:///Users/demo'],
    ['parent_segment', '/Users/demo/../other'],
    ['parent_segment', '/Users/demo/..'],
    ['parent_segment', '~/../other'],
    ['parent_segment', '/Users/demo\\..\\other'],
    ['parent_segment', '/..'],
  ],
  file: [
    ['wrong_type', 5],
    ['empty', ''],
    ['too_long', '/' + 'a'.repeat(500)],
    ['control_character', '/Users/demo/a\r\nb.csv'],
    ['line_separator', '/Users/demo/a b.csv'],
    ['bidi_format', '/Users/demo/a‮b.csv'],
    ['format_character', '/Users/demo/a​b.csv'],
    ['template_text', '/Users/demo/{{n1.output.x}}.csv'],
    ['not_absolute_path', 'ledger.csv'],
    ['not_absolute_path', '~ledger.csv'],
    ['parent_segment', '/Users/demo/../ledger.csv'],
    ['parent_segment', '~/../ledger.csv'],
  ],
  glob: [
    ['wrong_type', 5],
    ['empty', ''],
    ['too_long', '*'.repeat(501)],
    ['control_character', '*.pdf\n'],
    ['line_separator', '* .pdf'],
    ['bidi_format', '*‮.pdf'],
    ['format_character', '*​.pdf'],
    ['template_text', '{{t1.output.name}}'],
    ['bad_glob', 'sub/*.pdf'],
    ['bad_glob', '/*.pdf'],
    ['bad_glob', '..\\*.pdf'],
    ['bad_glob', '*/'],
  ],
  text: [
    ['wrong_type', 5],
    ['wrong_type', true],
    ['empty', ''],
    ['empty', ' \t '],
    ['too_long', 'a'.repeat(501)],
    ['too_long', '😀'.repeat(501)],
    ['control_character', 'line one\nline two'],
    ['control_character', 'a\u0000b'],
    ['control_character', 'a\u001bb'],
    ['line_separator', 'a b'],
    ['line_separator', 'a b'],
    ['bidi_format', 'a‮b'],
    ['bidi_format', 'a⁧b'],
    ['format_character', 'a​b'],
    ['format_character', 'a­b'],
    ['format_character', 'a⁠b'],
    ['format_character', 'a\u{e0041}b'],
    ['template_text', 'see {{n1.output.amount}}'],
    ['template_text', 'only {{'],
    ['template_text', 'only }}'],
    ['template_text', '{{ {{ }} }}'],
  ],
  number: [
    ['wrong_type', '5'],
    ['wrong_type', ''],
    ['wrong_type', null],
    ['wrong_type', true],
    ['wrong_type', [1]],
    ['not_finite', Number.NaN],
    ['not_finite', Number.POSITIVE_INFINITY],
    ['not_finite', Number.NEGATIVE_INFINITY],
    ['below_min', -1],
    ['below_min', -0.0001],
    ['above_max', 101],
    ['above_max', 100.0001],
    ['above_max', Number.MAX_VALUE],
  ],
  cron: [
    ['wrong_type', 5],
    ['empty', ''],
    ['empty', '  '],
    ['too_long', '*'.repeat(501)],
    ['control_character', '0 9 * * *\n'],
    ['control_character', '0\t9 * * *'],
    ['line_separator', '0 9 * * * '],
    ['bidi_format', '0 9 * * *‮'],
    ['format_character', '0 9​ * * *'],
    ['template_text', '{{t1.output.x}} 9 * * *'],
    ['bad_cron', 'not a cron'],
    ['bad_cron', '0 9 * *'],
    ['bad_cron', '0 9 * * * *'],
    ['bad_cron', '60 9 * * *'],
    ['bad_cron', '0 24 * * *'],
    ['bad_cron', '0 9 32 * *'],
    ['bad_cron', '0 9 * 13 *'],
    ['bad_cron', '0 9 * * 8'],
    ['bad_cron', '*/0 * * * *'],
    ['bad_cron', '5-1 * * * *'],
    ['bad_cron', '0 0 31 2 *'],
  ],
  url: [
    ['wrong_type', 5],
    ['empty', ''],
    ['too_long', 'https://example.test/' + 'a'.repeat(500)],
    ['control_character', 'https://example.test/\n'],
    ['line_separator', 'https://example.test/ '],
    ['bidi_format', 'https://example.test/‮'],
    ['format_character', 'https://example.test/​'],
    ['template_text', 'https://example.test/{{n1.output.id}}'],
    ['bad_url', 'ftp://example.test/file'],
    ['bad_url', 'file:///etc/passwd'],
    ['bad_url', 'javascript:alert(1)'],
    ['bad_url', 'data:text/plain,hello'],
    ['bad_url', 'example.test/health'],
    ['bad_url', '//example.test/health'],
    ['bad_url', 'HTTPS://example.test/health'],
    ['bad_url', 'https://'],
    ['bad_url', 'https:///health'],
    ['bad_url', 'https://exa mple.test'],
    ['bad_url', 'https://example.test/a b'],
    ['bad_url', 'https://[::1'],
    ['bad_url', 'https://example.test:99999/'],
    ['url_credentials', 'https://user:pass@example.test/'],
    ['url_credentials', 'https://user@example.test/'],
    ['url_credentials', 'https://example.test@other.test/'],
  ],
  connection: [
    ['wrong_type', 5],
    ['empty', ''],
    ['empty', '  '],
    ['too_long', 'a'.repeat(501)],
    ['control_character', 'slack\nops'],
    ['line_separator', 'slack ops'],
    ['bidi_format', 'slack‮ops'],
    ['format_character', 'slack​ops'],
    ['format_character', 'slack‍ops'],
    ['template_text', 'slack-{{ops}}'],
  ],
}

describe('the parameter kinds', () => {
  it('are the eight kinds of the plan', () => {
    expect([...PARAM_KINDS]).toEqual(['folder', 'file', 'glob', 'text', 'number', 'cron', 'url', 'connection'])
  })

  it('share one limit of 500 characters and 20 values', () => {
    expect(MAX_PARAM_STRING_CHARS).toBe(500)
    expect(MAX_PARAM_VALUES).toBe(20)
  })

  it('list for every kind exactly the value rules that some example reaches', () => {
    for (const kind of PARAM_KINDS) {
      const reached = new Set<ParamRule>()
      for (const [rule] of REJECTS[kind]) reached.add(rule)
      expect([...reached].sort(), kind).toEqual([...PARAM_RULES[kind]].sort())
    }
  })

  it('keep the rules of values apart from the rules of the form', () => {
    expect([...GENERAL_RULES].sort()).toEqual(['required', 'unknown_param'])
    for (const kind of PARAM_KINDS) for (const rule of PARAM_RULES[kind]) expect(GENERAL_RULES as readonly string[]).not.toContain(rule)
  })
})

describe.each(PARAM_KINDS)('checkValue for the %s kind', (kind) => {
  it('accepts valid values', () => {
    for (const value of ACCEPTS[kind]) expect(checkValue(param(kind), value), String(value)).toBeUndefined()
  })

  it('names the rule a value breaks', () => {
    for (const [rule, value] of REJECTS[kind]) expect(checkValue(param(kind), value), `${rule}: ${String(value).slice(0, 40)}`).toBe(rule)
  })
})

describe('character rules', () => {
  it('count characters, not UTF-16 units, for the limit of 500', () => {
    expect(checkValue(param('text'), '😀'.repeat(500))).toBeUndefined()
    expect(checkValue(param('text'), '😀'.repeat(501))).toBe('too_long')
    expect(checkValue(param('folder'), '/' + 'é'.repeat(499))).toBeUndefined()
    expect(checkValue(param('folder'), '/' + 'é'.repeat(500))).toBe('too_long')
  })

  it('check the length before the characters, so a huge value is only too long', () => {
    expect(checkValue(param('text'), 'a\n'.repeat(1_000_000))).toBe('too_long')
  })

  it('keep the zero-width joiner and non-joiner in text only, as emoji need them', () => {
    const family = '👨‍👩‍👧'
    expect(checkValue(param('text'), family)).toBeUndefined()
    expect(checkValue(param('text'), 'a‌b')).toBeUndefined()
    for (const kind of ['folder', 'file', 'glob', 'cron', 'url', 'connection'] as const) {
      const base = kind === 'folder' || kind === 'file' ? '/Users/demo/' : kind === 'url' ? 'https://example.test/' : kind === 'cron' ? '0 9 * * *' : 'a'
      expect(checkValue(param(kind), `${base}‍`), kind).toBe('format_character')
    }
  })

  it('allow ordinary spaces, other scripts and punctuation in text', () => {
    expect(checkValue(param('text'), 'Café 東京 — “quoted” (ok) [x] #1 50% $5')).toBeUndefined()
  })

  it('reject single braces only when doubled', () => {
    expect(checkValue(param('text'), '{')).toBeUndefined()
    expect(checkValue(param('text'), '}')).toBeUndefined()
    expect(checkValue(param('text'), '{ }')).toBeUndefined()
    expect(checkValue(param('text'), '{{')).toBe('template_text')
    expect(checkValue(param('text'), '}}')).toBe('template_text')
    expect(checkValue(param('text'), '}{')).toBeUndefined()
  })
})

describe('the number kind', () => {
  it('applies the bounds of the parameter, both ends inclusive', () => {
    const rate = param('number', { min: 1, max: 10 })
    expect(checkValue(rate, 1)).toBeUndefined()
    expect(checkValue(rate, 10)).toBeUndefined()
    expect(checkValue(rate, 0.99)).toBe('below_min')
    expect(checkValue(rate, 10.01)).toBe('above_max')
  })

  it('accepts negative bounds and zero', () => {
    const range = param('number', { min: -5, max: 5 })
    expect(checkValue(range, -5)).toBeUndefined()
    expect(checkValue(range, 0)).toBeUndefined()
    expect(checkValue(range, -0)).toBeUndefined()
    expect(checkValue(range, -5.5)).toBe('below_min')
  })

  it('does not take a number as text or text as a number', () => {
    expect(checkValue(param('text'), 5)).toBe('wrong_type')
    expect(checkValue(param('number'), '5')).toBe('wrong_type')
  })
})

describe('checkParams', () => {
  const recipe: Recipe = {
    id: 'demo',
    title: label,
    description: label,
    tags: [],
    params: [
      { id: 'folder', kind: 'folder', label, required: true },
      { id: 'glob', kind: 'glob', label, required: false, default: '*.pdf' },
      { id: 'limit', kind: 'number', label, required: true, min: 0, max: 10 },
    ],
    workflow: {},
    sample: {},
  }

  it('accepts complete values and lets a default fill an absent optional one', () => {
    expect(checkParams(recipe, { folder: '/Users/demo', limit: 3 })).toEqual([])
    expect(checkParams(recipe, { folder: '/Users/demo', glob: '*.png', limit: 3 })).toEqual([])
  })

  it('reports an absent required value', () => {
    expect(checkParams(recipe, { limit: 3 })).toEqual([{ param: 'folder', rule: 'required' }])
    expect(checkParams(recipe, {})).toEqual([
      { param: 'folder', rule: 'required' },
      { param: 'limit', rule: 'required' },
    ])
  })

  it('treats an undefined value like an absent one', () => {
    expect(checkParams(recipe, { folder: undefined, limit: 3 } as never)).toEqual([{ param: 'folder', rule: 'required' }])
  })

  it('ignores a value that only a prototype provides', () => {
    const inherited = Object.create({ folder: '/Users/demo' }) as Record<string, string | number>
    inherited.limit = 3
    expect(checkParams(recipe, inherited)).toEqual([{ param: 'folder', rule: 'required' }])
  })

  it('reports a bad value with the parameter id and the rule only', () => {
    expect(checkParams(recipe, { folder: 'relative', glob: 'a/b', limit: 11 })).toEqual([
      { param: 'folder', rule: 'not_absolute_path' },
      { param: 'glob', rule: 'bad_glob' },
      { param: 'limit', rule: 'above_max' },
    ])
  })

  it('checks a value that is given even when a default exists', () => {
    expect(checkParams(recipe, { folder: '/Users/demo', glob: '', limit: 1 })).toEqual([{ param: 'glob', rule: 'empty' }])
  })

  it('rejects a key that no parameter declares', () => {
    expect(checkParams(recipe, { folder: '/Users/demo', limit: 1, extra: 'x' })).toEqual([{ param: 'extra', rule: 'unknown_param' }])
    expect(checkParams(recipe, { folder: '/Users/demo', limit: 1, constructor: 'x' } as never)).toEqual([{ param: 'constructor', rule: 'unknown_param' }])
  })

  it('names an unknown key only when it has the shape of a parameter id', () => {
    const keys = ['a b', 'bad-key', '1abc', 'x'.repeat(33), `${MARKER}-key`, '', '__proto__', 'new\nline']
    const values = JSON.parse(`{"folder":"/Users/demo","limit":1,${keys.map((key) => `${JSON.stringify(key)}:"v"`).join(',')}}`) as Record<string, string | number>
    const problems = checkParams(recipe, values)
    expect(problems).toHaveLength(keys.length)
    expect(problems.every((problem) => problem.param === '?' && problem.rule === 'unknown_param')).toBe(true)
    expect(JSON.stringify(problems)).not.toContain(MARKER)
  })

  it('never puts a value in a problem', () => {
    let checked = 0
    for (const kind of PARAM_KINDS) {
      const single: Recipe = { ...recipe, params: [param(kind)] }
      for (const [, value] of REJECTS[kind]) {
        const marked = typeof value === 'string' ? `${MARKER}${value}${MARKER}` : value
        const problems = checkParams(single, { value: marked as string | number })
        for (const problem of problems) {
          expect(Object.keys(problem).sort()).toEqual(['param', 'rule'])
          expect(problem.param).toBe('value')
          expect(problem.rule).toMatch(/^[a-z_]+$/)
        }
        expect(JSON.stringify(problems)).not.toContain(MARKER)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('does not change its input', () => {
    const values = Object.freeze({ folder: '/Users/demo', limit: 3 })
    expect(() => checkParams(recipe, values)).not.toThrow()
    expect(values).toEqual({ folder: '/Users/demo', limit: 3 })
  })
})
