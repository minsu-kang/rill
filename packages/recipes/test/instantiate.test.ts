import { describe, expect, it } from 'vitest'
import { RecipeDefinitionError, instantiateRecipe, param, type Recipe } from '../src/index'

const label = { ko: '라벨', en: 'Label' }
const MARKER = 'MARKER-3be5a0'

function recipeWith(workflow: unknown, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'demo',
    title: label,
    description: label,
    tags: [],
    params: [
      { id: 'folder', kind: 'folder', label, required: true },
      { id: 'note', kind: 'text', label, required: false, default: 'default note' },
      { id: 'limit', kind: 'number', label, required: true, min: 0, max: 1000 },
    ],
    workflow,
    sample: { folder: '/Users/demo/in', note: 'sample note', limit: 5 },
    ...overrides,
  }
}

const template = {
  schemaVersion: 1,
  name: 'demo',
  nodes: [
    { id: 't1', type: 'trigger.folderWatch@1', config: { folder: param('folder') } },
    { id: 'n1', type: 'notify.slack@1', config: { connection: 'slack-ops', text: param('note'), extra: [param('limit'), { nested: param('note') }] } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
}

const recipe = recipeWith(template)
const values = { folder: '/Users/demo/in', limit: 5 }

function workflowOf(result: ReturnType<typeof instantiateRecipe>): Record<string, unknown> {
  if (!('workflow' in result)) throw new Error(`expected a workflow, got ${JSON.stringify(result)}`)
  return result.workflow as unknown as Record<string, unknown>
}

describe('instantiateRecipe', () => {
  it('replaces every placeholder with its value and fills the default of an absent optional parameter', () => {
    const workflow = workflowOf(instantiateRecipe(recipe, values))
    expect(workflow).toEqual({
      schemaVersion: 1,
      name: 'demo',
      nodes: [
        { id: 't1', type: 'trigger.folderWatch@1', config: { folder: '/Users/demo/in' } },
        { id: 'n1', type: 'notify.slack@1', config: { connection: 'slack-ops', text: 'default note', extra: [5, { nested: 'default note' }] } },
      ],
      edges: [{ from: 't1', to: 'n1' }],
    })
  })

  it('prefers a given value over the default', () => {
    const workflow = workflowOf(instantiateRecipe(recipe, { ...values, note: 'given note' }))
    expect(JSON.stringify(workflow)).toContain('given note')
    expect(JSON.stringify(workflow)).not.toContain('default note')
  })

  it('keeps a number a number and a string a string', () => {
    const workflow = workflowOf(instantiateRecipe(recipe, values)) as { nodes: Array<{ config: { extra?: unknown[] } }> }
    expect(workflow.nodes[1]!.config.extra![0]).toBe(5)
    expect(typeof workflow.nodes[0]!.config).toBe('object')
  })

  it('reports problems and no workflow when a value is wrong', () => {
    const result = instantiateRecipe(recipe, { folder: 'relative', limit: 5 })
    expect(result).toEqual({ problems: [{ param: 'folder', rule: 'not_absolute_path' }] })
    expect('workflow' in result).toBe(false)
  })

  it('reports an absent required value and an unknown key together', () => {
    expect(instantiateRecipe(recipe, { limit: 5, stray: 'x' })).toEqual({
      problems: [
        { param: 'folder', rule: 'required' },
        { param: 'stray', rule: 'unknown_param' },
      ],
    })
  })

  it('never reads a value out of a problem list', () => {
    const result = instantiateRecipe(recipe, { folder: `${MARKER}/relative`, note: `${MARKER}{{x}}`, limit: 5 })
    expect(JSON.stringify(result)).not.toContain(MARKER)
  })
})

describe('placeholders are replaced structurally', () => {
  const lookalikes = ['{"$param":"folder"}', '{"$param":"note"}', '["a","b"]', '{"a":[{"b":1}]}', '$param', '"quoted"', 'null', '{ $param: note }', '\\{"x":1}']

  it.each(lookalikes)('keeps the value %s as one plain string', (text) => {
    const workflow = workflowOf(instantiateRecipe(recipe, { ...values, note: text })) as {
      nodes: Array<{ config: { text?: unknown; extra?: Array<unknown> } }>
    }
    const config = workflow.nodes[1]!.config
    expect(config.text).toBe(text)
    expect(config.extra).toEqual([5, { nested: text }])
  })

  it('does not look at a replaced value again, so one value cannot select another parameter', () => {
    const twin = recipeWith({
      schemaVersion: 1,
      name: 'demo',
      nodes: [{ id: 't1', type: 'trigger.manual@1', config: { a: param('note'), b: param('folder'), c: param('limit') } }],
      edges: [],
    })
    const workflow = workflowOf(instantiateRecipe(twin, { folder: '/Users/demo/in', note: '{"$param":"folder"}', limit: 1 })) as {
      nodes: Array<{ config: Record<string, unknown> }>
    }
    expect(workflow.nodes[0]!.config).toEqual({ a: '{"$param":"folder"}', b: '/Users/demo/in', c: 1 })
  })

  it('never builds the JSON text of the workflow to replace in', () => {
    const quoted = recipeWith(
      { schemaVersion: 1, name: 'demo', nodes: [{ id: 't1', type: 'trigger.manual@1', config: { a: param('note') } }], edges: [] },
      { params: [{ id: 'note', kind: 'text', label, required: true }], sample: { note: 'x' } },
    )
    const injected = '","evil":"yes'
    const workflow = workflowOf(instantiateRecipe(quoted, { note: injected })) as { nodes: Array<{ config: Record<string, unknown> }> }
    expect(workflow.nodes[0]!.config).toEqual({ a: injected })
    const tricky = '\\","evil":{"x":"'
    expect((workflowOf(instantiateRecipe(quoted, { note: tricky })) as { nodes: Array<{ config: Record<string, unknown> }> }).nodes[0]!.config).toEqual({ a: tricky })
  })

  it('refuses a placeholder object that has other keys', () => {
    const odd = recipeWith({
      schemaVersion: 1,
      name: 'demo',
      nodes: [{ id: 't1', type: 'trigger.manual@1', config: { a: { $param: 'note', other: 1 }, b: param('folder'), c: param('limit') } }],
      edges: [],
    })
    expect(() => instantiateRecipe(odd, values)).toThrow(RecipeDefinitionError)
  })

  it('does not let a key such as __proto__ in the values reach the workflow', () => {
    const polluted = JSON.parse('{"folder":"/Users/demo/in","limit":5,"__proto__":{"polluted":true}}') as Record<string, string | number>
    expect(instantiateRecipe(recipe, polluted)).toEqual({ problems: [{ param: '?', rule: 'unknown_param' }] })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('a recipe that is wrongly written', () => {
  const used = { folder: param('folder'), limit: param('limit') }
  const withConfig = (config: Record<string, unknown>) => recipeWith({ schemaVersion: 1, name: 'demo', nodes: [{ id: 't1', type: 'trigger.manual@1', config }], edges: [] })

  it.each([
    ['a placeholder in a key position', { ...used, [JSON.stringify(param('note'))]: 1 }],
    ['an undeclared placeholder', { ...used, note: param('ghost') }],
    ['a declared parameter that nothing uses', { folder: param('folder') }],
  ])('is refused when it has %s', (_name, config) => {
    expect(() => instantiateRecipe(withConfig(config), values)).toThrow(RecipeDefinitionError)
  })

  it('names the defects and never a value in the error', () => {
    try {
      instantiateRecipe(withConfig({ ...used, note: param('ghost') }), { folder: `${MARKER}`, limit: 5 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RecipeDefinitionError)
      expect((error as Error).message).toContain('undeclared_param')
      expect((error as Error).message).not.toContain(MARKER)
    }
  })
})

describe('determinism', () => {
  it('gives the same workflow, ids and key order included, for the same recipe and values', () => {
    const first = JSON.stringify(instantiateRecipe(recipe, values))
    for (let index = 0; index < 5; index++) expect(JSON.stringify(instantiateRecipe(recipe, values))).toBe(first)
  })

  it('does not depend on the order of the keys in the values', () => {
    const a = JSON.stringify(instantiateRecipe(recipe, { folder: '/Users/demo/in', note: 'n', limit: 5 }))
    const b = JSON.stringify(instantiateRecipe(recipe, { limit: 5, note: 'n', folder: '/Users/demo/in' }))
    expect(a).toBe(b)
  })

  it('returns a fresh structure that shares nothing with the recipe or an earlier result', () => {
    const before = structuredClone(template)
    const first = workflowOf(instantiateRecipe(recipe, values)) as { nodes: Array<{ config: Record<string, unknown> }>; edges: unknown[] }
    first.nodes[0]!.config.folder = 'changed'
    first.nodes.push({ config: {} } as never)
    first.edges.push('extra')
    const second = workflowOf(instantiateRecipe(recipe, values)) as { nodes: Array<{ config: Record<string, unknown> }>; edges: unknown[] }
    expect(second.nodes).toHaveLength(2)
    expect(second.edges).toHaveLength(1)
    expect(second.nodes[0]!.config.folder).toBe('/Users/demo/in')
    expect(recipe.workflow).toEqual(before)
  })

  it('works on a recipe whose structures are frozen', () => {
    const frozen = structuredClone(recipe)
    const freeze = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        Object.freeze(value)
        for (const inner of Object.values(value)) freeze(inner)
      }
    }
    freeze(frozen)
    expect(() => instantiateRecipe(frozen, Object.freeze({ ...values }))).not.toThrow()
  })
})
