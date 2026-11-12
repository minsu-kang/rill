import type { PlanIssue } from '@rill/dsl'
import { createCoreRegistry } from '@rill/nodes-core'
import { findRecipe } from '@rill/recipes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { draftFromRecipe, RecipeInvalidError } from '../src/recipes'

const issues: PlanIssue[] = []

vi.mock('@rill/nodes-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rill/nodes-core')>()
  return { ...actual, validateWorkflow: () => issues }
})

const warning: PlanIssue = { stage: 3, pointer: '/nodes/0', code: 'nullable_into_required', message: 'a warning' }
const other: PlanIssue = { stage: 3, pointer: '/nodes/1', code: 'branch_unused', message: 'another warning' }
const error: PlanIssue = { stage: 3, pointer: '/nodes/1/config/connection', code: 'unknown_connection', message: 'an error' }

const recipe = findRecipe('webhook-to-slack')!
const context = { registry: createCoreRegistry(), allowedRoots: ['/Users/demo'], connections: [{ name: 'slack-ops', kind: 'slack' as const }] }
const draft = () => draftFromRecipe(recipe.id, recipe.sample, context)

beforeEach(() => {
  issues.length = 0
})

describe('a warning of the validator', () => {
  it('does not refuse a draft, as it does not refuse a deploy', () => {
    issues.push(warning, other)
    expect(draft().recipeId).toBe('webhook-to-slack')
  })

  it('is not listed in the refusal that an error causes', () => {
    issues.push(warning, error, other)
    try {
      draft()
      expect.unreachable()
    } catch (caught) {
      expect(caught).toBeInstanceOf(RecipeInvalidError)
      expect((caught as RecipeInvalidError).problems).toEqual(['unknown_connection at /nodes/1/config/connection'])
    }
  })

  it('does not stop a draft when there is none', () => {
    expect(draft().workflow.nodes).toHaveLength(2)
  })

  it('is refused with a single error, however many warnings come with it', () => {
    issues.push(error)
    expect(() => draft()).toThrow(RecipeInvalidError)
  })
})
