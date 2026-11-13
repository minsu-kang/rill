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

  it('lists the newest runs of a workflow without the dry runs, newest first, with their status', () => {
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
    const d = make(id, false)
    make(id, true, 'failed')
    expect(store.recentNonDryRuns(id, 10)).toEqual([
      { id: d, status: 'queued' },
      { id: c, status: 'succeeded' },
      { id: a, status: 'failed' },
    ])
    expect(store.recentNonDryRuns(id, 2).map((run) => run.id)).toEqual([d, c])
    expect(store.recentNonDryRuns('missing', 5)).toEqual([])
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
})
