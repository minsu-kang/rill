import Type from 'typebox'
import { AGENT_NAME_MAX_CHARS } from './agents'
import { EffortDetailSchema, IdSchema, UsageSchema } from './plan'

const closed = { additionalProperties: false } as const

export const REVIEW_SEVERITIES = ['problem', 'warning', 'info'] as const
export const REVIEW_SUMMARY_MAX_CHARS = 400
export const REVIEW_FINDING_MAX_CHARS = 400
export const REVIEW_MAX_FINDINGS = 10

export const ReviewSeveritySchema = Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('problem')])

export const ReviewFindingSchema = Type.Object(
  {
    severity: ReviewSeveritySchema,
    text: Type.String({ minLength: 1, maxLength: REVIEW_FINDING_MAX_CHARS }),
    nodeId: Type.Optional(IdSchema),
  },
  closed,
)

export const ReviewSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: REVIEW_SUMMARY_MAX_CHARS }),
    findings: Type.Array(ReviewFindingSchema, { maxItems: REVIEW_MAX_FINDINGS }),
  },
  closed,
)

export const ReviewMetaSchema = Type.Object(
  {
    provider: Type.String(),
    model: Type.String(),
    effort: EffortDetailSchema,
    costNote: Type.Optional(Type.String()),
    usage: UsageSchema,
    costUsd: Type.Union([Type.Number(), Type.Null()]),
    repaired: Type.Boolean(),
    agentUsed: Type.Object({ id: IdSchema, name: Type.String({ minLength: 1, maxLength: AGENT_NAME_MAX_CHARS }) }, closed),
    skillsUsed: Type.Integer({ minimum: 0 }),
    agentDropped: Type.Integer({ minimum: 0 }),
  },
  closed,
)

export const ReviewResultSchema = Type.Object({ review: ReviewSchema, meta: ReviewMetaSchema }, closed)

export type ReviewSeverity = Type.Static<typeof ReviewSeveritySchema>
export type ReviewFinding = Type.Static<typeof ReviewFindingSchema>
export type Review = Type.Static<typeof ReviewSchema>
export type ReviewMeta = Type.Static<typeof ReviewMetaSchema>
export type ReviewResult = Type.Static<typeof ReviewResultSchema>
