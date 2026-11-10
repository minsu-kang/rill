import Type from 'typebox'
import Value from 'typebox/value'
import { SCHEMA_VERSION } from './version'

const NODE_ID = '^[a-z][a-z0-9_]{0,31}$'
const NODE_TYPE = '^[a-z][a-zA-Z0-9]*(\\.[a-zA-Z][a-zA-Z0-9]*)*@[0-9]+$'

export const RetrySchema = Type.Object(
  {
    maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
    baseDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
  },
  { additionalProperties: false },
)

export const WorkflowNodeSchema = Type.Object(
  {
    id: Type.String({ pattern: NODE_ID }),
    type: Type.String({ pattern: NODE_TYPE }),
    config: Type.Record(Type.String(), Type.Unknown()),
    retry: Type.Optional(RetrySchema),
    onError: Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('continue')])),
  },
  { additionalProperties: false },
)

export const WorkflowEdgeSchema = Type.Object(
  {
    from: Type.String({ pattern: NODE_ID }),
    to: Type.String({ pattern: NODE_ID }),
    when: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
)

export const WorkflowSchema = Type.Object(
  {
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    name: Type.String({ minLength: 1 }),
    nodes: Type.Array(WorkflowNodeSchema, { minItems: 1 }),
    edges: Type.Array(WorkflowEdgeSchema),
  },
  { additionalProperties: false },
)

export type Workflow = Type.Static<typeof WorkflowSchema>
export type WorkflowNode = Type.Static<typeof WorkflowNodeSchema>
export type WorkflowEdge = Type.Static<typeof WorkflowEdgeSchema>

export type ParseResult = { ok: true; workflow: Workflow } | { ok: false; errors: string[] }

export function parseWorkflowShape(input: unknown): ParseResult {
  if (Value.Check(WorkflowSchema, input)) return { ok: true, workflow: input }
  const errors = [...Value.Errors(WorkflowSchema, input)].map((e) => `${e.instancePath || '/'}: ${e.message}`)
  return { ok: false, errors }
}
