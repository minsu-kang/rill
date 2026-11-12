import type { Workflow } from '@rill/dsl'
import { fieldRoles, valueAtPointer, type ConnectionResolver, type NodeRegistry } from '@rill/nodes-core'
import type { RunSummaryRow, StepDetailRow } from './store'

export const MAX_CONCURRENT_EXPLAINS = 2

export class RunNotExplainableError extends Error {
  constructor() {
    super('only a finished run that failed or has a failed step can be explained')
    this.name = 'RunNotExplainableError'
  }
}

export class ExplainBusyError extends Error {
  constructor(limit: number) {
    super(`too many explanations are running (at most ${limit} at a time)`)
    this.name = 'ExplainBusyError'
  }
}

const FAILED_ATTEMPTS: ReadonlySet<string> = new Set(['failed', 'abandoned', 'continued'])

export function isExplainable(run: Pick<RunSummaryRow, 'status'>, steps: readonly Pick<StepDetailRow, 'status'>[]): boolean {
  if (run.status === 'queued' || run.status === 'running') return false
  return run.status === 'failed' || steps.some((step) => FAILED_ATTEMPTS.has(step.status))
}

export function connectionSecrets(workflow: Workflow, steps: readonly StepDetailRow[], registry: NodeRegistry, connections: ConnectionResolver): string[] {
  const inputs = new Map<string, unknown[]>()
  for (const step of steps) {
    const list = inputs.get(step.nodeId)
    if (list === undefined) inputs.set(step.nodeId, [step.input])
    else list.push(step.input)
  }
  const names = new Set<string>()
  for (const node of workflow.nodes) {
    const def = registry.get(node.type)
    if (def === undefined) continue
    for (const { pointer, role } of fieldRoles(def)) {
      if (role !== 'connection') continue
      for (const source of [node.config, ...(inputs.get(node.id) ?? [])]) {
        const name = valueAtPointer(source, pointer)
        if (typeof name === 'string') names.add(name)
      }
    }
  }
  const secrets: string[] = []
  for (const name of names) {
    try {
      const secret = connections.get(name)
      if (secret !== undefined) secrets.push(secret)
    } catch {
      continue
    }
  }
  return secrets
}
