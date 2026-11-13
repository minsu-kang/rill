import { RetrySchema, WorkflowEdgeSchema, WorkflowNodeSchema, WorkflowSchema } from '@rill/dsl'
import Type from 'typebox'
import { AGENT_NAME_MAX_CHARS } from './agents'

export const IdSchema = Type.String({ minLength: 1, maxLength: 128 })

const closed = { additionalProperties: false } as const
const nullable = <T extends Type.TSchema>(schema: T) => Type.Union([schema, Type.Null()])

export const PLAN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const PlanEffortSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
])

export const AttachmentRefSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[A-Za-z0-9_-]{8,64}$' }),
    mediaType: Type.Union([
      Type.Literal('application/pdf'),
      Type.Literal('image/png'),
      Type.Literal('image/jpeg'),
      Type.Literal('image/gif'),
      Type.Literal('image/webp'),
      Type.Literal('text/plain'),
      Type.Literal('text/csv'),
      Type.Literal('text/markdown'),
    ]),
    name: Type.String({ minLength: 1, maxLength: 255 }),
    bytes: Type.Integer({ minimum: 0 }),
  },
  closed,
)

export const FlagSchema = Type.Object(
  {
    nodeId: Type.String(),
    pointer: Type.String(),
    code: Type.Union([Type.Literal('attachment_origin'), Type.Literal('new_egress_target'), Type.Literal('untrusted_flow')]),
    message: Type.String(),
  },
  closed,
)

export const PlanQuestionSchema = Type.Object(
  { id: Type.String(), text: Type.String(), options: Type.Array(Type.String(), { maxItems: 10 }), default: Type.String() },
  closed,
)

export const PatchOpSchema = Type.Union([
  Type.Object({ op: Type.Literal('add_node'), node: WorkflowNodeSchema }, closed),
  Type.Object(
    {
      op: Type.Literal('set_config'),
      nodeId: Type.String(),
      config: Type.Record(Type.String(), Type.Unknown()),
      retry: Type.Optional(RetrySchema),
      onError: Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('continue')])),
    },
    closed,
  ),
  Type.Object({ op: Type.Literal('remove_node'), nodeId: Type.String() }, closed),
  Type.Object({ op: Type.Literal('connect'), edge: WorkflowEdgeSchema }, closed),
  Type.Object({ op: Type.Literal('disconnect'), from: Type.String(), to: Type.String() }, closed),
])

export const PlanResultBodySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('workflow'),
      workflow: WorkflowSchema,
      summary: Type.String(),
      patch: Type.Optional(Type.Array(PatchOpSchema)),
      flags: Type.Array(FlagSchema),
      needsConfirmation: Type.Boolean(),
    },
    closed,
  ),
  Type.Object(
    { kind: Type.Literal('questions'), questions: Type.Array(PlanQuestionSchema, { maxItems: 10 }), summary: Type.String() },
    closed,
  ),
  Type.Object(
    { kind: Type.Literal('unsupported'), reason: Type.String(), nearest: Type.String(), summary: Type.String() },
    closed,
  ),
])

export const PlanTurnSchema = Type.Object(
  {
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    text: Type.String({ maxLength: 8000 }),
    attachments: Type.Optional(Type.Array(AttachmentRefSchema, { maxItems: 5 })),
    result: Type.Optional(PlanResultBodySchema),
    answers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 8000 }), { maxProperties: 10 })),
  },
  closed,
)

export const UsageSchema = Type.Object(
  {
    inputTokens: Type.Number(),
    outputTokens: Type.Number(),
    cacheReadInputTokens: Type.Number(),
    cacheCreationInputTokens: Type.Number(),
  },
  closed,
)

export const PlanIssueSchema = Type.Object(
  {
    stage: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)]),
    pointer: Type.String(),
    code: Type.String(),
    message: Type.String(),
    hint: Type.Optional(Type.String()),
  },
  closed,
)

