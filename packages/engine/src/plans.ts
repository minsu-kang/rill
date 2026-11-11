import { createHash } from 'node:crypto'
import { PlanError, addUsage, type PlanErrorKind, type PlanResult } from '@rill/planner'
import {
  flagKey,
  type AttachmentRef,
  type PlanEffort,
  type PlanMeta,
  type PlanRecord,
  type PlanResultBody,
} from '@rill/protocol'

export type StoredPlan = PlanRecord & { workflowHash: string | null }

export interface PlanOutcome {
  planId: string
  result: PlanResultBody
  meta: PlanMeta
}

interface PlanSource {
  planId: string
  text: string
  attachments: AttachmentRef[]
  effort: PlanEffort
}

export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`plan not found: ${planId}`)
    this.name = 'PlanNotFoundError'
  }
}

export class PlanExistsError extends Error {
  constructor(planId: string) {
    super(`a plan with this id already exists: ${planId}`)
    this.name = 'PlanExistsError'
  }
}

export class PlanBusyError extends Error {
  constructor(limit: number) {
    super(`too many plans are running (at most ${limit} at a time)`)
    this.name = 'PlanBusyError'
  }
}

export class PlanNotConfirmedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanNotConfirmedError'
  }
}

export class PlanDeployedError extends Error {
  constructor(planId: string, reason = 'the plan is already deployed') {
    super(`${reason}: ${planId}`)
    this.name = 'PlanDeployedError'
  }
}

export class LlmUnavailableError extends Error {
  constructor() {
    super('no model provider is configured for planning')
    this.name = 'LlmUnavailableError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DEFAULT_BASE_DELAY_MS = 500

function normalizedRetry(retry: unknown): unknown {
  if (!isRecord(retry)) return retry
  if (retry.maxAttempts === 1) return undefined
  return { ...retry, baseDelayMs: retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS }
}

function normalizedNode(node: unknown): unknown {
  if (!isRecord(node)) return node
  const { onError, retry, ...rest } = node
  return { ...rest, onError: onError === 'fail' ? undefined : onError, retry: normalizedRetry(retry) }
}

function unordered(items: unknown): unknown {
  if (!Array.isArray(items)) return items
  return items
    .map((item) => [canonical(item), item] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item)
}

export function workflowHash(workflow: unknown): string {
  const source = isRecord(workflow) ? workflow : {}
  const plain = JSON.parse(JSON.stringify({ schemaVersion: source.schemaVersion, nodes: source.nodes, edges: source.edges })) as Record<string, unknown>
  const nodes = Array.isArray(plain.nodes) ? plain.nodes.map(normalizedNode) : plain.nodes
  const content = JSON.parse(JSON.stringify({ schemaVersion: plain.schemaVersion, nodes, edges: plain.edges })) as Record<string, unknown>
  return createHash('sha256')
    .update(canonical({ schemaVersion: content.schemaVersion, nodes: unordered(content.nodes), edges: unordered(content.edges) }))
    .digest('hex')
}

export function toPlanRecord(stored: StoredPlan): PlanRecord {
  return {
    planId: stored.planId,
    createdAt: stored.createdAt,
    status: stored.status,
    effort: stored.effort,
    model: stored.model,
    requestText: stored.requestText,
    attachments: stored.attachments,
    result: stored.result,
    meta: stored.meta,
    error: stored.error,
    flagKeys: stored.flagKeys,
    workflowId: stored.workflowId,
    confirmed: stored.confirmed,
  }
}

function resultBody(result: PlanResultBody): PlanResultBody {
  switch (result.kind) {
    case 'workflow':
      return {
        kind: 'workflow',
        workflow: result.workflow,
        summary: result.summary,
        ...(result.patch === undefined ? {} : { patch: result.patch }),
        flags: result.flags.map(({ nodeId, pointer, code, message }) => ({ nodeId, pointer, code, message })),
        needsConfirmation: result.needsConfirmation,
      }
    case 'questions':
      return { kind: 'questions', questions: result.questions, summary: result.summary }
    case 'unsupported':
      return { kind: 'unsupported', reason: result.reason, nearest: result.nearest, summary: result.summary }
  }
}

export function plannedRecord(source: PlanSource, planned: PlanResult, createdAt: number): { record: StoredPlan; outcome: PlanOutcome } {
  const result = resultBody(planned)
  const meta: PlanMeta = {
    rounds: planned.rounds,
    usage: planned.usage,
    costUsd: planned.costUsd,
    model: planned.model,
    effort: planned.effort,
    fallbackUsed: planned.fallbackUsed,
  }
  const record: StoredPlan = {
    planId: source.planId,
    createdAt,
    status: 'planned',
    effort: source.effort,
    model: planned.model,
    requestText: source.text,
    attachments: source.attachments,
    result,
    meta,
    error: null,
    flagKeys: result.kind === 'workflow' ? [...new Set(result.flags.map(flagKey))] : [],
    workflowId: null,
    confirmed: null,
    workflowHash: result.kind === 'workflow' ? workflowHash(result.workflow) : null,
  }
  return { record, outcome: { planId: source.planId, result, meta } }
}

const FAILURE_TEXT: Record<PlanErrorKind, string> = {
  invalid_after_repair: 'the plan was not valid after the repair rounds',
  invalid_request: 'the request could not be planned',
  provider: 'the model provider failed',
  aborted: 'planning was cancelled',
  attachment: 'an attachment could not be used',
}

export function failedRecord(source: PlanSource, error: unknown, createdAt: number): StoredPlan {
  const planError = error instanceof PlanError ? error : undefined
  const rounds = planError?.rounds ?? []
  const meta: PlanMeta | null =
    rounds.length === 0
      ? null
      : {
          rounds,
          usage: rounds.reduce(
            (sum, round) => addUsage(sum, round.usage),
            { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          ),
          costUsd: null,
          model: '',
          effort: source.effort,
          fallbackUsed: false,
        }
  return {
    planId: source.planId,
    createdAt,
    status: planError?.kind === 'aborted' ? 'cancelled' : 'failed',
    effort: source.effort,
    model: null,
    requestText: source.text,
    attachments: source.attachments,
    result: null,
    meta,
    error: planError === undefined ? 'planning failed unexpectedly' : FAILURE_TEXT[planError.kind],
    flagKeys: [],
    workflowId: null,
    confirmed: null,
    workflowHash: null,
  }
}

const MAX_LISTED_FLAGS = 20

function describeFlagKey(key: string): string {
  try {
    const [nodeId, pointer] = JSON.parse(key) as [string, string]
    return `${nodeId} at ${pointer}`
  } catch {
    return 'an unreadable flag'
  }
}

export function confirmationProblem(flagKeys: readonly string[], confirmed: readonly string[]): string | undefined {
  const known = new Set(flagKeys)
  const given = new Set(confirmed)
  const missing = flagKeys.filter((key) => !given.has(key))
  const unknown = [...given].filter((key) => !known.has(key)).length
  const parts: string[] = []
  if (missing.length > 0) {
    const listed = missing.slice(0, MAX_LISTED_FLAGS).map(describeFlagKey)
    const more = missing.length > listed.length ? ` and ${missing.length - listed.length} more` : ''
    parts.push(`confirm every flag before deploying; not confirmed: ${listed.join(', ')}${more}`)
  }
  if (unknown > 0) parts.push(`${unknown} confirmed ${unknown === 1 ? 'key is' : 'keys are'} not a flag of this plan`)
  return parts.length === 0 ? undefined : parts.join('; ')
}
