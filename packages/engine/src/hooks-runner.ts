import { postSlackMessage, type ConnectionResolver } from '@rill/nodes-core'
import {
  HOOK_COOLDOWN_MS,
  HOOK_RATE_LIMIT,
  HOOK_RATE_WINDOW_MS,
  hookMessage,
  type Hook,
  type HookEvent,
  type HookFailureCode,
  type HookOutcome,
} from '@rill/protocol'
import type { EngineEvent } from './events'
import { SLACK_CONNECTION_KIND, notifyForbidden } from './hooks'
import type { Store } from './store'

export const HOOK_POST_TIMEOUT_MS = 15_000

export interface HookRunnerDeps {
  store: Store
  connections: ConnectionResolver
  forbiddenNodes: () => readonly string[]
  deactivate: (workflowId: string) => void
  timeoutMs?: number
}

interface HookJob {
  event: HookEvent
  at: number
  runId?: string
  workflowId?: string
}

interface HookResult {
  outcome: HookOutcome
  code: HookFailureCode | null
}

const DONE: HookResult = { outcome: 'ok', code: null }
const SKIPPED_INACTIVE: HookResult = { outcome: 'skipped_inactive', code: null }
const failure = (code: HookFailureCode): HookResult => ({ outcome: 'failed', code })

function jobOf(event: EngineEvent): HookJob | undefined {
  switch (event.type) {
    case 'run.finished':
      return { event: event.status === 'failed' ? 'run.failed' : 'run.succeeded', at: event.at, runId: event.runId }
    case 'plan.deployed':
      return { event: 'plan.deployed', at: event.at, workflowId: event.workflowId }
    default:
      return undefined
  }
}

export class HookRunner {
  private readonly deps: HookRunnerDeps
  private readonly timeoutMs: number
  private readonly queue: HookJob[] = []
  private readonly abort = new AbortController()
  private hooks: Hook[] = []
  private revision = -1
  private running: Promise<void> | undefined
  private stopped = false

  constructor(deps: HookRunnerDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? HOOK_POST_TIMEOUT_MS
    this.enabled()
  }

  handle(event: EngineEvent): void {
    if (this.stopped) return
    const job = jobOf(event)
    if (job === undefined) return
    try {
      if (!this.enabled().some((hook) => hook.event === job.event)) return
    } catch {
      return
    }
    this.queue.push(job)
    this.kick()
  }

  async idle(): Promise<void> {
    while (this.running !== undefined) await this.running
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    this.abort.abort()
    await this.idle()
  }

  private enabled(): Hook[] {
    if (this.revision !== this.deps.store.hooksRevision) {
      this.revision = this.deps.store.hooksRevision
      this.hooks = this.deps.store.listHooks().filter((hook) => hook.enabled)
    }
    return this.hooks
  }

  private kick(): void {
    if (this.running !== undefined) return
    this.running = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.drain())
      .finally(() => {
        this.running = undefined
        if (this.queue.length > 0 && !this.stopped) this.kick()
      })
  }

  private async drain(): Promise<void> {
    for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
      try {
        await this.process(job)
      } catch {
        continue
      }
    }
  }

  private async process(job: HookJob): Promise<void> {
    const workflowId = this.workflowOf(job)
    if (workflowId === undefined) return
    const hooks = this.enabled().filter((hook) => hook.event === job.event && (hook.scope.type === 'all' || hook.scope.workflowId === workflowId))
    for (const hook of hooks) {
      if (this.stopped) return
      await this.execute(hook, job, workflowId)
    }
  }

  private workflowOf(job: HookJob): string | undefined {
    if (job.workflowId !== undefined) return job.workflowId
    if (job.runId === undefined) return undefined
    try {
      const run = this.deps.store.getRunSummary(job.runId)
      return run.dryRun ? undefined : run.workflowId
    } catch {
      return undefined
    }
  }

  private async execute(hook: Hook, job: HookJob, workflowId: string): Promise<void> {
    let result: HookResult
    try {
      result = await this.perform(hook, job, workflowId)
    } catch {
      result = failure('unknown')
    }
    try {
      this.deps.store.appendHookLog({ hookId: hook.id, at: job.at, event: job.event, workflowId, outcome: result.outcome, code: result.code })
    } catch {
      return
    }
  }

  private async perform(hook: Hook, job: HookJob, workflowId: string): Promise<HookResult> {
    const { action } = hook
    if (action.type === 'notify') {
      if (notifyForbidden(this.deps.forbiddenNodes())) return { outcome: 'blocked_by_rule', code: null }
      if (this.cooling(hook.id, job.at)) return { outcome: 'skipped_cooldown', code: null }
    }
    if (this.capped(job.at)) return { outcome: 'rate_limited', code: null }
    switch (action.type) {
      case 'record':
        return DONE
      case 'notify':
        return this.notify(action.connection, action.channel, job, workflowId)
      case 'deactivateAfterFailures':
        return this.deactivate(action.count, job, workflowId)
    }
  }

  private cooling(hookId: string, at: number): boolean {
    const last = this.deps.store.lastHookExecution(hookId)
    return last !== undefined && at - last < HOOK_COOLDOWN_MS
  }

  private capped(at: number): boolean {
    return this.deps.store.hookExecutionsSince(at - HOOK_RATE_WINDOW_MS) >= HOOK_RATE_LIMIT
  }

  private async notify(connection: string, channel: string | undefined, job: HookJob, workflowId: string): Promise<HookResult> {
    const name = this.deps.store.workflowName(workflowId)
    if (name === undefined) return failure('unknown')
    const secret = this.deps.connections.get(connection)
    if (secret === undefined || this.deps.connections.kindOf?.(connection) !== SLACK_CONNECTION_KIND) return failure('connection')
    const posted = await postSlackMessage({ secret, text: hookMessage(job.event, name), channel, timeoutMs: this.timeoutMs, signal: this.abort.signal })
    return posted.ok ? DONE : failure(posted.failure)
  }

  private deactivate(count: number, job: HookJob, workflowId: string): HookResult {
    if (job.event !== 'run.failed' || job.runId === undefined) return failure('unknown')
    const recent = this.deps.store.recentNonDryRuns(workflowId, count)
    const matches = recent.length === count && recent[0]!.id === job.runId && recent.every((run) => run.status === 'failed')
    if (!matches || !this.deps.store.isWorkflowActive(workflowId)) return SKIPPED_INACTIVE
    this.deps.deactivate(workflowId)
    return DONE
  }
}
