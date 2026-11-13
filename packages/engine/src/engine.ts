import { capIssues, isTrigger, isWarningIssue, type PlanIssue, type Workflow } from '@rill/dsl'
import { assertPathAllowed, isEmptyPolicy, policyIssues, validateWorkflow, type ConnectionResolver, type NodeRegistry, type Policy } from '@rill/nodes-core'
import type { LlmProvider } from '@rill/llm'
import {
  createExplainer,
  createPlanner,
  scrubResultText,
  trustedTexts,
  type AttachmentStore,
  type ExplainEffort,
  type ExplainResult,
  type PlanConnection,
  type PlanRequest,
  type PlanResult,
} from '@rill/planner'
import type {
  AttachmentRef,
  LlmModelsResult,
  MemoryItem,
  NodeInfo,
  PlanEffort,
  PlanRecord,
  PlanSummary,
  PlanTurn,
  RecipeDraft,
  RecipeInfo,
  RecipeValues,
  Rule,
  RuleKind,
  RunSummary,
  StepDetail,
  WorkflowSummary,
} from '@rill/protocol'
import { createFsAttachmentStore, recordReads } from './attachments'
import { systemClock, type Clock } from './clock'
import type { Db } from './db'
import { EventBus, type EngineListener } from './events'
import { ExplainBusyError, MAX_CONCURRENT_EXPLAINS, RunNotExplainableError, connectionSecrets, isExplainable } from './explain'
import { RunExecutor, type RunResult } from './executor'
import { llmModelsResult, type EngineLlmInfo } from './llm-models'
import {
  LlmUnavailableError,
  PlanBusyError,
  PlanDeployedError,
  PlanExistsError,
  PlanNotConfirmedError,
  confirmationProblem,
  failedRecord,
  plannedRecord,
  toPlanRecord,
  workflowHash,
  type PlanOutcome,
} from './plans'
import { RunQueue } from './queue'
import { draftFromRecipe, listRecipeInfos } from './recipes'
import { RuleNotFoundError, RuleViolationError, normaliseRule } from './rules'
import { NotFoundError, Store, type RunRow } from './store'
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
  llmInfo?: EngineLlmInfo
  attachmentsRoot?: string
  planConnections?: PlanConnection[]
  maxConcurrentPlans?: number
  maxConcurrentExplains?: number
  maxRepairRounds?: number
}

export const MAX_CHECK_WORKFLOWS = 200
export const MAX_CHECK_ISSUES = 20

export interface RuleCheckEntry {
  workflowId: string
  name: string
  issues: PlanIssue[]
}

export interface EnginePlanInput {
  planId: string
  text: string
  turns: PlanTurn[]
  attachments: AttachmentRef[]
  effort: PlanEffort
  workflowId?: string
  selection?: { nodeId: string }
  useMemory?: boolean
}

interface PendingPlan {
  controller: AbortController
  done: Promise<void>
}

export interface EngineExplainInput {
  runId: string
  effort?: ExplainEffort
  signal?: AbortSignal
}

export class WorkflowValidationError extends Error {
  readonly problems: string[]
  readonly problemIssues: PlanIssue[]

  constructor(problems: string[], problemIssues: PlanIssue[] = []) {
    super(`invalid workflow: ${problems.join('; ')}`)
    this.name = 'WorkflowValidationError'
    this.problems = problems
    this.problemIssues = problemIssues
  }
}

export class WorkflowBusyError extends Error {
  constructor(workflowId: string) {
    super(`the workflow has a run that is queued or running: ${workflowId}`)
    this.name = 'WorkflowBusyError'
  }
}

export class Engine {
  readonly store: Store
  private readonly registry: NodeRegistry
  private readonly allowedRoots: string[] | undefined
  private readonly executor: RunExecutor
  private readonly bus: EventBus
  private readonly queue: RunQueue
  private readonly triggers: TriggerManager
  private readonly owned = new Set<string>()
  private readonly db: Db
  private readonly now: () => number
  private readonly llm: LlmProvider | undefined
  private readonly llmInfo: EngineLlmInfo | undefined
  private readonly attachmentsRoot: string | undefined
  private readonly attachmentStore: AttachmentStore | undefined
  private readonly planConnections: PlanConnection[]
  private readonly maxConcurrentPlans: number
  private readonly maxConcurrentExplains: number
  private readonly connections: ConnectionResolver
  private readonly maxRepairRounds: number | undefined
  private readonly pendingPlans = new Map<string, PendingPlan>()
  private readonly pendingExplains = new Set<PendingPlan>()

