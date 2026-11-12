import type { EngineEvent, MethodName, MethodParams, MethodResult, RunSummary, StepDetail } from '@rill/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { useRunList, useRunStates } from '../src/engine/hooks'
import { fakeData, ids } from '../src/fixtures'
import { stateOf } from '../src/model/status'

function spied(client: EngineClient) {
  const calls: Array<{ method: string; params: unknown }> = []
  let listeners = 0
  const wrapped: EngineClient = {
    request: (method, params) => {
      calls.push({ method, params })
      return client.request(method, params)
    },
    onEvent: (listener) => {
      listeners += 1
      const off = client.onEvent(listener)
      let done = false
      return () => {
        if (!done) listeners -= 1
        done = true
        off()
      }
    },
  }
  return { client: wrapped, calls, listeners: () => listeners }
}

function deferredClient(inner: EngineClient) {
  const waiting: Array<() => void> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
      new Promise<MethodResult<M>>((resolve, reject) => {
        waiting.push(() => inner.request(method, params).then(resolve, reject))
      }),
    onEvent: (listener) => inner.onEvent(listener),
  }
  return { client, release: () => waiting.splice(0).forEach((fn) => fn()), pending: () => waiting.length }
}

function heldClient(inner: EngineClient) {
  const waiting: Array<() => void> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>) => {
      const answer = inner.request(method, params)
      return new Promise<MethodResult<M>>((resolve, reject) => {
        waiting.push(() => answer.then(resolve, reject))
      })
    },
    onEvent: (listener) => inner.onEvent(listener),
  }
  return { client, release: () => waiting.splice(0).forEach((fn) => fn()) }
}

const run = (status: RunSummary['status'], id = 'r1'): RunSummary => ({ id, workflowId: 'w1', status, dryRun: false, error: null, createdAt: 1, startedAt: status === 'queued' ? null : 2, finishedAt: null })
const row = (nodeId: string, attempt: number, status: StepDetail['status'], error: string | null = null): StepDetail => ({
  nodeId,
  attempt,
  status,
  input: null,
  output: null,
  error,
  startedAt: attempt,
  finishedAt: status === 'running' ? null : attempt + 1,
})
const tiny = (runs: RunSummary[], steps: Record<string, StepDetail[]>) => createFakeClient({ workflows: [], runs, steps, catalog: [] })

const at = 9000
const ev = {
  started: (runId: string, nodeId: string, attempt = 1): EngineEvent => ({ type: 'step.started', at, runId, nodeId, attempt }),
  succeeded: (runId: string, nodeId: string, attempt = 1): EngineEvent => ({ type: 'step.succeeded', at, runId, nodeId, attempt }),
}

