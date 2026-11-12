import Type from 'typebox'
import { PlanEffortSchema } from './plan'

const closed = { additionalProperties: false } as const
const nullable = <T extends Type.TSchema>(schema: T) => Type.Union([schema, Type.Null()])

export const ProviderIdSchema = Type.Union([
  Type.Literal('anthropic'),
  Type.Literal('openai'),
  Type.Literal('gemini'),
  Type.Literal('grok'),
  Type.Literal('meta'),
])

const ImageMediaTypeSchema = Type.Union([
  Type.Literal('image/png'),
  Type.Literal('image/jpeg'),
  Type.Literal('image/gif'),
  Type.Literal('image/webp'),
])

export const LlmCapabilitiesSchema = Type.Object(
  {
    structuredOutput: Type.Union([Type.Literal('strict'), Type.Literal('best-effort')]),
    documents: Type.Union([Type.Literal('native-pdf'), Type.Literal('none')]),
    images: Type.Array(ImageMediaTypeSchema),
    maxRequestBytes: Type.Optional(Type.Number()),
    cache: Type.Union([Type.Literal('explicit'), Type.Literal('automatic'), Type.Literal('none')]),
    maxCacheBreakpoints: Type.Optional(Type.Number()),
    effortLevels: Type.Array(PlanEffortSchema),
    effortMap: Type.Object(
      { low: Type.String(), medium: Type.String(), high: Type.String(), xhigh: Type.String(), max: Type.String() },
      closed,
    ),
    reasoningCappedByMaxTokens: Type.Boolean(),
    streaming: Type.Union([Type.Literal('required'), Type.Literal('optional')]),
    maxOutputTokens: Type.Optional(Type.Number()),
    dataNote: Type.String(),
  },
  closed,
)

export const LlmModelInfoSchema = Type.Object(
  {
    provider: ProviderIdSchema,
    id: Type.String(),
    tier: Type.Union([Type.Literal('strong'), Type.Literal('mid'), Type.Literal('cheap')]),
    label: Type.String(),
    contextTokens: Type.Number(),
    capabilities: LlmCapabilitiesSchema,
  },
  closed,
)

export const LlmProviderStatusSchema = Type.Object(
  { id: ProviderIdSchema, label: Type.String(), keyEnv: Type.String(), configured: Type.Boolean() },
  closed,
)

export const LlmModelsResultSchema = Type.Object(
  {
    models: Type.Array(LlmModelInfoSchema),
    providers: Type.Array(LlmProviderStatusSchema),
    active: nullable(Type.Object({ provider: ProviderIdSchema, model: Type.String() }, closed)),
  },
  closed,
)

export type ProviderId = Type.Static<typeof ProviderIdSchema>
export type LlmCapabilitiesInfo = Type.Static<typeof LlmCapabilitiesSchema>
export type LlmModelInfo = Type.Static<typeof LlmModelInfoSchema>
export type LlmProviderStatus = Type.Static<typeof LlmProviderStatusSchema>
export type LlmModelsResult = Type.Static<typeof LlmModelsResultSchema>
