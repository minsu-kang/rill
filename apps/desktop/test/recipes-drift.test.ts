// @vitest-environment node
import { ISSUE_CODES } from '@rill/dsl'
import { METHODS, RECIPE_CONNECTION_KINDS, RECIPE_PARAM_KINDS } from '@rill/protocol'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { CONNECTION_KIND_CODE } from '../../../packages/planner/src/connections'
import { GENERAL_RULES, PARAM_RULES, RECIPES } from '../../../packages/recipes/src/index'
import { buildRecipeFixture } from '../scripts/build-recipe-fixture'
import { ISSUE_CODE_KEYS, issueKey, PARAM_RULE_IDS } from '../src/recipes/model/problems'

const FIXTURE = join(import.meta.dirname, '../src/fixtures/recipe-infos.json')

describe('recipe rule table', () => {
  it('lists exactly the rule ids of @rill/recipes', () => {
    const real = new Set<string>([...GENERAL_RULES, ...Object.values(PARAM_RULES).flat()])
    expect(new Set(PARAM_RULE_IDS)).toEqual(real)
    expect(PARAM_RULE_IDS).toHaveLength(real.size)
  })

  it('has a message for every issue code the engine can return from instantiateRecipe', () => {
    expect(CONNECTION_KIND_CODE).toBe('connection_kind_mismatch')
    for (const code of [...ISSUE_CODES, CONNECTION_KIND_CODE]) {
      expect(Object.keys(ISSUE_CODE_KEYS), code).toContain(code)
      expect(ISSUE_CODE_KEYS[code], code).not.toBe('recipes.issue.unknown')
      expect(issueKey(code), code).not.toBe('recipes.issue.unknown')
    }
  })

  it('would fall back to the unknown message for a code no family covers', () => {
    expect(issueKey('a_code_nobody_mapped')).toBe('recipes.issue.unknown')
  })
})

describe('recipe fixture', () => {
  const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown
  const real = JSON.parse(JSON.stringify(buildRecipeFixture())) as unknown

  it('is the recipe list and the drafts of the real engine, exactly as the methods answer them', () => {
    expect(committed).toEqual(real)
  })

  it('has the same recipe order as the package', () => {
    const order = (fixture: unknown) => (fixture as { recipes: Array<{ id: string }> }).recipes.map((recipe) => recipe.id)
    expect(order(committed)).toEqual(RECIPES.map((recipe) => recipe.id))
  })

  it('passes the protocol result schemas', () => {
    const fixture = committed as { recipes: unknown[]; drafts: Record<string, { draft: unknown }> }
    expect(Value.Check(METHODS.listRecipes.result, { recipes: fixture.recipes })).toBe(true)
    for (const [id, entry] of Object.entries(fixture.drafts)) expect(Value.Check(METHODS.instantiateRecipe.result, entry.draft), id).toBe(true)
  })

  it('only uses param kinds and connection kinds the form knows', () => {
    const fixture = committed as { recipes: Array<{ params: Array<{ kind: string; connectionKind?: string }> }> }
    for (const recipe of fixture.recipes) {
      for (const param of recipe.params) {
        expect(RECIPE_PARAM_KINDS as readonly string[]).toContain(param.kind)
        if (param.connectionKind !== undefined) expect(RECIPE_CONNECTION_KINDS as readonly string[]).toContain(param.connectionKind)
      }
    }
  })

  it('has a draft for every recipe, one that sends to the model and one that does not', () => {
    const fixture = committed as { drafts: Record<string, { draft: { summary: { sendsToModel: boolean }; workflow: unknown } }> }
    expect(Object.keys(fixture.drafts).sort()).toEqual(RECIPES.map((recipe) => recipe.id).sort())
    expect(Object.values(fixture.drafts).some((entry) => entry.draft.summary.sendsToModel)).toBe(true)
    expect(Object.values(fixture.drafts).some((entry) => !entry.draft.summary.sendsToModel)).toBe(true)
  })
})
