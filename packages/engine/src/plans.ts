import { createHash } from 'node:crypto'
import type { PlanRecord } from '@rill/protocol'

export type StoredPlan = PlanRecord & { workflowHash: string | null }

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
  constructor(planId: string) {
    super(`the plan is already deployed or cannot be deployed: ${planId}`)
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

export function workflowHash(workflow: unknown): string {
  const source = typeof workflow === 'object' && workflow !== null ? (workflow as Record<string, unknown>) : {}
  const content = JSON.parse(JSON.stringify({ schemaVersion: source.schemaVersion, nodes: source.nodes, edges: source.edges }))
  return createHash('sha256').update(canonical(content)).digest('hex')
}
