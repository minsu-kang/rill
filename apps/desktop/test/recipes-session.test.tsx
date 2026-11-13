import { RillError, type MethodName, type MethodParams, type RecipeValues } from '@rill/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withRecipeMethods } from '../src/engine/fake-recipes'
import { fakeData } from '../src/fixtures'
import { fixtureRecipeData } from '../src/fixtures/recipes'
import { useRecipeSession } from '../src/recipes/useRecipes'

const VALUES: RecipeValues = { schedule: '0 9 * * 1-5', url: 'https://example.test/health', slackConnection: 'slack-ops' }

function spied() {
  const base = withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData())
  const calls: string[] = []
  const client: EngineClient = {
    onEvent: (listener) => base.onEvent(listener),
    request: <M extends MethodName>(method: M, params: MethodParams<M>) => {
      calls.push(method)
      return base.request(method, params)
    },
  }
  return { client, calls }
}

describe('useRecipeSession', () => {
  it('deploys a draft once, even when deploy is called again after it is deployed or while it deploys', async () => {
    const { client, calls } = spied()
    const { result } = renderHook(() => useRecipeSession(client, 'daily-health-check'))
    await act(async () => result.current.submit(VALUES))
    await waitFor(() => expect(result.current.session.phase).toBe('draft'))
    await act(async () => {
      result.current.deploy()
      result.current.deploy()
    })
    await waitFor(() => expect(result.current.session).toMatchObject({ phase: 'draft', deploy: { phase: 'deployed' } }))
    await act(async () => result.current.deploy())
    expect(calls.filter((call) => call === 'deploy')).toHaveLength(1)
  })

  it('does nothing when deploy is called before there is a draft', async () => {
    const { client, calls } = spied()
    const { result } = renderHook(() => useRecipeSession(client, 'daily-health-check'))
    await act(async () => result.current.deploy())
    expect(calls).toEqual([])
    expect(result.current.session).toEqual({ phase: 'editing' })
  })

  it('keeps the unknown error as the generic failure', async () => {
    const client: EngineClient = { onEvent: () => () => undefined, request: () => Promise.reject(new RillError('INTERNAL', 'x')) }
    const { result } = renderHook(() => useRecipeSession(client, 'daily-health-check'))
    await act(async () => result.current.submit(VALUES))
    await waitFor(() => expect(result.current.session).toEqual({ phase: 'failed', key: 'recipes.error.generic' }))
  })

  it('says that a rule refused the workflow when deploy fails with the message of a rule issue', async () => {
    const base = withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData())
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: (method, params) => (method === 'deploy' ? Promise.reject(new RillError('INVALID_WORKFLOW', 'x', ['node check: the host evil.example is not in the allowed hosts'])) : base.request(method, params)),
    }
    const { result } = renderHook(() => useRecipeSession(client, 'daily-health-check'))
    await act(async () => result.current.submit(VALUES))
    await waitFor(() => expect(result.current.session.phase).toBe('draft'))
    await act(async () => result.current.deploy())
    await waitFor(() => expect(result.current.session).toMatchObject({ phase: 'draft', deploy: { phase: 'failed', key: 'recipes.deployError.rule' } }))
  })

  it('keeps the old text when deploy fails for another reason', async () => {
    const base = withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData())
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: (method, params) => (method === 'deploy' ? Promise.reject(new RillError('INVALID_WORKFLOW', 'x', ['node check: the field url is required'])) : base.request(method, params)),
    }
    const { result } = renderHook(() => useRecipeSession(client, 'daily-health-check'))
    await act(async () => result.current.submit(VALUES))
    await waitFor(() => expect(result.current.session.phase).toBe('draft'))
    await act(async () => result.current.deploy())
    await waitFor(() => expect(result.current.session).toMatchObject({ phase: 'draft', deploy: { phase: 'failed', key: 'recipes.deployError.invalid' } }))
  })
})
