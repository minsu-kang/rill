import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  METHODS,
  RECIPE_MAX_STRING_CHARS,
  RECIPE_MAX_VALUES,
  RECIPE_PARAM_KINDS,
  RecipeInfoSchema,
  RecipeParamInfoSchema,
  validateParams,
} from '../src/index'

const label = { ko: '라벨', en: 'Label' }

const info = {
  id: 'receipt-folder-to-csv',
  title: label,
  description: label,
  tags: ['receipts'],
  params: [
    { id: 'watchFolder', kind: 'folder', label, help: label, required: true },
    { id: 'glob', kind: 'glob', label, required: false, default: '*.pdf' },
    { id: 'threshold', kind: 'number', label, required: true, min: 0, max: 100 },
  ],
  nodeTypes: ['trigger.folderWatch@1', 'csv.append@1'],
  needsConnection: false,
}

const draft = {
  recipeId: 'receipt-folder-to-csv',
  workflow: {
    schemaVersion: 1,
    name: 'demo',
    nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
    edges: [],
  },
  summary: { nodes: [{ id: 't1', type: 'trigger.manual@1', title: 'Manual' }], sideEffects: ['idempotent', 'external'] },
}

const check = (schema: unknown, value: unknown): boolean => Value.Check(schema as never, value)

describe('the recipe limits and kinds', () => {
  it('are 20 values of at most 500 characters and the eight parameter kinds', () => {
    expect(RECIPE_MAX_VALUES).toBe(20)
    expect(RECIPE_MAX_STRING_CHARS).toBe(500)
    expect([...RECIPE_PARAM_KINDS]).toEqual(['folder', 'file', 'glob', 'text', 'number', 'cron', 'url', 'connection'])
  })
})

