import { WorkflowSchema } from '@rill/dsl'
import Type from 'typebox'
import { IdSchema } from './plan'

export const RECIPE_PARAM_KINDS = ['folder', 'file', 'glob', 'text', 'number', 'cron', 'url', 'connection'] as const
export const RECIPE_CONNECTION_KINDS = ['slack', 'http', 'webhookSecret'] as const
export const RECIPE_MAX_VALUES = 20
export const RECIPE_MAX_STRING_CHARS = 500

const closed = { additionalProperties: false } as const
const localized = Type.Object({ ko: Type.String(), en: Type.String() }, closed)

export const RecipeParamInfoSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.Enum(RECIPE_PARAM_KINDS),
    label: localized,
    help: Type.Optional(localized),
    required: Type.Boolean(),
    default: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    extension: Type.Optional(Type.String()),
    connectionKind: Type.Optional(Type.Enum(RECIPE_CONNECTION_KINDS)),
  },
  closed,
)

export const RecipeInfoSchema = Type.Object(
  {
    id: Type.String(),
    title: localized,
    description: localized,
    tags: Type.Array(Type.String()),
    params: Type.Array(RecipeParamInfoSchema),
    nodeTypes: Type.Array(Type.String()),
    needsConnection: Type.Boolean(),
  },
  closed,
)

export const RecipeValuesSchema = Type.Record(Type.String(), Type.Union([Type.String({ maxLength: RECIPE_MAX_STRING_CHARS }), Type.Number()]), {
  maxProperties: RECIPE_MAX_VALUES,
  additionalProperties: false,
})

export const RecipeSummarySchema = Type.Object(
  {
    nodes: Type.Array(Type.Object({ id: Type.String(), type: Type.String(), title: Type.String() }, closed)),
    sideEffects: Type.Array(Type.Union([Type.Literal('external'), Type.Literal('idempotent')]), { uniqueItems: true }),
    sendsToModel: Type.Boolean(),
  },
  closed,
)

export const RecipeDraftSchema = Type.Object({ recipeId: IdSchema, workflow: WorkflowSchema, summary: RecipeSummarySchema }, closed)

export type RecipeParamInfo = Type.Static<typeof RecipeParamInfoSchema>
export type RecipeInfo = Type.Static<typeof RecipeInfoSchema>
export type RecipeValues = Type.Static<typeof RecipeValuesSchema>
export type RecipeSummary = Type.Static<typeof RecipeSummarySchema>
export type RecipeDraft = Type.Static<typeof RecipeDraftSchema>
