import Type from 'typebox'
import { IdSchema, PlanEffortDetailSchema, UsageSchema } from './plan'

const closed = { additionalProperties: false } as const

export const EXPLAIN_LIKELY_CAUSES = [
  'configuration',
  'input_data',
  'external_service',
  'credentials_or_connection',
  'permission_or_path',
  'rate_limit_or_timeout',
  'workflow_design',
  'unknown',
] as const

export const EXPLAIN_SUGGESTED_ACTIONS = ['retry_run', 'open_connections', 'edit_node', 'check_input_file', 'wait_and_retry', 'deactivate_workflow', 'none'] as const

export const EXPLAIN_SIGNALS = [
  'unknown_connection',
  'path_not_allowed',
  'invalid_config',
  'unresolved_reference',
  'http_status_4xx',
  'http_status_401_403',
  'http_status_404',
  'http_status_429',
  'http_status_5xx',
  'network_error',
  'timeout',
  'file_missing',
  'file_unreadable',
  'llm_unavailable',
  'llm_extract_failed',
  'condition_error',
  'slack_error',
  'csv_error',
  'unknown',
] as const

export const ExplainEffortSchema = Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])

export const ExplainMetaSchema = Type.Object(
  {
    provider: Type.String(),
    model: Type.String(),
    effort: PlanEffortDetailSchema,
    digestChars: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    usage: UsageSchema,
    costUsd: Type.Union([Type.Number(), Type.Null()]),
    repaired: Type.Boolean(),
  },
  closed,
)

export const ExplainResultSchema = Type.Object(
  {
    runId: IdSchema,
    explanation: Type.String({ minLength: 1, maxLength: 1500 }),
    likelyCause: Type.Enum(EXPLAIN_LIKELY_CAUSES),
    suggestedActions: Type.Array(Type.Enum(EXPLAIN_SUGGESTED_ACTIONS), { maxItems: 3 }),
    fixProposal: Type.Optional(Type.Object({ nodeId: IdSchema, requestText: Type.String({ minLength: 1, maxLength: 400 }) }, closed)),
    signals: Type.Array(
      Type.Object({ nodeId: Type.String(), signal: Type.Enum(EXPLAIN_SIGNALS) }, closed),
    ),
    meta: ExplainMetaSchema,
  },
  closed,
)

export type ExplainEffort = Type.Static<typeof ExplainEffortSchema>
export type ExplainMeta = Type.Static<typeof ExplainMetaSchema>
export type ExplainResult = Type.Static<typeof ExplainResultSchema>
