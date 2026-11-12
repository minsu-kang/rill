import { describe, expect, it } from 'vitest'
import { RECIPE_RULES, param, recipeNodeTypes, recipeProblems, type Recipe, type RecipeParam, type RecipeRule } from '../src/index'

const label = { ko: '라벨', en: 'Label' }

const folder: RecipeParam = { id: 'folder', kind: 'folder', label, required: true }
const note: RecipeParam = { id: 'note', kind: 'text', label, required: false, default: 'a note' }
const file: RecipeParam = { id: 'ledger', kind: 'file', label, required: true, extension: '.csv' }
const slack: RecipeParam = { id: 'slack', kind: 'connection', label, required: true, connectionKind: 'slack' }

function workflowWith(config: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    name: 'demo',
    nodes: [{ id: 't1', type: 'trigger.folderWatch@1', config, ...extra }],
    edges: [],
  }
}

function make(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'demo',
    title: label,
    description: label,
    tags: ['demo'],
    params: [folder, note],
    workflow: workflowWith({ folder: param('folder'), glob: param('note') }),
    sample: { folder: '/Users/demo/in', note: 'sample' },
    ...overrides,
  }
}

const rules = (recipe: unknown): RecipeRule[] => recipeProblems(recipe).map((defect) => defect.rule)

