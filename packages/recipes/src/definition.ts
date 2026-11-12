import { joinPointer } from '@rill/dsl'
import Value from 'typebox/value'
import { checkValue } from './params'
import { PLACEHOLDER_KEY, isPlaceholderObject } from './placeholder'
import { RecipeSchema, type Recipe, type RecipeParam } from './types'

export const RECIPE_RULES = [
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
] as const

export type RecipeRule = (typeof RECIPE_RULES)[number]

export interface RecipeDefect {
  pointer: string
  rule: RecipeRule
}

const MAX_SHAPE_DEFECTS = 20
const MAX_DEPTH = 32
const IN_NODE_CONFIG = /^\/workflow\/nodes\/\d+\/config\/./

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasNodes(workflow: unknown): boolean {
  if (!isObject(workflow) || !Array.isArray(workflow.nodes) || workflow.nodes.length === 0) return false
  return workflow.nodes.every((node) => isObject(node) && typeof node.id === 'string' && typeof node.type === 'string')
}

function boundsAreValid(param: RecipeParam): boolean {
  const { min, max } = param
  return min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && min <= max
}

export function recipeProblems(input: unknown): RecipeDefect[] {
  if (!Value.Check(RecipeSchema, input)) {
    return [...Value.Errors(RecipeSchema, input)].slice(0, MAX_SHAPE_DEFECTS).map((error) => ({
      pointer: error.instancePath === '' ? '/' : error.instancePath,
      rule: 'bad_shape' as const,
    }))
  }
  const recipe: Recipe = input
  const defects: RecipeDefect[] = []
  const add = (pointer: string, rule: RecipeRule) => defects.push({ pointer, rule })

  const declared = new Set<string>()
  recipe.params.forEach((param, index) => {
    const at = joinPointer('/params', index)
    if (declared.has(param.id)) add(joinPointer(at, 'id'), 'duplicate_param')
    declared.add(param.id)
    if (param.kind === 'number') {
      if (!boundsAreValid(param)) add(at, 'bad_bounds')
    } else if (param.min !== undefined || param.max !== undefined) {
      add(at, 'bounds_not_allowed')
    }
    if (param.required && param.default !== undefined) add(joinPointer(at, 'default'), 'default_on_required')
    if (!param.required && param.default === undefined) add(at, 'default_missing')
    if (param.default !== undefined && checkValue(param, param.default) !== undefined) add(joinPointer(at, 'default'), 'bad_default')
  })

  for (const param of recipe.params) {
    const at = joinPointer('/sample', param.id)
    if (!Object.hasOwn(recipe.sample, param.id)) add(at, 'sample_missing')
    else if (checkValue(param, recipe.sample[param.id]) !== undefined) add(at, 'bad_sample')
  }
  for (const key of Object.keys(recipe.sample)) {
    if (!declared.has(key)) add(joinPointer('/sample', key), 'sample_unknown')
  }

  if (!hasNodes(recipe.workflow)) add('/workflow', 'bad_workflow')
  const used = new Set<string>()
  const placeholder = (value: Record<string, unknown>, pointer: string): void => {
    const id = value[PLACEHOLDER_KEY]
    if (Object.keys(value).length !== 1 || typeof id !== 'string' || id === '') {
      add(pointer, 'bad_placeholder')
      return
    }
    if (!IN_NODE_CONFIG.test(pointer)) add(pointer, 'placeholder_outside_config')
    if (declared.has(id)) used.add(id)
    else add(pointer, 'undeclared_param')
  }
  const walk = (value: unknown, pointer: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      add(pointer, 'bad_workflow')
      return
    }
    if (typeof value === 'string') {
      if (value.includes(PLACEHOLDER_KEY)) add(pointer, 'placeholder_in_text')
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, joinPointer(pointer, index), depth + 1))
    } else if (isPlaceholderObject(value)) {
      placeholder(value, pointer)
    } else if (isObject(value)) {
      for (const [key, inner] of Object.entries(value)) {
        if (key.includes(PLACEHOLDER_KEY)) add(pointer, 'placeholder_in_key')
        walk(inner, joinPointer(pointer, key), depth + 1)
      }
    }
  }
  walk(recipe.workflow, '/workflow', 0)
  recipe.params.forEach((param, index) => {
    if (!used.has(param.id)) add(joinPointer('/params', index), 'unused_param')
  })
  return defects
}
