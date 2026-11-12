import { METHODS, RillError, type EngineEvent } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { fakeData } from '../src/fixtures'

function manualScheduler() {
  const queue: Array<{ fn: () => void; ms: number }> = []
  return {
    schedule: (fn: () => void, ms: number) => {
      queue.push({ fn, ms })
    },
    runNext: () => queue.shift()?.fn(),
    delays: () => queue.map((entry) => entry.ms),
    pending: () => queue.length,
  }
}

const runEvent = (runId: string, nodeId: string): EngineEvent => ({ type: 'step.started', at: 1, runId, nodeId, attempt: 1 })

afterEach(() => {
  vi.useRealTimers()
})

describe('createFakeClient requests', () => {
  const client = createFakeClient(fakeData)
  const workflow = fakeData.workflows[0]!
  const run = fakeData.runs[0]!

  it('answers listWorkflows with data that passes the protocol schema', async () => {
    const result = await client.request('listWorkflows', {})
    expect(Value.Check(METHODS.listWorkflows.result, result)).toBe(true)
    expect(result.workflows.map((w) => w.id)).toEqual(fakeData.workflows.map((w) => w.id))
    expect(result.workflows[0]).toMatchObject({ name: workflow.workflow.name, triggerType: expect.stringMatching(/^trigger\./) })
  })

  it('answers getWorkflow', async () => {
    const result = await client.request('getWorkflow', { workflowId: workflow.id })
    expect(Value.Check(METHODS.getWorkflow.result, result)).toBe(true)
    expect(result.workflow).toEqual(workflow.workflow)
  })

  it('answers listRuns in the given order, filtered by workflow and limited', async () => {
    const all = await client.request('listRuns', {})
    expect(Value.Check(METHODS.listRuns.result, all)).toBe(true)
    expect(all.runs.map((r) => r.id)).toEqual(fakeData.runs.map((r) => r.id))
    const mine = await client.request('listRuns', { workflowId: workflow.id })
    expect(mine.runs.length).toBeGreaterThan(0)
    expect(mine.runs.every((r) => r.workflowId === workflow.id)).toBe(true)
    expect(mine.runs.map((r) => r.id)).toEqual(fakeData.runs.filter((r) => r.workflowId === workflow.id).map((r) => r.id))
    const limited = await client.request('listRuns', { limit: 2 })
    expect(limited.runs.map((r) => r.id)).toEqual(all.runs.slice(0, 2).map((r) => r.id))
  })

  it('answers getRun with the run and its steps', async () => {
    for (const each of fakeData.runs) {
      const result = await client.request('getRun', { runId: each.id })
      expect(Value.Check(METHODS.getRun.result, result), each.id).toBe(true)
      expect(result.run).toEqual(each)
      expect(result.steps).toEqual(fakeData.steps[each.id] ?? [])
    }
    expect(run.id).toBeTruthy()
  })

  it('answers nodeCatalog with the catalog', async () => {
    const result = await client.request('nodeCatalog', {})
    expect(Value.Check(METHODS.nodeCatalog.result, result)).toBe(true)
    expect(result.nodes.map((n) => n.type)).toEqual(fakeData.catalog.map((n) => n.type))
  })

  it('rejects an unknown id with a RillError NOT_FOUND', async () => {
    await expect(client.request('getRun', { runId: 'nope' })).rejects.toMatchObject({ name: 'RillError', code: 'NOT_FOUND' })
    await expect(client.request('getWorkflow', { workflowId: 'nope' })).rejects.toBeInstanceOf(RillError)
    await expect(client.request('getWorkflow', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'workflow not found: nope' })
    await expect(client.request('getRun', { runId: 'constructor' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.request('getWorkflow', { workflowId: '__proto__' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an unsupported method with a RillError UNKNOWN_METHOD', async () => {
    await expect(client.request('deploy', { workflow: {} })).rejects.toMatchObject({ name: 'RillError', code: 'UNKNOWN_METHOD' })
    await expect(client.request('toString' as 'ping', {})).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' })
  })

  it('hands out copies so a caller cannot change the fixtures', async () => {
    const original = structuredClone({ run, steps: fakeData.steps[run.id] ?? [] })
    const first = await client.request('getRun', { runId: run.id })
    first.run.status = 'cancelled'
    first.steps.length = 0
    const second = await client.request('getRun', { runId: run.id })
    expect(second).toEqual(original)
    expect(run).toEqual(original.run)
  })

  it('reports an unknown trigger type for a workflow without a trigger', async () => {
    const bare = createFakeClient({
      ...fakeData,
      workflows: [{ id: 'bare', workflow: { schemaVersion: 1, name: 'bare', nodes: [{ id: 'a', type: 'condition@1', config: {} }], edges: [] } }],
    })
    const result = await bare.request('listWorkflows', {})
    expect(result.workflows).toEqual([{ id: 'bare', name: 'bare', active: false, triggerType: 'unknown', createdAt: 0 }])
  })
})

describe('createFakeClient events', () => {
  it('delivers emitted events to every listener in order and stops after unsubscribe', () => {
    const client = createFakeClient(fakeData)
    const a: EngineEvent[] = []
    const b: EngineEvent[] = []
    const offA = client.onEvent((event) => a.push(event))
    client.onEvent((event) => b.push(event))
    client.emit(runEvent('r', 'x'))
    offA()
    client.emit(runEvent('r', 'y'))
    expect(a.map((e) => (e as { nodeId: string }).nodeId)).toEqual(['x'])
    expect(b.map((e) => (e as { nodeId: string }).nodeId)).toEqual(['x', 'y'])
  })

  it('keeps delivering when one listener throws', () => {
    const client = createFakeClient(fakeData)
    const seen: EngineEvent[] = []
    client.onEvent(() => {
      throw new Error('listener bug')
    })
    client.onEvent((event) => seen.push(event))
    expect(() => client.emit(runEvent('r', 'x'))).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})

describe('createFakeClient play', () => {
  const events = [runEvent('r1', 'a'), runEvent('r1', 'b'), runEvent('r1', 'c')]

  it('emits the events in order, one per tick, through the scheduler', () => {
    const client = createFakeClient(fakeData)
    const scheduler = manualScheduler()
    const seen: string[] = []
    client.onEvent((event) => seen.push((event as { nodeId: string }).nodeId))
    client.play('r1', events, scheduler.schedule, 250)
    expect(seen).toEqual([])
    expect(scheduler.delays()).toEqual([0])
    scheduler.runNext()
    expect(seen).toEqual(['a'])
    expect(scheduler.delays()).toEqual([250])
    scheduler.runNext()
    scheduler.runNext()
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(scheduler.pending()).toBe(0)
  })

  it('plays only the events of the given run and those without a run', () => {
    const client = createFakeClient(fakeData)
    const scheduler = manualScheduler()
    const seen: EngineEvent[] = []
    client.onEvent((event) => seen.push(event))
    client.play('r1', [runEvent('r2', 'x'), { type: 'trigger.skipped', at: 1, workflowId: 'w', reason: 'busy' }, runEvent('r1', 'y')], scheduler.schedule)
    while (scheduler.pending() > 0) scheduler.runNext()
    expect(seen.map((e) => e.type)).toEqual(['trigger.skipped', 'step.started'])
  })

  it('does nothing for no events', () => {
    const scheduler = manualScheduler()
    createFakeClient(fakeData).play('r1', [], scheduler.schedule)
    expect(scheduler.pending()).toBe(0)
  })

  it('stops when the returned function is called', () => {
    const client = createFakeClient(fakeData)
    const scheduler = manualScheduler()
    const seen: EngineEvent[] = []
    client.onEvent((event) => seen.push(event))
    const stop = client.play('r1', events, scheduler.schedule)
    scheduler.runNext()
    stop()
    scheduler.runNext()
    expect(seen).toHaveLength(1)
    expect(scheduler.pending()).toBe(0)
  })

  it('does not deliver to a listener that unsubscribed', () => {
    const client = createFakeClient(fakeData)
    const scheduler = manualScheduler()
    const seen: EngineEvent[] = []
    const off = client.onEvent((event) => seen.push(event))
    client.play('r1', events, scheduler.schedule)
    scheduler.runNext()
    off()
    scheduler.runNext()
    scheduler.runNext()
    expect(seen).toHaveLength(1)
  })

  it('uses timers with the interval when no scheduler is given', () => {
    vi.useFakeTimers()
    const client = createFakeClient(fakeData)
    const seen: EngineEvent[] = []
    client.onEvent((event) => seen.push(event))
    client.play('r1', events, undefined, 100)
    vi.advanceTimersByTime(0)
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(99)
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(seen).toHaveLength(2)
    vi.advanceTimersByTime(100)
    expect(seen).toHaveLength(3)
  })
})
