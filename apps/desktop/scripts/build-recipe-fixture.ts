import { Db, Engine } from '@rill/engine'
import { createCoreRegistry } from '@rill/nodes-core'
import type { RecipeDraft, RecipeInfo, RecipeValues } from '@rill/protocol'
import { RECIPES } from '../../../packages/recipes/src/index'

export interface RecipeFixture {
  recipes: RecipeInfo[]
  drafts: Record<string, { values: RecipeValues; draft: RecipeDraft }>
}

export function buildRecipeFixture(): RecipeFixture {
  const engine = new Engine({
    db: Db.open(':memory:'),
    registry: createCoreRegistry(),
    allowedRoots: ['/Users/demo'],
    planConnections: [
      { name: 'slack-ops', kind: 'slack' },
      { name: 'google', kind: 'google' },
      { name: 'microsoft', kind: 'microsoft' },
    ],
  })
  const drafts: RecipeFixture['drafts'] = {}
  for (const recipe of RECIPES) {
    const values: RecipeValues = { ...recipe.sample }
    drafts[recipe.id] = { values, draft: engine.instantiateRecipe({ recipeId: recipe.id, values }) }
  }
  return { recipes: engine.listRecipes(), drafts }
}
