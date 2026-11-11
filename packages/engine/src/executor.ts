import {
  incomingEdges,
  resolveTemplates,
  topologicalOrder,
  type WorkflowEdge,
  type WorkflowNode,
} from '@rill/dsl'
import { RetryableError, type ActionNodeDefinition, type ConnectionResolver, type NodeRegistry } from '@rill/nodes-core'
import Value from 'typebox/value'
import type { RunRow, Store } from './store'

export interface RunResult {
  runId: string
  status: 'succeeded' | 'failed'
  error: string | null
  outputs: Record<string, unknown>
}

type NodeOutcome = { ok: true; output: unknown } | { ok: false; error: string; attempt: number }

export function computeBackoff(failures: number, baseDelayMs: number, random: () => number): number {
  const ceiling = Math.min(baseDelayMs * 2 ** (failures - 1), 30_000)
  return Math.floor(random() * ceiling)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function branchOf(output: unknown): string | undefined {
  if (output === null || typeof output !== 'object' || !('branch' in output)) return undefined
  const branch = (output as { branch: unknown }).branch
  return typeof branch === 'string' ? branch : undefined
}

function edgeFires(edge: WorkflowEdge, sourceOutput: unknown): boolean {
  return edge.when === undefined || branchOf(sourceOutput) === edge.when
}

export interface ExecutorDeps {
  store: Store
  registry: NodeRegistry
  sleep: (ms: number) => Promise<void>
  random: () => number
  allowedRoots: string[] | undefined
  connections: ConnectionResolver
}

export class RunExecutor {
  private readonly store: Store
  private readonly registry: NodeRegistry
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly allowedRoots: string[] | undefined
  private readonly connections: ConnectionResolver

  constructor(deps: ExecutorDeps) {
    this.store = deps.store
    this.registry = deps.registry
    this.sleep = deps.sleep
    this.random = deps.random
    this.allowedRoots = deps.allowedRoots
    this.connections = deps.connections
  }

  async execute(run: RunRow): Promise<RunResult> {
    const workflow = this.store.getWorkflow(run.workflowId)
    const order = topologicalOrder(workflow)
    const outputs: Record<string, unknown> = {}
    if (!order) return this.failRun(run.id, 'graph contains a cycle', outputs)
    const nodes = new Map(workflow.nodes.map((n) => [n.id, n]))
    const settled = new Map<string, 'done' | 'skipped'>()
    this.store.abandonRunningAttempts(run.id)
    this.store.markRunRunning(run.id)
    for (const id of order) {
      const node = nodes.get(id)!
      const def = this.registry.get(node.type)
      if (!def) return this.failRun(run.id, `unknown node type: ${node.type}`, outputs)
      if (def.kind === 'trigger') {
        outputs[id] = run.payload
        settled.set(id, 'done')
        continue
      }
      const active = incomingEdges(workflow, id).some(
        (edge) => settled.get(edge.from) === 'done' && edgeFires(edge, outputs[edge.from]),
      )
      if (!active) {
        this.store.recordSkipped(run.id, id, `${run.id}:${id}`)
        settled.set(id, 'skipped')
        continue
      }
      if (this.store.isContinued(run.id, id)) {
        outputs[id] = null
        settled.set(id, 'done')
        continue
      }
      const finished = this.store.latestSucceededOutput(run.id, id)
      if (finished) {
        outputs[id] = finished.output
        settled.set(id, 'done')
        continue
      }
      const outcome = await this.runNode(run, node, def, outputs)
      if (outcome.ok) {
        outputs[id] = outcome.output
        settled.set(id, 'done')
      } else if (node.onError === 'continue') {
        this.store.markContinued(run.id, id, outcome.attempt)
        outputs[id] = null
        settled.set(id, 'done')
      } else {
        return this.failRun(run.id, `node ${id} failed: ${outcome.error}`, outputs)
      }
    }
    this.store.finishRun(run.id, 'succeeded')
    return { runId: run.id, status: 'succeeded', error: null, outputs }
  }

  private failRun(runId: string, error: string, outputs: Record<string, unknown>): RunResult {
    this.store.finishRun(runId, 'failed', error)
    return { runId, status: 'failed', error, outputs }
  }

  private async runNode(
    run: RunRow,
    node: WorkflowNode,
    def: ActionNodeDefinition,
    outputs: Record<string, unknown>,
  ): Promise<NodeOutcome> {
    const idempotencyKey = `${run.id}:${node.id}`
    let config: unknown
    try {
      config = resolveTemplates(node.config, outputs, { lenient: def.lenientRefs === true })
      if (!Value.Check(def.configSchema, config)) {
        const detail = [...Value.Errors(def.configSchema, config)]
          .map((e) => `${e.instancePath || '/'}: ${e.message}`)
          .join('; ')
        throw new Error(`invalid config: ${detail}`)
      }
    } catch (error) {
      const attempt = this.store.startAttempt({ runId: run.id, nodeId: node.id, input: node.config, idempotencyKey })
      const message = errorMessage(error)
      this.store.finishAttempt(run.id, node.id, attempt, { status: 'failed', error: message })
      return { ok: false, error: message, attempt }
    }

    const maxAttempts = node.retry?.maxAttempts ?? 1
    let failures = 0
    for (;;) {
      const attempt = this.store.startAttempt({ runId: run.id, nodeId: node.id, input: config, idempotencyKey })
      try {
        const output =
          (await def.execute(config, {
            runId: run.id,
            nodeId: node.id,
            attempt,
            dryRun: run.dryRun,
            idempotencyKey,
            journal: this.store.journal(),
            sleep: this.sleep,
            allowedRoots: this.allowedRoots,
            connections: this.connections,
          })) ?? null
        this.store.finishAttempt(run.id, node.id, attempt, { status: 'succeeded', output })
        return { ok: true, output }
      } catch (error) {
        failures += 1
        const message = errorMessage(error)
        this.store.finishAttempt(run.id, node.id, attempt, { status: 'failed', error: message })
        if (!(error instanceof RetryableError) || failures >= maxAttempts) return { ok: false, error: message, attempt }
        await this.sleep(computeBackoff(failures, node.retry?.baseDelayMs ?? 500, this.random))
      }
    }
  }
}
