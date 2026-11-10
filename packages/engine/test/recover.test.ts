import { describe, expect, it } from 'vitest'
import { createTestEngine, linearWorkflow } from './helpers'

const steps = [
  { id: 't1', type: 'trigger.manual@1' },
  { id: 'n1', type: 'test.echo@1', config: { value: 1 } },
  { id: 'n2', type: 'test.echo@1', config: { value: '{{n1.output.value}}' } },
]

describe('Engine.recover', () => {
  it('returns nothing when no run is pending', async () => {
    const { engine } = createTestEngine()
    expect(await engine.recover()).toEqual([])
  })

  it('resumes an interrupted run without re-running finished steps', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const workflowId = engine.deploy(linearWorkflow(steps))
    const store = engine.store
    const run = store.createRun({ workflowId, payload: {}, dryRun: false })
    store.markRunRunning(run.id)
    const first = store.startAttempt({ runId: run.id, nodeId: 'n1', input: { value: 1 }, idempotencyKey: `${run.id}:n1` })
    store.finishAttempt(run.id, 'n1', first, { status: 'succeeded', output: { value: 1 } })
    store.startAttempt({ runId: run.id, nodeId: 'n2', input: { value: 1 }, idempotencyKey: `${run.id}:n2` })

    const [result] = await engine.recover()

    expect(result?.status).toBe('succeeded')
    expect(calls).toEqual(['n2'])
    expect(
      store
        .listAttempts(run.id)
        .filter((a) => a.nodeId === 'n2')
        .map((a) => [a.attempt, a.status]),
    ).toEqual([
      [1, 'abandoned'],
      [2, 'succeeded'],
    ])
    expect(store.getRun(run.id).status).toBe('succeeded')
  })

  it('also picks up a run that was queued but never started', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const workflowId = engine.deploy(linearWorkflow(steps))
    const run = engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    const [result] = await engine.recover()
    expect(result?.runId).toBe(run.id)
    expect(result?.status).toBe('succeeded')
    expect(calls).toEqual(['n1', 'n2'])
  })

  it('does not touch runs that already finished', async () => {
    const { engine } = createTestEngine()
    const workflowId = engine.deploy(linearWorkflow(steps))
    await engine.startRun(workflowId)
    expect(await engine.recover()).toEqual([])
  })
})
