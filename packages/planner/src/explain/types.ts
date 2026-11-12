import type { Workflow } from '@rill/dsl'
import type { LlmUsage } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import type { PlanEffortMeta } from '../types'

export const MAX_DIGEST_CHARS = 12_000

export const LIKELY_CAUSES = [
  'configuration',
  'input_data',
  'external_service',
  'credentials_or_connection',
  'permission_or_path',
  'rate_limit_or_timeout',
  'workflow_design',
  'unknown',
] as const

export const SUGGESTED_ACTIONS = ['retry_run', 'open_connections', 'edit_node', 'check_input_file', 'wait_and_retry', 'deactivate_workflow', 'none'] as const

export const FAILURE_SIGNALS = [
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

export type FailureSignal = (typeof FAILURE_SIGNALS)[number]

export interface ExplainStep {
  nodeId: string
  attempt: number
  status: 'running' | 'succeeded' | 'failed' | 'abandoned' | 'skipped' | 'continued'
  input: unknown
  output: unknown
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface ExplainRun {
  id: string
  status: string
  dryRun: boolean
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface ExplainRunInput {
  run: ExplainRun
  steps: readonly ExplainStep[]
  workflow: Workflow
  registry: NodeRegistry
  secrets: readonly string[]
}

export interface RunDigest {
  text: string
  chars: number
  omittedSteps: number
  truncated: boolean
  failedNodeIds: string[]
}

export interface ExplainSignal {
  nodeId: string
  signal: FailureSignal
}

export interface ExplainAnswer {
  explanation: string
  likelyCause: (typeof LIKELY_CAUSES)[number]
  suggestedActions: Array<(typeof SUGGESTED_ACTIONS)[number]>
  fixProposal?: { nodeId: string; requestText: string }
}

export interface ExplainMeta {
  provider: string
  model: string
  effort: PlanEffortMeta
  digestChars: number
  truncated: boolean
  usage: LlmUsage
  costUsd: number | null
  repaired: boolean
}

export interface ExplainResult extends ExplainAnswer {
  signals: ExplainSignal[]
  meta: ExplainMeta
}

export type ExplainErrorKind = 'provider' | 'invalid' | 'aborted'

export class ExplainError extends Error {
  readonly kind: ExplainErrorKind

  constructor(kind: ExplainErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExplainError'
    this.kind = kind
  }
}

export function isFailedLike(status: ExplainStep['status']): boolean {
  return status === 'failed' || status === 'continued' || status === 'abandoned'
}
