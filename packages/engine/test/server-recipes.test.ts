import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import {
  RECIPE_CONNECTION_KINDS,
  RECIPE_MAX_STRING_CHARS,
  RECIPE_MAX_VALUES,
  RECIPE_PARAM_KINDS,
  RecipeParamInfoSchema,
  type MethodParams,
} from '@rill/protocol'
import { CONNECTION_KINDS, MAX_PARAM_STRING_CHARS, MAX_PARAM_VALUES, PARAM_KINDS, RECIPES, checkValue, findRecipe, instantiateRecipe, recipeNodeTypes, type ParamValues, type Recipe } from '@rill/recipes'
import Value from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { MemoryInvalidError, normaliseMemoryText } from '../src/memory'
import { RecipeInvalidError, RecipeNotFoundError } from '../src/recipes'
import { failure, snapshot, startRecipeEnv, useCleanups } from './recipe-helpers'

useCleanups()

const MARKER = 'VALUE-MARKER-5d0e'
const registry = createCoreRegistry()

const EFFECTS: Record<string, string[]> = {
  'receipt-folder-to-csv': ['idempotent'],
  'receipt-big-amount-alert': ['idempotent', 'external'],
  'daily-health-check': ['external'],
  'webhook-to-slack': ['external'],
  'monthly-reminder': ['external'],
  'failure-webhook-alert': ['external'],
}

const SENDS_TO_MODEL: Record<string, boolean> = {
  'receipt-folder-to-csv': true,
  'receipt-big-amount-alert': true,
  'daily-health-check': false,
  'webhook-to-slack': false,
  'monthly-reminder': false,
  'failure-webhook-alert': false,
}

const instantiateParams = (recipeId: string, values: Record<string, string | number>): MethodParams<'instantiateRecipe'> => ({ recipeId, values })

function workflowOf(recipe: Recipe, values: ParamValues) {
  const result = instantiateRecipe(recipe, values)
  if (!('workflow' in result)) throw new Error(JSON.stringify(result.problems))
  return result.workflow
}

function requiredOnly(id: string): Record<string, string | number> {
  const recipe = findRecipe(id)!
  return Object.fromEntries(recipe.params.filter((param) => param.required).map((param) => [param.id, recipe.sample[param.id]!]))
}

describe('the mirror of the recipe package in the protocol', () => {
  it('has the same parameter kinds and limits', () => {
    expect([...RECIPE_PARAM_KINDS]).toEqual([...PARAM_KINDS])
    expect(RECIPE_MAX_VALUES).toBe(MAX_PARAM_VALUES)
    expect(RECIPE_MAX_STRING_CHARS).toBe(MAX_PARAM_STRING_CHARS)
    expect([...RECIPE_CONNECTION_KINDS]).toEqual([...CONNECTION_KINDS])
  })

  it('describes every parameter of every recipe', () => {
    for (const recipe of RECIPES) for (const param of recipe.params) expect(Value.Check(RecipeParamInfoSchema, param), `${recipe.id} ${param.id}`).toBe(true)
  })
})

describe('the character rules of a text value', () => {
  const text = { id: 'value', kind: 'text', label: { ko: '라벨', en: 'Label' }, required: true } as const
  const characters = [
    '\u0000', '\n', '\r', '\t', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029',
    '\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069',
    '\u200b', '\u00ad', '\u2060', '\ufeff', '\u{e0041}', '\u{e007f}', '\u{e0100}', '\u{e01ef}',
    '\u200c', '\u200d', 'é', '😀', '—', ' ', '\u00a0', '\u3000', '東',
  ]

  it('are the ones of a memory note: the same characters are refused under the same rule name', () => {
    for (const character of characters) {
      const sample = `a${character}b`
      let memory: string | undefined
      try {
        normaliseMemoryText(sample)
      } catch (error) {
        if (!(error instanceof MemoryInvalidError)) throw error
        memory = error.rule
      }
      expect(checkValue(text, sample), JSON.stringify(character)).toBe(memory)
    }
  })
})

