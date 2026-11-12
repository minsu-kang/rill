import { METHODS, RillError, type MethodName, type MethodParams, type MethodResult, type RecipeDraft, type RecipeInfo } from '@rill/protocol'
import Value from 'typebox/value'
import type { EngineClient } from './client'

export const FAKE_DEPLOYED_ID = 'wf-recipe-deployed'

export interface FakeRecipeData {
  recipes: RecipeInfo[]
  instantiate: (params: MethodParams<'instantiateRecipe'>) => RecipeDraft | RillError
}

export function withRecipeMethods(client: EngineClient, data: FakeRecipeData): EngineClient {
  const handedOut = new Set<string>()

  function instantiate(params: MethodParams<'instantiateRecipe'>): RecipeDraft {
    if (!Value.Check(METHODS.instantiateRecipe.params, params)) throw new RillError('INVALID_PARAMS', 'invalid instantiateRecipe params')
    if (!data.recipes.some((recipe) => recipe.id === params.recipeId)) throw new RillError('NOT_FOUND', 'recipe not found')
    const answer = data.instantiate(params)
    if (answer instanceof RillError) throw answer
    if (!Value.Check(METHODS.instantiateRecipe.result, answer)) throw new RillError('INTERNAL', 'the fake instantiateRecipe answer does not match the protocol')
    handedOut.add(JSON.stringify(answer.workflow))
    return structuredClone(answer)
  }

  function deploy(params: MethodParams<'deploy'>): MethodResult<'deploy'> {
    if (!Value.Check(METHODS.deploy.params, params)) throw new RillError('INVALID_PARAMS', 'invalid deploy params')
    if (!handedOut.has(JSON.stringify(params.workflow))) throw new RillError('INVALID_WORKFLOW', 'the fake deploy only accepts a workflow of a recipe draft')
    return { workflowId: FAKE_DEPLOYED_ID }
  }

  return {
    onEvent: (listener) => client.onEvent(listener),
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      switch (method) {
        case 'listRecipes':
          return structuredClone({ recipes: data.recipes }) as MethodResult<M>
        case 'instantiateRecipe':
          return instantiate(params as MethodParams<'instantiateRecipe'>) as MethodResult<M>
        case 'deploy':
          return deploy(params as MethodParams<'deploy'>) as MethodResult<M>
        default:
          return client.request(method, params)
      }
    },
  }
}
