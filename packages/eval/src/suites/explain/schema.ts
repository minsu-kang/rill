import { WorkflowSchema, type Workflow } from '@rill/dsl'
import { FAILURE_SIGNALS, LIKELY_CAUSES, SUGGESTED_ACTIONS } from '@rill/planner'
import Type from 'typebox'
import { schemaProblems } from '../planner/schema'

export const EXPLAIN_DRAFT_SIZE = 6
export const EXPLAIN_EFFORTS = ['low', 'medium', 'high'] as const

const strict = { additionalProperties: false } as const
const text = Type.String({ minLength: 1 })
const nullable = <T extends Type.TSchema>(schema: T) => Type.Union([schema, Type.Null()])

const stepSchema = Type.Object(
  {
    nodeId: text,
    attempt: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('abandoned'), Type.Literal('skipped'), Type.Literal('continued')]),
    input: Type.Unknown(),
    output: Type.Unknown(),
    error: nullable(Type.String()),
    startedAt: Type.Number(),
    finishedAt: nullable(Type.Number()),
  },
  strict,
)

const runSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('failed'), Type.Literal('succeeded')]),
    dryRun: Type.Boolean(),
    error: nullable(Type.String()),
    createdAt: Type.Number(),
    startedAt: nullable(Type.Number()),
    finishedAt: nullable(Type.Number()),
  },
  strict,
)

const expectSchema = Type.Object(
  {
    signals: Type.Array(Type.Object({ nodeId: text, signal: Type.Enum(FAILURE_SIGNALS) }, strict)),
    likelyCause: Type.Array(Type.Enum(LIKELY_CAUSES)),
    actions: Type.Array(Type.Enum(SUGGESTED_ACTIONS)),
    mention: Type.Array(text),
    injection: Type.Optional(Type.Object({ needles: Type.Array(text, { minItems: 1 }) }, strict)),
  },
  strict,
)

export const explainCaseSchema = Type.Object(
  {
    id: text,
    title: text,
    workflow: WorkflowSchema,
    run: runSchema,
    steps: Type.Array(stepSchema),
    secrets: Type.Array(Type.String()),
    effort: Type.Enum(EXPLAIN_EFFORTS),
    tags: Type.Optional(Type.Array(text)),
    expect: expectSchema,
  },
  strict,
)

export const explainDraftSchema = Type.Object(
  {
    status: Type.Literal('DRAFT'),
    notice: Type.String({ pattern: '^DRAFT: not approved\\.' }),
    cases: Type.Array(explainCaseSchema),
  },
  strict,
)

export type ExplainCaseSpec = Type.Static<typeof explainCaseSchema>
export type ExplainDraftFile = Type.Static<typeof explainDraftSchema>
export type ExplainWorkflow = Workflow

export function parseExplainDraft(input: unknown): ExplainDraftFile {
  const problems = schemaProblems(explainDraftSchema, input)
  if (problems.length > 0) throw new Error(`invalid explain draft:\n${problems.join('\n')}`)
  return input as ExplainDraftFile
}
