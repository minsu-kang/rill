import type { Workflow } from '@rill/dsl'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { NotFoundError, Store } from '../src/store'

const workflow = (name: string): Workflow => ({
  schemaVersion: 1,
  name,
  nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
  edges: [],
})

let now = 1000
let store: Store

beforeEach(() => {
  now = 1000
  store = new Store(Db.open(':memory:'), () => (now += 10))
})

describe('NotFoundError', () => {
  it('is thrown with the familiar messages', () => {
    expect(() => store.getWorkflow('nope')).toThrow(NotFoundError)
    expect(() => store.getWorkflow('nope')).toThrow('workflow not found: nope')
    expect(() => store.getRun('nope')).toThrow(NotFoundError)
    expect(() => store.getRun('nope')).toThrow('run not found: nope')
    expect(() => store.getRunSummary('nope')).toThrow('run not found: nope')
  })
})

describe('listStoredWorkflows', () => {
  it('lists workflows in creation order with their flags', () => {
    const a = store.saveWorkflow(workflow('a'))
    const b = store.saveWorkflow(workflow('b'))
    store.setWorkflowActive(b, true)
    const listed = store.listStoredWorkflows()
    expect(listed.map((w) => [w.id, w.name, w.active])).toEqual([
      [a, 'a', false],
      [b, 'b', true],
    ])
    expect(listed[0]?.workflow).toEqual(workflow('a'))
    expect(listed[0]?.createdAt).toBeLessThan(listed[1]!.createdAt)
  })
})

describe('run summaries', () => {
  it('lists newest first, filters by workflow and honours the limit', () => {
    const a = store.saveWorkflow(workflow('a'))
    const b = store.saveWorkflow(workflow('b'))
    const r1 = store.createRun({ workflowId: a, payload: {}, dryRun: false })
    const r2 = store.createRun({ workflowId: b, payload: {}, dryRun: true })
    const r3 = store.createRun({ workflowId: a, payload: {}, dryRun: false })
    expect(store.listRunSummaries({ limit: 10 }).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id])
    expect(store.listRunSummaries({ workflowId: a, limit: 10 }).map((r) => r.id)).toEqual([r3.id, r1.id])
    expect(store.listRunSummaries({ limit: 2 }).map((r) => r.id)).toEqual([r3.id, r2.id])
  })

  it('reports status, timestamps, dry run and error', () => {
    const w = store.saveWorkflow(workflow('a'))
    const run = store.createRun({ workflowId: w, payload: {}, dryRun: true })
    expect(store.getRunSummary(run.id)).toMatchObject({
      id: run.id,
      workflowId: w,
      status: 'queued',
      dryRun: true,
      error: null,
      startedAt: null,
      finishedAt: null,
    })
    store.markRunRunning(run.id)
    store.finishRun(run.id, 'failed', 'node a failed: x')
    const summary = store.getRunSummary(run.id)
    expect(summary).toMatchObject({ status: 'failed', error: 'node a failed: x' })
    expect(summary.startedAt).not.toBeNull()
    expect(summary.finishedAt).toBeGreaterThanOrEqual(summary.startedAt!)
    expect(summary.createdAt).toBeLessThan(summary.startedAt!)
  })
})

describe('step details', () => {
  it('lists every attempt in execution order with input, output and timestamps', () => {
    const w = store.saveWorkflow(workflow('a'))
    const run = store.createRun({ workflowId: w, payload: {}, dryRun: false })
    const first = store.startAttempt({ runId: run.id, nodeId: 'n1', input: { a: 1 }, idempotencyKey: 'k' })
    store.finishAttempt(run.id, 'n1', first, { status: 'failed', error: 'boom' })
    const second = store.startAttempt({ runId: run.id, nodeId: 'n1', input: { a: 1 }, idempotencyKey: 'k' })
    store.finishAttempt(run.id, 'n1', second, { status: 'succeeded', output: { ok: true } })
    store.recordSkipped(run.id, 'n2', 'k2')
    const steps = store.listStepDetails(run.id)
    expect(steps.map((s) => [s.nodeId, s.attempt, s.status])).toEqual([
      ['n1', 1, 'failed'],
      ['n1', 2, 'succeeded'],
      ['n2', 1, 'skipped'],
    ])
    expect(steps[0]).toMatchObject({ input: { a: 1 }, output: null, error: 'boom' })
    expect(steps[1]).toMatchObject({ input: { a: 1 }, output: { ok: true }, error: null })
    expect(steps[1]!.finishedAt).toBeGreaterThanOrEqual(steps[1]!.startedAt)
    expect(store.listStepDetails('unknown-run')).toEqual([])
  })
})
