import Type from 'typebox'

const id = Type.String({ minLength: 1 })
const at = Type.Number()
const attempt = Type.Integer({ minimum: 1 })
const closed = { additionalProperties: false } as const

export const EngineEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('run.started'), at, runId: id, workflowId: id, dryRun: Type.Boolean() }, closed),
  Type.Object({ type: Type.Literal('step.started'), at, runId: id, nodeId: id, attempt }, closed),
  Type.Object({ type: Type.Literal('step.succeeded'), at, runId: id, nodeId: id, attempt }, closed),
  Type.Object(
    {
      type: Type.Literal('step.failed'),
      at,
      runId: id,
      nodeId: id,
      attempt,
      error: Type.String(),
      willRetry: Type.Boolean(),
    },
    closed,
  ),
  Type.Object({ type: Type.Literal('step.skipped'), at, runId: id, nodeId: id }, closed),
  Type.Object(
    { type: Type.Literal('step.continued'), at, runId: id, nodeId: id, attempt, error: Type.String() },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal('run.finished'),
      at,
      runId: id,
      status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
      error: Type.Union([Type.String(), Type.Null()]),
    },
    closed,
  ),
  Type.Object({ type: Type.Literal('trigger.fired'), at, workflowId: id, runId: id }, closed),
  Type.Object({ type: Type.Literal('trigger.skipped'), at, workflowId: id, reason: Type.String() }, closed),
  Type.Object({ type: Type.Literal('trigger.error'), at, workflowId: id, error: Type.String() }, closed),
  Type.Object({ type: Type.Literal('workflow.activated'), at, workflowId: id }, closed),
  Type.Object({ type: Type.Literal('workflow.deactivated'), at, workflowId: id }, closed),
  Type.Object({ type: Type.Literal('workflow.deleted'), at, workflowId: id }, closed),
])

export type EngineEvent = Type.Static<typeof EngineEventSchema>
