import { RillError, type Agent, type MethodName, type MethodParams, type MethodResult, type Skill } from '@rill/protocol'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { activeAgentOf, agentIdForRequest, agentsStoreFor, assistantsOf, kindOf, reviewersOf, sendsAgentText, skillIdsOf, type AgentsState } from '../src/engine/agents'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { agentsUsingSkill, skillSize, skillsStoreFor, useSkills } from '../src/engine/skills'
import { fakeData } from '../src/fixtures'
import { agentFixtures, agentOf } from '../src/fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { skillFixtures, skillOf } from '../src/fixtures/skills'

function world(extra: { fail?: (method: MethodName) => boolean; skills?: readonly Skill[]; agents?: readonly Agent[] } = {}) {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(extra.skills === undefined ? {} : { skills: extra.skills }),
    ...(extra.agents === undefined ? {} : { agents: extra.agents }),
  })
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

const fields = { name: 'Checklist', description: '', body: 'Check twice.' }

describe('the skills store of a client', () => {
  it('is one store per client, loaded once on the first subscription and not before', async () => {
    const { client, callsOf } = world({ skills: skillFixtures.few })
    const store = skillsStoreFor(client)
    expect(skillsStoreFor(client)).toBe(store)
    expect(store.getState()).toMatchObject({ status: 'loading', skills: [] })
    expect(callsOf('listSkills')).toHaveLength(0)
    const one = vi.fn()
    const off = store.subscribe(one)
    store.subscribe(() => undefined)()
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    expect(callsOf('listSkills')).toHaveLength(1)
    expect(store.getState().skills.map((skill) => skill.name)).toEqual(['Receipts checklist', 'Slack message style', '한국어 요약 규칙'])
    expect(one).toHaveBeenCalled()
    off()
    expect(skillsStoreFor(world().client)).not.toBe(store)
  })

  it('can be watched without loading', async () => {
    const { client, callsOf } = world()
    const store = skillsStoreFor(client)
    const heard = vi.fn()
    const stop = store.watch(heard)
    await Promise.resolve()
    expect(callsOf('listSkills')).toHaveLength(0)
    await store.refresh()
    expect(heard).toHaveBeenCalled()
    stop()
  })

  it('goes to the error state when the engine cannot list, and loads again on refresh', async () => {
    let failing = true
    const { client } = world({ fail: (method) => method === 'listSkills' && failing })
    const store = skillsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('error'))
    failing = false
    const refreshing = store.refresh()
    expect(store.getState().status).toBe('loading')
    await refreshing
    expect(store.getState().status).toBe('ready')
    off()
  })

  it('keeps the list when a refresh fails after a good load, and shows the error', async () => {
    let failing = false
    const { client } = world({ skills: skillFixtures.few, fail: (method) => method === 'listSkills' && failing })
    const store = skillsStoreFor(client)
    const off = store.subscribe(() => undefined)
    await waitFor(() => expect(store.getState().status).toBe('ready'))
    failing = true
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: 'error' })
    expect(store.getState().skills).toHaveLength(3)
    off()
  })

  it('saves, orders by name and deletes through the engine and updates the state', async () => {
    const { client, callsOf } = world({ skills: skillFixtures.few })
    const store = skillsStoreFor(client)
    await store.refresh()
    const saved = await store.save({ ...fields, name: 'Alpha' })
    expect(store.getState().skills.map((skill) => skill.name)).toEqual(['Alpha', 'Receipts checklist', 'Slack message style', '한국어 요약 규칙'])
    const edited = await store.save({ ...fields, name: 'Zulu', id: saved.id })
    expect(edited.id).toBe(saved.id)
    expect(store.getState().skills.map((skill) => skill.name)).toEqual(['Receipts checklist', 'Slack message style', 'Zulu', '한국어 요약 규칙'])
    expect(await store.remove(saved.id)).toBe(true)
    expect(store.getState().skills).toHaveLength(3)
    expect(callsOf('saveSkill')).toHaveLength(2)
  })

  it('loads the agents again after a skill was deleted, because the engine took it off every agent', async () => {
    const [skilled] = agentFixtures.skilled as [Agent]
    const { client, callsOf } = world({ skills: skillFixtures.few, agents: [skilled] })
    const agents = agentsStoreFor(client)
    await agents.refresh()
    expect(agents.getState().agents.find((agent) => agent.id === skilled.id)!.skillIds).toEqual(['skill-receipts', 'skill-slack'])
    const store = skillsStoreFor(client)
    await store.refresh()
    const before = callsOf('listAgents').length
    await store.remove('skill-receipts')
    await waitFor(() => expect(callsOf('listAgents').length).toBeGreaterThan(before))
    await waitFor(() => expect(agents.getState().agents.find((agent) => agent.id === skilled.id)!.skillIds).toEqual(['skill-slack']))
  })

  it('does not load the agents again after a delete that deleted nothing', async () => {
    const { client, callsOf } = world()
    const store = skillsStoreFor(client)
    await store.refresh()
    expect(await store.remove('missing')).toBe(false)
    expect(callsOf('listAgents')).toHaveLength(0)
  })

  it('rejects a failed write, leaves the state as it was and loads the list again when the skill was not found', async () => {
    const { client, callsOf } = world({ skills: skillFixtures.few })
    const store = skillsStoreFor(client)
    await store.refresh()
    await expect(store.save({ ...fields, id: 'missing' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    await waitFor(() => expect(callsOf('listSkills').length).toBeGreaterThan(1))
    expect(store.getState().skills).toHaveLength(3)
    await expect(store.save({ ...fields, name: '' })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
  })

  it('runs the writes one after the other', async () => {
    const { client } = world()
    const store = skillsStoreFor(client)
    await store.refresh()
    const results = await Promise.all([store.save({ ...fields, name: 'One' }), store.save({ ...fields, name: 'Two' }), store.save({ ...fields, name: 'Three' })])
    expect(results.map((skill) => skill.name)).toEqual(['One', 'Two', 'Three'])
    expect(store.getState().skills.map((skill) => skill.name)).toEqual(['One', 'Three', 'Two'])
  })

  it('ignores a list answer that arrives after a newer write', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = world({ skills: skillFixtures.few })
    let first = true
    const client: EngineClient = {
      request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
        const answer = await inner.client.request(method, params)
        if (method === 'listSkills' && first) {
          first = false
          await gate
        }
        return answer
      },
      onEvent: inner.client.onEvent,
    }
    const store = skillsStoreFor(client)
    const loading = store.refresh()
    await store.save({ ...fields, name: 'Alpha' })
    release?.()
    await loading
    expect(store.getState().skills.map((skill) => skill.name)).toContain('Alpha')
  })

  it('follows the store in a component', async () => {
    const { client } = world({ skills: skillFixtures.few })
    function Probe() {
      const { state } = useSkills(client)
      return <p>{state.status === 'ready' ? `${state.skills.length} skills` : state.status}</p>
    }
    render(<Probe />)
    expect(screen.getByText('loading')).toBeTruthy()
    await screen.findByText('3 skills')
    await act(async () => {
      await skillsStoreFor(client).save({ ...fields, name: 'Alpha' })
    })
    await screen.findByText('4 skills')
  })
})

