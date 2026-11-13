import { RillError, type Agent, type AgentFields, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { agentIdForRequest, agentsStoreFor, activeAgentOf, sendsAgentText, useAgents } from '../src/engine/agents'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

const fields: AgentFields = { name: 'Reviewer', description: '', persona: 'Calm.', instructions: '' }

function world(extra: { fail?: (method: MethodName) => boolean } = {}) {
  const inner = withPlanMethods(createFakeClient(fakeData), { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three] })
  const calls: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      if (extra.fail?.(method) === true) throw new RillError('INTERNAL', 'x')
      return inner.request(method, params)
    },
    onEvent: inner.onEvent,
  }
  return { client, calls, inner, callsOf: (method: MethodName) => calls.filter((call) => call.method === method) }
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return { id, name: id, description: '', persona: '', instructions: '', builtin: false, createdAt: 1, updatedAt: 1, ...overrides }
}

describe('the agents store of a client', () => {
  it('is one store per client, loaded once on the first subscription and not before', async () => {
    const { client, callsOf } = world()
    const store = agentsStoreFor(client)
    expect(agentsStoreFor(client)).toBe(store)
    expect(store.getState()).toMatchObject({ status: 'loading', agents: [], activeId: 'default' })
    expect(callsOf('listAgents')).toHaveLength(0)
    const one = vi.fn()
    const two = vi.fn()
    const offOne = store.subscribe(one)
    const offTwo = store.subscribe(two)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    expect(callsOf('listAgents')).toHaveLength(1)
    expect(store.getState().agents.map((entry) => entry.id)).toEqual(['default'])
    expect(one).toHaveBeenCalled()
    expect(two).toHaveBeenCalled()
    offOne()
    offTwo()
    const another = world()
    expect(agentsStoreFor(another.client)).not.toBe(store)
  })

  it('can be watched without loading, and tells a watcher what a later load brings', async () => {
    const { client, callsOf } = world()
    const store = agentsStoreFor(client)
    const heard = vi.fn()
    const stop = store.watch(heard)
    await Promise.resolve()
    expect(callsOf('listAgents')).toHaveLength(0)
    await store.refresh()
    expect(heard).toHaveBeenCalled()
    expect(store.getState().status).toBe('ready')
    stop()
    heard.mockClear()
    await store.refresh()
    expect(heard).not.toHaveBeenCalled()
  })

  it('goes to the error state when the engine cannot list, and loads again on refresh', async () => {
    let failing = true
    const { client } = world({ fail: (method) => method === 'listAgents' && failing })
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('error'))
    expect(store.getState().agents).toEqual([])
    failing = false
    const refreshing = store.refresh()
    expect(store.getState().status).toBe('loading')
    await refreshing
    expect(store.getState().status).toBe('ready')
    off()
  })

  it('keeps the list when a refresh fails after a good load, and shows the error', async () => {
    let failing = false
    const { client } = world({ fail: (method) => method === 'listAgents' && failing })
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    await store.save(fields)
    failing = true
    await store.refresh()
    expect(store.getState().status).toBe('error')
    expect(store.getState().agents.map((entry) => entry.name)).toEqual(['Default', 'Reviewer'])
    off()
  })

  it('saves, orders by name, activates and deletes through the engine and updates the state', async () => {
    const { client, callsOf } = world()
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    const charlie = await store.save({ ...fields, name: 'charlie' })
    const alpha = await store.save({ ...fields, name: 'Alpha' })
    expect(store.getState().agents.map((entry) => entry.name)).toEqual(['Default', 'Alpha', 'charlie'])
    await store.save({ ...fields, id: charlie.id, name: 'bravo' })
    expect(store.getState().agents.map((entry) => entry.name)).toEqual(['Default', 'Alpha', 'bravo'])
    await store.select(alpha.id)
    expect(store.getState().activeId).toBe(alpha.id)
    expect(callsOf('setActiveAgent')).toHaveLength(1)
    expect(await store.remove(alpha.id)).toBe(true)
    expect(store.getState().activeId).toBe('default')
    expect(store.getState().agents.map((entry) => entry.name)).toEqual(['Default', 'bravo'])
    expect(callsOf('listAgents')).toHaveLength(1)
    off()
  })

  it('keeps the active agent when another agent is deleted', async () => {
    const { client } = world()
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    const one = await store.save({ ...fields, name: 'one' })
    const two = await store.save({ ...fields, name: 'two' })
    await store.select(one.id)
    await store.remove(two.id)
    expect(store.getState().activeId).toBe(one.id)
    off()
  })

  it('rejects a failed write, leaves the state as it was and loads the list again', async () => {
    const { client, callsOf } = world()
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    await expect(store.select('missing')).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    expect(store.getState().activeId).toBe('default')
    await waitFor(() => expect(callsOf('listAgents')).toHaveLength(2))
    await expect(store.save({ ...fields, name: '' })).rejects.toMatchObject({ code: 'AGENT_INVALID' })
    expect(store.getState().agents).toHaveLength(1)
    off()
  })

  it('runs the writes one after the other, so the last selection wins', async () => {
    const inner = world()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const client: EngineClient = {
      request: async <M extends MethodName>(method: M, params: MethodParams<M>) => {
        if (method === 'setActiveAgent') {
          order.push(`start ${(params as { id: string }).id}`)
          if ((params as { id: string }).id !== 'default') await gate
          order.push(`end ${(params as { id: string }).id}`)
        }
        return inner.client.request(method, params)
      },
      onEvent: inner.client.onEvent,
    }
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    const saved = await store.save(fields)
    const first = store.select(saved.id)
    const second = store.select('default')
    release()
    await Promise.all([first, second])
    expect(order).toEqual([`start ${saved.id}`, `end ${saved.id}`, 'start default', 'end default'])
    expect(store.getState().activeId).toBe('default')
    off()
  })

  it('ignores a list answer that arrives after a newer write', async () => {
    const inner = world()
    let releaseList!: () => void
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    let listCalls = 0
    const client: EngineClient = {
      request: async <M extends MethodName>(method: M, params: MethodParams<M>) => {
        if (method === 'listAgents') {
          listCalls += 1
          const answer = await inner.client.request(method, params)
          if (listCalls === 2) await listGate
          return answer
        }
        return inner.client.request(method, params)
      },
      onEvent: inner.client.onEvent,
    }
    const store = agentsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    const stale = store.refresh()
    await store.save({ ...fields, name: 'newer' })
    releaseList()
    await stale
    expect(store.getState().agents.map((entry) => entry.name)).toEqual(['Default', 'newer'])
    off()
  })
})

