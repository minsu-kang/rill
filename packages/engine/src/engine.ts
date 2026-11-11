import { isTrigger, parseWorkflowShape, validateGraph, validateReferences, type Workflow } from '@rill/dsl'
import {
  declaredBranches,
  type ConnectionResolver,
  type NodeRegistry,
  type TriggerNodeDefinition,
} from '@rill/nodes-core'
import type { LlmProvider } from '@rill/llm'
import type { NodeInfo, RunSummary, StepDetail, WorkflowSummary } from '@rill/protocol'
import Value from 'typebox/value'
import { systemClock, type Clock } from './clock'
import type { Db } from './db'
import { EventBus, type EngineListener } from './events'
import { RunExecutor, type RunResult } from './executor'
import { RunQueue } from './queue'
import { Store, type RunRow } from './store'
import { TriggerManager } from './triggers/manager'
import type { FireOptions } from './triggers/types'

export { computeBackoff, type RunResult } from './executor'

export interface EngineOptions {
  db: Db
  registry: NodeRegistry
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  clock?: Clock
  allowedRoots?: string[]
  connections?: ConnectionResolver
  maxConcurrentRuns?: number
  webhookPort?: number
  llm?: LlmProvider
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
  private readonly triggers: TriggerManager
  private readonly owned = new Set<string>()

  constructor(options: EngineOptions) {
    const clock = options.clock ?? systemClock
    const now = options.now ?? (() => clock.now())
    const connections = options.connections ?? { get: () => undefined }
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
      connections,
      llm: options.llm,
      emit: (event) => this.bus.emit(event),
    })
    this.triggers = new TriggerManager({
      store: this.store,
      registry: options.registry,
      clock,
      fire: (workflowId, payload, fireOptions) => this.fire(workflowId, payload, fireOptions),
      isBusy: (workflowId) => this.store.hasActiveRun(workflowId),
      emit: (event) => this.bus.emit(event),
      allowedRoots: options.allowedRoots,
      connections,
      webhookPort: options.webhookPort ?? 0,
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
    options: { dryRun?: boolean; deferStart?: boolean } = {},
  ): { runId: string; done: Promise<RunResult> } {
    const run = this.store.createRun({ workflowId, payload, dryRun: options.dryRun ?? false })
    return { runId: run.id, done: this.track(run, options.deferStart ?? false) }
  }

  async startRun(workflowId: string, payload: unknown = {}, options: { dryRun?: boolean } = {}): Promise<RunResult> {
    return this.enqueueRun(workflowId, payload, options).done
  }

  async recover(): Promise<RunResult[]> {
    const pending = [...this.store.listRunsByStatus('running'), ...this.store.listRunsByStatus('queued')].filter(
      (run) => !this.owned.has(run.id),
    )
    const results: RunResult[] = []
    for (const run of pending) {
      this.owned.add(run.id)
      try {
        results.push(await this.executor.execute(run))
      } finally {
        this.owned.delete(run.id)
      }
    }
    return results
  }

  listWorkflows(): WorkflowSummary[] {
    return this.store.listStoredWorkflows().map((stored) => ({
      id: stored.id,
      name: stored.name,
      active: stored.active,
      triggerType: stored.workflow.nodes.find((node) => isTrigger(node.type))?.type ?? 'unknown',
      createdAt: stored.createdAt,
    }))
  }

  getWorkflow(workflowId: string): Workflow {
    return this.store.getWorkflow(workflowId)
  }

  listRuns(options: { workflowId?: string; limit?: number } = {}): RunSummary[] {
    const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : 50
    const limit = Math.min(Math.max(requested, 1), 200)
    return this.store.listRunSummaries({ workflowId: options.workflowId, limit })
  }

  getRunDetail(runId: string): { run: RunSummary; steps: StepDetail[] } {
    return { run: this.store.getRunSummary(runId), steps: this.store.listStepDetails(runId) }
  }

  nodeCatalog(): NodeInfo[] {
    return this.registry.list().map((def) =>
      def.kind === 'trigger'
        ? {
            type: def.type,
            kind: 'trigger' as const,
            title: def.title,
            description: def.description,
            configSchema: def.configSchema,
            outputSchema: def.outputSchema,
          }
        : {
            type: def.type,
            kind: 'action' as const,
            title: def.title,
            description: def.description,
            sideEffect: def.sideEffect,
            configSchema: def.configSchema,
            outputSchema: def.outputSchema,
          },
    )
  }

  async activate(workflowId: string): Promise<void> {
    await this.triggers.activate(workflowId)
  }

  deactivate(workflowId: string): void {
    this.triggers.deactivate(workflowId)
  }

  async resumeActive(): Promise<void> {
    await this.triggers.resumeActive()
  }

  webhookPort(): number | undefined {
    return this.triggers.webhookPort
  }

  async idle(): Promise<void> {
    await this.triggers.idle()
    await this.queue.idle()
  }

  async shutdown(): Promise<void> {
    await this.triggers.shutdown()
    await this.queue.idle()
  }

  private track(run: RunRow, deferStart = false): Promise<RunResult> {
    this.owned.add(run.id)
    return this.queue
      .run(() =>
        deferStart
          ? new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.executor.execute(run))
          : this.executor.execute(run),
      )
      .finally(() => {
        this.owned.delete(run.id)
      })
  }

  private fire(workflowId: string, payload: unknown, options: FireOptions = {}): { runId: string } {
    const run = this.store.createTriggeredRun({ workflowId, payload, fingerprint: options.fingerprint })
    this.bus.emit({ type: 'trigger.fired', workflowId, runId: run.id })
    this.track(run).catch((error: unknown) => {
      this.bus.emit({
        type: 'trigger.error',
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return { runId: run.id }
  }

  private triggerProblems(id: string, def: TriggerNodeDefinition, config: unknown): string[] {
    if (!Value.Check(def.configSchema, config)) {
      const detail = [...Value.Errors(def.configSchema, config)]
        .map((e) => `${e.instancePath || '/'}: ${e.message}`)
        .join('; ')
      return [`trigger ${id}: invalid config: ${detail}`]
    }
    return (def.validate?.(config) ?? []).map((message) => `trigger ${id}: ${message}`)
  }

  private registryProblems(workflow: Workflow): string[] {
    const problems: string[] = []
    const typeOf = new Map(workflow.nodes.map((n) => [n.id, n.type]))
    for (const node of workflow.nodes) {
      const def = this.registry.get(node.type)
      if (!def) problems.push(`unknown node type: ${node.type}`)
      else if ((def.kind === 'trigger') !== isTrigger(node.type)) problems.push(`node type kind mismatch: ${node.type}`)
      else if (def.kind === 'trigger') problems.push(...this.triggerProblems(node.id, def, node.config))
      else problems.push(...(def.validate?.(node.config) ?? []).map((message) => `node ${node.id}: ${message}`))
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
