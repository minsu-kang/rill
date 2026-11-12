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

export function createFakeClient(data: FakeData): FakeClient {
  const workflows = new Map(data.workflows.map((entry) => [entry.id, entry]))
  const runs = new Map(data.runs.map((run) => [run.id, run]))
  const listeners = new Set<(event: EngineEvent) => void>()

  const handlers: Handlers = {
    listWorkflows: () => ({
      workflows: data.workflows.map((entry) => ({
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
      return { runs: data.runs.filter((run) => workflowId === undefined || run.workflowId === workflowId).slice(0, size) }
    },
    getRun: ({ runId }) => {
      const run = runs.get(runId)
      if (run === undefined) throw notFound('run', runId)
      return { run, steps: Object.hasOwn(data.steps, runId) ? [...data.steps[runId]!] : [] }
    },
    nodeCatalog: () => ({ nodes: [...data.catalog] }),
  }

  function emit(event: EngineEvent): void {
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