describe('the selectors', () => {
  const ready = (activeId: string, agents: Agent[]) => ({ status: 'ready' as const, activeId, agents: [agent('default', { builtin: true, name: 'Default' }), ...agents] })

  it('send an agentId only for a loaded, non-default agent', () => {
    expect(agentIdForRequest(ready('default', []))).toBeUndefined()
    expect(agentIdForRequest(ready('a', [agent('a')]))).toBe('a')
    expect(agentIdForRequest({ status: 'loading', activeId: 'a', agents: [agent('a')] })).toBeUndefined()
    expect(agentIdForRequest({ status: 'error', activeId: 'a', agents: [agent('a')], error: new Error('x') })).toBeUndefined()
  })

  it('find the active agent, and say whether its text is sent', () => {
    const withText = agent('a', { persona: 'p' })
    const onlyInstructions = agent('b', { instructions: 'i' })
    const empty = agent('c')
    expect(activeAgentOf(ready('a', [withText]))?.id).toBe('a')
    expect(activeAgentOf(ready('missing', [withText]))).toBeUndefined()
    expect(sendsAgentText(ready('a', [withText]))).toBe(true)
    expect(sendsAgentText(ready('b', [onlyInstructions]))).toBe(true)
    expect(sendsAgentText(ready('c', [empty]))).toBe(false)
    expect(sendsAgentText(ready('default', [withText]))).toBe(false)
    expect(sendsAgentText({ status: 'loading', activeId: 'a', agents: [withText] })).toBe(false)
  })
})

describe('useAgents', () => {
  function Probe({ client }: { client: EngineClient }) {
    const { state } = useAgents(client)
    return <p data-testid="probe">{`${state.status}:${state.activeId}:${state.agents.map((entry) => entry.name).join(',')}`}</p>
  }

  it('renders the state, follows the store and shares it between components of one client', async () => {
    const { client, callsOf } = world()
    render(
      <>
        <Probe client={client} />
        <Probe client={client} />
      </>,
    )
    expect(screen.getAllByTestId('probe')[0]!.textContent).toBe('loading:default:')
    await waitFor(() => expect(screen.getAllByTestId('probe')[1]!.textContent).toBe('ready:default:Default'))
    expect(callsOf('listAgents')).toHaveLength(1)
    await act(async () => {
      await agentsStoreFor(client).save(fields)
    })
    expect(screen.getAllByTestId('probe').map((node) => node.textContent)).toEqual(['ready:default:Default,Reviewer', 'ready:default:Default,Reviewer'])
  })
})
