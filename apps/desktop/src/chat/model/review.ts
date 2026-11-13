import type { ReviewResult } from '@rill/protocol'
import type { MessageKey } from '../../i18n'

export type ReviewState =
  | { phase: 'idle' }
  | { phase: 'asking'; agentId: string; requestId: number }
  | { phase: 'done'; agentId: string; result: ReviewResult }
  | { phase: 'error'; agentId: string; key: MessageKey }

export const IDLE_REVIEW: ReviewState = { phase: 'idle' }

const KEYS: Readonly<Record<string, MessageKey>> = {
  NOT_FOUND: 'chat.review.error.notFound',
  PLAN_NOT_REVIEWABLE: 'chat.review.error.notReviewable',
  AGENT_NOT_FOUND: 'chat.review.error.agentNotFound',
  AGENT_NOT_REVIEWER: 'chat.review.error.notReviewer',
  LLM_UNAVAILABLE: 'chat.review.error.llmUnavailable',
  REVIEW_BUSY: 'chat.review.error.busy',
  REVIEW_PROVIDER: 'chat.review.error.provider',
  REVIEW_INVALID: 'chat.review.error.invalid',
  INVALID_PARAMS: 'chat.review.error.params',
}

export function reviewErrorKey(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && Object.hasOwn(KEYS, code) ? KEYS[code]! : 'chat.review.error.generic'
}

export function reloadsAgents(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 'AGENT_NOT_FOUND' || code === 'AGENT_NOT_REVIEWER'
}