describe('useRunStates', () => {
  it('does nothing without a run id', () => {
    const { client, calls, listeners } = spied(createFakeClient(fakeData))
    const { result } = renderHook(() => useRunStates(client, undefined))
    expect(result.current).toMatchObject({ run: undefined, steps: [], error: undefined, loading: false })
    expect(Object.keys(result.current.states)).toEqual([])
    expect(calls).toEqual([])
    expect(listeners()).toBe(0)
  })

  it('loads the run, its steps and the node states', async () => {
    const client = createFakeClient(fakeData)
    const { result } = renderHook(() => useRunStates(client, ids.runs.receiptFailed))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeUndefined()
    expect(result.current.run?.id).toBe(ids.runs.receiptFailed)
    expect(result.current.steps).toEqual(fakeData.steps[ids.runs.receiptFailed])
    expect(stateOf(result.current.states, 'extract')).toMatchObject({ status: 'failed', attempt: 3 })
    expect(stateOf(result.current.states, 'append')).toBeUndefined()
  })

  it('updates node states and the run when events of the open run arrive', async () => {
    const client = createFakeClient(fakeData)
    const { result } = renderHook(() => useRunStates(client, ids.runs.branchingRunning))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'healthy')?.status).toBe('running')
    act(() => client.emit(ev.succeeded(ids.runs.branchingRunning, 'healthy')))
    expect(stateOf(result.current.states, 'healthy')?.status).toBe('succeeded')
    act(() => client.emit({ type: 'step.skipped', at, runId: ids.runs.branchingRunning, nodeId: 'alert' }))
    expect(stateOf(result.current.states, 'alert')?.status).toBe('skipped')
    act(() => client.emit({ type: 'run.finished', at, runId: ids.runs.branchingRunning, status: 'succeeded', error: null }))
    expect(result.current.run).toMatchObject({ status: 'succeeded', finishedAt: at })
  })

  it('ignores events of other runs without asking the engine again', async () => {
    const fake = createFakeClient(fakeData)
    const { client, calls } = spied(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.branchingRunning))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = result.current.states
    const requests = calls.length
    act(() => fake.emit(ev.started('another-run', 'healthy', 1)))
    act(() => fake.emit({ type: 'run.finished', at, runId: 'another-run', status: 'failed', error: 'x' }))
    expect(result.current.states).toBe(before)
    expect(calls.length).toBe(requests)
  })

  it('fetches the steps again after a step event and keeps the event states', async () => {
    const fake = createFakeClient(fakeData)
    const { client, calls } = spied(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.branchingRunning))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const requests = calls.length
    act(() => fake.emit(ev.succeeded(ids.runs.branchingRunning, 'healthy')))
    await waitFor(() => expect(calls.length).toBe(requests + 1))
    expect(calls.at(-1)).toEqual({ method: 'getRun', params: { runId: ids.runs.branchingRunning } })
    expect(stateOf(result.current.states, 'healthy')?.status).toBe('succeeded')
  })

  it('applies events that arrive while the first request is still open', async () => {
    const fake = createFakeClient(fakeData)
    const { client, release } = deferredClient(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.branchingRunning))
    act(() => fake.emit(ev.succeeded(ids.runs.branchingRunning, 'healthy')))
    act(() => fake.emit(ev.started(ids.runs.branchingRunning, 'log')))
    expect(result.current.loading).toBe(true)
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'healthy')?.status).toBe('succeeded')
    expect(stateOf(result.current.states, 'log')?.status).toBe('running')
  })

  it('does not let an old buffered event undo the loaded state', async () => {
    const fake = createFakeClient(fakeData)
    const { client, release } = heldClient(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.receiptOk))
    act(() => fake.emit(ev.started(ids.runs.receiptOk, 'extract')))
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'extract')?.status).toBe('succeeded')
  })

  it('shows the node as running when the event came first and the answer, taken afterwards, agrees', async () => {
    const fake = createFakeClient(fakeData)
    const { client, release } = deferredClient(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.receiptOk))
    act(() => fake.emit(ev.started(ids.runs.receiptOk, 'extract')))
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'extract')?.status).toBe('running')
    expect(result.current.steps.find((item) => item.nodeId === 'extract')?.status).toBe('running')
  })

  it('keeps the states of the loaded rows when a run.started that is older than the answer was buffered', async () => {
    const fake = tiny([run('running')], { r1: [row('a', 1, 'succeeded'), row('b', 1, 'running')] })
    const { client, release } = deferredClient(fake)
    const { result } = renderHook(() => useRunStates(client, 'r1'))
    act(() => fake.emit({ type: 'run.started', at, runId: 'r1', workflowId: 'w1', dryRun: false }))
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'a')?.status).toBe('succeeded')
    expect(stateOf(result.current.states, 'b')?.status).toBe('running')
    expect(result.current.run?.status).toBe('running')
  })

  it('does not let an old run.started turn a finished run back into a running one', async () => {
    const fake = tiny([{ ...run('succeeded'), finishedAt: 5 }], { r1: [row('a', 1, 'succeeded')] })
    const { client, release } = heldClient(fake)
    const { result } = renderHook(() => useRunStates(client, 'r1'))
    act(() => fake.emit({ type: 'run.started', at, runId: 'r1', workflowId: 'w1', dryRun: false }))
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.run).toMatchObject({ status: 'succeeded', finishedAt: 5 })
  })

  it('still starts a queued run from a buffered run.started and the step events after it', async () => {
    const fake = tiny([run('queued')], { r1: [] })
    const { client, release } = heldClient(fake)
    const { result } = renderHook(() => useRunStates(client, 'r1'))
    act(() => fake.emit({ type: 'run.started', at, runId: 'r1', workflowId: 'w1', dryRun: false }))
    act(() => fake.emit(ev.started('r1', 'a')))
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.run).toMatchObject({ status: 'running', startedAt: at })
    expect(stateOf(result.current.states, 'a')?.status).toBe('running')
  })

  it('shows a node whose last row failed in a running run as running and retrying', async () => {
    const fake = tiny([run('running')], { r1: [row('a', 1, 'failed', 'HTTP 503')] })
    const { result } = renderHook(() => useRunStates(fake, 'r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'a')).toEqual({ status: 'running', attempt: 1, retrying: true, error: 'HTTP 503' })
  })

  it('shows the same failed row as failed once the run is not running', async () => {
    const fake = tiny([{ ...run('failed'), finishedAt: 5 }], { r1: [row('a', 1, 'failed', 'HTTP 503')] })
    const { result } = renderHook(() => useRunStates(fake, 'r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'a')).toEqual({ status: 'failed', attempt: 1, retrying: false, error: 'HTTP 503' })
  })

  it('refetches only when a step ends or the run finishes', async () => {
    const fake = createFakeClient(fakeData)
    const { client, calls } = spied(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.branchingRunning))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const requests = () => calls.filter((call) => call.method === 'getRun').length
    const runId = ids.runs.branchingRunning
    const quiet: EngineEvent[] = [
      { type: 'run.started', at, runId, workflowId: ids.workflows.branching, dryRun: false },
      ev.started(runId, 'log', 1),
      { type: 'trigger.fired', at, workflowId: ids.workflows.branching, runId },
    ]
    const before = requests()
    for (const event of quiet) act(() => fake.emit(event))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(requests()).toBe(before)
    const ending: EngineEvent[] = [
      ev.succeeded(runId, 'log'),
      { type: 'step.failed', at, runId, nodeId: 'alert', attempt: 1, error: 'x', willRetry: false },
      { type: 'step.continued', at, runId, nodeId: 'check', attempt: 1, error: 'x' },
      { type: 'step.skipped', at, runId, nodeId: 'other' },
      { type: 'run.finished', at, runId, status: 'succeeded', error: null },
    ]
    let expected = before
    for (const event of ending) {
      act(() => fake.emit(event))
      expected += 1
      await waitFor(() => expect(requests(), event.type).toBe(expected))
    }
  })

  it('does not refetch for a step that will be retried while the rows are about to change again', async () => {
    const fake = createFakeClient(fakeData)
    const { client, calls } = spied(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.branchingRunning))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = calls.length
    act(() => fake.emit({ type: 'step.started', at, runId: ids.runs.branchingRunning, nodeId: 'healthy', attempt: 2 }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(calls.length).toBe(before)
  })

  it('recovers from a failed first request on the next ending event with the states read from the rows', async () => {
    let calls = 0
    const rows = [row('a', 1, 'failed', 'HTTP 503')]
    const listeners = new Set<(event: EngineEvent) => void>()
    const client: EngineClient = {
      request: <M extends MethodName>(): Promise<MethodResult<M>> => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('socket closed'))
        return Promise.resolve({ run: run('running'), steps: rows } as MethodResult<M>)
      },
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const { result } = renderHook(() => useRunStates(client, 'r1'))
    await waitFor(() => expect(result.current.error).toBe('socket closed'))
    act(() => listeners.forEach((listener) => listener(ev.succeeded('r1', 'b'))))
    await waitFor(() => expect(result.current.error).toBeUndefined())
    expect(result.current.run?.status).toBe('running')
    expect(stateOf(result.current.states, 'a')).toEqual({ status: 'running', attempt: 1, retrying: true, error: 'HTTP 503' })
    expect(stateOf(result.current.states, 'b')).toBeUndefined()
  })

  it('reports the message of a rejected request', async () => {
    const client: EngineClient = {
      request: () => Promise.reject(new Error('socket closed')),
      onEvent: () => () => undefined,
    }
    const { result } = renderHook(() => useRunStates(client, 'any'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('socket closed')
    expect(result.current.run).toBeUndefined()
    expect(result.current.steps).toEqual([])
  })

  it('reports a RillError of an unknown run', async () => {
    const client = createFakeClient(fakeData)
    const { result } = renderHook(() => useRunStates(client, 'missing'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('run not found: missing')
  })

  it('switches to the new run and drops the old one', async () => {
    const { client, listeners } = spied(createFakeClient(fakeData))
    const { result, rerender } = renderHook(({ id }) => useRunStates(client, id), { initialProps: { id: ids.runs.receiptOk as string | undefined } })
    await waitFor(() => expect(result.current.run?.id).toBe(ids.runs.receiptOk))
    rerender({ id: ids.runs.receiptFailed })
    expect(result.current.loading).toBe(true)
    expect(result.current.run).toBeUndefined()
    await waitFor(() => expect(result.current.run?.id).toBe(ids.runs.receiptFailed))
    expect(listeners()).toBe(1)
    rerender({ id: undefined })
    expect(result.current.loading).toBe(false)
    expect(result.current.run).toBeUndefined()
    expect(listeners()).toBe(0)
  })

  it('unsubscribes on unmount and ignores a response that arrives afterwards', async () => {
    const fake = createFakeClient(fakeData)
    const { client, release } = deferredClient(fake)
    const spy = spied(client)
    const { unmount } = renderHook(() => useRunStates(spy.client, ids.runs.receiptOk))
    expect(spy.listeners()).toBe(1)
    unmount()
    expect(spy.listeners()).toBe(0)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => release())
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('useRunList', () => {
  it('does nothing without a workflow id', () => {
    const { client, calls } = spied(createFakeClient(fakeData))
    const { result } = renderHook(() => useRunList(client, undefined))
    expect(result.current).toEqual({ runs: [], error: undefined, loading: false })
    expect(calls).toEqual([])
  })

  it('loads the runs of the workflow in the given order', async () => {
    const client = createFakeClient(fakeData)
    const { result } = renderHook(() => useRunList(client, ids.workflows.receipt))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.runs.map((r) => r.id)).toEqual(fakeData.runs.filter((r) => r.workflowId === ids.workflows.receipt).map((r) => r.id))
    expect(result.current.error).toBeUndefined()
  })

  it('asks for the runs of the workflow again when one of its runs starts or finishes', async () => {
    const fake = createFakeClient(fakeData)
    const { client, calls } = spied(fake)
    const { result } = renderHook(() => useRunList(client, ids.workflows.receipt))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const requests = calls.length
    act(() => fake.emit({ type: 'run.started', at, runId: 'new-run', workflowId: ids.workflows.receipt, dryRun: false }))
    await waitFor(() => expect(calls.length).toBe(requests + 1))
    act(() => fake.emit({ type: 'run.finished', at, runId: 'new-run', status: 'succeeded', error: null }))
    await waitFor(() => expect(calls.length).toBe(requests + 2))
    expect(calls.at(-1)).toMatchObject({ method: 'listRuns', params: { workflowId: ids.workflows.receipt } })
  })

  it('ignores runs of other workflows when they start', async () => {
    const fake = createFakeClient(fakeData)
    const { client, calls } = spied(fake)
    const { result } = renderHook(() => useRunList(client, ids.workflows.receipt))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const requests = calls.length
    act(() => fake.emit({ type: 'run.started', at, runId: 'other', workflowId: ids.workflows.webhook, dryRun: false }))
    act(() => fake.emit({ type: 'trigger.fired', at, workflowId: ids.workflows.webhook, runId: 'other' }))
    await Promise.resolve()
    expect(calls.length).toBe(requests)
  })

  it('reports the message of a rejected request', async () => {
    const client: EngineClient = { request: () => Promise.reject(new Error('offline')), onEvent: () => () => undefined }
    const { result } = renderHook(() => useRunList(client, 'w'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({ runs: [], error: 'offline' })
  })

  it('unsubscribes on unmount and when the workflow changes', async () => {
    const { client, listeners } = spied(createFakeClient(fakeData))
    const { result, rerender, unmount } = renderHook(({ id }) => useRunList(client, id), { initialProps: { id: ids.workflows.receipt as string } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(listeners()).toBe(1)
    rerender({ id: ids.workflows.branching })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.runs.every((r) => r.workflowId === ids.workflows.branching)).toBe(true)
    expect(listeners()).toBe(1)
    unmount()
    expect(listeners()).toBe(0)
  })
})
