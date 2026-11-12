import type { MethodName, MethodParams, MethodResult } from '@rill/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { useWorkflowSource } from '../src/engine/use-workflow'
import { fakeData, ids, workflows } from '../src/fixtures'

describe('useWorkflowSource', () => {
  it('loads the workflow and the catalog', async () => {
    const client = createFakeClient(fakeData)
    const { result } = renderHook(() => useWorkflowSource(client, ids.workflows.branching))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.workflow).toEqual(workflows.branching)
    expect(result.current.catalog).toHaveLength(fakeData.catalog.length)
    expect(result.current.error).toBeUndefined()
  })

  it('does nothing without a workflow id', () => {
    let requests = 0
    const client: EngineClient = {
      request: () => {
        requests += 1
        return Promise.reject(new Error('no'))
      },
      onEvent: () => () => undefined,
    }
    const { result } = renderHook(() => useWorkflowSource(client, undefined))
    expect(result.current).toMatchObject({ workflow: undefined, loading: false, error: undefined })
    expect(requests).toBe(0)
  })

  it('reports the message of an unknown workflow and keeps no data', async () => {
    const client = createFakeClient(fakeData)
    const { result } = renderHook(() => useWorkflowSource(client, 'nope'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('workflow not found: nope')
    expect(result.current.workflow).toBeUndefined()
  })

  it('shows loading and no old workflow while another id loads', async () => {
    const client = createFakeClient(fakeData)
    const { result, rerender } = renderHook(({ id }) => useWorkflowSource(client, id), { initialProps: { id: ids.workflows.receipt as string } })
    await waitFor(() => expect(result.current.workflow).toEqual(workflows.receipt))
    rerender({ id: ids.workflows.webhook })
    expect(result.current.loading).toBe(true)
    expect(result.current.workflow).toBeUndefined()
    await waitFor(() => expect(result.current.workflow).toEqual(workflows.webhook))
  })

  it('ignores an answer that arrives after the id changed or the component went away', async () => {
    const waiting: Array<() => void> = []
    const inner = createFakeClient(fakeData)
    const client: EngineClient = {
      request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
        new Promise<MethodResult<M>>((resolve, reject) => {
          waiting.push(() => inner.request(method, params).then(resolve, reject))
        }),
      onEvent: (listener) => inner.onEvent(listener),
    }
    const { result, rerender, unmount } = renderHook(({ id }) => useWorkflowSource(client, id), { initialProps: { id: ids.workflows.receipt as string } })
    rerender({ id: ids.workflows.webhook })
    expect(waiting).toHaveLength(4)
    const [first, second, third, fourth] = waiting.splice(0)
    await act(async () => {
      third!()
      fourth!()
    })
    await waitFor(() => expect(result.current.workflow).toEqual(workflows.webhook))
    await act(async () => {
      first!()
      second!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.workflow).toEqual(workflows.webhook)
    expect(result.current.loading).toBe(false)
    unmount()
  })

  it('reports a rejected catalog request', async () => {
    const inner = createFakeClient(fakeData)
    const client: EngineClient = {
      request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
        method === 'nodeCatalog' ? Promise.reject(new Error('catalog down')) : inner.request(method, params),
      onEvent: (listener) => inner.onEvent(listener),
    }
    const { result } = renderHook(() => useWorkflowSource(client, ids.workflows.receipt))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('catalog down')
  })
})

describe('useWorkflowSource more', () => {
  it('drops the failure of the workflow it left even when it arrives last', async () => {
    const waiting: Array<() => void> = []
    const inner = createFakeClient(fakeData)
    const client: EngineClient = {
      request: <M extends MethodName>(method: M, params: MethodParams<M>) => {
        const answer = inner.request(method, params)
        answer.catch(() => undefined)
        return new Promise<MethodResult<M>>((resolve, reject) => {
          waiting.push(() => answer.then(resolve, reject))
        })
      },
      onEvent: (listener) => inner.onEvent(listener),
    }
    const { result, rerender } = renderHook(({ id }) => useWorkflowSource(client, id), { initialProps: { id: 'nope' } })
    rerender({ id: ids.workflows.receipt })
    expect(waiting).toHaveLength(4)
    await act(async () => {
      waiting[2]!()
      waiting[3]!()
    })
    await waitFor(() => expect(result.current.workflow).toEqual(workflows.receipt))
    await act(async () => {
      waiting[0]!()
      waiting[1]!()
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(result.current.workflow).toEqual(workflows.receipt)
    expect(result.current.error).toBeUndefined()
  })

  it('shows the text of a rejection that is not an Error', async () => {
    const client: EngineClient = { request: () => Promise.reject('plain text'), onEvent: () => () => undefined }
    const { result } = renderHook(() => useWorkflowSource(client, 'w'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('plain text')
  })
})