const PlanRoundSchema = Type.Object(
  {
    index: Type.Integer({ minimum: 0 }),
    issues: Type.Array(PlanIssueSchema),
    usage: UsageSchema,
    durationMs: Type.Number(),
    targeted: Type.Array(Type.String()),
  },
  closed,
)

const effortDetailFields = { requested: PlanEffortSchema, effective: PlanEffortSchema, native: Type.String(), collapsed: Type.Boolean() }

export const EffortDetailSchema = Type.Object(effortDetailFields, closed)

export const PlanEffortDetailSchema = Type.Object({ ...effortDetailFields, cappedByRule: Type.Boolean() }, closed)

export const PlanMetaSchema = Type.Object(
  {
    rounds: Type.Array(PlanRoundSchema),
    usage: UsageSchema,
    costUsd: nullable(Type.Number()),
    model: Type.String(),
    effort: PlanEffortSchema,
    fallbackUsed: Type.Boolean(),
    provider: Type.Optional(Type.String()),
    effortDetail: Type.Optional(PlanEffortDetailSchema),
    reasoningCapped: Type.Optional(Type.Boolean()),
    costNote: Type.Optional(Type.String()),
    memoryUsed: Type.Optional(Type.Integer({ minimum: 0 })),
    memoryDropped: Type.Optional(Type.Integer({ minimum: 0 })),
    agentUsed: Type.Optional(Type.Object({ id: IdSchema, name: Type.String({ minLength: 1, maxLength: AGENT_NAME_MAX_CHARS }) }, closed)),
    agentDropped: Type.Optional(Type.Integer({ minimum: 0 })),
    skillsUsed: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  closed,
)

const PlanStatusSchema = Type.Union([Type.Literal('planned'), Type.Literal('failed'), Type.Literal('cancelled')])

export const PlanRecordSchema = Type.Object(
  {
    planId: IdSchema,
    createdAt: Type.Number(),
    status: PlanStatusSchema,
    effort: PlanEffortSchema,
    model: nullable(Type.String()),
    requestText: Type.String(),
    attachments: Type.Array(AttachmentRefSchema),
    result: nullable(PlanResultBodySchema),
    meta: nullable(PlanMetaSchema),
    error: nullable(Type.String()),
    flagKeys: Type.Array(Type.String()),
    workflowId: nullable(IdSchema),
    confirmed: nullable(Type.Array(Type.String())),
    memoryIds: Type.Optional(Type.Array(IdSchema)),
    agentId: Type.Optional(IdSchema),
  },
  closed,
)

export const PlanSummarySchema = Type.Object(
  {
    planId: IdSchema,
    createdAt: Type.Number(),
    status: PlanStatusSchema,
    kind: nullable(Type.Union([Type.Literal('workflow'), Type.Literal('questions'), Type.Literal('unsupported')])),
    summary: nullable(Type.String()),
    flagCount: Type.Integer({ minimum: 0 }),
    workflowId: nullable(IdSchema),
  },
  closed,
)

export type PlanEffort = Type.Static<typeof PlanEffortSchema>
export type AttachmentRef = Type.Static<typeof AttachmentRefSchema>
export type Flag = Type.Static<typeof FlagSchema>
export type PlanQuestion = Type.Static<typeof PlanQuestionSchema>
export type PatchOp = Type.Static<typeof PatchOpSchema>
export type PlanResultBody = Type.Static<typeof PlanResultBodySchema>
export type PlanTurn = Type.Static<typeof PlanTurnSchema>
export type EffortDetail = Type.Static<typeof EffortDetailSchema>
export type PlanEffortDetail = Type.Static<typeof PlanEffortDetailSchema>
export type PlanMeta = Type.Static<typeof PlanMetaSchema>
export type PlanRecord = Type.Static<typeof PlanRecordSchema>
export type PlanSummary = Type.Static<typeof PlanSummarySchema>

export function flagKey(flag: { nodeId: string; pointer: string; code: string }): string {
  return JSON.stringify([flag.nodeId, flag.pointer, flag.code])
}
