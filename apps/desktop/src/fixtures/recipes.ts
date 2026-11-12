import { RillError, type MethodParams, type RecipeDraft, type RecipeInfo, type RecipeValues } from '@rill/protocol'
import type { FakeRecipeData } from '../engine/fake-recipes'
import fixtureJson from './recipe-infos.json'

interface Stored {
  recipes: unknown
  drafts: Record<string, { values: RecipeValues; draft: unknown }>
}

const stored = fixtureJson as Stored

export const recipeInfos: RecipeInfo[] = stored.recipes as RecipeInfo[]

export const recipeDrafts: Record<string, RecipeDraft> = Object.fromEntries(Object.entries(stored.drafts).map(([id, entry]) => [id, entry.draft as RecipeDraft]))

export const recipeSampleValues: Record<string, RecipeValues> = Object.fromEntries(Object.entries(stored.drafts).map(([id, entry]) => [id, entry.values]))

export const recipeProblemSets = {
  required: ['watchFolder: required', 'csvFile: required', 'threshold: required'],
  folderAndFile: ['watchFolder: not_absolute_path', 'csvFile: wrong_extension', 'csvFile: trailing_separator'],
  textRules: ['watchFolder: surrounding_space', 'glob: bad_glob', 'watchFolder: parent_segment', 'csvFile: control_character'],
  numberRules: ['threshold: below_min', 'threshold: above_max', 'threshold: not_finite'],
  cron: ['schedule: bad_cron'],
  url: ['url: bad_url', 'url: url_credentials'],
  pathIssues: ['path_outside_roots at /nodes/2/config/file', 'inside_watched_folder at /nodes/2/config/file'],
  connectionIssues: ['unknown_connection at /nodes/4/config/connection', 'connection_kind_mismatch at /nodes/4/config/connection'],
  configIssues: ['config_pattern at /nodes/0/config/glob', 'cron_expression at /nodes/0/config/expression', 'config_rule at /nodes/2/config'],
  unknown: ['watchFolder: a_rule_from_the_future', 'ghost: required', 'something_new at /nodes/9', 'free text that fits no form'],
} as const satisfies Record<string, readonly string[]>

export const hostileRecipes: RecipeInfo[] = [
  {
    id: 'hostile-recipe',
    title: { ko: '<img src=x onerror="window.__pwned = 1"> 제목', en: '<img src=x onerror="window.__pwned = 1"> title' },
    description: {
      ko: '<script>window.__pwned = 1</script> [링크](javascript:window.__pwned=1) **굵게** invoice ‮txt.exe ' + '긴 설명 '.repeat(120),
      en: '<script>window.__pwned = 1</script> [link](javascript:window.__pwned=1) **bold** invoice ‮txt.exe ' + 'long text '.repeat(60),
    },
    tags: ['<b>tag</b>', 'a-very-long-tag-name'.repeat(5)],
    params: [
      {
        id: 'target',
        kind: 'text',
        label: { ko: '<a href="javascript:alert(1)">라벨</a>', en: '<a href="javascript:alert(1)">Label</a>' },
        help: { ko: '<svg onload=alert(1)> 도움말', en: '<svg onload=alert(1)> help' },
        required: true,
      },
    ],
    nodeTypes: ['trigger.manual@1', 'evil.<img src=x>@1'],
    needsConnection: false,
  },
]

export function fixtureRecipeData(): FakeRecipeData {
  return {
    recipes: recipeInfos,
    instantiate: ({ recipeId }: MethodParams<'instantiateRecipe'>) => {
      const draft = recipeDrafts[recipeId]
      return draft === undefined ? new RillError('NOT_FOUND', 'recipe not found') : structuredClone(draft)
    },
  }
}

export function failingInstantiate(problems: readonly string[]): FakeRecipeData['instantiate'] {
  return () => new RillError('RECIPE_INVALID', 'the recipe values are not valid', [...problems])
}