describe('recipeProblems', () => {
  it('accepts a well-written recipe', () => {
    expect(recipeProblems(make())).toEqual([])
  })

  it('lists the rules it can raise', () => {
    expect(new Set(RECIPE_RULES).size).toBe(RECIPE_RULES.length)
    for (const rule of [
      'bad_shape',
      'bad_workflow',
      'duplicate_param',
      'bad_bounds',
      'bounds_not_allowed',
      'default_on_required',
      'default_missing',
      'bad_default',
      'sample_missing',
      'sample_unknown',
      'bad_sample',
      'bad_placeholder',
      'placeholder_in_key',
      'placeholder_in_text',
      'placeholder_outside_config',
      'undeclared_param',
      'unused_param',
      'extension_not_allowed',
      'connection_kind_missing',
      'connection_kind_not_allowed',
    ] as const) {
      expect(RECIPE_RULES).toContain(rule)
    }
  })

  describe('the shape', () => {
    it.each([
      ['not an object', 'recipe'],
      ['null', null],
      ['an array', []],
      ['a missing title', { ...make(), title: undefined }],
      ['an empty title', make({ title: { ko: '', en: 'x' } })],
      ['a title without a language', make({ title: { ko: '가' } as never })],
      ['an extra field', { ...make(), extra: 1 }],
      ['an id that is not kebab-case', make({ id: 'Not_Kebab' })],
      ['an empty id', make({ id: '' })],
      ['a parameter id that is not a plain word', make({ params: [{ ...folder, id: 'bad-id' }, note] })],
      ['a parameter id starting with a capital', make({ params: [{ ...folder, id: 'Folder' }, note] })],
      ['an unknown parameter kind', make({ params: [{ ...folder, kind: 'path' as never }, note] })],
      ['a parameter without required', make({ params: [{ id: 'folder', kind: 'folder', label } as never, note] })],
      ['a parameter with an extra field', make({ params: [{ ...folder, extra: 1 } as never, note] })],
      ['an extension without the dot', make({ params: [{ ...file, extension: 'csv' }, note] })],
      ['an extension in capitals', make({ params: [{ ...file, extension: '.CSV' }, note] })],
      ['an extension of nine characters', make({ params: [{ ...file, extension: '.abcdefghi' }, note] })],
      ['an empty extension', make({ params: [{ ...file, extension: '.' }, note] })],
      ['an extension with a second dot', make({ params: [{ ...file, extension: '.tar.gz' }, note] })],
      ['an extension that is not text', make({ params: [{ ...file, extension: 5 as never }, note] })],
      ['a connection kind that is not known', make({ params: [{ ...slack, connectionKind: 'email' as never }, note] })],
      ['a connection kind in capitals', make({ params: [{ ...slack, connectionKind: 'Slack' as never }, note] })],
      ['a sample value that is not text or a number', make({ sample: { folder: '/Users/demo/in', note: true as never } })],
      ['tags that are not words', make({ tags: ['Not A Tag'] })],
      ['too many parameters', make({ params: Array.from({ length: 11 }, (_unused, index) => ({ ...note, id: `p${index}` })) })],
    ])('refuses %s', (_name, recipe) => {
      expect(rules(recipe)).toContain('bad_shape')
    })

    it('reports only the shape when the shape is broken, since the rest cannot be read', () => {
      expect(new Set(rules({ ...make(), params: 'nope' }))).toEqual(new Set(['bad_shape']))
    })

    it('needs a workflow with nodes that have a string id and a string type', () => {
      expect(rules(make({ workflow: undefined }))).toContain('bad_workflow')
      expect(rules(make({ workflow: 'text' }))).toContain('bad_workflow')
      expect(rules(make({ workflow: { nodes: [] } }))).toContain('bad_workflow')
      expect(rules(make({ workflow: { nodes: 'x' } }))).toContain('bad_workflow')
      expect(rules(make({ workflow: { nodes: [{ id: 5, type: 'trigger.manual@1' }] } }))).toContain('bad_workflow')
      expect(rules(make({ workflow: { nodes: [{ id: 't1', type: param('note') }] } }))).toContain('bad_workflow')
    })
  })

  describe('the parameters', () => {
    it('refuses two parameters with the same id', () => {
      expect(recipeProblems(make({ params: [folder, { ...note, id: 'folder' }] }))).toContainEqual({ pointer: '/params/1/id', rule: 'duplicate_param' })
    })

    it('needs finite bounds, lowest first, on a number parameter and none on any other kind', () => {
      const number = (extra: Partial<RecipeParam>): RecipeParam => ({ id: 'limit', kind: 'number', label, required: true, ...extra })
      const recipe = (limit: RecipeParam) => make({ params: [limit], workflow: workflowWith({ n: param('limit') }), sample: { limit: 5 } })
      expect(recipeProblems(recipe(number({ min: 0, max: 10 })))).toEqual([])
      expect(recipeProblems(recipe(number({ min: 5, max: 5 })))).toEqual([])
      expect(rules(recipe(number({})))).toContain('bad_bounds')
      expect(rules(recipe(number({ min: 0 })))).toContain('bad_bounds')
      expect(rules(recipe(number({ max: 10 })))).toContain('bad_bounds')
      expect(rules(recipe(number({ min: 10, max: 0 })))).toContain('bad_bounds')
      expect(recipeProblems(recipe(number({ min: Number.NEGATIVE_INFINITY, max: 10 }))).length).toBeGreaterThan(0)
      expect(recipeProblems(recipe(number({ min: 0, max: Number.NaN }))).length).toBeGreaterThan(0)
      expect(rules(make({ params: [{ ...folder, min: 0 }, note] }))).toContain('bounds_not_allowed')
      expect(rules(make({ params: [folder, { ...note, max: 5 }] }))).toContain('bounds_not_allowed')
    })

    it('accepts an extension on a file and a connection kind on a connection, each with a value that passes', () => {
      const recipe = make({
        params: [folder, file, slack],
        workflow: workflowWith({ folder: param('folder'), file: param('ledger'), connection: param('slack') }),
        sample: { folder: '/Users/demo/in', ledger: '/Users/demo/ledger.csv', slack: 'slack-ops' },
      })
      expect(recipeProblems(recipe)).toEqual([])
      for (const kind of ['slack', 'http', 'webhookSecret'] as const) {
        expect(recipeProblems({ ...recipe, params: [folder, file, { ...slack, connectionKind: kind }] }), kind).toEqual([])
      }
    })

    it('allows an extension on a file only', () => {
      expect(recipeProblems(make({ params: [{ ...folder, extension: '.csv' }, note] }))).toContainEqual({ pointer: '/params/0', rule: 'extension_not_allowed' })
      expect(recipeProblems(make({ params: [folder, { ...note, extension: '.csv' }] }))).toContainEqual({ pointer: '/params/1', rule: 'extension_not_allowed' })
      expect(recipeProblems(make({ params: [folder, { ...slack, extension: '.csv' }] }))).toContainEqual({ pointer: '/params/1', rule: 'extension_not_allowed' })
    })

    it('needs a connection kind on a connection and allows it on nothing else', () => {
      const bare: RecipeParam = { ...slack }
      delete bare.connectionKind
      const used = (params: RecipeParam[]) => make({ params, workflow: workflowWith({ a: param('folder'), b: param('slack'), c: param('note') }), sample: { folder: '/Users/demo/in', slack: 's', note: 'x' } })
      expect(recipeProblems(used([folder, bare, note]))).toEqual([{ pointer: '/params/1', rule: 'connection_kind_missing' }])
      expect(recipeProblems(used([{ ...folder, connectionKind: 'slack' }, slack, note]))).toEqual([{ pointer: '/params/0', rule: 'connection_kind_not_allowed' }])
      expect(recipeProblems(used([folder, slack, { ...note, connectionKind: 'http' }]))).toEqual([{ pointer: '/params/2', rule: 'connection_kind_not_allowed' }])
    })

    it('holds a default and a sample to the extension of their file parameter', () => {
      const base = (params: RecipeParam[], sample: Record<string, string>) =>
        make({ params, workflow: workflowWith({ file: param('ledger') }), sample })
      expect(recipeProblems(base([{ ...file, required: false, default: '/Users/demo/a.csv' }], { ledger: '/Users/demo/b.csv' }))).toEqual([])
      expect(recipeProblems(base([{ ...file, required: false, default: '/Users/demo/a.txt' }], { ledger: '/Users/demo/b.csv' }))).toEqual([{ pointer: '/params/0/default', rule: 'bad_default' }])
      expect(recipeProblems(base([file], { ledger: '/Users/demo/b.txt' }))).toEqual([{ pointer: '/sample/ledger', rule: 'bad_sample' }])
    })

    it('gives a required parameter no default and an optional one a default', () => {
      expect(rules(make({ params: [{ ...folder, default: '/Users/demo/in' }, note] }))).toContain('default_on_required')
      expect(rules(make({ params: [folder, { id: 'note', kind: 'text', label, required: false }] }))).toContain('default_missing')
    })

    it('holds a default to the rules of its kind', () => {
      const bad = (defaultValue: string | number) => make({ params: [folder, { ...note, default: defaultValue }] })
      expect(rules(bad('line\nbreak'))).toContain('bad_default')
      expect(rules(bad('{{n1.output.x}}'))).toContain('bad_default')
      expect(rules(bad(5))).toContain('bad_default')
      const cron = make({
        params: [folder, { id: 'when', kind: 'cron', label, required: false, default: 'every day' }],
        workflow: workflowWith({ folder: param('folder'), glob: param('when') }),
        sample: { folder: '/Users/demo/in', when: '0 9 * * *' },
      })
      expect(rules(cron)).toContain('bad_default')
    })
  })

  describe('the sample', () => {
    it('has a value for every parameter and for nothing else', () => {
      expect(recipeProblems(make({ sample: { folder: '/Users/demo/in' } }))).toContainEqual({ pointer: '/sample/note', rule: 'sample_missing' })
      expect(recipeProblems(make({ sample: { folder: '/Users/demo/in', note: 'x', stray: 'y' } }))).toContainEqual({ pointer: '/sample/stray', rule: 'sample_unknown' })
    })

    it('holds each value to the rules of its parameter', () => {
      expect(recipeProblems(make({ sample: { folder: 'relative', note: 'x' } }))).toContainEqual({ pointer: '/sample/folder', rule: 'bad_sample' })
      expect(recipeProblems(make({ sample: { folder: '/Users/demo/in', note: '{{x}}' } }))).toContainEqual({ pointer: '/sample/note', rule: 'bad_sample' })
    })
  })

  describe('the placeholders', () => {
    it('accepts a placeholder anywhere in the config of a node, in nested objects and lists', () => {
      const nested = make({ workflow: workflowWith({ folder: param('folder'), deep: { list: [1, { glob: param('note') }] } }) })
      expect(recipeProblems(nested)).toEqual([])
    })

    it('refuses a placeholder for a parameter that is not declared', () => {
      const wrong = make({ workflow: workflowWith({ folder: param('folder'), glob: param('note'), other: param('ghost') }) })
      expect(recipeProblems(wrong)).toEqual([{ pointer: '/workflow/nodes/0/config/other', rule: 'undeclared_param' }])
    })

    it('refuses a declared parameter that no placeholder uses', () => {
      const wrong = make({ workflow: workflowWith({ folder: param('folder') }) })
      expect(recipeProblems(wrong)).toEqual([{ pointer: '/params/1', rule: 'unused_param' }])
    })

    it('counts a parameter as used when several placeholders name it', () => {
      expect(recipeProblems(make({ workflow: workflowWith({ folder: param('folder'), a: param('note'), b: param('note') }) }))).toEqual([])
    })

    it('refuses a placeholder in a key position, however it is spelled', () => {
      const keys = [JSON.stringify(param('note')), 'x$paramx', '{{$param:note}}', '$param:note', '$params']
      for (const key of keys) {
        const wrong = make({ workflow: workflowWith({ folder: param('folder'), glob: param('note'), [key]: 1 }) })
        expect(recipeProblems(wrong), key).toContainEqual({ pointer: '/workflow/nodes/0/config', rule: 'placeholder_in_key' })
      }
    })

    it('refuses a key that holds a placeholder at any depth, also in the workflow outside the nodes', () => {
      const deep = make({ workflow: workflowWith({ folder: param('folder'), glob: param('note'), a: { b: { [JSON.stringify(param('folder'))]: 1 } } }) })
      expect(recipeProblems(deep)).toContainEqual({ pointer: '/workflow/nodes/0/config/a/b', rule: 'placeholder_in_key' })
      const top = make({ workflow: { ...(workflowWith({ folder: param('folder'), glob: param('note') }) as object), [JSON.stringify(param('note'))]: 1 } })
      expect(recipeProblems(top)).toContainEqual({ pointer: '/workflow', rule: 'placeholder_in_key' })
    })

    it('refuses a text that spells a placeholder, so there is no interpolation', () => {
      const texts = ['{"$param":"note"}', 'folder is $param', '/Users/$param/x', '$param']
      for (const text of texts) {
        const wrong = make({ workflow: workflowWith({ folder: param('folder'), glob: param('note'), other: text }) })
        expect(recipeProblems(wrong), text).toContainEqual({ pointer: '/workflow/nodes/0/config/other', rule: 'placeholder_in_text' })
      }
    })

    it('refuses a placeholder object that is not exactly one string id', () => {
      const shapes: unknown[] = [{ $param: 'note', other: 1 }, { $param: 5 }, { $param: null }, { $param: ['note'] }, { $param: { id: 'note' } }, { $param: '' }]
      for (const shape of shapes) {
        const wrong = make({ workflow: workflowWith({ folder: param('folder'), glob: param('note'), other: shape }) })
        expect(rules(wrong), JSON.stringify(shape)).toContain('bad_placeholder')
      }
    })

    it('allows a placeholder only in the config of a node, never in an id, a type, a name, a whole config, an edge, a retry or onError', () => {
      const base = workflowWith({ folder: param('folder'), glob: param('note') }) as { nodes: Array<Record<string, unknown>>; edges: unknown[] } & Record<string, unknown>
      const variants: Array<[string, unknown, string]> = [
        ['name', { ...base, name: param('note') }, '/workflow/name'],
        ['schemaVersion', { ...base, schemaVersion: param('note') }, '/workflow/schemaVersion'],
        ['node id', { ...base, nodes: [{ ...base.nodes[0], id: param('note') }] }, '/workflow/nodes/0/id'],
        ['whole config', { ...base, nodes: [{ ...base.nodes[0], config: param('note') }] }, '/workflow/nodes/0/config'],
        ['node type', { ...base, nodes: [{ ...base.nodes[0], type: param('note') }] }, '/workflow/nodes/0/type'],
        ['retry', { ...base, nodes: [{ ...base.nodes[0], retry: { maxAttempts: param('note') } }] }, '/workflow/nodes/0/retry/maxAttempts'],
        ['onError', { ...base, nodes: [{ ...base.nodes[0], onError: param('note') }] }, '/workflow/nodes/0/onError'],
        ['edge', { ...base, edges: [{ from: 't1', to: param('note') }] }, '/workflow/edges/0/to'],
        ['edge when', { ...base, edges: [{ from: 't1', to: 't2', when: param('note') }] }, '/workflow/edges/0/when'],
      ]
      for (const [name, workflow, pointer] of variants) {
        expect(recipeProblems(make({ workflow })), name).toContainEqual({ pointer, rule: 'placeholder_outside_config' })
      }
    })

    it('treats a placeholder as the value it stands for, for the types of numbers and text alike', () => {
      const recipe = make({
        params: [folder, { id: 'limit', kind: 'number', label, required: true, min: 0, max: 9 }],
        workflow: workflowWith({ folder: param('folder'), limit: param('limit') }),
        sample: { folder: '/Users/demo/in', limit: 3 },
      })
      expect(recipeProblems(recipe)).toEqual([])
    })
  })
})

describe('recipeNodeTypes', () => {
  it('lists the node types of the workflow in order, once each', () => {
    const recipe = make({
      workflow: {
        schemaVersion: 1,
        name: 'demo',
        nodes: [
          { id: 't1', type: 'trigger.folderWatch@1', config: { folder: param('folder'), glob: param('note') } },
          { id: 'n1', type: 'notify.slack@1', config: {} },
          { id: 'n2', type: 'notify.slack@1', config: {} },
          { id: 'n3', type: 'condition@1', config: {} },
        ],
        edges: [],
      },
    })
    expect(recipeNodeTypes(recipe)).toEqual(['trigger.folderWatch@1', 'notify.slack@1', 'condition@1'])
  })
})
