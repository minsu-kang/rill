import { isTrigger, type Workflow } from '@rill/dsl'
import {
  RillError,
  type EngineEvent,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NodeInfo,
  type RunSummary,
  type StepDetail,
} from '@rill/protocol'
import { reduceRunSummary } from '../model/reduce-events'
import type { EngineClient } from './client'

export interface FakeWorkflow {
  id: string
  workflow: Workflow
  active?: boolean
  createdAt?: number
}

export interface FakeData {
  workflows: readonly FakeWorkflow[]
  runs: readonly RunSummary[]
  steps: Readonly<Record<string, readonly StepDetail[]>>
  catalog: readonly NodeInfo[]
}

export type Scheduler = (fn: () => void, ms: number) => void

export interface FakeClient extends EngineClient {
  emit(event: EngineEvent): void
  play(runId: string, events: readonly EngineEvent[], schedule?: Scheduler, intervalMs?: number): () => void
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => MethodResult<M> }

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_INTERVAL_MS = 600

const timeoutScheduler: Scheduler = (fn, ms) => {
  setTimeout(fn, ms)
}

function notFound(kind: string, id: string): RillError {
  return new RillError('NOT_FOUND', `${kind} not found: ${id}`)
}

function openRow(nodeId: string, attempt: number, at: number): StepDetail {
  return { nodeId, attempt, status: 'running', input: null, output: null, error: null, startedAt: at, finishedAt: null }
}

function rowOf(rows: StepDetail[], nodeId: string, attempt: number, at: number): StepDetail {
  const found = rows.find((row) => row.nodeId === nodeId && row.attempt === attempt)
  if (found !== undefined) return found
  const created = openRow(nodeId, attempt, at)
  rows.push(created)
  return created
}

function applyStep(rows: StepDetail[], event: EngineEvent): void {
  switch (event.type) {
    case 'step.started': {
      const at = rows.findIndex((row) => row.nodeId === event.nodeId && row.attempt === event.attempt)
      if (at >= 0) rows.splice(at, 1, openRow(event.nodeId, event.attempt, event.at))
      else rows.push(openRow(event.nodeId, event.attempt, event.at))
      return
    }
    case 'step.succeeded': {
      const row = rowOf(rows, event.nodeId, event.attempt, event.at)
      row.status = 'succeeded'
      row.error = null
      row.finishedAt = event.at
      return
    }
    case 'step.failed': {
      const row = rowOf(rows, event.nodeId, event.attempt, event.at)
      row.status = 'failed'
      row.error = event.error
      row.finishedAt = event.at
      return
    }
    case 'step.continued': {
      const row = rowOf(rows, event.nodeId, event.attempt, event.at)
      row.status = 'continued'
      row.error = event.error
      row.finishedAt ??= event.at
      return
    }
    case 'step.skipped': {
      const last = rows.filter((row) => row.nodeId === event.nodeId).reduce<StepDetail | undefined>((best, row) => (best === undefined || row.attempt > best.attempt ? row : best), undefined)
      if (last?.status === 'skipped') return
      rows.push({ ...openRow(event.nodeId, (last?.attempt ?? 0) + 1, event.at), status: 'skipped', finishedAt: event.at })
      return
    }
    default:
      return
  }
}

