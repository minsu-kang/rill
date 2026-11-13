import Type from 'typebox'

export const PARAM_KINDS = ['folder', 'file', 'glob', 'text', 'number', 'cron', 'url', 'connection', 'spreadsheetId', 'driveFile', 'tableName'] as const
export type ParamKind = (typeof PARAM_KINDS)[number]

export const CONNECTION_KINDS = ['slack', 'http', 'webhookSecret', 'google', 'microsoft'] as const
export type ConnectionKindName = (typeof CONNECTION_KINDS)[number]

export const MAX_PARAM_STRING_CHARS = 500
export const MAX_PARAM_VALUES = 20
export const MAX_RECIPE_PARAMS = 10
export const PARAM_ID_PATTERN = '^[a-z][a-zA-Z0-9]{0,31}$'
export const RECIPE_ID_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
export const EXTENSION_PATTERN = '^\\.[a-z0-9]{1,8}$'
const TAG_PATTERN = '^[a-z][a-z0-9-]{0,31}$'

const closed = { additionalProperties: false } as const
const shortText = Type.String({ minLength: 1, maxLength: 200 })
const longText = Type.String({ minLength: 1, maxLength: 600 })
const localized = (text: Type.TString) => Type.Object({ ko: text, en: text }, closed)

export const RecipeParamSchema = Type.Object(
  {
    id: Type.String({ pattern: PARAM_ID_PATTERN }),
    kind: Type.Enum(PARAM_KINDS),
    label: localized(shortText),
    help: Type.Optional(localized(longText)),
    required: Type.Boolean(),
    default: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    extension: Type.Optional(Type.String({ pattern: EXTENSION_PATTERN })),
    connectionKind: Type.Optional(Type.Enum(CONNECTION_KINDS)),
  },
  closed,
)

export const RecipeSchema = Type.Object(
  {
    id: Type.String({ pattern: RECIPE_ID_PATTERN, maxLength: 64 }),
    title: localized(shortText),
    description: localized(longText),
    tags: Type.Array(Type.String({ pattern: TAG_PATTERN }), { maxItems: 8 }),
    params: Type.Array(RecipeParamSchema, { maxItems: MAX_RECIPE_PARAMS }),
    workflow: Type.Unknown(),
    sample: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
  },
  closed,
)

export type RecipeParam = Type.Static<typeof RecipeParamSchema>
export type Recipe = Type.Static<typeof RecipeSchema>

export type ParamValues = Readonly<Record<string, string | number>>
