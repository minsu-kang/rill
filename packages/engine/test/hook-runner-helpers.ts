import type { ConnectionTable } from '../src/connection-channel'
import { Db } from '../src/db'
import type { EngineEvent } from '../src/events'
import { HookRunner } from '../src/hooks-runner'
import { Store } from '../src/store'
import { connectionTable, echoWorkflow, failingWorkflow } from './hook-helpers'

export const START = Date.UTC(2026, 10, 13, 10, 0, 0)

export interface LogRow {
  hook_id: string
  at: number
  event: string
  workflow_id: string
  outcome: string
  code: string | null
}

export function logRows(db: Db): LogRow[] {
  return db.all<LogRow>('SELECT hook_id, at, event, workflow_id, outcome, code FROM hook_log ORDER BY id')
}

export const outcomes = (db: Db): string[] => logRows(db).map((row) => (row.code === null ? row.outcome : `${row.outcome}:${row.code}`))

export function standalone(options: { table?: ConnectionTable; forbidden?: () => readonly string[]; timeoutMs?: number } = {}) {
  const db = Db.open(':memory:')
  let clock = START
  const store = new Store(db, () => (clock += 1))
  const table = options.table ?? connectionTable()
  const deactivated: string[] = []
  const runner = new HookRunner({
    store,
    connections: table.resolver,
    forbiddenNodes: options.forbidden ?? (() => []),
    deactivate: (workflowId) => {
      deactivated.push(workflowId)
      store.setWorkflowActive(workflowId, false)
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return { db, store, table, runner, deactivated }
}

export function workflowIn(store: Store, name: string, kind: 'echo' | 'fail' = 'fail'): string {
  return store.saveWorkflow((kind === 'fail' ? failingWorkflow(name) : echoWorkflow(name)) as never)
}

export function finishedRun(store: Store, workflowId: string, status: 'succeeded' | 'failed', dryRun = false): string {
  const run = store.createRun({ workflowId, payload: {}, dryRun })
  store.finishRun(run.id, status, status === 'failed' ? 'x' : undefined)
  return run.id
}

export const finished = (runId: string, status: 'succeeded' | 'failed', at: number): EngineEvent => ({
  type: 'run.finished',
  at,
  runId,
  status,
  error: status === 'failed' ? 'x' : null,
})

export const deployed = (workflowId: string, at: number, planId = 'plan-1'): EngineEvent => ({ type: 'plan.deployed', at, workflowId, planId })