describe('listRecipes', () => {
  it('lists the six recipes with the fields of a form and no workflow body', async () => {
    const { client, frames } = await startRecipeEnv()
    const result = await client.request('listRecipes', {})
    expect(result.recipes.map((entry) => entry.id)).toEqual(RECIPES.map((recipe) => recipe.id))
    expect(result.recipes).toHaveLength(6)
    for (const entry of result.recipes) {
      const recipe = findRecipe(entry.id)!
      expect(Object.keys(entry).sort()).toEqual(['description', 'id', 'needsConnection', 'nodeTypes', 'params', 'tags', 'title'])
      expect(entry.title).toEqual(recipe.title)
      expect(entry.description).toEqual(recipe.description)
      expect(entry.tags).toEqual(recipe.tags)
      expect(entry.params).toEqual(recipe.params)
      expect(entry.nodeTypes).toEqual(recipeNodeTypes(recipe))
      expect(entry.needsConnection).toBe(recipe.params.some((param) => param.kind === 'connection'))
    }
    const frame = frames.find((text) => text.includes('"recipes"'))!
    for (const word of ['"workflow"', '"sample"', '"nodes"', '"edges"', '"config"', '"schemaVersion"']) expect(frame, word).not.toContain(word)
  })

  it('says which recipes need a Slack connection', async () => {
    const { client } = await startRecipeEnv()
    const need = Object.fromEntries((await client.request('listRecipes', {})).recipes.map((entry) => [entry.id, entry.needsConnection]))
    expect(need).toEqual({
      'receipt-folder-to-csv': false,
      'receipt-big-amount-alert': true,
      'daily-health-check': true,
      'webhook-to-slack': true,
      'monthly-reminder': true,
      'failure-webhook-alert': true,
    })
  })

  it('works with no model provider, no attachments folder and no connection, and writes nothing', async () => {
    const { client, db } = await startRecipeEnv({ planConnections: [], connections: undefined, allowedRoots: undefined })
    const before = snapshot(db)
    expect((await client.request('listRecipes', {})).recipes).toHaveLength(6)
    expect(snapshot(db)).toEqual(before)
  })

  it('takes no params', async () => {
    const { client } = await startRecipeEnv()
    expect((await failure(client.request('listRecipes', { tag: 'csv' } as never))).code).toBe('INVALID_PARAMS')
  })

  it('hands out copies, so a caller cannot change the catalogue', async () => {
    const { engine } = await startRecipeEnv()
    const first = engine.listRecipes()
    first[0]!.params[0]!.label.ko = 'changed'
    first[0]!.params.pop()
    first[0]!.tags.push('x')
    first[0]!.nodeTypes.length = 0
    first.pop()
    const again = engine.listRecipes()
    expect(again).toHaveLength(6)
    expect(again[0]!.params).toEqual(RECIPES[0]!.params)
    expect(again[0]!.tags).toEqual(RECIPES[0]!.tags)
    expect(again[0]!.nodeTypes).toEqual(recipeNodeTypes(RECIPES[0]!))
  })
})

