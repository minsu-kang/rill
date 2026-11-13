import { renderUserTurn } from '@rill/planner'
import type { PlanTurn } from '@rill/protocol'

export const MAX_CONCURRENT_REVIEWS = 1
export const MAX_REVIEW_REQUEST_CHARS = 16_000
export const REVIEW_REQUEST_CUT = '[Earlier messages are left out.]'

const SEPARATOR = '\n\n'

export class PlanNotReviewableError extends Error {
  constructor() {
    super('only a plan with a workflow can be reviewed')
    this.name = 'PlanNotReviewableError'
  }
}

export class ReviewBusyError extends Error {
  constructor() {
    super('a review is already running; wait for it to finish')
    this.name = 'ReviewBusyError'
  }
}

const length = (text: string): number => [...text].length

export function reviewRequestText(text: string, turns: readonly PlanTurn[]): string {
  const messages = [...turns.filter((turn) => turn.role === 'user').map(renderUserTurn).filter((message) => message !== ''), text]
  const kept: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const size = length(message) + (kept.length === 0 ? 0 : SEPARATOR.length)
    if (used + size > MAX_REVIEW_REQUEST_CHARS) break
    kept.unshift(message)
    used += size
  }
  if (kept.length === messages.length) return kept.join(SEPARATOR)
  const body = kept.length === 0 ? [...text].slice(0, MAX_REVIEW_REQUEST_CHARS).join('') : kept.join(SEPARATOR)
  return `${REVIEW_REQUEST_CUT}${SEPARATOR}${body}`
}
