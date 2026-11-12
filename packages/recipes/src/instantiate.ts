import type { Workflow } from '@rill/dsl'
import { recipeProblems, type RecipeDefect } from './definition'
import { checkParams, valuesWithDefaults, type ParamProblem } from './params'
import { PLACEHOLDER_KEY, isPlaceholderObject } from './placeholder'
import type { ParamValues, Recipe } from './types'

export class RecipeDefinitionError extends Error {
  constructor(defects: readonly RecipeDefect[]) {
    super(`the recipe is written wrongly: ${defects.map((defect) => `${defect.rule} at ${defect.pointer}`).join('; ')}`)
    this.name = 'RecipeDefinitionError'
  }
}

function fill(node: unknown, values: ReadonlyMap<string, string | number>): unknown {
  if (isPlaceholderObject(node)) return values.get(String(node[PLACEHOLDER_KEY]))
  if (Array.isArray(node)) return node.map((item) => fill(item, values))
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, fill(inner, values)]))
  }
  return node
}

export function instantiateRecipe(recipe: Recipe, values: ParamValues): { workflow: Workflow } | { problems: ParamProblem[] } {
  const defects = recipeProblems(recipe)
  if (defects.length > 0) throw new RecipeDefinitionError(defects)
  const problems = checkParams(recipe, values)
  if (problems.length > 0) return { problems }
  return { workflow: fill(recipe.workflow, valuesWithDefaults(recipe, values)) as Workflow }
}