describe('instantiateRecipe', () => {
  it.each(RECIPES)('turns the sample of $id into a draft that deploys', async (recipe) => {
    const { client } = await startRecipeEnv()
    const draft = await client.request('instantiateRecipe', instantiateParams(recipe.id, recipe.sample))
    expect(draft.recipeId).toBe(recipe.id)
    expect(draft.workflow).toEqual(workflowOf(recipe, recipe.sample))
    expect(draft.summary.nodes).toEqual(draft.workflow.nodes.map((node) => ({ id: node.id, type: node.type, title: registry.get(node.type)!.title })))
    expect(draft.summary.sideEffects).toEqual(EFFECTS[recipe.id])
    expect(draft.summary.sendsToModel).toBe(SENDS_TO_MODEL[recipe.id])
    const { workflowId } = await client.request('deploy', { workflow: draft.workflow })
    expect((await client.request('getWorkflow', { workflowId })).workflow).toEqual(draft.workflow)
  })

  it.each(RECIPES)('fills the defaults of $id when only the required values come', async (recipe) => {
    const { client } = await startRecipeEnv()
    const draft = await client.request('instantiateRecipe', instantiateParams(recipe.id, requiredOnly(recipe.id)))
    expect(draft.workflow).toEqual(workflowOf(recipe, requiredOnly(recipe.id)))
    await client.request('deploy', { workflow: draft.workflow })
  })

  it('names the title of each node from its definition and derives the side effects from the definitions', async () => {
    const { client } = await startRecipeEnv()
    const draft = await client.request('instantiateRecipe', instantiateParams('receipt-big-amount-alert', findRecipe('receipt-big-amount-alert')!.sample))
    expect(draft.summary.nodes).toEqual([
      { id: 't1', type: 'trigger.folderWatch@1', title: 'Folder watch' },
      { id: 'n1', type: 'llm.extract@1', title: 'Extract fields with AI' },
      { id: 'n2', type: 'csv.append@1', title: 'Append CSV row' },
      { id: 'n3', type: 'condition@1', title: 'Condition' },
      { id: 'n4', type: 'notify.slack@1', title: 'Slack message' },
    ])
    expect(draft.summary.sideEffects).toEqual(['idempotent', 'external'])
  })

  it('says that the receipts go to the model provider, apart from the side effects, and only for the recipes that read a receipt', async () => {
    const { client } = await startRecipeEnv()
    const told: Record<string, boolean> = {}
    for (const recipe of RECIPES) told[recipe.id] = (await client.request('instantiateRecipe', instantiateParams(recipe.id, recipe.sample))).summary.sendsToModel
    expect(told).toEqual(SENDS_TO_MODEL)
    const ledger = await client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', findRecipe('receipt-folder-to-csv')!.sample))
    expect(ledger.summary.sideEffects).toEqual(['idempotent'])
    expect(ledger.summary.sendsToModel).toBe(true)
  })

  it('works with no model provider, no attachments folder and no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    try {
      const { client } = await startRecipeEnv()
      await client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: 'slack-ops' }))
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('gives the same workflow for the same input, on every call, every engine and every key order', async () => {
    const recipe = findRecipe('receipt-big-amount-alert')!
    const reversed = Object.fromEntries(Object.entries(recipe.sample).reverse())
    const a = await startRecipeEnv()
    const b = await startRecipeEnv()
    const results = [
      await a.client.request('instantiateRecipe', instantiateParams(recipe.id, recipe.sample)),
      await a.client.request('instantiateRecipe', instantiateParams(recipe.id, recipe.sample)),
      await a.client.request('instantiateRecipe', instantiateParams(recipe.id, reversed)),
      await b.client.request('instantiateRecipe', instantiateParams(recipe.id, recipe.sample)),
    ]
    const texts = results.map((result) => JSON.stringify(result))
    expect(new Set(texts).size).toBe(1)
    expect(results[0]!.workflow.nodes.map((node) => node.id)).toEqual(['t1', 'n1', 'n2', 'n3', 'n4'])
  })

  it('never deploys and never writes: every table is the same before and after, for drafts and for refusals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rill-recipes-'))
    try {
      mkdirSync(join(dir, 'in'))
      const { client, db, engine } = await startRecipeEnv({ allowedRoots: [dir] })
      await client.request('saveMemory', { text: 'My receipts live in the Receipts folder' })
      const seeded = (await client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: 'slack-ops' }))).workflow
      await client.request('deploy', { workflow: seeded })
      const before = snapshot(db)
      for (const name of ['workflows', 'memory_items']) expect(JSON.parse(before[name]!), name).not.toHaveLength(0)
      expect(Object.keys(before)).toEqual(
        db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name),
      )
      const files = readdirSync(dir, { recursive: true }).map(String).sort()
      const events: unknown[] = []
      engine.on((event) => events.push(event))

      const sample = findRecipe('receipt-folder-to-csv')!.sample
      const values = { ...sample, watchFolder: join(dir, 'in'), csvFile: join(dir, 'in', 'ledger.csv') }
      await client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values))
      await client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values))
      await client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: 'slack-ops' }))
      for (const bad of [{ ...values, watchFolder: '/elsewhere' }, { ...values, glob: 'a/b' }, { ...values, stray: 1 }, {}]) {
        await failure(client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', bad)))
      }
      await failure(client.request('instantiateRecipe', instantiateParams('no-such-recipe', {})))
      await client.request('listRecipes', {})

      expect(snapshot(db)).toEqual(before)
      expect(readdirSync(dir, { recursive: true }).map(String).sort()).toEqual(files)
      expect(events).toEqual([])
      expect((await client.request('listWorkflows', {})).workflows).toHaveLength(1)
      expect((await client.request('listPlans', {})).plans).toEqual([])
      expect((await client.request('listRuns', {})).runs).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not apply the open-plan gate of deploy, since a draft is not a plan', async () => {
    const { client } = await startRecipeEnv()
    const draft = await client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: 'slack-ops' }))
    expect((await client.request('deploy', { workflow: draft.workflow })).workflowId).toBeTruthy()
  })
})

