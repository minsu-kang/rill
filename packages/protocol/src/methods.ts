import { WorkflowSchema } from '@rill/dsl'
import Type from 'typebox'

const id = Type.String({ minLength: 1, maxLength: 128 })
const closed = { additionalProperties: false } as const

export const WorkflowSummarySchema = Type.Object({
  id,
  name: Type.String(),
  active: Type.Boolean(),
  triggerType: Type.String(),
  createdAt: Type.Number(),
})

export const RunSummarySchema = Type.Object({
  id,
  workflowId: id,
  status: Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  dryRun: Type.Boolean(),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
})

export const StepDetailSchema = Type.Object({
  nodeId: id,
  attempt: Type.Integer({ minimum: 1 }),
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('abandoned'),
    Type.Literal('skipped'),
    Type.Literal('continued'),
  ]),
  input: Type.Unknown(),
  output: Type.Unknown(),
  error: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
})

export const NodeInfoSchema = Type.Object({
  type: Type.String(),
  kind: Type.Union([Type.Literal('trigger'), Type.Literal('action')]),
  title: Type.String(),
  description: Type.String(),
  sideEffect: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('idempotent'), Type.Literal('external')])),
  configSchema: Type.Unknown(),
  outputSchema: Type.Unknown(),
})

export type WorkflowSummary = Type.Static<typeof WorkflowSummarySchema>
export type RunSummary = Type.Static<typeof RunSummarySchema>
export type StepDetail = Type.Static<typeof StepDetailSchema>
export type NodeInfo = Type.Static<typeof NodeInfoSchema>

const noParams = Type.Object({}, closed)
const noResult = Type.Object({})

export const METHODS = {
  deploy: {
    params: Type.Object({ workflow: Type.Unknown() }, closed),
    result: Type.Object({ workflowId: id }),
  },
  getWorkflow: {
    params: Type.Object({ workflowId: id }, closed),
    result: Type.Object({ workflow: WorkflowSchema }),
  },
  listWorkflows: {
    params: noParams,
    result: Type.Object({ workflows: Type.Array(WorkflowSummarySchema) }),
  },
  startRun: {
    params: Type.Object(
      { workflowId: id, payload: Type.Optional(Type.Unknown()), dryRun: Type.Optional(Type.Boolean()) },
      closed,
    ),
    result: Type.Object({ runId: id }),
  },
  activate: { params: Type.Object({ workflowId: id }, closed), result: noResult },
  deactivate: { params: Type.Object({ workflowId: id }, closed), result: noResult },
  listRuns: {
    params: Type.Object(
      { workflowId: Type.Optional(id), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) },
      closed,
    ),
    result: Type.Object({ runs: Type.Array(RunSummarySchema) }),
  },
  getRun: {
    params: Type.Object({ runId: id }, closed),
    result: Type.Object({ run: RunSummarySchema, steps: Type.Array(StepDetailSchema) }),
  },
  nodeCatalog: {
    params: noParams,
    result: Type.Object({ nodes: Type.Array(NodeInfoSchema) }),
  },
  ping: { params: noParams, result: Type.Object({ time: Type.Number() }) },
} as const

export type MethodName = keyof typeof METHODS
export type MethodParams<M extends MethodName> = Type.Static<(typeof METHODS)[M]['params']>
export type MethodResult<M extends MethodName> = Type.Static<(typeof METHODS)[M]['result']>

export const ERROR_CODES = [
  'INVALID_PARAMS',
  'UNKNOWN_METHOD',
  'INVALID_WORKFLOW',
  'NOT_FOUND',
  'ACTIVATION_FAILED',
  'INTERNAL',
] as const
