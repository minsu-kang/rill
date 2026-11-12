import type { RecipeInfo } from '@rill/protocol'
import type { Locale } from '../../i18n'

export function nodeTypeBase(type: string): string {
  return type.replace(/@\d+$/, '')
}

export function sendsToModelProvider(recipe: Pick<RecipeInfo, 'nodeTypes'>): boolean {
  return recipe.nodeTypes.some((type) => nodeTypeBase(type) === 'llm.extract')
}

export function allTags(recipes: readonly RecipeInfo[]): string[] {
  return [...new Set(recipes.flatMap((recipe) => recipe.tags))].sort()
}

export function filterRecipes(recipes: readonly RecipeInfo[], query: string, tags: readonly string[], locale: Locale): RecipeInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
  return recipes.filter((recipe) => {
    if (!tags.every((tag) => recipe.tags.includes(tag))) return false
    const haystack = [recipe.title[locale], recipe.description[locale], ...recipe.tags].join('\n').toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}