describe('the selectors of skills', () => {
  it('count the size of a skill in characters, not in UTF-16 units', () => {
    expect(skillSize(skillOf('a', { body: '😀😀abc' }))).toBe(5)
    expect(skillSize(skillOf('a', { body: 'a\nb' }))).toBe(3)
  })

  it('find the agents that use a skill, in the order of the list', () => {
    const agents = [agentOf('a1', { skillIds: ['s1'] }), agentOf('a2', { skillIds: ['s2'] }), agentOf('a3', { skillIds: ['s2', 's1'] }), agentOf('a4')]
    expect(agentsUsingSkill(agents, 's1').map((agent) => agent.id)).toEqual(['a1', 'a3'])
    expect(agentsUsingSkill(agents, 'none')).toEqual([])
  })
})

describe('the selectors of the kind of an agent', () => {
  const [terse] = agentFixtures.few as [Agent]
  const [skilled] = agentFixtures.skilled as [Agent]
  const [reviewer] = agentFixtures.reviewers as [Agent]

  it('read an absent kind as assistant and absent skills as none', () => {
    expect(kindOf(terse)).toBe('assistant')
    expect(skillIdsOf(terse)).toEqual([])
    expect(kindOf(reviewer)).toBe('reviewer')
    expect(skillIdsOf(skilled)).toEqual(['skill-receipts', 'skill-slack'])
  })

  it('split a list into assistants and reviewers', () => {
    const all = [terse, skilled, reviewer, ...agentFixtures.reviewers.slice(1)]
    expect(assistantsOf(all).map((agent) => agent.id)).toEqual(['agent-terse', 'agent-skilled'])
    expect(reviewersOf(all).map((agent) => agent.id)).toEqual(['agent-reviewer', 'agent-reviewer-ko'])
  })

  const stateOf = (agent: Agent): AgentsState => ({ status: 'ready', agents: [agent], activeId: agent.id })

  it('say that the text of skills is sent even when the persona and the instructions are empty', () => {
    expect(activeAgentOf(stateOf(skilled))).toBe(skilled)
    expect(agentIdForRequest(stateOf(skilled))).toBe(skilled.id)
    expect(sendsAgentText(stateOf(skilled))).toBe(true)
    const onlySkills = agentOf('only-skills', { skillIds: ['skill-slack'] })
    expect(sendsAgentText(stateOf(onlySkills))).toBe(true)
    expect(sendsAgentText(stateOf(agentOf('nothing', { kind: 'assistant', skillIds: [] })))).toBe(false)
    expect(sendsAgentText(stateOf(agentOf('persona', { persona: 'x' })))).toBe(true)
  })
})
