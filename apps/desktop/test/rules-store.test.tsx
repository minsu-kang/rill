import { RillError, type MethodName, type MethodParams, type MethodResult, type Rule } from '@rill/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { rulesStoreFor, useRules } from '../src/engine/rules'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

function seed(id: string, kind: Rule['kind'], value: string): Rule {
  return { id, kind, value, createdAt: 1 }
}

function world(rules: readonly Rule[] = [], intercept?: (method: MethodName) => Promise<unknown> | undefined) {
  const inner = withPlanMethods(createFakeClient(fakeData), { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three], rules })
  const calls: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      return (intercept?.(method) ?? inner.request(method, params)) as Promise<MethodResult<M>>
    },
    onEvent: inner.onEvent,
  }
  return { client, calls, count: (method: MethodName) => calls.filter((call) => call.method === method).length }
}

describe('the rules store', () => {
  it('starts loading, asks the engine once, and is ready with the rules', async () => {
    const { client, count } = world([seed('r1', 'forbidNode', 'http.request')])
    const { result } = renderHook(() => useRules(client))
    expect(result.current.state.status).toBe('loading')
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(result.current.state.rules).toEqual([seed('r1', 'forbidNode', 'http.request')])
    expect(count('listRules')).toBe(1)
  })

  it('is one store per client, so two readers share one request', async () => {
    const { client, count } = world()
    const first = renderHook(() => useRules(client))
    const second = renderHook(() => useRules(client))
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'))
    expect(second.result.current.state.status).toBe('ready')
    expect(count('listRules')).toBe(1)
    expect(rulesStoreFor(client)).toBe(rulesStoreFor(client))
  })

  it('reports a load error and loads again on refresh', async () => {
    let fail = true
    const { client } = world([], (method) => (method === 'listRules' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined))
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    fail = false
    await act(async () => {
      await result.current.store.refresh()
    })
    expect(result.current.state.status).toBe('ready')
  })

  it('saves a rule and puts it at the end of the list', async () => {
    const { client } = world([seed('r1', 'forbidNode', 'delay')])
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    let saved: Rule | undefined
    await act(async () => {
      saved = await result.current.store.save('allowHost', 'API.example.com')
    })
    expect(saved).toMatchObject({ kind: 'allowHost', value: 'api.example.com' })
    expect(result.current.state.rules.map((rule) => rule.value)).toEqual(['delay', 'api.example.com'])
  })

  it('replaces the planning effort cap in place and keeps its id', async () => {
    const { client } = world([seed('cap', 'maxPlanEffort', 'high'), seed('r2', 'allowHost', 'a.example.com')])
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await result.current.store.save('maxPlanEffort', 'low')
    })
    expect(result.current.state.rules.map((rule) => [rule.id, rule.value])).toEqual([
      ['cap', 'low'],
      ['r2', 'a.example.com'],
    ])
  })

  it('removes a rule', async () => {
    const { client } = world([seed('r1', 'forbidNode', 'delay'), seed('r2', 'allowHost', 'a.example.com')])
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await result.current.store.remove('r1')
    })
    expect(result.current.state.rules.map((rule) => rule.id)).toEqual(['r2'])
  })

  it('keeps the list when a save is refused, and passes the error on', async () => {
    const { client } = world([seed('r1', 'forbidNode', 'delay')])
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    const failure = await result.current.store.save('forbidNode', 'DELAY').catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'RULE_DUPLICATE' })
    expect(result.current.state.rules).toHaveLength(1)
  })

  it('loads the list again after RULE_NOT_FOUND, because the list was out of date', async () => {
    const { client, count } = world([seed('r1', 'forbidNode', 'delay')])
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    const failure = await result.current.store.remove('nope').catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'RULE_NOT_FOUND' })
    await waitFor(() => expect(count('listRules')).toBe(2))
  })

  it('runs changes one after another', async () => {
    const { client, calls } = world()
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(async () => {
      await Promise.all([result.current.store.save('allowHost', 'a.example.com'), result.current.store.save('allowHost', 'b.example.com')])
    })
    expect(calls.filter((call) => call.method === 'saveRule').map((call) => (call.params as { value: string }).value)).toEqual(['a.example.com', 'b.example.com'])
    expect(result.current.state.rules.map((rule) => rule.value)).toEqual(['a.example.com', 'b.example.com'])
  })

  it('answers the cap with the effort of the maxPlanEffort rule', async () => {
    const { client } = world([seed('cap', 'maxPlanEffort', 'medium')])
    const { result } = renderHook(() => useRules(client))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(result.current.cap).toBe('medium')
  })

  it('has no cap while loading or after an error', async () => {
    const { client } = world([seed('cap', 'maxPlanEffort', 'medium')], () => Promise.reject(new RillError('INTERNAL', 'x')))
    const { result } = renderHook(() => useRules(client))
    expect(result.current.cap).toBeUndefined()
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(result.current.cap).toBeUndefined()
  })
})
