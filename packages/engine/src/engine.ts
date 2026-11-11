import { isTrigger, parseWorkflowShape, validateGraph, validateReferences, type Workflow } from '@rill/dsl'
import { declaredBranches, type ConnectionResolver, type NodeRegistry } from '@rill/nodes-core'
import type { Db } from './db'
import { EventBus, type EngineListener } from './events'
import { RunExecutor, type RunResult } from './executor'
import { RunQueue } from './queue'
import { Store } from './store'

export { computeBackoff, type RunResult } from './executor'

export interface EngineOptions {
  db: Db
  registry: NodeRegistry
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  allowedRoots?: string[]
  connections?: ConnectionResolver
  maxConcurrentRuns?: number
}

export class WorkflowValidationError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`invalid workflow: ${problems.join('; ')}`)
    this.name = 'WorkflowValidationError'
    this.problems = problems
  }
}

export class Engine {
  readonly store: Store
  private readonly registry: NodeRegistry
  private readonly executor: RunExecutor
  private readonly bus: EventBus
  private readonly queue: RunQueue

  constructor(options: EngineOptions) {
    const now = options.now ?? (() => Date.now())
    this.store = new Store(options.db, now)
    this.registry = options.registry
    this.bus = new EventBus(now)
    this.queue = new RunQueue(options.maxConcurrentRuns ?? 4)
    this.executor = new RunExecutor({
      store: this.store,
      registry: options.registry,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      allowedRoots: options.allowedRoots,
      connections: options.connections ?? { get: () => undefined },
      emit: (event) => this.bus.emit(event),
    })
  }

  on(listener: EngineListener): () => void {
    return this.bus.on(listener)
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

  enqueueRun(
    workflowId: string,
    payload: unknown = {},
    options: { dryRun?: boolean } = {},
  ): { runId: string; done: Promise<RunResult> } {
    const run = this.store.createRun({ workflowId, payload, dryRun: options.dryRun ?? false })
    return { runId: run.id, done: this.queue.run(() => this.executor.execute(run)) }
  }

  async startRun(workflowId: string, payload: unknown = {}, options: { dryRun?: boolean } = {}): Promise<RunResult> {
    return this.enqueueRun(workflowId, payload, options).done
  }

  async idle(): Promise<void> {
    await this.queue.idle()
  }

  async recover(): Promise<RunResult[]> {
    const pending = [...this.store.listRunsByStatus('running'), ...this.store.listRunsByStatus('queued')]
    const results: RunResult[] = []
    for (const run of pending) results.push(await this.executor.execute(run))
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
}