export function createFakeClient(data: FakeData): FakeClient {
  const workflows = new Map(data.workflows.map((entry) => [entry.id, entry]))
  const runs = new Map(data.runs.map((run) => [run.id, structuredClone(run)]))
  const order = data.runs.map((run) => run.id)
  const steps = new Map(Object.entries(data.steps).map(([runId, rows]) => [runId, structuredClone([...rows])]))
  const listeners = new Set<(event: EngineEvent) => void>()

  function ensureRun(runId: string, workflowId: string, at: number): RunSummary {
    const known = runs.get(runId)
    if (known !== undefined) return known
    const created: RunSummary = { id: runId, workflowId, status: 'queued', dryRun: false, error: null, createdAt: at, startedAt: null, finishedAt: null }
    runs.set(runId, created)
    order.unshift(runId)
    return created
  }

  function removeWorkflow(workflowId: string): void {
    workflows.delete(workflowId)
    for (const [runId, run] of [...runs]) {
      if (run.workflowId !== workflowId) continue
      runs.delete(runId)
      steps.delete(runId)
      order.splice(order.indexOf(runId), 1)
    }
  }

  function apply(event: EngineEvent): void {
    switch (event.type) {
      case 'trigger.fired':
        ensureRun(event.runId, event.workflowId, event.at)
        return
      case 'workflow.deleted':
        removeWorkflow(event.workflowId)
        return
      case 'run.started':
        runs.set(event.runId, reduceRunSummary(ensureRun(event.runId, event.workflowId, event.at), event))
        return
      case 'run.finished': {
        const run = runs.get(event.runId)
        if (run !== undefined) runs.set(event.runId, reduceRunSummary(run, event))
        return
      }
      case 'step.started':
      case 'step.succeeded':
      case 'step.failed':
      case 'step.skipped':
      case 'step.continued': {
        if (!runs.has(event.runId)) return
        const rows = steps.get(event.runId) ?? []
        steps.set(event.runId, rows)
        applyStep(rows, event)
        return
      }
      default:
        return
    }
  }

  const handlers: Handlers = {
    listWorkflows: () => ({
      workflows: [...workflows.values()].map((entry) => ({
        id: entry.id,
        name: entry.workflow.name,
        active: entry.active ?? false,
        triggerType: entry.workflow.nodes.find((node) => isTrigger(node.type))?.type ?? 'unknown',
        createdAt: entry.createdAt ?? 0,
      })),
    }),
    getWorkflow: ({ workflowId }) => {
      const entry = workflows.get(workflowId)
      if (entry === undefined) throw notFound('workflow', workflowId)
      return { workflow: entry.workflow }
    },
    listRuns: ({ workflowId, limit }) => {
      const requested = Number.isFinite(limit) ? Math.trunc(limit as number) : DEFAULT_LIMIT
      const size = Math.min(Math.max(requested, 1), MAX_LIMIT)
      const all = order.map((id) => runs.get(id)!)
      return { runs: all.filter((run) => workflowId === undefined || run.workflowId === workflowId).slice(0, size) }
    },
    getRun: ({ runId }) => {
      const run = runs.get(runId)
      if (run === undefined) throw notFound('run', runId)
      return { run, steps: [...(steps.get(runId) ?? [])] }
    },
    deleteWorkflow: ({ workflowId }) => {
      if (!workflows.has(workflowId)) throw notFound('workflow', workflowId)
      emit({ type: 'workflow.deleted', at: Date.now(), workflowId })
      return {}
    },
    nodeCatalog: () => ({ nodes: [...data.catalog] }),
  }

  function emit(event: EngineEvent): void {
    apply(event)
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        continue
      }
    }
  }

  return {
    async request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
      const handler = Object.hasOwn(handlers, method)
        ? (handlers[method] as ((params: MethodParams<M>) => MethodResult<M>) | undefined)
        : undefined
      if (handler === undefined) throw new RillError('UNKNOWN_METHOD', `unknown method: ${method}`)
      return structuredClone(handler(params))
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit,
    play(runId, events, schedule = timeoutScheduler, intervalMs = DEFAULT_INTERVAL_MS) {
      const queue = events.filter((event) => !('runId' in event) || event.runId === runId)
      let next = 0
      let stopped = false
      const tick = (): void => {
        const event = queue[next]
        if (stopped || event === undefined) return
        next += 1
        emit(event)
        if (next < queue.length) schedule(tick, intervalMs)
      }
      if (queue.length > 0) schedule(tick, 0)
      return () => {
        stopped = true
      }
    },
  }
}
