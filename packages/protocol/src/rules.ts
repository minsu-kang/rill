import Type from 'typebox'
import { IdSchema } from './plan'

export const RULE_KINDS = ['forbidNode', 'allowHost', 'maxPlanEffort'] as const
export const RULE_MAX_ITEMS = 30
export const RULE_MAX_VALUE_CHARS = 255
export const RULE_MAX_INPUT_CHARS = 500

export const RuleKindSchema = Type.Union([Type.Literal('forbidNode'), Type.Literal('allowHost'), Type.Literal('maxPlanEffort')])

export const RuleSchema = Type.Object(
  {
    id: IdSchema,
    kind: RuleKindSchema,
    value: Type.String({ minLength: 1, maxLength: RULE_MAX_VALUE_CHARS }),
    createdAt: Type.Number(),
  },
  { additionalProperties: false },
)

export type RuleKind = (typeof RULE_KINDS)[number]
export type Rule = Type.Static<typeof RuleSchema>