describe('listRecipes', () => {
  it('takes no params', () => {
    expect(validateParams('listRecipes', {})).toEqual({ ok: true, method: 'listRecipes', params: {} })
    expect(validateParams('listRecipes', undefined).ok).toBe(true)
    expect(validateParams('listRecipes', { tag: 'csv' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns entries with the form fields and no workflow', () => {
    expect(check(METHODS.listRecipes.result, { recipes: [info] })).toBe(true)
    expect(check(METHODS.listRecipes.result, { recipes: [] })).toBe(true)
    expect(check(METHODS.listRecipes.result, {})).toBe(false)
    expect(check(RecipeInfoSchema, { ...info, workflow: {} })).toBe(false)
    expect(check(RecipeInfoSchema, { ...info, sample: {} })).toBe(false)
  })

  it('needs every field of an entry', () => {
    for (const key of Object.keys(info)) {
      const rest: Record<string, unknown> = { ...info }
      delete rest[key]
      expect(check(RecipeInfoSchema, rest), key).toBe(false)
    }
    expect(check(RecipeInfoSchema, { ...info, needsConnection: 'no' })).toBe(false)
    expect(check(RecipeInfoSchema, { ...info, nodeTypes: [1] })).toBe(false)
    expect(check(RecipeInfoSchema, { ...info, title: { ko: '가' } })).toBe(false)
  })

  it('describes a parameter by kind with its own bounds and default', () => {
    for (const param of info.params) expect(check(RecipeParamInfoSchema, param), param.id).toBe(true)
    expect(check(RecipeParamInfoSchema, { ...info.params[0], kind: 'path' })).toBe(false)
    expect(check(RecipeParamInfoSchema, { ...info.params[0], extra: 1 })).toBe(false)
    expect(check(RecipeParamInfoSchema, { ...info.params[0], required: 'yes' })).toBe(false)
    expect(check(RecipeParamInfoSchema, { ...info.params[2], min: 'zero' })).toBe(false)
    expect(check(RecipeParamInfoSchema, { ...info.params[1], default: true })).toBe(false)
    expect(check(RecipeParamInfoSchema, { ...info.params[1], default: 5 })).toBe(true)
  })
})

describe('instantiateRecipe parameters', () => {
  const ok = (params: unknown) => validateParams('instantiateRecipe', params)

  it('take a recipe id and the values of the form', () => {
    expect(ok({ recipeId: 'receipt-folder-to-csv', values: { watchFolder: '/Users/demo/Receipts', threshold: 5 } })).toEqual({
      ok: true,
      method: 'instantiateRecipe',
      params: { recipeId: 'receipt-folder-to-csv', values: { watchFolder: '/Users/demo/Receipts', threshold: 5 } },
    })
    expect(ok({ recipeId: 'x', values: {} }).ok).toBe(true)
  })

  it('are closed and need both fields', () => {
    expect(ok({ recipeId: 'x', values: {}, extra: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ values: {} })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok(undefined)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: '', values: {} })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 'x'.repeat(129), values: {} })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 5, values: {} })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('take at most 20 values', () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`p${index}`, 'v']))
    expect(ok({ recipeId: 'x', values: many(20) }).ok).toBe(true)
    expect(ok({ recipeId: 'x', values: many(21) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('take only text of at most 500 characters and numbers as values', () => {
    expect(ok({ recipeId: 'x', values: { a: 'x'.repeat(500) } }).ok).toBe(true)
    expect(ok({ recipeId: 'x', values: { a: '😀'.repeat(500) } }).ok).toBe(true)
    expect(ok({ recipeId: 'x', values: { a: 'x'.repeat(501) } })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 'x', values: { a: '😀'.repeat(501) } })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    for (const value of [true, null, [1], { a: 1 }, undefined]) {
      expect(ok({ recipeId: 'x', values: { a: value } }), String(value)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
    expect(ok({ recipeId: 'x', values: { a: 1.5, b: -3, c: 0 } }).ok).toBe(true)
    expect(ok({ recipeId: 'x', values: 'a=b' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 'x', values: [] })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 'x', values: null })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('refuse a value that is not a finite number, the way JSON can still carry one', () => {
    const huge = JSON.parse('{"recipeId":"x","values":{"a":1e999}}') as unknown
    expect(ok(huge)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('leave the keys of the values to the engine, since an unknown key is a problem of the form', () => {
    expect(ok({ recipeId: 'x', values: { 'not-an-id': 'v', 'with space': 'v', '': 'v' } }).ok).toBe(true)
  })

  it('refuse a key with a line break, so that no value can hide under a key the pattern of the keys skips', () => {
    expect(ok({ recipeId: 'x', values: { 'a\nb': { deep: 1 } } })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(ok({ recipeId: 'x', values: { 'a\u2028b': 'v'.repeat(600) } })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('do not put a value into the problems of a bad request', () => {
    const marker = 'VALUE-MARKER-2f7a'
    const result = ok({ recipeId: 'x', values: { a: marker.repeat(100), b: marker } })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(marker)
  })
})

describe('the instantiateRecipe result', () => {
  it('carries the recipe id, the workflow and a summary of the nodes and the side effects', () => {
    expect(check(METHODS.instantiateRecipe.result, draft)).toBe(true)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, sideEffects: [] } })).toBe(true)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, sideEffects: ['external'] } })).toBe(true)
  })

  it('knows only the side effects that a person needs to hear about, each once', () => {
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, sideEffects: ['none'] } })).toBe(false)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, sideEffects: ['external', 'external'] } })).toBe(false)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, sideEffects: ['write'] } })).toBe(false)
  })

  it('needs a valid workflow and closed objects', () => {
    expect(check(METHODS.instantiateRecipe.result, { ...draft, workflow: { schemaVersion: 1, name: '', nodes: [], edges: [] } })).toBe(false)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, extra: 1 })).toBe(false)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, extra: 1 } })).toBe(false)
    expect(check(METHODS.instantiateRecipe.result, { ...draft, summary: { ...draft.summary, nodes: [{ id: 't1', type: 'x' }] } })).toBe(false)
    const rest: Record<string, unknown> = { ...draft }
    delete rest.summary
    expect(check(METHODS.instantiateRecipe.result, rest)).toBe(false)
  })
})

describe('the recipe error code', () => {
  it('is listed next to the others, once', () => {
    expect(ERROR_CODES as readonly string[]).toContain('RECIPE_INVALID')
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
