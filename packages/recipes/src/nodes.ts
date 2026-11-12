import type { Recipe } from './types'

export function recipeNodeTypes(recipe: Recipe): string[] {
  const nodes = (recipe.workflow as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(nodes)) return []
  const types = nodes.flatMap((node: unknown) => {
    const type = (node as { type?: unknown } | null)?.type
    return typeof type === 'string' ? [type] : []
  })
  return [...new Set(types)]
}
