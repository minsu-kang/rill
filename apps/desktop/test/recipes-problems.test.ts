// @vitest-environment node
import { ISSUE_CODES } from '@rill/dsl'
import type { RecipeParamInfo } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { ISSUE_CODE_KEYS, PARAM_RULE_IDS, issueKey, problemsToFields, ruleKey } from '../src/recipes/model/problems'

const LABEL = { ko: '라벨', en: 'Label' }
const params: RecipeParamInfo[] = [
  { id: 'watchFolder', kind: 'folder', label: LABEL, required: true },
  { id: 'csvFile', kind: 'file', label: LABEL, required: true, extension: '.csv' },
  { id: 'threshold', kind: 'number', label: LABEL, required: true },
]

describe('problemsToFields for <param>: <rule> problems', () => {
  it('puts every problem on its field with a message of its own', () => {
    const { fields, general, raw } = problemsToFields(['watchFolder: not_absolute_path', 'csvFile: wrong_extension', 'threshold: below_min'], params)
    expect(fields).toEqual({ watchFolder: 'recipes.rule.not_absolute_path', csvFile: 'recipes.rule.wrong_extension', threshold: 'recipes.rule.below_min' })
    expect(general).toEqual([])
    expect(raw).toEqual({})
  })

  it('keeps the first problem of a field', () => {
    const { fields } = problemsToFields(['watchFolder: required', 'watchFolder: parent_segment'], params)
    expect(fields).toEqual({ watchFolder: 'recipes.rule.required' })
  })

  it('has a message in both languages for every rule id', () => {
    for (const id of PARAM_RULE_IDS) {
      const key = ruleKey(id)
      expect(key, id).not.toBe('recipes.rule.generic')
      expect(ko, key).toHaveProperty(key)
      expect(en, key).toHaveProperty(key)
    }
  })

  it('falls back to a generic message and keeps the raw rule id for an unknown rule', () => {
    const { fields, raw } = problemsToFields(['watchFolder: made_up_rule'], params)
    expect(fields).toEqual({ watchFolder: 'recipes.rule.generic' })
    expect(raw).toEqual({ watchFolder: 'made_up_rule' })
  })

  it('sends a problem about a param the form does not have to the general list with the raw ids', () => {
    const { fields, general } = problemsToFields(['ghost: required', '?: unknown_param', 'ghost: made_up_rule'], params)
    expect(fields).toEqual({})
    expect(general).toEqual([
      { code: 'required', pointer: 'ghost', key: 'recipes.rule.required' },
      { code: 'unknown_param', pointer: '?', key: 'recipes.rule.unknown_param' },
      { code: 'made_up_rule', pointer: 'ghost', key: 'recipes.rule.generic' },
    ])
  })

  it('does not treat a param id like constructor or __proto__ as a field of the form', () => {
    const { fields, general } = problemsToFields(['constructor: required', '__proto__: required'], params)
    expect(Object.keys(fields)).toEqual([])
    expect(general).toHaveLength(2)
  })
})

describe('problemsToFields for <code> at <pointer> issues', () => {
  it('keeps issues in the general list even when the pointer is inside a node config', () => {
    const { fields, general } = problemsToFields(['path_outside_roots at /nodes/2/config/file', 'unknown_connection at /nodes/3/config/connection', 'inside_watched_folder at /nodes/2/config/file'], params)
    expect(fields).toEqual({})
    expect(general).toEqual([
      { code: 'path_outside_roots', pointer: '/nodes/2/config/file', key: 'recipes.issue.path_outside_roots' },
      { code: 'unknown_connection', pointer: '/nodes/3/config/connection', key: 'recipes.issue.unknown_connection' },
      { code: 'inside_watched_folder', pointer: '/nodes/2/config/file', key: 'recipes.issue.inside_watched_folder' },
    ])
  })

  it('reads the root pointer and an unknown code', () => {
    const { general } = problemsToFields(['cycle at /', 'brand_new_code at /nodes/0'], params)
    expect(general).toEqual([
      { code: 'cycle', pointer: '/', key: 'recipes.issue.structure' },
      { code: 'brand_new_code', pointer: '/nodes/0', key: 'recipes.issue.unknown' },
    ])
  })

  it('shows text that is neither form as a cut raw line with the unknown message', () => {
    const { general } = problemsToFields(['something went wrong ' + 'x'.repeat(200)], params)
    expect(general).toHaveLength(1)
    expect(general[0]!.key).toBe('recipes.issue.unknown')
    expect(general[0]!.code.length).toBeLessThanOrEqual(80)
    expect(general[0]!.pointer).toBe('')
  })

  it('handles an empty list', () => {
    expect(problemsToFields([], params)).toEqual({ fields: {}, general: [], raw: {} })
  })
})

describe('issue messages', () => {
  it('cover every issue code of the DSL and the connection kind check', () => {
    const codes = [...ISSUE_CODES, 'connection_kind_mismatch']
    expect(codes.length).toBeGreaterThan(40)
    for (const code of codes) {
      const key = issueKey(code)
      expect(key, code).not.toBe('recipes.issue.unknown')
      expect(ko, key).toHaveProperty(key)
      expect(en, key).toHaveProperty(key)
    }
    expect(Object.keys(ISSUE_CODE_KEYS).sort()).toEqual([...codes].sort())
  })

  it('give config_* and shape_* codes their family message and keep specific codes apart', () => {
    expect(issueKey('config_pattern')).toBe('recipes.issue.config')
    expect(issueKey('shape_type')).toBe('recipes.issue.structure')
    expect(issueKey('cron_expression')).toBe('recipes.issue.cron_expression')
    expect(issueKey('connection_kind_mismatch')).toBe('recipes.issue.connection_kind_mismatch')
  })

  it('never echo the code table with a prototype name', () => {
    expect(issueKey('constructor')).toBe('recipes.issue.unknown')
    expect(ruleKey('__proto__')).toBe('recipes.rule.generic')
  })
})

describe('no problem text carries a value', () => {
  it('shows only keys, rule ids, codes and pointers', () => {
    const MARKER = 'VALUE-MARKER-9f3a'
    const t = createTranslator('ko')
    const { fields, general } = problemsToFields(['watchFolder: not_absolute_path', 'path_outside_roots at /nodes/2/config/file'], params)
    const shown = [...Object.values(fields), ...general.map((item) => item.key)].map((key) => t(key)).join(' ')
    expect(shown).not.toContain(MARKER)
    for (const key of [...Object.values(fields), ...general.map((item) => item.key)]) expect(ko[key as keyof typeof ko] ?? '').not.toMatch(/\{[a-zA-Z]+\}/)
  })
})
