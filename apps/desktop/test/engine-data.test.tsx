import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEngineData } from '../src/app/glue/useEngineData'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { catalog, fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

function world(failCatalog: () => boolean = () => false) {
  const inner = withPlanMethods(createFakeClient(fakeData), { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three] })
  const calls: MethodName[] = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push(method)
      if (method === 'nodeCatalog' && failCatalog()) return Promise.reject(new RillError('INTERNAL', 'x'))
      return inner.request(method, params)
    },
    onEvent: inner.onEvent,
  }
  return { client, count: (method: MethodName) => calls.filter((name) => name === method).length }
}

describe('useEngineData and the node catalog', () => {
  it('is loading with an empty catalog first, and ready with the node types after', async () => {
    const { client } = world()
    const { result } = renderHook(() => useEngineData(client))
    expect(result.current.catalogStatus).toBe('loading')
    expect(result.current.catalog).toEqual([])
    await waitFor(() => expect(result.current.catalogStatus).toBe('ready'))
    expect(result.current.catalog).toHaveLength(catalog.length)
  })

  it('is loading without a client', () => {
    const { result } = renderHook(() => useEngineData(undefined))
    expect(result.current.catalogStatus).toBe('loading')
  })

  it('reports an error when the catalog cannot be loaded, and loads it again on reload without asking for the model again', async () => {
    let fail = true
    const { client, count } = world(() => fail)
    const { result } = renderHook(() => useEngineData(client))
    await waitFor(() => expect(result.current.catalogStatus).toBe('error'))
    expect(result.current.catalog).toEqual([])
    await waitFor(() => expect(result.current.model).toBeDefined())
    fail = false
    act(() => result.current.reloadCatalog())
    expect(result.current.catalogStatus).toBe('loading')
    await waitFor(() => expect(result.current.catalogStatus).toBe('ready'))
    expect(result.current.catalog).toHaveLength(catalog.length)
    expect(count('nodeCatalog')).toBe(2)
    expect(count('llmModels')).toBe(1)
  })

  it('starts again for a new client instead of showing the node types of the old one', async () => {
    const first = world()
    const second = world(() => true)
    const { result, rerender } = renderHook(({ client }) => useEngineData(client), { initialProps: { client: first.client } })
    await waitFor(() => expect(result.current.catalogStatus).toBe('ready'))
    rerender({ client: second.client })
    expect(result.current.catalogStatus).toBe('loading')
    expect(result.current.catalog).toEqual([])
    await waitFor(() => expect(result.current.catalogStatus).toBe('error'))
  })
})
