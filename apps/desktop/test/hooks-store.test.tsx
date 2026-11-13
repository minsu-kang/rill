import { HOOK_LOG_DEFAULT_LIMIT, RillError, type Hook, type HookInput, type HookLogEntry, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { hookStoreFor, useHookStore } from '../src/engine/hook-store'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

const workflowId = fakeData.workflows[0]!.id

const record: HookInput = { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true }
const other: HookInput = { event: 'run.succeeded', scope: { type: 'all' }, action: { type: 'record' }, enabled: true }

function seedHook(id: string, input: HookInput = record): Hook {
  return { id, ...input, createdAt: 1, updatedAt: 1 }
}

function row(id: number, outcome: HookLogEntry['outcome'] = 'ok'): HookLogEntry {
  return { id, hookId: 'h1', at: id, event: 'run.failed', workflowId, outcome, code: null }
}

function world(options: { hooks?: readonly Hook[]; log?: readonly HookLogEntry[]; intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined } = {}) {
  const base = createFakeClient(fakeData)
  const inner = withPlanMethods(base, {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.log === undefined ? {} : { hookLog: options.log }),
  })
  const calls: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      return (options.intercept?.(method, params) ?? inner.request(method, params)) as Promise<MethodResult<M>>
    },
    onEvent: inner.onEvent,
  }
  return { client, inner, base, calls, count: (method: MethodName) => calls.filter((call) => call.method === method).length, paramsOf: (method: MethodName) => calls.filter((call) => call.method === method).map((call) => call.params) }
}