describe('instantiateRecipe refuses', () => {
  const invalid = async (recipeId: string, values: Record<string, string | number>, options: Parameters<typeof startRecipeEnv>[0] = {}) => {
    const env = await startRecipeEnv(options)
    const error = await failure(env.client.request('instantiateRecipe', instantiateParams(recipeId, values)))
    return { ...env, error }
  }

  it('a folder outside the allowed folders, with the code and the pointer and not the path', async () => {
    const { error, frames, logs } = await invalid('receipt-folder-to-csv', { ...findRecipe('receipt-folder-to-csv')!.sample, watchFolder: `/Users/other/${MARKER}/Receipts` })
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', message: 'the recipe values are not valid', problems: ['path_outside_roots at /nodes/0/config/folder'] })
    expect([...frames, ...logs].join('\n')).not.toContain(MARKER)
    expect([...frames, ...logs].join('\n')).not.toContain('/Users/other')
  })

  it('a file outside the allowed folders', async () => {
    const { error } = await invalid('receipt-folder-to-csv', { ...findRecipe('receipt-folder-to-csv')!.sample, csvFile: '/Users/other/ledger.csv' })
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', problems: ['path_outside_roots at /nodes/2/config/file'] })
  })

  it('a missing connection', async () => {
    const { error, frames } = await invalid('webhook-to-slack', { slackConnection: `${MARKER}-conn` })
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', message: 'the recipe values are not valid', problems: ['unknown_connection at /nodes/1/config/connection'] })
    expect(frames.join('\n')).not.toContain(MARKER)
  })

  it('every connection when the engine knows none', async () => {
    const { error } = await invalid('webhook-to-slack', { slackConnection: 'slack-ops' }, { planConnections: [] })
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', problems: ['unknown_connection at /nodes/1/config/connection'] })
  })

  it('a bad cron expression', async () => {
    const { error, frames } = await invalid('monthly-reminder', { slackConnection: 'slack-ops', schedule: `61 9 * * * ${MARKER}` })
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', message: 'the recipe values are not valid', problems: ['schedule: bad_cron'] })
    expect(frames.join('\n')).not.toContain(MARKER)
  })

  it('a text that tries to become a reference', async () => {
    const { error, frames } = await invalid('monthly-reminder', { slackConnection: 'slack-ops', message: `{{n1.output.${MARKER}}}` })
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', message: 'the recipe values are not valid', problems: ['message: template_text'] })
    expect(frames.join('\n')).not.toContain(MARKER)
  })

  it('a key that no parameter declares, by name only when it looks like a parameter id', async () => {
    const stray = await invalid('webhook-to-slack', { slackConnection: 'slack-ops', stray: 'x' })
    expect(stray.error).toMatchObject({ code: 'RECIPE_INVALID', problems: ['stray: unknown_param'] })
    const odd = await invalid('webhook-to-slack', { slackConnection: 'slack-ops', [`${MARKER}-key`]: 'x' })
    expect(odd.error).toMatchObject({ code: 'RECIPE_INVALID', problems: ['?: unknown_param'] })
    expect(odd.frames.join('\n')).not.toContain(MARKER)
  })

  it('a missing value, a wrong type and a number out of bounds, in the order of the form', async () => {
    const { error } = await invalid('receipt-big-amount-alert', { glob: 5, threshold: -1 })
    expect(error.problems).toEqual(['watchFolder: required', 'glob: wrong_type', 'csvFile: required', 'threshold: below_min', 'slackConnection: required'])
    const typed = await invalid('receipt-big-amount-alert', { ...findRecipe('receipt-big-amount-alert')!.sample, threshold: '100000' })
    expect(typed.error.problems).toEqual(['threshold: wrong_type'])
  })

  it('an unknown recipe, with the code NOT_FOUND and a fixed text that does not name it', async () => {
    const { error, frames } = await invalid(`${MARKER}-recipe`, {})
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'recipe not found', problems: [] })
    expect(frames.join('\n')).not.toContain(MARKER)
  })

  it('an id that differs from a real one by a space or by case, as an unknown recipe', async () => {
    for (const id of ['webhook-to-slack ', ' webhook-to-slack', 'Webhook-To-Slack', 'webhook-to-slac']) {
      const { error } = await invalid(id, { slackConnection: 'slack-ops' })
      expect(error, id).toMatchObject({ code: 'NOT_FOUND', message: 'recipe not found' })
    }
  })

  it('21 values, a string of 501 characters and extra params, as malformed params', async () => {
    const { client, frames, logs } = await startRecipeEnv()
    const many = Object.fromEntries(Array.from({ length: RECIPE_MAX_VALUES + 1 }, (_unused, index) => [`p${index}`, `${MARKER}${index}`]))
    expect((await failure(client.request('instantiateRecipe', instantiateParams('webhook-to-slack', many)))).code).toBe('INVALID_PARAMS')
    const long = `${MARKER}${'x'.repeat(RECIPE_MAX_STRING_CHARS)}`
    expect((await failure(client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: long })))).code).toBe('INVALID_PARAMS')
    const extra = { recipeId: 'webhook-to-slack', values: { slackConnection: 'slack-ops' }, deploy: true } as never
    expect((await failure(client.request('instantiateRecipe', extra))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('instantiateRecipe', { recipeId: 'webhook-to-slack' } as never))).code).toBe('INVALID_PARAMS')
    expect([...frames.slice(1), ...logs].join('\n')).not.toContain(MARKER)
  })

  it('20 unknown keys as one refusal that lists at most 20 problems', async () => {
    const keys = Object.fromEntries(Array.from({ length: RECIPE_MAX_VALUES }, (_unused, index) => [`extra${index}`, 'x']))
    const { error } = await invalid('webhook-to-slack', keys)
    expect(error.code).toBe('RECIPE_INVALID')
    expect(error.problems).toHaveLength(20)
    expect(error.problems[0]).toBe('slackConnection: required')
  })

  it('a string of exactly 500 characters as long text but not as a value that breaks a rule', async () => {
    const { client } = await startRecipeEnv()
    const draft = await client.request('instantiateRecipe', instantiateParams('monthly-reminder', { slackConnection: 'slack-ops', message: 'x'.repeat(500) }))
    expect(JSON.stringify(draft.workflow)).toContain('x'.repeat(500))
  })

  it('never puts any value into a frame or a log line, for every kind of refusal', async () => {
    const { client, frames, logs } = await startRecipeEnv()
    const bad: Array<[string, Record<string, string | number>]> = [
      ['receipt-folder-to-csv', { watchFolder: `../${MARKER}`, csvFile: `/Users/demo/${MARKER}/../x.csv`, glob: `${MARKER}/*` }],
      ['receipt-folder-to-csv', { watchFolder: `/Users/demo/${MARKER}\n`, csvFile: `${MARKER}`, glob: `${MARKER}‮` }],
      ['receipt-big-amount-alert', { watchFolder: `/Users/elsewhere/${MARKER}`, csvFile: `/Users/demo/${MARKER}.csv`, threshold: 1, slackConnection: `${MARKER}` }],
      ['daily-health-check', { url: `ftp://${MARKER}`, schedule: `${MARKER}`, slackConnection: `{{${MARKER}}}` }],
      ['daily-health-check', { url: `https://user:${MARKER}@example.test/`, slackConnection: 'slack-ops' }],
      ['failure-webhook-alert', { slackConnection: 'slack-ops', failedStatus: `${MARKER}{{x}}` }],
      ['monthly-reminder', { slackConnection: 'slack-ops', message: `${MARKER}\u0000` }],
    ]
    for (const [recipeId, values] of bad) {
      const error = await failure(client.request('instantiateRecipe', instantiateParams(recipeId, values)))
      expect(error.code, recipeId).toBe('RECIPE_INVALID')
      expect(error.message).toBe('the recipe values are not valid')
      expect(error.problems.length).toBeGreaterThan(0)
      expect(JSON.stringify([error.message, error.problems])).not.toContain(MARKER)
    }
    expect([...frames, ...logs].join('\n')).not.toContain(MARKER)
  })

  it('logs only the name of an unexpected failure, never the message', async () => {
    const { client, engine, logs, frames } = await startRecipeEnv()
    vi.spyOn(engine, 'instantiateRecipe').mockImplementation(() => {
      throw new Error(`raw failure ${MARKER}`)
    })
    const error = await failure(client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: `${MARKER}` })))
    expect(error).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(logs.map((line) => JSON.parse(line) as unknown)).toEqual([{ type: 'error', method: 'instantiateRecipe', name: 'Error' }])
    expect([...frames, ...logs].join('\n')).not.toContain(MARKER)
  })
})

