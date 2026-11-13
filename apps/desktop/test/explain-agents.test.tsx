import { RillError, type Agent, type ExplainResult, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { agentsStoreFor } from '../src/engine/agents'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { ExplainPanel } from '../src/explain/ExplainPanel'
import { fakeData, fixtureRuns, ids } from '../src/fixtures'
import { agentFixtures } from '../src/fixtures/agents'
import { explainCases } from '../src/fixtures/explain'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { renderThemed } from './render'

const FAILED = fixtureRuns.find((item) => item.id === ids.runs.receiptFailed)!
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-5' }
const [terse, kind] = agentFixtures.few as [Agent, Agent, Agent]

interface Pending {
  params: MethodParams<'explainRun'>
  resolve(result: ExplainResult): void
  reject(error: unknown): void
}

function world(agents: readonly Agent[] = agentFixtures.few, activeAgentId?: string) {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    agents,
    ...(activeAgentId === undefined ? {} : { activeAgentId }),
  })
  const pending: Pending[] = []
  const requests: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      requests.push({ method, params })
      if (method !== 'explainRun') return inner.request(method, params)
      return new Promise<MethodResult<M>>((resolve, reject) => {
        pending.push({ params: params as MethodParams<'explainRun'>, resolve: resolve as (result: ExplainResult) => void, reject })
      })
    },
    onEvent: inner.onEvent,
  }
  return { client, pending, requests, inner }
}

async function loaded(client: EngineClient): Promise<void> {
  await agentsStoreFor(client).refresh()
}

function mount(client: EngineClient, model: { provider: string; model: string } | undefined = MODEL) {
  return renderThemed(<ExplainPanel client={client} run={FAILED} model={model} onAction={vi.fn()} onProposeFix={vi.fn()} />, { locale: 'en' })
}

const ask = (): HTMLElement => screen.getByRole('button', { name: en['explain.ask'] })
const send = (): HTMLElement => screen.getByRole('button', { name: en['explain.notice.send'] })

describe('explainRun carries the active agent', () => {
  it('sends the id of a saved agent, and only that', async () => {
    const { client, pending } = world(agentFixtures.few, terse.id)
    await loaded(client)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    await user.click(send())
    expect(pending).toHaveLength(1)
    expect(pending[0]!.params).toEqual({ runId: FAILED.id, effort: 'medium', agentId: terse.id })
  })

  it('sends no agentId for the Default agent', async () => {
    const { client, pending } = world()
    await loaded(client)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    await user.click(send())
    expect(pending[0]!.params).toEqual({ runId: FAILED.id, effort: 'medium' })
  })

  it('sends no agentId when the agents were never loaded, and does not load them itself', async () => {
    const { client, pending, requests } = world(agentFixtures.few, terse.id)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    await user.click(send())
    expect(pending[0]!.params).toEqual({ runId: FAILED.id, effort: 'medium' })
    expect(requests.filter((request) => request.method === 'listAgents')).toEqual([])
  })

  it('reads the agent when it sends, so a change between the click and the notice counts', async () => {
    const { client, pending } = world(agentFixtures.few)
    await loaded(client)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    await act(async () => {
      await agentsStoreFor(client).select(kind.id)
    })
    await user.click(send())
    expect(pending[0]!.params).toMatchObject({ agentId: kind.id })
  })
})

describe('the notice of an explanation names the agent settings', () => {
  it('shows a line for an agent with text and none for Default or an agent without text', async () => {
    const { client } = world([...agentFixtures.few, { ...terse, id: 'agent-bare', name: 'Bare', persona: '', instructions: '' }], terse.id)
    await loaded(client)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    expect(screen.getByText(en['explain.notice.agent'])).toBeTruthy()
    await act(async () => {
      await agentsStoreFor(client).select('agent-bare')
    })
    expect(screen.queryByText(en['explain.notice.agent'])).toBeNull()
    await act(async () => {
      await agentsStoreFor(client).select('default')
    })
    expect(screen.queryByText(en['explain.notice.agent'])).toBeNull()
  })

  it('is in Korean too', async () => {
    const { client } = world(agentFixtures.few, terse.id)
    await loaded(client)
    renderThemed(<ExplainPanel client={client} run={FAILED} model={MODEL} onAction={vi.fn()} onProposeFix={vi.fn()} />, { locale: 'ko' })
    await userEvent.setup().click(screen.getByRole('button', { name: ko['explain.ask'] }))
    expect(screen.getByText(ko['explain.notice.agent'])).toBeTruthy()
  })

  it('comes back after "do not ask again" when the agent changes', async () => {
    const { client, pending } = world(agentFixtures.few, terse.id)
    await loaded(client)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    await user.click(screen.getByRole('checkbox', { name: en['explain.notice.skip'] }))
    await user.click(send())
    await act(async () => pending[0]!.resolve(explainCases.unknown))
    await user.click(screen.getByRole('button', { name: en['explain.askAgain'] }))
    expect(pending).toHaveLength(2)
    await act(async () => pending[1]!.resolve(explainCases.unknown))
    await act(async () => {
      await agentsStoreFor(client).select(kind.id)
    })
    await user.click(screen.getByRole('button', { name: en['explain.askAgain'] }))
    expect(screen.getByText(en['explain.notice.agent'])).toBeTruthy()
    expect(pending).toHaveLength(2)
  })
})

describe('an explanation with an agent that is gone', () => {
  it('says so, loads the agents again and sends the new active agent when the person tries again', async () => {
    const { client, pending, inner } = world(agentFixtures.few, terse.id)
    await loaded(client)
    mount(client)
    const user = userEvent.setup()
    await user.click(ask())
    await user.click(send())
    inner.agents.remove({ id: terse.id })
    await act(async () => pending[0]!.reject(new RillError('AGENT_NOT_FOUND', 'x')))
    expect(await screen.findByText(en['explain.error.agentNotFound'])).toBeTruthy()
    await waitFor(() => expect(agentsStoreFor(client).getState().activeId).toBe('default'))
    await user.click(screen.getByRole('button', { name: en['explain.retry'] }))
    expect(screen.queryByText(en['explain.notice.agent'])).toBeNull()
    await user.click(send())
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1]!.params).not.toHaveProperty('agentId')
  })
})
