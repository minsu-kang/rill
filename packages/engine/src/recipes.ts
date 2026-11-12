import { isWarningIssue, type PlanIssue, type Workflow } from '@rill/dsl'
import { validateWorkflow, type NodeRegistry } from '@rill/nodes-core'
import { connectionKindIssues, type PlanConnection } from '@rill/planner'
import type { RecipeDraft, RecipeInfo, RecipeSummary } from '@rill/protocol'
import { RECIPES, findRecipe, instantiateRecipe, recipeNodeTypes, type ParamValues, type Recipe } from '@rill/recipes'

export const RECIPE_INVALID_MESSAGE = 'the recipe values are not valid'
const MAX_PROBLEMS = 20

export class RecipeNotFoundError extends Error {
  constructor() {
    super('recipe not found')
    this.name = 'RecipeNotFoundError'
  }
}

export class RecipeInvalidError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(RECIPE_INVALID_MESSAGE)
    this.name = 'RecipeInvalidError'
    this.problems = problems.slice(0, MAX_PROBLEMS)
  }
}

export interface RecipeContext {
  registry: NodeRegistry
  allowedRoots: string[] | undefined
  connections: readonly PlanConnection[]
}

const MODEL_NODES: ReadonlySet<string> = new Set(['llm.extract'])

function baseType(type: string): string {
  return type.replace(/@\d+$/, '')
}

function issueProblems(issues: readonly PlanIssue[]): string[] {
  return issues.map((issue) => `${issue.code} at ${issue.pointer === '' ? '/' : issue.pointer}`)
}

function recipeInfo(recipe: Recipe): RecipeInfo {
  return structuredClone({
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    tags: recipe.tags,
    params: recipe.params,
    nodeTypes: recipeNodeTypes(recipe),
    needsConnection: recipe.params.some((param) => param.kind === 'connection'),
  })
}

export function listRecipeInfos(): RecipeInfo[] {
  return RECIPES.map(recipeInfo)
}

function summaryOf(workflow: Workflow, registry: NodeRegistry): RecipeSummary {
  const defs = workflow.nodes.map((node) => registry.get(node.type))
  const effects = new Set(defs.flatMap((def) => (def?.kind === 'action' ? [def.sideEffect] : [])))
  return {
    nodes: workflow.nodes.map((node, index) => ({ id: node.id, type: node.type, title: defs[index]?.title ?? node.type })),
    sideEffects: (['idempotent', 'external'] as const).filter((effect) => effects.has(effect)),
    sendsToModel: workflow.nodes.some((node) => MODEL_NODES.has(baseType(node.type))),
  }
}

export function draftFromRecipe(recipeId: string, values: ParamValues, context: RecipeContext): RecipeDraft {
  const recipe = findRecipe(recipeId)
  if (recipe === undefined) throw new RecipeNotFoundError()
  const result = instantiateRecipe(recipe, values)
  if ('problems' in result) throw new RecipeInvalidError(result.problems.map((problem) => `${problem.param}: ${problem.rule}`))
  const issues = [
    ...validateWorkflow(result.workflow, {
      registry: context.registry,
      allowedRoots: context.allowedRoots,
      connections: context.connections.map((connection) => connection.name),
    }),
    ...connectionKindIssues(result.workflow, context.registry, context.connections),
  ]
  const errors = issues.filter((issue) => !isWarningIssue(issue))
  if (errors.length > 0) throw new RecipeInvalidError(issueProblems(errors))
  return { recipeId: recipe.id, workflow: result.workflow, summary: summaryOf(result.workflow, context.registry) }
}