describe('a ledger that the watcher would see', () => {
  const sample = findRecipe('receipt-folder-to-csv')!.sample
  const layout = (watchFolder: string, glob: string | undefined, csvFile: string) => {
    const values: Record<string, string | number> = { ...sample, watchFolder, csvFile }
    if (glob === undefined) delete values.glob
    else values.glob = glob
    return values
  }
  const refused = async (values: Record<string, string | number>, options: Parameters<typeof startRecipeEnv>[0] = {}, recipeId = 'receipt-folder-to-csv') => {
    const { client } = await startRecipeEnv(options)
    return (await failure(client.request('instantiateRecipe', instantiateParams(recipeId, values)))).problems
  }
  const accepted = async (values: Record<string, string | number>, options: Parameters<typeof startRecipeEnv>[0] = {}, recipeId = 'receipt-folder-to-csv') => {
    const { client } = await startRecipeEnv(options)
    return (await client.request('instantiateRecipe', instantiateParams(recipeId, values))).workflow.nodes[2]!.config.file
  }
  const LOOP = ['inside_watched_folder at /nodes/2/config/file']

  it.each([
    ['any file name', '/Users/demo/Receipts', '*', '/Users/demo/Receipts/ledger.csv'],
    ['every .csv file', '/Users/demo/Receipts', '*.csv', '/Users/demo/Receipts/ledger.csv'],
    ['a name in capitals, since the pattern ignores case', '/Users/demo/Receipts', '*.CSV', '/Users/demo/Receipts/ledger.csv'],
    ['one character of the name', '/Users/demo/Receipts', 'ledger.cs?', '/Users/demo/Receipts/ledger.csv'],
    ['the exact name', '/Users/demo/Receipts', 'ledger.csv', '/Users/demo/Receipts/ledger.csv'],
    ['a ledger path with a dot segment', '/Users/demo/Receipts', '*', '/Users/demo/Receipts/./ledger.csv'],
    ['a ledger path with a double slash', '/Users/demo/Receipts', '*', '/Users/demo//Receipts//ledger.csv'],
    ['a folder with a trailing slash', '/Users/demo/Receipts/', '*', '/Users/demo/Receipts/ledger.csv'],
  ])('refuses the ledger when the pattern matches %s', async (_name, folder, glob, csvFile) => {
    expect(await refused(layout(folder, glob, csvFile))).toEqual(LOOP)
  })

  it('compares the folders without regard to case, as a desktop file system does', async () => {
    expect(await refused(layout('/Users/demo/receipts', '*', '/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP)
    expect(await refused(layout('/Users/demo/Receipts', '*', '/Users/demo/RECEIPTS/ledger.csv'))).toEqual(LOOP)
  })

  it('compares a folder written with ~/ by the folder it stands for', async () => {
    const options = { allowedRoots: [homedir()] }
    expect(await refused(layout('~/Receipts', '*', join(homedir(), 'Receipts', 'ledger.csv')), options)).toEqual(LOOP)
    expect(await refused(layout(join(homedir(), 'Receipts'), '*', '~/Receipts/ledger.csv'), options)).toEqual(LOOP)
    expect(await accepted(layout('~/Receipts', '*', '~/ledger.csv'), options)).toBe('~/ledger.csv')
  })

  it('refuses it in the recipe with the Slack alert too', async () => {
    const big = findRecipe('receipt-big-amount-alert')!.sample
    expect(await refused({ ...big, glob: '*', csvFile: '/Users/demo/Receipts/ledger.csv' }, {}, 'receipt-big-amount-alert')).toEqual(['inside_watched_folder at /nodes/2/config/file'])
    expect(await accepted({ ...big, glob: '*', csvFile: '/Users/demo/ledger.csv' }, {}, 'receipt-big-amount-alert')).toBe('/Users/demo/ledger.csv')
  })

  it.each([
    ['the pattern does not match the name', '*.pdf', '/Users/demo/Receipts/ledger.csv'],
    ['the default pattern is used', undefined, '/Users/demo/Receipts/ledger.csv'],
    ['the name differs by a character', 'ledger.cs', '/Users/demo/Receipts/ledger.csv'],
    ['the ledger is in a folder inside the watched folder, which the watcher does not enter', '*', '/Users/demo/Receipts/out/ledger.csv'],
    ['the ledger is in the folder above', '*', '/Users/demo/ledger.csv'],
    ['the ledger is in a folder that only shares the start of the name', '*', '/Users/demo/Receipts2/ledger.csv'],
    ['the ledger is in a folder whose name ends the same way', '*', '/Users/demo/Old/Receipts/ledger.csv'],
    ['the ledger is a hidden file, which the watcher ignores', '*', '/Users/demo/Receipts/.ledger.csv'],
  ])('accepts the ledger when %s', async (_name, glob, csvFile) => {
    expect(await accepted(layout('/Users/demo/Receipts', glob, csvFile))).toBe(csvFile)
  })

  it('names the position and the code and never the path', async () => {
    const values = layout(`/Users/demo/${MARKER}`, '*', `/Users/demo/${MARKER}/ledger.csv`)
    const { client, frames, logs } = await startRecipeEnv()
    const error = await failure(client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values)))
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', message: 'the recipe values are not valid', problems: LOOP })
    expect([...frames, ...logs].join('\n')).not.toContain(MARKER)
  })

  it('keeps the allowed-folder refusal next to it, one problem for each cause', async () => {
    expect(await refused(layout('/Users/other/Receipts', '*', '/Users/other/Receipts/ledger.csv'))).toEqual([
      'path_outside_roots at /nodes/0/config/folder',
      'path_outside_roots at /nodes/2/config/file',
      'inside_watched_folder at /nodes/2/config/file',
    ])
  })

  it('refuses the same layout when the engine has no allowed folders', async () => {
    expect(await refused(layout('/anywhere/Receipts', '*', '/anywhere/Receipts/ledger.csv'), { allowedRoots: undefined })).toEqual(LOOP)
  })
})

describe('a connection of the wrong kind', () => {
  const connections = [
    { name: 'slack-ops', kind: 'slack' as const },
    { name: 'api', kind: 'http' as const },
    { name: 'hook', kind: 'webhookSecret' as const },
  ]
  const refused = async (recipeId: string, values: Record<string, string | number>, planConnections = connections) => {
    const { client, frames } = await startRecipeEnv({ planConnections })
    const error = await failure(client.request('instantiateRecipe', instantiateParams(recipeId, values)))
    return { error, frames }
  }

  it('is refused with the code and the position, as the planner does, and not with the name', async () => {
    for (const name of ['api', 'hook']) {
      const { error } = await refused('webhook-to-slack', { slackConnection: name })
      expect(error).toMatchObject({ code: 'RECIPE_INVALID', message: 'the recipe values are not valid', problems: ['connection_kind_mismatch at /nodes/1/config/connection'] })
    }
    const { frames } = await refused('webhook-to-slack', { slackConnection: 'api' })
    expect(frames.join('\n')).not.toContain('webhookSecret')
  })

  it('is refused in every recipe that asks for a Slack connection', async () => {
    for (const recipe of RECIPES.filter((entry) => entry.params.some((param) => param.kind === 'connection'))) {
      const { error } = await refused(recipe.id, { ...recipe.sample, slackConnection: 'api' })
      expect(error.problems, recipe.id).toHaveLength(1)
      expect(error.problems[0], recipe.id).toMatch(/^connection_kind_mismatch at \/nodes\/\d+\/config\/connection$/)
    }
  })

  it('is accepted when it has the kind that the parameter declares, for the kind of each parameter', async () => {
    const { client } = await startRecipeEnv({ planConnections: connections })
    for (const recipe of RECIPES) {
      for (const param of recipe.params.filter((entry) => entry.kind === 'connection')) {
        for (const kind of CONNECTION_KINDS) {
          const name = `conn-${kind}`
          const { client: one } = await startRecipeEnv({ planConnections: [{ name, kind }] })
          const result = one.request('instantiateRecipe', instantiateParams(recipe.id, { ...recipe.sample, [param.id]: name }))
          if (kind === param.connectionKind) expect((await result).recipeId, `${recipe.id} ${kind}`).toBe(recipe.id)
          else expect((await failure(result)).problems, `${recipe.id} ${kind}`).toEqual([expect.stringMatching(/^connection_kind_mismatch at /)])
        }
      }
    }
    expect(await client.request('listRecipes', {})).toBeTruthy()
  })

  it('leaves a name that is not configured to the unknown_connection check', async () => {
    const { error } = await refused('webhook-to-slack', { slackConnection: 'nowhere' })
    expect(error.problems).toEqual(['unknown_connection at /nodes/1/config/connection'])
  })

  it('tells a Slack connection from another one by kind and not by name', async () => {
    const { client } = await startRecipeEnv({ planConnections: [{ name: 'api', kind: 'slack' }, { name: 'slack-ops', kind: 'http' }] })
    expect((await client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: 'api' }))).recipeId).toBe('webhook-to-slack')
    expect((await failure(client.request('instantiateRecipe', instantiateParams('webhook-to-slack', { slackConnection: 'slack-ops' })))).problems).toEqual([
      'connection_kind_mismatch at /nodes/1/config/connection',
    ])
  })
})