  constructor(options: EngineOptions) {
    if (options.attachmentsRoot !== undefined && options.allowedRoots !== undefined) {
      try {
        assertPathAllowed(options.attachmentsRoot, options.allowedRoots)
      } catch {
        throw new Error(`the attachments folder must be inside an allowed folder: ${options.attachmentsRoot}`)
      }
    }
    const clock = options.clock ?? systemClock
    const now = options.now ?? (() => clock.now())
    const connections = options.connections ?? { get: () => undefined }
    this.store = new Store(options.db, now)
    this.db = options.db
    this.now = now
    this.registry = options.registry
    this.allowedRoots = options.allowedRoots
    this.llm = options.llm
    this.llmInfo =
      options.llmInfo === undefined
        ? undefined
        : { configured: [...options.llmInfo.configured], active: options.llmInfo.active === null ? null : { ...options.llmInfo.active } }
    this.attachmentsRoot = options.attachmentsRoot
    this.attachmentStore = options.attachmentsRoot === undefined ? undefined : createFsAttachmentStore(options.attachmentsRoot)
    this.planConnections = options.planConnections ?? []
    this.maxConcurrentPlans = options.maxConcurrentPlans ?? 2
    this.maxConcurrentExplains = options.maxConcurrentExplains ?? MAX_CONCURRENT_EXPLAINS
    this.connections = connections
    this.maxRepairRounds = options.maxRepairRounds
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
      policy: () => this.policy(),
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
      ruleIssues: (workflow) => this.ruleIssues(workflow),
    })
  }

  on(listener: EngineListener): () => void {
    return this.bus.on(listener)
  }

  deploy(input: unknown): string {
    const workflow = this.validated(input)
    const open = this.store.findOpenPlanByHash(workflowHash(workflow))
    if (open !== undefined) {
      throw new PlanNotConfirmedError(`this workflow has flags that plan ${open.id} has not confirmed; deploy it through deployPlan`)
    }
    return this.store.saveWorkflow(workflow)
  }

  private policy(): Policy {
    const rules = this.store.listRules()
    return {
      forbiddenNodes: rules.filter((rule) => rule.kind === 'forbidNode').map((rule) => rule.value),
      allowedHosts: rules.filter((rule) => rule.kind === 'allowHost').map((rule) => rule.value),
    }
  }

  private effortCap(): PlanEffort | undefined {
    return this.store.listRules().find((rule) => rule.kind === 'maxPlanEffort')?.value as PlanEffort | undefined
  }

  private ruleIssues(workflow: Workflow): PlanIssue[] {
    const policy = this.policy()
    return isEmptyPolicy(policy) ? [] : policyIssues(workflow, policy)
  }

  checkRules(): RuleCheckEntry[] {
    const policy = this.policy()
    if (isEmptyPolicy(policy)) return []
    const entries: RuleCheckEntry[] = []
    for (const stored of this.store.listStoredWorkflows()) {
      const issues = policyIssues(stored.workflow, policy)
      if (issues.length === 0) continue
      entries.push({ workflowId: stored.id, name: stored.name, issues: capIssues(issues, { max: MAX_CHECK_ISSUES }) })
      if (entries.length >= MAX_CHECK_WORKFLOWS) break
    }
    return entries
  }

  private validated(input: unknown): Workflow {
    const policy = this.policy()
    const issues = validateWorkflow(input, { registry: this.registry, allowedRoots: this.allowedRoots, ...(isEmptyPolicy(policy) ? {} : { policy }) })
    const errors = issues.filter((issue) => !isWarningIssue(issue))
    if (errors.length > 0) throw new WorkflowValidationError(errors.map((issue) => issue.message), errors)
    return input as Workflow
  }

  async plan(input: EnginePlanInput): Promise<PlanOutcome> {
    const llm = this.llm
    if (llm === undefined) throw new LlmUnavailableError()
    if (this.pendingPlans.has(input.planId) || this.store.hasPlan(input.planId)) throw new PlanExistsError(input.planId)
    if (this.pendingPlans.size >= this.maxConcurrentPlans) throw new PlanBusyError(this.maxConcurrentPlans)
    const existingWorkflow = input.workflowId === undefined ? undefined : this.store.getWorkflow(input.workflowId)
    const controller = new AbortController()
    const pending: PendingPlan = { controller, done: Promise.resolve() }
    this.pendingPlans.set(input.planId, pending)
    const run = this.runPlan(llm, input, existingWorkflow, controller.signal)
    pending.done = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async runPlan(
    llm: LlmProvider,
    input: EnginePlanInput,
    existingWorkflow: Workflow | undefined,
    signal: AbortSignal,
  ): Promise<PlanOutcome> {
    try {
      const reads = this.attachmentStore === undefined ? undefined : recordReads(this.attachmentStore)
      const planner = createPlanner({
        provider: llm,
        registry: this.registry,
        ...(reads === undefined ? {} : { attachmentStore: reads.store }),
        ...(this.maxRepairRounds === undefined ? {} : { maxRepairRounds: this.maxRepairRounds }),
      })
      const notes = input.useMemory === false ? [] : this.store.listMemory()
      const memoryIds = notes.map((note) => note.id)
      const policy = this.policy()
      const cap = this.effortCap()
      const request: PlanRequest = {
        text: input.text,
        turns: input.turns,
        attachments: input.attachments,
        effort: input.effort,
        ...(cap === undefined ? {} : { maxEffort: cap }),
        ...(input.selection === undefined ? {} : { selection: input.selection }),
        context: {
          connections: this.planConnections,
          allowedRoots: this.allowedRoots ?? [],
          attachmentsRoot: this.attachmentsRoot ?? '',
          ...(existingWorkflow === undefined ? {} : { existingWorkflow }),
          ...(notes.length === 0 ? {} : { memory: notes.map((note) => note.text) }),
          ...(isEmptyPolicy(policy) ? {} : { rules: policy }),
        },
        signal,
      }
      let planned: PlanResult
      try {
        planned = await planner.plan(request)
      } catch (error) {
        this.store.savePlan(failedRecord({ ...input, memoryIds }, error, this.now()))
        throw error
      }
      if (reads !== undefined) {
        const attachmentTexts = reads.textsOf([...input.attachments, ...input.turns.flatMap((turn) => turn.attachments ?? [])])
        planned = {
          ...planned,
          ...scrubResultText(planned, {
            attachmentTexts,
            userTexts: trustedTexts(request),
            registry: this.registry,
            ...(existingWorkflow === undefined ? {} : { existingWorkflow }),
          }),
        }
      }
      const { record, outcome } = plannedRecord({ ...input, memoryIds }, planned, this.now())
      this.store.savePlan(record)
      return outcome
    } finally {
      this.pendingPlans.delete(input.planId)
    }
  }

  cancelPlan(planId: string): boolean {
    const pending = this.pendingPlans.get(planId)
    if (pending === undefined) return false
    pending.controller.abort()
    return true
  }

  getPlan(planId: string): PlanRecord {
    return toPlanRecord(this.store.getPlan(planId))
  }

  listPlans(options: { limit?: number } = {}): PlanSummary[] {
    const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : 50
    return this.store.listPlanSummaries(Math.min(Math.max(requested, 1), 200))
  }

  deployPlan(planId: string, confirmed: string[]): string {
    const plan = this.store.getPlan(planId)
    if (plan.status !== 'planned' || plan.result?.kind !== 'workflow') {
      throw new PlanDeployedError(planId, 'only a planned workflow can be deployed')
    }
    if (plan.workflowId !== null) throw new PlanDeployedError(planId)
    const problem = confirmationProblem(plan.flagKeys, confirmed)
    if (problem !== undefined) throw new PlanNotConfirmedError(problem)
    const workflow = this.validated(plan.result.workflow)
    return this.db.transaction(() => {
      const workflowId = this.store.saveWorkflow(workflow)
      this.store.markPlanDeployed(planId, workflowId, [...new Set(confirmed)])
      return workflowId
    })
  }

  enqueueRun(
    workflowId: string,
    payload: unknown = {},
    options: { dryRun?: boolean; deferStart?: boolean } = {},
  ): { runId: string; done: Promise<RunResult> } {
    this.assertRules(workflowId)
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

  async explainRun(input: EngineExplainInput): Promise<ExplainResult> {
    const run = this.store.getRunSummary(input.runId)
    const llm = this.llm
    if (llm === undefined) throw new LlmUnavailableError('explaining')
    if (this.pendingExplains.size >= this.maxConcurrentExplains) throw new ExplainBusyError(this.maxConcurrentExplains)
    const steps = this.store.listStepDetails(input.runId)
    if (!isExplainable(run, steps)) throw new RunNotExplainableError()
    const workflow = this.store.getWorkflow(run.workflowId)
    const secrets = connectionSecrets(
      workflow,
      steps,
      this.registry,
      this.connections,
      this.planConnections.map((connection) => connection.name),
    )
    const controller = new AbortController()
    const pending: PendingPlan = { controller, done: Promise.resolve() }
    this.pendingExplains.add(pending)
    const forward = () => controller.abort(input.signal?.reason)
    if (input.signal?.aborted === true) forward()
    else input.signal?.addEventListener('abort', forward, { once: true })
    const result = createExplainer({ provider: llm, registry: this.registry }).explain({
      run: {
        id: run.id,
        status: run.status,
        dryRun: run.dryRun,
        error: run.error,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      steps,
      workflow,
      registry: this.registry,
      secrets,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      signal: controller.signal,
    })
    pending.done = result.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await result
    } finally {
      input.signal?.removeEventListener('abort', forward)
      this.pendingExplains.delete(pending)
    }
  }

  listMemory(): MemoryItem[] {
    return this.store.listMemory()
  }

  saveMemory(input: { id?: string; text: string }): MemoryItem {
    return this.store.saveMemory(input)
  }

  deleteMemory(id: string): boolean {
    return this.store.deleteMemory(id)
  }

  listRules(): Rule[] {
    return this.store.listRules()
  }

  saveRule(input: { kind: RuleKind; value: string }): Rule {
    const nodeTypes = new Set(this.registry.list().map((def) => def.type.replace(/@\d+$/, '')))
    return this.store.saveRule(normaliseRule(input, nodeTypes))
  }

  deleteRule(id: string): boolean {
    if (!this.store.deleteRule(id)) throw new RuleNotFoundError()
    return true
  }

  llmModels(): LlmModelsResult {
    return llmModelsResult(this.llmInfo)
  }

  listRecipes(): RecipeInfo[] {
    return listRecipeInfos()
  }

  instantiateRecipe(input: { recipeId: string; values: RecipeValues }): RecipeDraft {
    const policy = this.policy()
    return draftFromRecipe(input.recipeId, input.values, {
      registry: this.registry,
      allowedRoots: this.allowedRoots,
      connections: this.planConnections,
      ...(isEmptyPolicy(policy) ? {} : { policy }),
    })
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

  deleteWorkflow(workflowId: string): void {
    if (!this.store.hasWorkflow(workflowId)) throw new NotFoundError(`workflow not found: ${workflowId}`)
    if (this.store.hasActiveRun(workflowId)) throw new WorkflowBusyError(workflowId)
    if (this.triggers.isActive(workflowId)) this.triggers.deactivate(workflowId)
    this.store.deleteWorkflow(workflowId)
    this.bus.emit({ type: 'workflow.deleted', workflowId })
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
    const pending = [...this.pendingPlans.values(), ...this.pendingExplains]
    for (const plan of pending) plan.controller.abort()
    await Promise.all(pending.map((plan) => plan.done))
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

  private assertRules(workflowId: string): void {
    const policy = this.policy()
    if (isEmptyPolicy(policy)) return
    const issues = policyIssues(this.store.getWorkflow(workflowId), policy)
    if (issues.length > 0) throw new RuleViolationError(issues)
  }

  private fire(workflowId: string, payload: unknown, options: FireOptions = {}): { runId: string } {
    try {
      this.assertRules(workflowId)
    } catch (error) {
      if (error instanceof RuleViolationError) {
        this.bus.emit({ type: 'run.blocked', workflowId, codes: [...new Set(error.issues.map((issue) => issue.code))] })
      }
      throw error
    }
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
}
