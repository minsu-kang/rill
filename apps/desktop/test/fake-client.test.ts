import { METHODS, RillError, type EngineEvent } from '@rill/protocol'
import Value from 'typebox/value'
import type { StepDetail } from '@rill/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { fakeData, ids } from '../src/fixtures'
import { branchingEvents, failingReceiptEvents, liveFakeData, liveIds } from '../src/fixtures/live'

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

describe('createFakeClient keeps its answers in step with the events it emits', () => {
  const at = 5_000
  const row = (nodeId: string, attempt: number, status: StepDetail['status'], extra: Partial<StepDetail> = {}): StepDetail => ({
    nodeId,
    attempt,
    status,
    input: null,
    output: null,
    error: null,
    startedAt: at,
    finishedAt: null,
    ...extra,
  })

  async function stepsOf(client: ReturnType<typeof createFakeClient>, runId: string): Promise<StepDetail[]> {
    return (await client.request('getRun', { runId })).steps
  }

  it('answers getRun with a running row after step.started and finishes it on step.succeeded', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'step.started', at, runId, nodeId: 'healthy', attempt: 1 })
    expect(await stepsOf(client, runId)).toEqual([row('healthy', 1, 'running')])
    client.emit({ type: 'step.succeeded', at: at + 10, runId, nodeId: 'healthy', attempt: 1 })
    expect(await stepsOf(client, runId)).toEqual([row('healthy', 1, 'succeeded', { finishedAt: at + 10 })])
  })

  it('keeps each attempt as its own row and writes the error of a failed one', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.receiptFails
    client.emit({ type: 'step.started', at, runId, nodeId: 'extract', attempt: 1 })
    client.emit({ type: 'step.failed', at: at + 1, runId, nodeId: 'extract', attempt: 1, error: 'HTTP 503', willRetry: true })
    client.emit({ type: 'step.started', at: at + 2, runId, nodeId: 'extract', attempt: 2 })
    expect(await stepsOf(client, runId)).toEqual([
      row('extract', 1, 'failed', { error: 'HTTP 503', finishedAt: at + 1 }),
      row('extract', 2, 'running', { startedAt: at + 2 }),
    ])
  })

  it('marks a continued attempt with the error text and a skipped node with one finished row', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'step.started', at, runId, nodeId: 'check', attempt: 1 })
    client.emit({ type: 'step.continued', at: at + 3, runId, nodeId: 'check', attempt: 1, error: 'timed out' })
    client.emit({ type: 'step.skipped', at: at + 4, runId, nodeId: 'log' })
    client.emit({ type: 'step.skipped', at: at + 5, runId, nodeId: 'log' })
    expect(await stepsOf(client, runId)).toEqual([
      row('check', 1, 'continued', { error: 'timed out', finishedAt: at + 3 }),
      row('log', 1, 'skipped', { startedAt: at + 4, finishedAt: at + 4 }),
    ])
  })

  it('numbers a skipped row after the attempts the node already has', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'step.started', at, runId, nodeId: 'log', attempt: 1 })
    client.emit({ type: 'step.started', at, runId, nodeId: 'log', attempt: 2 })
    client.emit({ type: 'step.skipped', at: at + 1, runId, nodeId: 'log' })
    expect((await stepsOf(client, runId)).map((r) => [r.attempt, r.status])).toEqual([
      [1, 'running'],
      [2, 'running'],
      [3, 'skipped'],
    ])
  })

  it('skips a node again after a later attempt but not twice in a row', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'step.skipped', at, runId, nodeId: 'log' })
    client.emit({ type: 'step.started', at: at + 1, runId, nodeId: 'log', attempt: 2 })
    client.emit({ type: 'step.skipped', at: at + 2, runId, nodeId: 'log' })
    expect((await stepsOf(client, runId)).map((r) => [r.attempt, r.status])).toEqual([
      [1, 'skipped'],
      [2, 'running'],
      [3, 'skipped'],
    ])
  })

  it('creates the row when the start event was never seen, for every ending event', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'step.succeeded', at, runId, nodeId: 'a', attempt: 1 })
    client.emit({ type: 'step.failed', at: at + 1, runId, nodeId: 'b', attempt: 1, error: 'x', willRetry: false })
    client.emit({ type: 'step.continued', at: at + 2, runId, nodeId: 'c', attempt: 1, error: 'y' })
    expect(await stepsOf(client, runId)).toEqual([
      row('a', 1, 'succeeded', { finishedAt: at }),
      row('b', 1, 'failed', { error: 'x', startedAt: at + 1, finishedAt: at + 1 }),
      row('c', 1, 'continued', { error: 'y', startedAt: at + 2, finishedAt: at + 2 }),
    ])
  })

  it('starts the same attempt again from a clean row', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'step.started', at, runId, nodeId: 'a', attempt: 1 })
    client.emit({ type: 'step.failed', at: at + 1, runId, nodeId: 'a', attempt: 1, error: 'x', willRetry: false })
    client.emit({ type: 'step.started', at: at + 2, runId, nodeId: 'a', attempt: 1 })
    expect(await stepsOf(client, runId)).toEqual([row('a', 1, 'running', { startedAt: at + 2 })])
  })

  it('keeps the steps of one run apart from another run and ignores an unknown run', async () => {
    const client = createFakeClient(liveFakeData())
    client.emit({ type: 'step.started', at, runId: liveIds.branching, nodeId: 'a', attempt: 1 })
    client.emit({ type: 'step.started', at, runId: 'unknown-run', nodeId: 'a', attempt: 1 })
    expect(await stepsOf(client, liveIds.receiptFails)).toEqual([])
    expect(await stepsOf(client, liveIds.branching)).toHaveLength(1)
    await expect(client.request('getRun', { runId: 'unknown-run' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('adds to the rows a run already has', async () => {
    const client = createFakeClient(fakeData)
    const before = (await stepsOf(client, ids.runs.branchingRunning)).length
    client.emit({ type: 'step.started', at, runId: ids.runs.branchingRunning, nodeId: 'log', attempt: 1 })
    expect(await stepsOf(client, ids.runs.branchingRunning)).toHaveLength(before + 1)
  })

  it('updates the run on run.started and run.finished, and listRuns shows it', async () => {
    const client = createFakeClient(liveFakeData())
    const runId = liveIds.branching
    client.emit({ type: 'run.started', at: at + 1, runId, workflowId: ids.workflows.branching, dryRun: true })
    expect((await client.request('getRun', { runId })).run).toMatchObject({ status: 'running', dryRun: true, startedAt: at + 1, finishedAt: null, error: null })
    client.emit({ type: 'run.finished', at: at + 9, runId, status: 'failed', error: 'node check failed: x' })
    const finished = (await client.request('getRun', { runId })).run
    expect(finished).toMatchObject({ status: 'failed', error: 'node check failed: x', finishedAt: at + 9 })
    const listed = (await client.request('listRuns', { workflowId: ids.workflows.branching })).runs.find((r) => r.id === runId)
    expect(listed).toEqual(finished)
  })

  it('adds a queued run at the front on trigger.fired and a running run on an unknown run.started', async () => {
    const client = createFakeClient(fakeData)
    client.emit({ type: 'trigger.fired', at, workflowId: ids.workflows.receipt, runId: 'fresh' })
    client.emit({ type: 'trigger.fired', at: at + 1, workflowId: ids.workflows.receipt, runId: 'fresh' })
    const first = await client.request('listRuns', { workflowId: ids.workflows.receipt })
    expect(first.runs[0]).toEqual({ id: 'fresh', workflowId: ids.workflows.receipt, status: 'queued', dryRun: false, error: null, createdAt: at, startedAt: null, finishedAt: null })
    expect(first.runs.filter((r) => r.id === 'fresh')).toHaveLength(1)
    client.emit({ type: 'run.started', at: at + 2, runId: 'direct', workflowId: ids.workflows.webhook, dryRun: false })
    const second = await client.request('listRuns', { workflowId: ids.workflows.webhook })
    expect(second.runs[0]).toMatchObject({ id: 'direct', status: 'running', createdAt: at + 2, startedAt: at + 2 })
    expect((await client.request('listRuns', { workflowId: ids.workflows.receipt })).runs.some((r) => r.id === 'direct')).toBe(false)
  })

  it('moves a queued run to running when its run.started arrives after trigger.fired', async () => {
    const client = createFakeClient(fakeData)
    client.emit({ type: 'trigger.fired', at, workflowId: ids.workflows.receipt, runId: 'fresh' })
    client.emit({ type: 'run.started', at: at + 1, runId: 'fresh', workflowId: ids.workflows.receipt, dryRun: false })
    const runs = (await client.request('listRuns', { workflowId: ids.workflows.receipt })).runs
    expect(runs.filter((r) => r.id === 'fresh')).toEqual([expect.objectContaining({ status: 'running', createdAt: at, startedAt: at + 1 })])
  })

  it('has applied an event before a listener hears about it', async () => {
    const client = createFakeClient(liveFakeData())
    const seen: number[] = []
    client.onEvent(() => {
      void client.request('getRun', { runId: liveIds.branching }).then((result) => seen.push(result.steps.length))
    })
    client.emit({ type: 'step.started', at, runId: liveIds.branching, nodeId: 'a', attempt: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([1])
  })

  it('does not change the data it was given, and a second client starts from the original data', async () => {
    const data = liveFakeData()
    const snapshot = structuredClone(data)
    const client = createFakeClient(data)
    for (const event of branchingEvents(liveIds.branching)) client.emit(event)
    expect(data).toEqual(snapshot)
    const other = createFakeClient(data)
    expect((await other.request('getRun', { runId: liveIds.branching })).steps).toEqual([])
  })

  it('plays a whole script into answers that pass the protocol schema and match what the events said', async () => {
    const client = createFakeClient(liveFakeData())
    const scheduler = manualScheduler()
    client.play(liveIds.receiptFails, failingReceiptEvents(liveIds.receiptFails), scheduler.schedule)
    while (scheduler.pending() > 0) scheduler.runNext()
    const result = await client.request('getRun', { runId: liveIds.receiptFails })
    expect(Value.Check(METHODS.getRun.result, result)).toBe(true)
    expect(result.run).toMatchObject({ status: 'failed', error: expect.stringContaining('node extract failed') })
    expect(result.steps.map((r) => [r.nodeId, r.attempt, r.status])).toEqual([
      ['extract', 1, 'failed'],
      ['extract', 2, 'failed'],
      ['extract', 3, 'failed'],
      ['append', 1, 'skipped'],
    ])
    expect(Value.Check(METHODS.listRuns.result, await client.request('listRuns', {}))).toBe(true)
  })

  it('does not apply workflow or trigger notices to any run', async () => {
    const client = createFakeClient(liveFakeData())
    const before = await client.request('listRuns', {})
    client.emit({ type: 'trigger.skipped', at, workflowId: ids.workflows.receipt, reason: 'busy' })
    client.emit({ type: 'trigger.error', at, workflowId: ids.workflows.receipt, error: 'x' })
    client.emit({ type: 'workflow.activated', at, workflowId: ids.workflows.receipt })
    client.emit({ type: 'workflow.deactivated', at, workflowId: ids.workflows.receipt })
    expect(await client.request('listRuns', {})).toEqual(before)
  })
})
