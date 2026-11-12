import type { EngineEvent, MethodName, MethodParams, MethodResult } from '@rill/protocol'
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
    const { client, release } = deferredClient(fake)
    const { result } = renderHook(() => useRunStates(client, ids.runs.receiptOk))
    act(() => fake.emit(ev.started(ids.runs.receiptOk, 'extract')))
    act(() => release())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(stateOf(result.current.states, 'extract')?.status).toBe('succeeded')
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
