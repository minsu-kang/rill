import { agentNameKey, isReservedAgentName, normaliseAgentField, type Agent, type AgentFields, type AgentKind } from '@rill/protocol'
import type { FileProblem } from '../agent-file'
import { draftProblems, hasProblems, type DraftProblems } from './draft'
import type { ReviewState } from './view'

export interface ReviewOutcome {
  fields: AgentFields | undefined
  kind?: AgentKind
  fileProblems: FileProblem[]
  fieldProblems: DraftProblems
  duplicate: boolean
  canSave: boolean
}

export function reviewOutcome(review: ReviewState, agents: readonly Agent[]): ReviewOutcome {
  if (review.base === undefined) return { fields: undefined, fileProblems: review.fileProblems, fieldProblems: {}, duplicate: false, canSave: false }
  const fields: AgentFields = { ...review.base, name: review.name, description: review.description }
  const fieldProblems = draftProblems(fields)
  const named = normaliseAgentField('name', fields.name)
  const duplicate = named.ok && (isReservedAgentName(named.value) || agents.some((agent) => !agent.builtin && agentNameKey(agent.name) === agentNameKey(named.value)))
  return { fields, ...(review.kind === undefined ? {} : { kind: review.kind }), fileProblems: review.fileProblems, fieldProblems, duplicate, canSave: review.fileProblems.length === 0 && !hasProblems(fieldProblems) && !duplicate }
}

const FILE_NAME_CLEANUP = /[\p{Cc}/\\:*?"<>|]+/gu

export function exportFileName(name: string, fallback = 'agent'): string {
  const cleaned = [...name.replace(FILE_NAME_CLEANUP, '-').trim()].slice(0, 120).join('').trim()
  return cleaned === '' || /^\.+$/.test(cleaned) ? fallback : cleaned
}
