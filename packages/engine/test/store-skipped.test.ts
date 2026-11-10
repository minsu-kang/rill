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
let runId: string

beforeEach(() => {
  store = new Store(Db.open(':memory:'))
  runId = store.createRun({ workflowId: store.saveWorkflow(workflow), payload: {}, dryRun: false }).id
})

describe('Store.recordSkipped', () => {
  it('records a skipped attempt with no input or output', () => {
    store.recordSkipped(runId, 'n1', `${runId}:n1`)
    expect(store.listAttempts(runId)).toEqual([
      {
        runId,
        nodeId: 'n1',
        attempt: 1,
        status: 'skipped',
        input: null,
        output: null,
        error: null,
        idempotencyKey: `${runId}:n1`,
      },
    ])
  })

  it('does not record the same skip twice', () => {
    store.recordSkipped(runId, 'n1', 'k')
    store.recordSkipped(runId, 'n1', 'k')
    expect(store.listAttempts(runId)).toHaveLength(1)
  })

  it('uses the next attempt number after earlier attempts', () => {
    const first = store.startAttempt({ runId, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    store.finishAttempt(runId, 'n1', first, { status: 'failed', error: 'x' })
    store.recordSkipped(runId, 'n1', 'k')
    expect(store.listAttempts(runId).map((a) => [a.attempt, a.status])).toEqual([
      [1, 'failed'],
      [2, 'skipped'],
    ])
  })

  it('never counts as a successful output', () => {
    store.recordSkipped(runId, 'n1', 'k')
    expect(store.latestSucceededOutput(runId, 'n1')).toBeUndefined()
  })
})

describe('Store.markContinued and isContinued', () => {
  it('marks a failed attempt as continued', () => {
    const attempt = store.startAttempt({ runId, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    store.finishAttempt(runId, 'n1', attempt, { status: 'failed', error: 'x' })
    expect(store.isContinued(runId, 'n1')).toBe(false)
    store.markContinued(runId, 'n1', attempt)
    expect(store.isContinued(runId, 'n1')).toBe(true)
    expect(store.listAttempts(runId)[0]?.status).toBe('continued')
    expect(store.latestSucceededOutput(runId, 'n1')).toBeUndefined()
  })

  it('only touches failed attempts', () => {
    const attempt = store.startAttempt({ runId, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    store.finishAttempt(runId, 'n1', attempt, { status: 'succeeded', output: 1 })
    store.markContinued(runId, 'n1', attempt)
    expect(store.isContinued(runId, 'n1')).toBe(false)
  })

  it('looks at the latest attempt only', () => {
    const first = store.startAttempt({ runId, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    store.finishAttempt(runId, 'n1', first, { status: 'failed', error: 'x' })
    store.markContinued(runId, 'n1', first)
    store.startAttempt({ runId, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    expect(store.isContinued(runId, 'n1')).toBe(false)
  })
})