describe('paths in the values and the allowed folders', () => {
  it('lets any absolute path through when the engine has no allowed folders, the same as deploy does', async () => {
    const { client } = await startRecipeEnv({ allowedRoots: undefined })
    const values = { ...findRecipe('receipt-folder-to-csv')!.sample, watchFolder: '/anywhere/Receipts' }
    const draft = await client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values))
    expect(draft.workflow.nodes[0]!.config.folder).toBe('/anywhere/Receipts')
  })

  it('keeps a path with ~/ as typed, and the engine checks the folder it stands for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rill-recipes-home-'))
    try {
      const values = { ...findRecipe('receipt-folder-to-csv')!.sample, watchFolder: '~/rill-recipe-test/Receipts', csvFile: '~/rill-recipe-test/ledger.csv' }
      const inside = await startRecipeEnv({ allowedRoots: [homedir()] })
      const draft = await inside.client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values))
      expect(draft.workflow.nodes[0]!.config.folder).toBe('~/rill-recipe-test/Receipts')
      expect(draft.workflow.nodes[2]!.config.file).toBe('~/rill-recipe-test/ledger.csv')
      const outside = await startRecipeEnv({ allowedRoots: [dir] })
      const error = await failure(outside.client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values)))
      expect(error.problems).toEqual(['path_outside_roots at /nodes/0/config/folder', 'path_outside_roots at /nodes/2/config/file'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a path that climbs out with .. before the engine looks at it', async () => {
    const { client } = await startRecipeEnv()
    const values = { ...findRecipe('receipt-folder-to-csv')!.sample, csvFile: '/Users/demo/../other/ledger.csv' }
    expect((await failure(client.request('instantiateRecipe', instantiateParams('receipt-folder-to-csv', values)))).problems).toEqual(['csvFile: parent_segment'])
  })
})

