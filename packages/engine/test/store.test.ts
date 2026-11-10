import type { Workflow } from '@rill/dsl'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Store } from '../src/store'

const workflow: Workflow = {
  schemaVersion: 1,
  name: 'wf',
  nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
  edges: [],
}

let store: Store
let workflowId: string

beforeEach(() => {
  store = new Store(Db.open(':memory:'))
  workflowId = store.saveWorkflow(workflow)
})

describe('workflows', () => {
  it('round-trips a workflow', () => {
    expect(store.getWorkflow(workflowId)).toEqual(workflow)
  })

  it('throws for an unknown workflow', () => {
    expect(() => store.getWorkflow('nope')).toThrow('workflow not found: nope')
  })
})

describe('runs', () => {
  it('creates a queued run and moves it through its lifecycle', () => {
    const run = store.createRun({ workflowId, payload: { a: 1 }, dryRun: true })
    expect(run).toMatchObject({ workflowId, status: 'queued', payload: { a: 1 }, dryRun: true, error: null })
    store.markRunRunning(run.id)
    expect(store.getRun(run.id).status).toBe('running')
    store.finishRun(run.id, 'failed', 'boom')
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('lists runs by status in creation order', () => {
    const first = store.createRun({ workflowId, payload: {}, dryRun: false })
    const second = store.createRun({ workflowId, payload: {}, dryRun: false })
    store.markRunRunning(second.id)
    expect(store.listRunsByStatus('queued').map((r) => r.id)).toEqual([first.id])
    expect(store.listRunsByStatus('running').map((r) => r.id)).toEqual([second.id])
  })
})

describe('attempts', () => {
  it('numbers attempts per node starting at 1', () => {
    const run = store.createRun({ workflowId, payload: {}, dryRun: false })
    const base = { runId: run.id, input: {}, idempotencyKey: `${run.id}:n1` }
    expect(store.startAttempt({ ...base, nodeId: 'n1' })).toBe(1)
    expect(store.startAttempt({ ...base, nodeId: 'n1' })).toBe(2)
    expect(store.startAttempt({ ...base, nodeId: 'n2' })).toBe(1)
  })

  it('records results and exposes the latest successful output', () => {
    const run = store.createRun({ workflowId, payload: {}, dryRun: false })
    const base = { runId: run.id, nodeId: 'n1', input: { x: 1 }, idempotencyKey: `${run.id}:n1` }
    const first = store.startAttempt(base)
    store.finishAttempt(run.id, 'n1', first, { status: 'failed', error: 'nope' })
    expect(store.latestSucceededOutput(run.id, 'n1')).toBeUndefined()
    const second = store.startAttempt(base)
    store.finishAttempt(run.id, 'n1', second, { status: 'succeeded', output: { y: 2 } })
    expect(store.latestSucceededOutput(run.id, 'n1')).toEqual({ output: { y: 2 } })
    expect(store.listAttempts(run.id).map((a) => [a.attempt, a.status, a.error])).toEqual([
      [1, 'failed', 'nope'],
      [2, 'succeeded', null],
    ])
  })

  it('abandons attempts left running and reports how many', () => {
    const run = store.createRun({ workflowId, payload: {}, dryRun: false })
    store.startAttempt({ runId: run.id, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    expect(store.abandonRunningAttempts(run.id)).toBe(1)
    expect(store.abandonRunningAttempts(run.id)).toBe(0)
    expect(store.listAttempts(run.id)[0]?.status).toBe('abandoned')
  })

  it('stores null output as null', () => {
    const run = store.createRun({ workflowId, payload: {}, dryRun: false })
    const attempt = store.startAttempt({ runId: run.id, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    store.finishAttempt(run.id, 'n1', attempt, { status: 'succeeded' })
    expect(store.latestSucceededOutput(run.id, 'n1')).toEqual({ output: null })
  })
})

describe('journal', () => {
  it('stores state and keeps earlier data when none is given', () => {
    const journal = store.journal()
    expect(journal.get('k')).toBeUndefined()
    journal.put('k', 'intent', '42')
    expect(journal.get('k')).toEqual({ state: 'intent', data: '42' })
    journal.put('k', 'done')
    expect(journal.get('k')).toEqual({ state: 'done', data: '42' })
  })
})
