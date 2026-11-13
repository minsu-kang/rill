import { AGENT_MAX_ITEMS, RillError, type Agent, type AgentFields, type MethodParams } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withExplainMethod } from '../src/engine/fake-explain'
import { withPlanMethods, type FakePlanData } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

const base: AgentFields = { name: 'Reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

function make(extra: Partial<FakePlanData> = {}) {
  const data: FakePlanData = { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three], ...extra }
  const client = withPlanMethods(createFakeClient(fakeData), data)
  return { client, request: client.request.bind(client) as typeof client.request }
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof RillError ? error.code : 'other'
  }
  return undefined
}

describe('the fake engine answers the agent methods with the rules of the engine', () => {
  it('starts with the built-in agent only, active, and lists saved agents by name after it', async () => {
    const { request } = make()
    const first = await request('listAgents', {})
    expect(first.activeId).toBe('default')
    expect(first.agents).toHaveLength(1)
    expect(first.agents[0]).toMatchObject({ id: 'default', builtin: true, persona: '', instructions: '' })
    await request('saveAgent', { ...base, name: 'charlie' })
    await request('saveAgent', { ...base, name: 'Alpha' })
    expect((await request('listAgents', {})).agents.map((agent) => agent.name)).toEqual(['Default', 'Alpha', 'charlie'])
  })

  it('can start with saved agents and an active one', async () => {
    const seeded: Agent = { id: 'a-1', name: 'Seeded', description: '', persona: 'p', instructions: '', builtin: false, createdAt: 1, updatedAt: 1 }
    const { request } = make({ agents: [seeded], activeAgentId: 'a-1' })
    expect(await request('listAgents', {})).toMatchObject({ activeId: 'a-1', agents: [{ id: 'default' }, { id: 'a-1', name: 'Seeded' }] })
  })

  it('creates, edits in place, activates and deletes', async () => {
    const { request } = make()
    const created = (await request('saveAgent', { ...base, name: '  My   Agent ' })).agent
    expect(created).toMatchObject({ name: 'My Agent', builtin: false })
    const edited = (await request('saveAgent', { ...base, id: created.id, persona: 'new' })).agent
    expect(edited).toMatchObject({ id: created.id, persona: 'new', createdAt: created.createdAt })
    await request('setActiveAgent', { id: created.id })
    expect((await request('listAgents', {})).activeId).toBe(created.id)
    expect(await request('deleteAgent', { id: created.id })).toEqual({ deleted: true })
    expect(await request('deleteAgent', { id: created.id })).toEqual({ deleted: false })
    expect((await request('listAgents', {})).activeId).toBe('default')
  })

  it('refuses text with the engine rules and the engine problem lines', async () => {
    const { request } = make()
    const error = await request('saveAgent', { ...base, name: '', description: 'a\nb', instructions: 'x'.repeat(3001) }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(RillError)
    expect((error as RillError).code).toBe('AGENT_INVALID')
    expect((error as RillError).problems?.map((line) => line.split(':')[0])).toEqual(['name.empty', 'description.control_character', 'instructions.too_long'])
  })

  it('refuses a duplicate name ignoring case, a 13th agent, an unknown id and the built-in agent', async () => {
    const { request } = make()
    const first = (await request('saveAgent', { ...base, name: 'Same name' })).agent
    expect(await code(request('saveAgent', { ...base, name: 'SAME   name' }))).toBe('AGENT_DUPLICATE')
    expect(await code(request('saveAgent', { ...base, id: 'missing' }))).toBe('AGENT_NOT_FOUND')
    expect(await code(request('setActiveAgent', { id: 'missing' }))).toBe('AGENT_NOT_FOUND')
    expect(await code(request('saveAgent', { ...base, id: 'default' }))).toBe('AGENT_BUILTIN')
    expect(await code(request('deleteAgent', { id: 'default' }))).toBe('AGENT_BUILTIN')
    for (let index = 1; index < AGENT_MAX_ITEMS; index++) await request('saveAgent', { ...base, name: `agent ${index}` })
    expect(await code(request('saveAgent', { ...base, name: 'one too many' }))).toBe('AGENT_FULL')
    expect((await request('saveAgent', { ...base, id: first.id, name: 'edited while full' })).agent.name).toBe('edited while full')
  })

  it('keeps the names of the built-in agent for itself and refuses a name that shows nothing', async () => {
    const { request } = make()
    const other = (await request('saveAgent', { ...base, name: 'other' })).agent
    for (const name of ['Default', 'default', '기본']) {
      expect(await code(request('saveAgent', { ...base, name })), name).toBe('AGENT_DUPLICATE')
      expect(await code(request('saveAgent', { ...base, id: other.id, name })), name).toBe('AGENT_DUPLICATE')
    }
    expect(await code(request('saveAgent', { ...base, name: 'Wo\u200drk' }))).toBeUndefined()
    expect(await code(request('saveAgent', { ...base, name: 'WO\u3164RK' }))).toBe('AGENT_DUPLICATE')
    expect(await code(request('saveAgent', { ...base, name: '\u3164' }))).toBe('AGENT_INVALID')
  })

  it('checks the params with the protocol schema', async () => {
    const { request } = make()
    expect(await code(request('saveAgent', { ...base, extra: 1 } as never))).toBe('INVALID_PARAMS')
    expect(await code(request('setActiveAgent', { id: '' }))).toBe('INVALID_PARAMS')
  })
})

describe('the fake planner and the fake explainer', () => {
  const planParams: MethodParams<'plan'> = { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low' }

  it('records the agentId that every plan request received', async () => {
    const { client, request } = make()
    const agent = (await request('saveAgent', base)).agent
    await request('plan', { ...planParams, planId: 'a' })
    await request('plan', { ...planParams, planId: 'b', agentId: agent.id })
    await request('plan', { ...planParams, planId: 'c', agentId: 'default' })
    expect(client.planAgentIds()).toEqual([undefined, agent.id, 'default'])
  })

  it('refuses an unknown agentId before it runs the script or takes a plan slot', async () => {
    let scripted = 0
    const { client, request } = make({
      script: () => {
        scripted += 1
        return outcomeOf(results.workflow)
      },
    })
    expect(await code(request('plan', { ...planParams, agentId: 'missing' }))).toBe('AGENT_NOT_FOUND')
    expect(scripted).toBe(0)
    expect(client.planAgentIds()).toEqual([])
    expect(await code(request('plan', planParams))).toBeUndefined()
  })

  it('refuses an unknown agentId on explainRun when it is given the agents', async () => {
    const { client } = make()
    const explain = withExplainMethod(client, () => new RillError('INTERNAL', 'x'), { agents: client.agents })
    expect(await code(explain.request('explainRun', { runId: 'r', agentId: 'missing' }))).toBe('AGENT_NOT_FOUND')
    expect(await code(explain.request('explainRun', { runId: 'r' }))).toBe('INTERNAL')
  })
})