describe('Engine.instantiateRecipe', () => {
  const engine = () => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: ['/Users/demo'], planConnections: [{ name: 'slack-ops', kind: 'slack' }] })

  it('throws a RecipeNotFoundError for an unknown recipe and a RecipeInvalidError with problems for bad values', () => {
    const target = engine()
    expect(() => target.instantiateRecipe({ recipeId: 'nope', values: {} })).toThrow(RecipeNotFoundError)
    for (const id of ['constructor', '__proto__', 'toString']) expect(() => target.instantiateRecipe({ recipeId: id, values: {} })).toThrow(RecipeNotFoundError)
    try {
      target.instantiateRecipe({ recipeId: 'webhook-to-slack', values: {} })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RecipeInvalidError)
      expect((error as RecipeInvalidError).problems).toEqual(['slackConnection: required'])
      expect((error as RecipeInvalidError).message).toBe('the recipe values are not valid')
    }
  })

  it('returns a draft that Engine.deploy accepts', () => {
    const target = engine()
    const recipe = findRecipe('daily-health-check')!
    const draft = target.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample })
    expect(target.deploy(draft.workflow)).toBeTruthy()
  })

  it('does not hand out a structure that shares anything with the next draft', () => {
    const target = engine()
    const recipe = findRecipe('daily-health-check')!
    const first = target.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample })
    first.workflow.nodes[0]!.config.expression = 'changed'
    first.summary.nodes.length = 0
    const second = target.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample })
    expect(second.workflow.nodes[0]!.config.expression).toBe(recipe.sample.schedule)
    expect(second.summary.nodes).toHaveLength(4)
  })
})
