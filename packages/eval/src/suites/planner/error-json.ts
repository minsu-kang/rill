import type { PlanError } from '@rill/planner'

const MAX_CAUSE_CHARS = 300

function causeMessage(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined
  const text = cause.message.replace(/\s+/gu, ' ').trim()
  return text.length > MAX_CAUSE_CHARS ? `${text.slice(0, MAX_CAUSE_CHARS)}...` : text
}

export function planErrorJson(error: PlanError): Record<string, unknown> {
  const cause = causeMessage(error.cause)
  return {
    name: error.name,
    kind: error.kind,
    message: error.message,
    ...(cause === undefined ? {} : { cause }),
    rounds: error.rounds,
    lastIssues: error.lastIssues,
  }
}

export function serializablePlanError(error: PlanError): PlanError {
  Object.defineProperty(error, 'toJSON', { value: () => planErrorJson(error), enumerable: false, configurable: true })
  return error
}
