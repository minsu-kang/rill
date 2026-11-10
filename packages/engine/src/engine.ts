import {
  incomingEdges,
  isTrigger,
  parseWorkflowShape,
  resolveTemplates,
  topologicalOrder,
  validateGraph,
  validateReferences,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from '@rill/dsl'
import {
  RetryableError,
  declaredBranches,
  type ActionNodeDefinition,
  type ConnectionResolver,
  type NodeRegistry,
} from '@rill/nodes-core'
import Value from 'typebox/value'
import type { Db } from './db'
import { Store, type RunRow } from './store'

export interface EngineOptions {
  db: Db
  registry: NodeRegistry
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  allowedRoots?: string[]
  connections?: ConnectionResolver
}

export interface RunResult {
  runId: string
  status: 'succeeded' | 'failed'
  error: string | null
  outputs: Record<string, unknown>
}

type NodeOutcome = { ok: true; output: unknown } | { ok: false; error: string; attempt: number }

export class WorkflowValidationError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`invalid workflow: ${problems.join('; ')}`)
    this.name = 'WorkflowValidationError'
    this.problems = problems
  }
}

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

export class Engine {
  readonly store: Store
  private readonly registry: NodeRegistry
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly allowedRoots: string[] | undefined
  private readonly connections: ConnectionResolver

  constructor(options: EngineOptions) {
    this.store = new Store(options.db, options.now)
    this.registry = options.registry
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
    this.allowedRoots = options.allowedRoots
    this.connections = options.connections ?? { get: () => undefined }
  }

  deploy(input: unknown): string {
    const parsed = parseWorkflowShape(input)
    if (!parsed.ok) throw new WorkflowValidationError(parsed.errors)
    const problems = [
      ...validateGraph(parsed.workflow),
      ...validateReferences(parsed.workflow),
      ...this.registryProblems(parsed.workflow),
    ]
    if (problems.length > 0) throw new WorkflowValidationError(problems)
    return this.store.saveWorkflow(parsed.workflow)
  }

  async startRun(workflowId: string, payload: unknown = {}, options: { dryRun?: boolean } = {}): Promise<RunResult> {
    const run = this.store.createRun({ workflowId, payload, dryRun: options.dryRun ?? false })
    return this.executeRun(run)
  }

  async recover(): Promise<RunResult[]> {
    const pending = [...this.store.listRunsByStatus('running'), ...this.store.listRunsByStatus('queued')]
    const results: RunResult[] = []
    for (const run of pending) results.push(await this.executeRun(run))
    return results
  }

  private registryProblems(workflow: Workflow): string[] {
    const problems: string[] = []
    const typeOf = new Map(workflow.nodes.map((n) => [n.id, n.type]))
    for (const node of workflow.nodes) {
      const def = this.registry.get(node.type)
      if (!def) problems.push(`unknown node type: ${node.type}`)
      else if ((def.kind === 'trigger') !== isTrigger(node.type)) problems.push(`node type kind mismatch: ${node.type}`)
    }
    for (const edge of workflow.edges) {
      if (edge.when === undefined) continue
      const source = this.registry.get(typeOf.get(edge.from) ?? '')
      if (!source || source.kind === 'trigger') continue
      const labels = declaredBranches(source)
      if (labels === null) {
        problems.push(`edge ${edge.from} -> ${edge.to}: ${edge.from} never produces a branch, remove "when"`)
      } else if (labels !== 'any' && !labels.includes(edge.when)) {
        problems.push(`edge ${edge.from} -> ${edge.to}: "${edge.when}" is not one of ${labels.join(', ')}`)
      }
    }
    return problems
  }

  private async executeRun(run: RunRow): Promise<RunResult> {
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
