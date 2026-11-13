import type { Workflow } from '@rill/dsl'
import { connectionSecretParts, fieldRoles, valueAtPointer, type ConnectionResolver, type NodeRegistry } from '@rill/nodes-core'
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
const CONNECTION_KEY = /connection$/i
const MAX_NAME_LENGTH = 200
const MAX_VISITS = 20_000
const MAX_NAME_DEPTH = 12

export function isExplainable(run: Pick<RunSummaryRow, 'status'>, steps: readonly Pick<StepDetailRow, 'status'>[]): boolean {
  if (run.status === 'queued' || run.status === 'running') return false
  return run.status === 'failed' || steps.some((step) => FAILED_ATTEMPTS.has(step.status))
}

function namesUnderConnectionKeys(value: unknown, names: Set<string>): void {
  let visits = 0
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_NAME_DEPTH || typeof node !== 'object' || node === null || visits >= MAX_VISITS) return
    for (const [key, entry] of Object.entries(node)) {
      visits += 1
      if (typeof entry === 'string') {
        if (CONNECTION_KEY.test(key) && entry.length <= MAX_NAME_LENGTH) names.add(entry)
      } else walk(entry, depth + 1)
    }
  }
  walk(value, 0)
}

export function connectionSecrets(
  workflow: Workflow,
  steps: readonly StepDetailRow[],
  registry: NodeRegistry,
  connections: ConnectionResolver,
  configured: readonly string[] = [],
): string[] {
  const inputs = new Map<string, unknown[]>()
  for (const step of steps) {
    const list = inputs.get(step.nodeId)
    if (list === undefined) inputs.set(step.nodeId, [step.input])
    else list.push(step.input)
  }
  const names = new Set<string>(configured)
  for (const node of workflow.nodes) {
    const def = registry.get(node.type)
    if (def === undefined) {
      namesUnderConnectionKeys([node.config, ...(inputs.get(node.id) ?? [])], names)
      continue
    }
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
      if (secret !== undefined) secrets.push(secret, ...connectionSecretParts(secret))
    } catch {
      continue
    }
  }
  return secrets
}
