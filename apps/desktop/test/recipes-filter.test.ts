// @vitest-environment node
import type { RecipeInfo } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { recipeInfos } from '../src/fixtures/recipes'
import { allTags, filterRecipes, nodeTypeBase, sendsToModelProvider } from '../src/recipes/model/filter'

const ids = (list: readonly RecipeInfo[]) => list.map((recipe) => recipe.id)

describe('filterRecipes', () => {
  it('returns every recipe for an empty query and no tags, in the same order', () => {
    expect(ids(filterRecipes(recipeInfos, '', [], 'ko'))).toEqual(ids(recipeInfos))
    expect(ids(filterRecipes(recipeInfos, '   ', [], 'en'))).toEqual(ids(recipeInfos))
  })

  it('matches the title and the description of the current language, ignoring case', () => {
    expect(ids(filterRecipes(recipeInfos, '영수증', [], 'ko'))).toEqual(['receipt-folder-to-csv', 'receipt-big-amount-alert'])
    expect(ids(filterRecipes(recipeInfos, 'BIG RECEIPT', [], 'en'))).toEqual(['receipt-big-amount-alert'])
    expect(filterRecipes(recipeInfos, 'receipt', [], 'ko').length).toBeGreaterThan(0)
  })

  it('matches the tags', () => {
    expect(ids(filterRecipes(recipeInfos, 'receipts', [], 'en'))).toContain('receipt-folder-to-csv')
  })

  it('needs every word of the query', () => {
    expect(ids(filterRecipes(recipeInfos, 'receipt slack', [], 'en'))).toEqual(['receipt-big-amount-alert'])
    expect(filterRecipes(recipeInfos, 'receipt zzzz', [], 'en')).toEqual([])
  })

  it('keeps recipes that have every chosen tag', () => {
    const [first] = recipeInfos
    const both = filterRecipes(recipeInfos, '', [first!.tags[0]!, first!.tags[1]!], 'ko')
    expect(ids(both)).toContain(first!.id)
    expect(filterRecipes(recipeInfos, '', ['no-such-tag'], 'ko')).toEqual([])
  })

  it('combines the query and the tags', () => {
    expect(ids(filterRecipes(recipeInfos, 'receipt', ['slack'], 'en'))).toEqual(['receipt-big-amount-alert'])
  })

  it('does not match a regular expression character as a pattern', () => {
    expect(filterRecipes(recipeInfos, '.*', [], 'en')).toEqual([])
    expect(filterRecipes(recipeInfos, '?*+', [], 'en')).toEqual([])
  })
})

describe('allTags', () => {
  it('lists each tag once, sorted', () => {
    const tags = allTags(recipeInfos)
    expect(tags).toEqual([...new Set(tags)].sort())
    expect(tags).toContain('slack')
    expect(tags.length).toBeGreaterThan(3)
  })

  it('is empty for no recipes', () => {
    expect(allTags([])).toEqual([])
  })
})

describe('node type helpers', () => {
  it('cuts the version off a node type', () => {
    expect(nodeTypeBase('llm.extract@1')).toBe('llm.extract')
    expect(nodeTypeBase('csv.append')).toBe('csv.append')
  })

  it('finds the recipes that send file contents to the model provider by their node types', () => {
    expect(recipeInfos.filter((recipe) => sendsToModelProvider(recipe)).map((recipe) => recipe.id)).toEqual(['receipt-folder-to-csv', 'receipt-big-amount-alert'])
  })
})
