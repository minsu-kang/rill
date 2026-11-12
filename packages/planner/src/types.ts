import type { PlanIssue, Workflow, WorkflowEdge, WorkflowNode } from '@rill/dsl'
import type { ImageMediaType, LlmEffort, LlmUsage } from '@rill/llm'

export type PlanEffort = LlmEffort

export type AttachmentMediaType = 'application/pdf' | ImageMediaType | 'text/plain' | 'text/csv' | 'text/markdown'

export interface AttachmentRef {
  id: string
  mediaType: AttachmentMediaType
  name: string
  bytes: number
}

export type PatchOp =
  | { op: 'add_node'; node: WorkflowNode }
  | { op: 'set_config'; nodeId: string; config: Record<string, unknown>; retry?: WorkflowNode['retry']; onError?: WorkflowNode['onError'] }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'connect'; edge: WorkflowEdge }
  | { op: 'disconnect'; from: string; to: string }

export interface PlanQuestion {
  id: string
  text: string
  options: string[]
  default: string
}

export interface Flag {
  nodeId: string
  /** The flagged config pointer: a role field, or the left or right operand of a condition@1 (untrusted_flow). */
  pointer: string
  code: 'attachment_origin' | 'new_egress_target' | 'untrusted_flow'
  message: string
}

export type PlanResultBody =
  | { kind: 'workflow'; workflow: Workflow; summary: string; patch?: PatchOp[]; flags: Flag[]; needsConfirmation: boolean }
  | { kind: 'questions'; questions: PlanQuestion[]; summary: string }
  | { kind: 'unsupported'; reason: string; nearest: string; summary: string }

export interface PlanTurn {
  role: 'user' | 'assistant'
  text: string
  attachments?: AttachmentRef[]
  result?: PlanResultBody
  answers?: Record<string, string>
}

export interface PlanConnection {
  name: string
  kind: 'slack' | 'http' | 'webhookSecret'
}

export interface PlanContext {
  connections: PlanConnection[]
  allowedRoots: string[]
  existingWorkflow?: Workflow
  attachmentsRoot: string
}

export interface PlanRequest {
  text: string
  turns: PlanTurn[]
  attachments: AttachmentRef[]
  effort: PlanEffort
  selection?: { nodeId: string }
  context: PlanContext
  signal?: AbortSignal
}

export interface PlanRound {
  index: number
  issues: PlanIssue[]
  usage: LlmUsage
  durationMs: number
  targeted: string[]
}

export type PlanResult = PlanResultBody & {
  rounds: PlanRound[]
  usage: LlmUsage
  /**
   * Upper bound in USD: each call's usage priced at the most expensive of the models that served it
   * (the final model and any fallback models), including calls whose reply was unreadable and that
   * reported their usage on the error. Null when one of those models has no price, or when an
   * unreadable reply reported no usage at all: the total is then not a known upper bound.
   */
  costUsd: number | null
  model: string
  /** The effort the caller asked for; meta.effort.effective is the level that ran. */
  effort: PlanEffort
  fallbackUsed: boolean
  meta: PlanProviderMeta
}

export interface PlanEffortMeta {
  requested: PlanEffort
  effective: PlanEffort
  native: string
  collapsed: boolean
}

export interface PlanProviderMeta {
  provider: string
  effort: PlanEffortMeta
  reasoningCapped: boolean
  costNote?: string
}

export type PlanErrorKind = 'invalid_request' | 'invalid_after_repair' | 'provider' | 'aborted' | 'attachment'

export class PlanError extends Error {
  readonly kind: PlanErrorKind
  readonly rounds: PlanRound[]
  readonly lastIssues: PlanIssue[]

  constructor(kind: PlanErrorKind, message: string, rounds: PlanRound[], lastIssues: PlanIssue[], options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlanError'
    this.kind = kind
    this.rounds = rounds
    this.lastIssues = lastIssues
  }
}
