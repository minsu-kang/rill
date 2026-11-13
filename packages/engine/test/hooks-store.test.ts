import { HOOK_LOG_MAX_ROWS, HOOK_RATE_LIMIT, HOOK_RATE_WINDOW_MS, type HookOutcome } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Store } from '../src/store'

function open() {
  const db = Db.open(':memory:')
  let clock = 100
  const store = new Store(db, () => (clock += 1))
  return { db, store }
}

const workflow = (name: string) => ({
  schemaVersion: 1 as const,
  name,
  nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
  edges: [],
})

describe('the store queries of the hook runner', () => {
  it('gives the name of a workflow and nothing for an unknown one', () => {
    const { store } = open()
    const id = store.saveWorkflow(workflow('Receipts'))
    expect(store.workflowName(id)).toBe('Receipts')
    expect(store.workflowName('missing')).toBeUndefined()
  })

  it('says whether a workflow is active, and false for an unknown one', () => {
    const { store } = open()
    const id = store.saveWorkflow(workflow('w'))
    expect(store.isWorkflowActive(id)).toBe(false)
    store.setWorkflowActive(id, true)
    expect(store.isWorkflowActive(id)).toBe(true)
    store.setWorkflowActive(id, false)
    expect(store.isWorkflowActive(id)).toBe(false)
    expect(store.isWorkflowActive('missing')).toBe(false)
  })

  it('lists the newest finished runs of a workflow by the time they finished, without the dry runs and the runs that have not finished', () => {
    const { store } = open()
    const id = store.saveWorkflow(workflow('w'))
    const other = store.saveWorkflow(workflow('other'))
    const make = (workflowId: string, dryRun: boolean, status?: 'succeeded' | 'failed') => {
      const run = store.createRun({ workflowId, payload: {}, dryRun })
      if (status !== undefined) store.finishRun(run.id, status, status === 'failed' ? 'x' : undefined)
      return run.id
    }
    const a = make(id, false, 'failed')
    make(id, true, 'succeeded')
    const c = make(id, false, 'succeeded')
    make(other, false, 'failed')
    make(id, false)
    const running = make(id, false)
    store.markRunRunning(running)
    make(id, true, 'failed')
    expect(store.recentFinishedRuns(id, 10)).toEqual([
      { id: c, status: 'succeeded' },
      { id: a, status: 'failed' },
    ])
    expect(store.recentFinishedRuns(id, 1).map((run) => run.id)).toEqual([c])
    expect(store.recentFinishedRuns('missing', 5)).toEqual([])
  })

  it('orders finished runs by when they finished and not by when they were created, and counts a cancelled run as finished', () => {
    const { db, store } = open()
    const id = store.saveWorkflow(workflow('w'))
    const first = store.createRun({ workflowId: id, payload: {}, dryRun: false })
    const second = store.createRun({ workflowId: id, payload: {}, dryRun: false })
    const third = store.createRun({ workflowId: id, payload: {}, dryRun: false })
    store.finishRun(second.id, 'failed', 'x')
    store.finishRun(first.id, 'succeeded')
    db.run("UPDATE runs SET status = 'cancelled', finished_at = 1 WHERE id = ?", third.id)
    expect(store.recentFinishedRuns(id, 10)).toEqual([
      { id: first.id, status: 'succeeded' },
      { id: second.id, status: 'failed' },
      { id: third.id, status: 'cancelled' },
    ])
    db.run('UPDATE runs SET finished_at = 5')
    expect(store.recentFinishedRuns(id, 10).map((run) => run.id)).toEqual([third.id, second.id, first.id])
  })

  it('finds the last time a hook acted and counts what acted since a time, ignoring skipped rows', () => {
    const { store } = open()
    const row = (hookId: string, at: number, outcome: 'ok' | 'failed' | 'skipped_cooldown' | 'rate_limited' | 'blocked_by_rule' | 'skipped_inactive') =>
      store.appendHookLog({ hookId, at, event: 'run.failed', workflowId: 'w', outcome, code: outcome === 'failed' ? 'unknown' : null })
    expect(store.lastHookExecution('h1')).toBeUndefined()
    expect(store.hookExecutionsSince(0)).toBe(0)
    row('h1', 10, 'ok')
    row('h1', 20, 'failed')
    row('h1', 30, 'skipped_cooldown')
    row('h1', 40, 'rate_limited')
    row('h1', 50, 'blocked_by_rule')
    row('h1', 60, 'skipped_inactive')
    row('h2', 35, 'ok')
    expect(store.lastHookExecution('h1')).toBe(20)
    expect(store.lastHookExecution('h2')).toBe(35)
    expect(store.lastHookExecution('h3')).toBeUndefined()
    expect(store.hookExecutionsSince(0)).toBe(3)
    expect(store.hookExecutionsSince(10)).toBe(2)
    expect(store.hookExecutionsSince(19)).toBe(2)
    expect(store.hookExecutionsSince(20)).toBe(1)
    expect(store.hookExecutionsSince(35)).toBe(0)
  })

  describe('pruning the hook log', () => {
    const T = 10_000_000
    const append = (store: Store, hookId: string, at: number, outcome: HookOutcome) =>
      store.appendHookLog({ hookId, at, event: 'run.failed', workflowId: 'w', outcome, code: outcome === 'failed' ? 'unknown' : null })
    const rowCount = (db: Db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM hook_log')?.n

    it('keeps the newest 500 rows and nothing else when no row counts toward a limit', () => {
      const { db, store } = open()
      for (let index = 0; index < HOOK_LOG_MAX_ROWS + 25; index++) append(store, 'h1', T + index, 'skipped_cooldown')
      expect(rowCount(db)).toBe(HOOK_LOG_MAX_ROWS)
      expect(db.get<{ first: number }>('SELECT MIN(id) AS first FROM hook_log')?.first).toBe(26)
    })

    it('keeps the rows that the cooldown and the cap read, however many other rows are written after them', () => {
      const { db, store } = open()
      append(store, 'h1', T, 'ok')
      append(store, 'h2', T + 1, 'failed')
      for (let index = 0; index < 700; index++) append(store, 'h1', T + 2 + index, index % 2 === 0 ? 'skipped_cooldown' : 'rate_limited')
      expect(store.lastHookExecution('h1')).toBe(T)
      expect(store.lastHookExecution('h2')).toBe(T + 1)
      expect(store.hookExecutionsSince(T - 1)).toBe(2)
      expect(rowCount(db)).toBe(HOOK_LOG_MAX_ROWS + 2)
    })

    it('lets a counted row go once it is outside the window of the row that is written, with the edge at exactly the window', () => {
      const { db, store } = open()
      append(store, 'old', T, 'ok')
      append(store, 'keeper', T + 1, 'ok')
      for (let index = 0; index < HOOK_LOG_MAX_ROWS; index++) append(store, 'h', T + HOOK_RATE_WINDOW_MS, 'skipped_cooldown')
      expect(store.lastHookExecution('old')).toBeUndefined()
      expect(store.lastHookExecution('keeper')).toBe(T + 1)
      expect(rowCount(db)).toBe(HOOK_LOG_MAX_ROWS + 1)
      append(store, 'h', T + HOOK_RATE_WINDOW_MS + 1, 'skipped_cooldown')
      expect(store.lastHookExecution('keeper')).toBeUndefined()
      expect(rowCount(db)).toBe(HOOK_LOG_MAX_ROWS)
    })

    it('protects at most the newest rows that the cap allows, so that the table stays bounded', () => {
      const { db, store } = open()
      for (let index = 0; index < 100; index++) append(store, `h${index}`, T + index, 'ok')
      for (let index = 0; index < 600; index++) append(store, 'h', T + 100 + index, 'skipped_cooldown')
      expect(rowCount(db)).toBe(HOOK_LOG_MAX_ROWS + HOOK_RATE_LIMIT)
      expect(store.lastHookExecution('h69')).toBeUndefined()
      expect(store.lastHookExecution('h70')).toBe(T + 70)
      expect(store.hookExecutionsSince(T - 1)).toBe(HOOK_RATE_LIMIT)
    })
  })
})
