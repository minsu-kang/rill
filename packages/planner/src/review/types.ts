import type { Workflow } from '@rill/dsl'
import type { LlmUsage } from '@rill/llm'
import type { Flag, PlanAgent, PlanEffortMeta, PlanRules } from '../types'

export const REVIEW_SEVERITIES = ['problem', 'warning', 'info'] as const

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]
export type ReviewEffort = 'low' | 'medium' | 'high'

export interface ReviewFinding {
  severity: ReviewSeverity
  text: string
  nodeId?: string
}

export interface ReviewAnswer {
  summary: string
  findings: ReviewFinding[]
}

export type ReviewFlag = Pick<Flag, 'nodeId' | 'pointer' | 'code'>

export interface ReviewRequest {
  workflow: Workflow
  requestText: string
  flags: readonly ReviewFlag[]
  rules?: PlanRules
  agent: PlanAgent
  effort?: ReviewEffort
  signal?: AbortSignal
}

export interface ReviewMeta {
  provider: string
  model: string
  effort: PlanEffortMeta
  costNote?: string
  usage: LlmUsage
  costUsd: number | null
  repaired: boolean
  agentUsed: { id: string; name: string }
  skillsUsed: number
  agentDropped: number
}

export interface ReviewResult {
  review: ReviewAnswer
  meta: ReviewMeta
}

export type ReviewErrorKind = 'provider' | 'invalid' | 'aborted'

export class ReviewError extends Error {
  readonly kind: ReviewErrorKind

  constructor(kind: ReviewErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ReviewError'
    this.kind = kind
  }
}
