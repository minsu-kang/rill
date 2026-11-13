// @vitest-environment node
import { METHODS, RillError } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { FAKE_DEPLOYED_ID, withRecipeMethods } from '../src/engine/fake-recipes'
import { fakeData } from '../src/fixtures'
import { fixtureRecipeData, hostileRecipes, recipeDrafts, recipeInfos, recipeProblemSets } from '../src/fixtures/recipes'

const base = createFakeClient(fakeData)
const RECEIPT = 'receipt-folder-to-csv'

function client(instantiate = fixtureRecipeData().instantiate) {
  return withRecipeMethods(base, { recipes: recipeInfos, instantiate })
}

describe('recipe fixtures', () => {
  it('hold the eight real recipes and a draft for each', () => {
    expect(recipeInfos).toHaveLength(8)
    expect(Object.keys(recipeDrafts).sort()).toEqual(recipeInfos.map((info) => info.id).sort())
    for (const draft of Object.values(recipeDrafts)) expect(Value.Check(METHODS.instantiateRecipe.result, draft)).toBe(true)
  })

  it('include a draft that sends to the model and one that does not', () => {
    expect(recipeDrafts[RECEIPT]!.summary.sendsToModel).toBe(true)
    expect(recipeDrafts['webhook-to-slack']!.summary.sendsToModel).toBe(false)
  })

  it('have a problems set for each rule family and for issues', () => {
    const text = Object.values(recipeProblemSets).flat().join('\n')
    for (const needle of ['required', 'not_absolute_path', 'wrong_extension', 'below_min', 'bad_cron', 'bad_url', 'path_outside_roots', 'unknown_connection', 'connection_kind_mismatch', 'inside_watched_folder', 'config_', 'cron_expression']) {
      expect(text, needle).toContain(needle)
    }
    for (const problems of Object.values(recipeProblemSets)) expect(problems.length).toBeLessThanOrEqual(20)
  })

  it('include recipes with hostile text', () => {
    expect(hostileRecipes.some((info) => info.title.ko.includes('<img'))).toBe(true)
    expect(Value.Check(METHODS.listRecipes.result, { recipes: hostileRecipes })).toBe(true)
  })
})

describe('withRecipeMethods', () => {
  it('answers listRecipes with a copy that passes the protocol schema', async () => {
    const { recipes } = await client().request('listRecipes', {})
    expect(Value.Check(METHODS.listRecipes.result, { recipes })).toBe(true)
    expect(recipes).toEqual(recipeInfos)
    recipes[0]!.title.ko = 'changed'
    expect(recipeInfos[0]!.title.ko).not.toBe('changed')
  })

  it('answers instantiateRecipe with a draft that passes the protocol schema', async () => {
    const draft = await client().request('instantiateRecipe', { recipeId: RECEIPT, values: { watchFolder: '/Users/demo/Receipts', csvFile: '/Users/demo/ledger.csv' } })
    expect(Value.Check(METHODS.instantiateRecipe.result, draft)).toBe(true)
    expect(draft.recipeId).toBe(RECEIPT)
  })

  it('answers NOT_FOUND for a recipe it does not have, without calling the script', async () => {
    const script = vi.fn(fixtureRecipeData().instantiate)
    await expect(client(script).request('instantiateRecipe', { recipeId: 'no-such-recipe', values: {} })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(script).not.toHaveBeenCalled()
  })

  it('rejects more than 20 values and strings over 500 characters like the real schema', async () => {
    const script = vi.fn(fixtureRecipeData().instantiate)
    const fake = client(script)
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, 'x']))
    await expect(fake.request('instantiateRecipe', { recipeId: RECEIPT, values: many })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(fake.request('instantiateRecipe', { recipeId: RECEIPT, values: { a: 'x'.repeat(501) } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(fake.request('instantiateRecipe', { recipeId: RECEIPT, values: { a: true } as never })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(fake.request('instantiateRecipe', { recipeId: RECEIPT, values: {}, extra: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(script).not.toHaveBeenCalled()
    await expect(fake.request('instantiateRecipe', { recipeId: RECEIPT, values: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`p${index}`, 'x'.repeat(500)])) })).resolves.toBeTruthy()
  })

  it('throws RECIPE_INVALID with the problems list the script returns', async () => {
    const fake = client(() => new RillError('RECIPE_INVALID', 'the recipe values are not valid', ['watchFolder: required']))
    const error = await fake.request('instantiateRecipe', { recipeId: RECEIPT, values: {} }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RillError)
    expect(error).toMatchObject({ code: 'RECIPE_INVALID', problems: ['watchFolder: required'] })
  })

  it('refuses a draft that does not match the protocol', async () => {
    const fake = client(() => ({ ...recipeDrafts[RECEIPT]!, recipeId: '' }))
    await expect(fake.request('instantiateRecipe', { recipeId: RECEIPT, values: {} })).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('deploys the workflow of a draft it handed out with a fixed id and refuses any other', async () => {
    const fake = client()
    const draft = await fake.request('instantiateRecipe', { recipeId: RECEIPT, values: {} })
    const answer = await fake.request('deploy', { workflow: draft.workflow })
    expect(answer).toEqual({ workflowId: FAKE_DEPLOYED_ID })
    expect(Value.Check(METHODS.deploy.result, answer)).toBe(true)
    await expect(fake.request('deploy', { workflow: { schemaVersion: 1, name: 'other', nodes: [], edges: [] } })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW' })
    await expect(fake.request('deploy', {} as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('passes every other method and the events on', async () => {
    const fake = client()
    expect((await fake.request('listWorkflows', {})).workflows.length).toBeGreaterThan(0)
    const seen: string[] = []
    const off = fake.onEvent((event) => seen.push(event.type))
    base.emit({ type: 'trigger.fired', runId: 'r', workflowId: 'w', at: 1 } as never)
    off()
    expect(seen).toEqual(['trigger.fired'])
  })
})