describe('the hook store', () => {
  it('starts loading, asks the engine once, and is ready with the hooks and no log yet', async () => {
    const { client, count } = world({ hooks: [seedHook('h1')] })
    const { result } = renderHook(() => useHookStore(client))
    expect(result.current.state.status).toBe('loading')
    expect(result.current.state.log).toEqual({ status: 'idle', entries: [] })
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(result.current.state.hooks).toEqual([seedHook('h1')])
    expect(count('listHooks')).toBe(1)
    expect(count('listHookLog')).toBe(0)
  })

  it('is one store per client, so two readers share one request', async () => {
    const { client, count } = world()
    const first = renderHook(() => useHookStore(client))
    const second = renderHook(() => useHookStore(client))
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'))
    expect(second.result.current.state.status).toBe('ready')
    expect(count('listHooks')).toBe(1)
    expect(hookStoreFor(client)).toBe(hookStoreFor(client))
  })

  it('reports a load error, loads again on refresh, and asks again when a reader comes while the last load failed', async () => {
    let fail = true
    const { client, count } = world({ intercept: (method) => (method === 'listHooks' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    const first = renderHook(() => useHookStore(client))
    await waitFor(() => expect(first.result.current.state.status).toBe('error'))
    fail = false
    await act(async () => {
      await first.result.current.store.refresh()
    })
    expect(first.result.current.state.status).toBe('ready')
    expect(count('listHooks')).toBe(2)
  })

  it('keeps the hooks that it has when a later refresh fails', async () => {
    let fail = false
    const { client } = world({ hooks: [seedHook('h1')], intercept: (method) => (method === 'listHooks' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    fail = true
    await act(async () => {
      await result.current.store.refresh()
    })
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.hooks).toEqual([seedHook('h1')])
  })

  it('saves a new hook at the end of the list and an edited hook in its place, and answers with the hook', async () => {
    const { client } = world({ hooks: [seedHook('h1')] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    let created: Hook | undefined
    await act(async () => {
      created = await result.current.store.save(other)
    })
    expect(created).toMatchObject({ event: 'run.succeeded', enabled: true })
    expect(result.current.state.hooks.map((hook) => hook.id)).toEqual(['h1', created!.id])
    await act(async () => {
      await result.current.store.save({ ...record, enabled: false, id: 'h1' })
    })
    expect(result.current.state.hooks.map((hook) => [hook.id, hook.enabled])).toEqual([
      ['h1', false],
      [created!.id, true],
    ])
  })

  it('deletes a hook and answers with the flag of the engine', async () => {
    const { client } = world({ hooks: [seedHook('h1'), seedHook('h2', other)] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    let deleted: boolean | undefined
    await act(async () => {
      deleted = await result.current.store.remove('h1')
    })
    expect(deleted).toBe(true)
    expect(result.current.state.hooks.map((hook) => hook.id)).toEqual(['h2'])
    await act(async () => {
      deleted = await result.current.store.remove('h1')
    })
    expect(deleted).toBe(false)
    expect(result.current.state.hooks.map((hook) => hook.id)).toEqual(['h2'])
  })

  it('runs the writes one after another, in the order in which they were asked', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { client, inner } = world({
      hooks: [seedHook('h1')],
      intercept: (method, params) => {
        if (method !== 'saveHook') return undefined
        const id = (params as { id?: string }).id ?? 'new'
        order.push(`start ${id}`)
        return (id === 'h1' ? gate : Promise.resolve()).then(() => {
          order.push(`end ${id}`)
          return inner.request(method, params as MethodParams<'saveHook'>)
        })
      },
    })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    let first!: Promise<Hook>
    let second!: Promise<Hook>
    act(() => {
      first = result.current.store.save({ ...record, enabled: false, id: 'h1' })
      second = result.current.store.save(other)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(order).toEqual(['start h1'])
    await act(async () => {
      release()
      await Promise.all([first, second])
    })
    expect(order).toEqual(['start h1', 'end h1', 'start new', 'end new'])
    expect(result.current.state.hooks).toHaveLength(2)
  })

  it('passes the error of a refused save on and keeps the list as it was', async () => {
    const { client } = world({ hooks: [seedHook('h1')] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await expect(result.current.store.save({ ...record, action: { type: 'deactivateAfterFailures', count: 1 } })).rejects.toMatchObject({ code: 'HOOK_INVALID' })
    })
    expect(result.current.state.hooks).toEqual([seedHook('h1')])
  })

  it('loads the list again when the engine says that a hook is not there', async () => {
    const { client, count } = world({ hooks: [seedHook('h1')] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await expect(result.current.store.save({ ...record, id: 'ghost' })).rejects.toMatchObject({ code: 'HOOK_NOT_FOUND' })
    })
    await waitFor(() => expect(count('listHooks')).toBe(2))
  })

  it('does not load the list again for a refusal that says nothing about the list', async () => {
    const { client, count } = world({ hooks: [seedHook('h1')] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await expect(result.current.store.save({ ...record, action: { type: 'deactivateAfterFailures', count: 1 } })).rejects.toMatchObject({ code: 'HOOK_INVALID' })
    })
    expect(count('listHooks')).toBe(1)
  })

  it('loads the list again when the answer of a save is lost, since the engine may have saved the hook', async () => {
    let lose = true
    const { client, count, inner } = world({
      hooks: [seedHook('h1')],
      intercept: (method, params) =>
        method === 'saveHook' && lose
          ? inner.request(method, params as MethodParams<'saveHook'>).then(() => {
              throw new RillError('INTERNAL', 'engine restarted')
            })
          : undefined,
    })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await expect(result.current.store.save(other)).rejects.toMatchObject({ code: 'INTERNAL' })
    })
    lose = false
    await waitFor(() => expect(result.current.state.hooks.map((hook) => hook.event)).toEqual(['run.failed', 'run.succeeded']))
    expect(count('listHooks')).toBe(2)
  })

  it('loads the list again when the engine calls a hook a duplicate that the list does not show', async () => {
    const { client, count, inner } = world({ hooks: [seedHook('h1')] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await inner.request('saveHook', other)
    await act(async () => {
      await expect(result.current.store.save(other)).rejects.toMatchObject({ code: 'HOOK_INVALID', problems: [expect.stringContaining('hook.duplicate')] })
    })
    await waitFor(() => expect(result.current.state.hooks.map((hook) => hook.event)).toEqual(['run.failed', 'run.succeeded']))
    expect(count('listHooks')).toBe(2)
  })

  it('answers a write that comes before the first list, and then loads the list', async () => {
    const { client, count } = world({ hooks: [seedHook('h1')] })
    const store = hookStoreFor(client)
    await act(async () => {
      await store.save(other)
    })
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    expect(store.getState().hooks.map((hook) => hook.event)).toEqual(['run.failed', 'run.succeeded'])
    expect(count('listHooks')).toBe(1)
  })
})

describe('the hooks of a workflow that is deleted', () => {
  it('are loaded again when the engine says that the workflow is gone, so that the list never shows a hook that the engine deleted with it', async () => {
    const scoped = seedHook('h2', { event: 'run.failed', scope: { type: 'workflow', workflowId }, action: { type: 'record' }, enabled: true })
    const { client, base, count } = world({ hooks: [seedHook('h1'), scoped] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.hooks.map((hook) => hook.id)).toEqual(['h1', 'h2']))
    act(() => {
      base.emit({ type: 'workflow.deleted', at: 1, workflowId })
    })
    await waitFor(() => expect(result.current.state.hooks.map((hook) => hook.id)).toEqual(['h1']))
    expect(count('listHooks')).toBe(2)
  })

  it('are loaded again when a write finishes while that load is on its way, so that the old list is not written back over it', async () => {
    const scoped = seedHook('h2', { event: 'run.failed', scope: { type: 'workflow', workflowId }, action: { type: 'record' }, enabled: true })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let lists = 0
    const { client, base, inner, count } = world({
      hooks: [seedHook('h1'), scoped],
      intercept: (method, params) => {
        if (method !== 'listHooks') return undefined
        lists += 1
        return lists === 2 ? gate.then(() => inner.request(method, params as MethodParams<'listHooks'>)) : undefined
      },
    })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.hooks.map((hook) => hook.id)).toEqual(['h1', 'h2']))
    act(() => {
      base.emit({ type: 'workflow.deleted', at: 1, workflowId })
    })
    await act(async () => {
      await result.current.store.save(other)
    })
    await act(async () => {
      release()
    })
    await waitFor(() => expect(result.current.state.hooks.map((hook) => hook.event)).toEqual(['run.failed', 'run.succeeded']))
    expect(result.current.state.hooks.map((hook) => hook.id)).not.toContain('h2')
    expect(count('listHooks')).toBe(3)
  })

  it('are not loaded for an event of another kind, nor before anyone has asked for the hooks', async () => {
    const { client, base, count } = world({ hooks: [seedHook('h1')] })
    act(() => {
      base.emit({ type: 'workflow.deleted', at: 1, workflowId })
    })
    expect(count('listHooks')).toBe(0)
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    act(() => {
      base.emit({ type: 'workflow.activated', at: 2, workflowId })
    })
    expect(count('listHooks')).toBe(1)
  })
})

describe('the activity log of the hook store', () => {
  it('asks for the newest rows, as many as the screen shows, only when it is told to', async () => {
    const { client, paramsOf } = world({ hooks: [seedHook('h1')], log: [row(1), row(2), row(3)] })
    const { result } = renderHook(() => useHookStore(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(paramsOf('listHookLog')).toEqual([])
    await act(async () => {
      await result.current.store.refreshLog()
    })
    expect(paramsOf('listHookLog')).toEqual([{ limit: HOOK_LOG_DEFAULT_LIMIT }])
    expect(HOOK_LOG_DEFAULT_LIMIT).toBe(50)
    expect(result.current.state.log.status).toBe('ready')
    expect(result.current.state.log.entries.map((entry) => entry.id)).toEqual([3, 2, 1])
  })

  it('shows loading while it asks, and keeps the rows that it has', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const { client, inner } = world({
      log: [row(1)],
      intercept: (method, params) => (method === 'listHookLog' && held ? gate.then(() => inner.request(method, params as MethodParams<'listHookLog'>)) : undefined),
    })
    const { result } = renderHook(() => useHookStore(client))
    await act(async () => {
      await result.current.store.refreshLog()
    })
    inner.hooks.addLog({ hookId: 'h1', at: 2, event: 'run.failed', workflowId, outcome: 'failed', code: 'timeout' })
    held = true
    let pending!: Promise<void>
    act(() => {
      pending = result.current.store.refreshLog()
    })
    expect(result.current.state.log.status).toBe('loading')
    expect(result.current.state.log.entries.map((entry) => entry.id)).toEqual([1])
    await act(async () => {
      release()
      await pending
    })
    expect(result.current.state.log.status).toBe('ready')
    expect(result.current.state.log.entries.map((entry) => entry.id)).toEqual([2, 1])
  })

  it('reports an error and keeps the rows that it has, and recovers on the next refresh', async () => {
    let fail = false
    const { client } = world({ log: [row(1)], intercept: (method) => (method === 'listHookLog' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    const { result } = renderHook(() => useHookStore(client))
    await act(async () => {
      await result.current.store.refreshLog()
    })
    fail = true
    await act(async () => {
      await result.current.store.refreshLog()
    })
    expect(result.current.state.log.status).toBe('error')
    expect(result.current.state.log.entries.map((entry) => entry.id)).toEqual([1])
    fail = false
    await act(async () => {
      await result.current.store.refreshLog()
    })
    expect(result.current.state.log.status).toBe('ready')
  })

  it('lets the newest answer win when two refreshes overlap', async () => {
    const resolvers: Array<() => void> = []
    const { client, inner } = world({
      log: [row(1)],
      intercept: (method, params) => {
        if (method !== 'listHookLog') return undefined
        const answer = inner.request(method, params as MethodParams<'listHookLog'>)
        return new Promise((resolve) => {
          resolvers.push(() => resolve(answer))
        })
      },
    })
    const { result } = renderHook(() => useHookStore(client))
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.store.refreshLog()
    })
    inner.hooks.addLog({ hookId: 'h1', at: 2, event: 'run.failed', workflowId, outcome: 'ok', code: null })
    act(() => {
      second = result.current.store.refreshLog()
    })
    await act(async () => {
      resolvers[1]!()
      await second
    })
    await act(async () => {
      resolvers[0]!()
      await first
    })
    expect(result.current.state.log.entries.map((entry) => entry.id)).toEqual([2, 1])
    expect(result.current.state.log.status).toBe('ready')
  })
})
