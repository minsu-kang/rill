import {
  AGENT_MAX_SKILLS,
  AGENT_SKILLS_MAX_CHARS,
  SKILL_MAX_ITEMS,
  RillError,
  type Agent,
  type AgentFields,
  type MethodParams,
  type Skill,
  type SkillFields,
} from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withExplainMethod } from '../src/engine/fake-explain'
import { withPlanMethods, type FakePlanData } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { agentFixtures } from '../src/fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { filler, skillFixtures, skillOf } from '../src/fixtures/skills'

const agentBase: AgentFields = { name: 'Helper', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }
const skillBase: SkillFields = { name: 'Checklist', description: 'Check twice', body: 'Check the total.\nCheck the date.' }

function make(extra: Partial<FakePlanData> = {}) {
  let tick = 1000
  const data: FakePlanData = { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three], now: () => (tick += 10), ...extra }
  const client = withPlanMethods(createFakeClient(fakeData), data)
  return { client, request: client.request.bind(client) as typeof client.request }
}

async function failure(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

const code = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise
  } catch (error) {
    return error instanceof RillError ? error.code : 'other'
  }
  return undefined
}

const lines = (error: RillError): Array<string | undefined> => error.problems.map((line) => line.split(':')[0])

describe('the fake engine answers the skill methods with the rules of the engine', () => {
  it('starts with no skills, saves one under a new id with line breaks in the body, and lists it', async () => {
    const { request } = make()
    expect(await request('listSkills', {})).toEqual({ skills: [] })
    const skill = (await request('saveSkill', { ...skillBase, name: '  My   skill ' })).skill
    expect(skill).toMatchObject({ name: 'My skill', description: 'Check twice', body: 'Check the total.\nCheck the date.' })
    expect(skill.createdAt).toBe(skill.updatedAt)
    expect((await request('listSkills', {})).skills).toEqual([skill])
  })

  it('can start with saved skills and lists them by name', async () => {
    const { request } = make({ skills: [skillOf('s-2', { name: 'charlie' }), skillOf('s-1', { name: 'Alpha' })] })
    expect((await request('listSkills', {})).skills.map((skill) => skill.name)).toEqual(['Alpha', 'charlie'])
    await request('saveSkill', { ...skillBase, name: 'bravo' })
    expect((await request('listSkills', {})).skills.map((skill) => skill.name)).toEqual(['Alpha', 'bravo', 'charlie'])
  })

  it('edits in place and keeps the id and createdAt', async () => {
    const { request } = make()
    const created = (await request('saveSkill', skillBase)).skill
    const edited = (await request('saveSkill', { ...skillBase, id: created.id, body: 'New body' })).skill
    expect(edited).toMatchObject({ id: created.id, body: 'New body', createdAt: created.createdAt })
    expect(edited.updatedAt).toBeGreaterThan(created.updatedAt)
  })

  it('refuses text with the engine rules and the engine problem lines, and never repeats the text', async () => {
    const { request } = make()
    const error = await failure(request('saveSkill', { name: '', description: 'a\nb', body: '' }))
    expect(error.code).toBe('SKILL_INVALID')
    expect(lines(error)).toEqual(['name.empty', 'description.control_character', 'body.empty'])
    const tab = await failure(request('saveSkill', { ...skillBase, body: 'a\tb' }))
    expect(lines(tab)).toEqual(['body.control_character'])
    const long = await failure(request('saveSkill', { ...skillBase, body: 'x'.repeat(4001) }))
    expect(lines(long)).toEqual(['body.too_long'])
    expect(long.problems.join('')).not.toContain('xxx')
  })

  it('accepts a body of 4000 characters counted as code points', async () => {
    const { request } = make()
    expect((await request('saveSkill', { ...skillBase, body: '😀'.repeat(4000) })).skill.body).toHaveLength(8000)
  })

  it('refuses a duplicate name ignoring case and invisible characters, before a full list', async () => {
    const { request } = make({ skills: skillFixtures.full })
    expect(await code(request('saveSkill', { ...skillBase, name: 'SKILL   01' }))).toBe('SKILL_DUPLICATE')
    expect(await code(request('saveSkill', { ...skillBase, name: 'Ski\u200dll 01' }))).toBe('SKILL_DUPLICATE')
    expect(await code(request('saveSkill', { ...skillBase, id: 'skill-02', name: 'skill 01' }))).toBe('SKILL_DUPLICATE')
    expect(await code(request('saveSkill', { ...skillBase, name: 'Skill 25' }))).toBe('SKILL_FULL')
    expect((await request('saveSkill', { ...skillBase, id: 'skill-02', name: 'Skill 02, renamed' })).skill.name).toBe('Skill 02, renamed')
  })

  it('does not apply the names of the built-in agent to skills', async () => {
    const { request } = make()
    expect(await code(request('saveSkill', { ...skillBase, name: 'Default' }))).toBeUndefined()
  })

  it('refuses an unknown id, and answers false when deleting one', async () => {
    const { request } = make()
    expect(await code(request('saveSkill', { ...skillBase, id: 'missing' }))).toBe('SKILL_NOT_FOUND')
    expect(await request('deleteSkill', { id: 'missing' })).toEqual({ deleted: false })
  })

  it('has the limit of 24 skills', async () => {
    const { request } = make()
    for (let index = 1; index <= SKILL_MAX_ITEMS; index++) await request('saveSkill', { ...skillBase, name: `skill ${index}` })
    expect(await code(request('saveSkill', { ...skillBase, name: 'one too many' }))).toBe('SKILL_FULL')
  })

  it('checks the params with the protocol schema', async () => {
    const { request } = make()
    expect(await code(request('saveSkill', { ...skillBase, extra: 1 } as never))).toBe('INVALID_PARAMS')
    expect(await code(request('deleteSkill', { id: '' }))).toBe('INVALID_PARAMS')
  })

  it('refuses an edit that would push an agent over 6000 characters, with the count of agents and no text', async () => {
    const { request } = make({ skills: skillFixtures.big, agents: [{ ...agentFixtures.few[0]!, skillIds: ['skill-big-a', 'skill-big-b'] }, { ...agentFixtures.few[1]!, skillIds: ['skill-big-a', 'skill-big-b'] }] })
    const error = await failure(request('saveSkill', { name: 'Glossary (long)', description: '', body: filler(2600, 'Term and its meaning. '), id: 'skill-big-b' }))
    expect(error.code).toBe('SKILL_INVALID')
    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toMatch(/^body\.too_large_for_agent: .*of 2 agents/)
    expect(error.problems[0]).not.toContain('Term')
    expect((await request('listSkills', {})).skills.find((skill) => skill.id === 'skill-big-b')!.body).toHaveLength(2400)
    expect((await request('saveSkill', { name: 'Glossary (long)', description: '', body: filler(2500, 'Term and its meaning. '), id: 'skill-big-b' })).skill.body).toHaveLength(2500)
  })

  it('removes a deleted skill from every agent that has it and keeps the order of the others', async () => {
    const [terse, kind] = agentFixtures.few as [Agent, Agent]
    const { request } = make({
      skills: skillFixtures.few,
      agents: [
        { ...terse, skillIds: ['skill-slack', 'skill-receipts', 'skill-ko'] },
        { ...kind, skillIds: ['skill-receipts'] },
      ],
    })
    expect(await request('deleteSkill', { id: 'skill-receipts' })).toEqual({ deleted: true })
    const { agents } = await request('listAgents', {})
    expect(agents.find((agent) => agent.id === terse.id)!.skillIds).toEqual(['skill-slack', 'skill-ko'])
    expect(agents.find((agent) => agent.id === kind.id)!.skillIds).toEqual([])
    expect(agents.find((agent) => agent.id === terse.id)!.updatedAt).toBe(terse.updatedAt)
  })
})

describe('the fake engine answers the extended agent methods with the rules of the engine', () => {
  it('gives the built-in agent and a new agent the kind assistant and no skills', async () => {
    const { request } = make()
    expect((await request('listAgents', {})).agents[0]).toMatchObject({ id: 'default', kind: 'assistant', skillIds: [] })
    expect((await request('saveAgent', agentBase)).agent).toMatchObject({ kind: 'assistant', skillIds: [] })
  })

  it('reports a seeded agent without a kind as an assistant without skills', async () => {
    const { request } = make({ agents: agentFixtures.few })
    for (const agent of (await request('listAgents', {})).agents) expect([agent.kind, agent.skillIds]).toEqual(['assistant', []])
  })

  it('saves a kind and skill ids and keeps the ids in the order that was sent', async () => {
    const { request } = make({ skills: skillFixtures.few })
    const saved = (await request('saveAgent', { ...agentBase, kind: 'reviewer', skillIds: ['skill-slack', 'skill-receipts'] })).agent
    expect(saved).toMatchObject({ kind: 'reviewer', skillIds: ['skill-slack', 'skill-receipts'] })
    expect((await request('listAgents', {})).agents.at(-1)).toEqual(saved)
  })

  it('keeps the stored kind and skill ids when an edit leaves them out, and replaces them when it sends them', async () => {
    const { request } = make({ skills: skillFixtures.few })
    const saved = (await request('saveAgent', { ...agentBase, kind: 'reviewer', skillIds: ['skill-slack'] })).agent
    const renamed = (await request('saveAgent', { ...agentBase, id: saved.id, name: 'Renamed' })).agent
    expect(renamed).toMatchObject({ kind: 'reviewer', skillIds: ['skill-slack'] })
    const cleared = (await request('saveAgent', { ...agentBase, id: saved.id, skillIds: [], kind: 'assistant' })).agent
    expect(cleared).toMatchObject({ kind: 'assistant', skillIds: [] })
  })

  it('refuses an unknown skill, a duplicate, nine skills and too many characters, each with its own problem line', async () => {
    const { request } = make({ skills: [...skillFixtures.few, ...skillFixtures.big, ...skillFixtures.full] })
    expect(lines(await failure(request('saveAgent', { ...agentBase, skillIds: ['nope'] })))).toEqual(['skills.unknown'])
    expect(lines(await failure(request('saveAgent', { ...agentBase, skillIds: ['skill-slack', 'skill-slack'] })))).toEqual(['skills.duplicate'])
    const nine = Array.from({ length: AGENT_MAX_SKILLS + 1 }, (_, index) => `skill-${String(index + 1).padStart(2, '0')}`)
    expect(lines(await failure(request('saveAgent', { ...agentBase, skillIds: nine })))).toEqual(['skills.too_many'])
    expect(lines(await failure(request('saveAgent', { ...agentBase, skillIds: ['skill-big-a', 'skill-big-b', 'skill-small'] })))).toEqual(['skills.too_large'])
    const ok = await request('saveAgent', { ...agentBase, skillIds: ['skill-big-a', 'skill-big-b'] })
    expect(ok.agent.skillIds).toEqual(['skill-big-a', 'skill-big-b'])
    expect(3500 + 2400).toBeLessThanOrEqual(AGENT_SKILLS_MAX_CHARS)
  })

  it('reports the list problems next to the text problems, and the others only once the text is valid', async () => {
    const { request } = make({ skills: skillFixtures.few })
    expect(lines(await failure(request('saveAgent', { ...agentBase, name: '', skillIds: ['skill-slack', 'skill-slack'] })))).toEqual(['name.empty', 'skills.duplicate'])
    expect(lines(await failure(request('saveAgent', { ...agentBase, name: '', skillIds: ['nope'] })))).toEqual(['name.empty'])
  })

  it('does not put an id or a text into a problem line', async () => {
    const { request } = make({ skills: skillFixtures.few })
    const error = await failure(request('saveAgent', { ...agentBase, skillIds: ['secret-skill-id'] }))
    expect(error.problems.join('\n')).not.toContain('secret-skill-id')
  })

  it('refuses the built-in agent before anything else, even with a kind', async () => {
    const { request } = make()
    expect(await code(request('saveAgent', { ...agentBase, id: 'default', kind: 'reviewer' }))).toBe('AGENT_BUILTIN')
  })

  it('lets only an assistant be made active, and refuses to turn the active agent into a reviewer', async () => {
    const { request } = make({ agents: [...agentFixtures.few, ...agentFixtures.reviewers], activeAgentId: 'agent-terse' })
    expect(await code(request('setActiveAgent', { id: 'agent-reviewer' }))).toBe('AGENT_NOT_ASSISTANT')
    expect(await code(request('setActiveAgent', { id: 'missing' }))).toBe('AGENT_NOT_FOUND')
    expect(await code(request('saveAgent', { ...agentBase, id: 'agent-terse', kind: 'reviewer' }))).toBe('AGENT_NOT_ASSISTANT')
    expect((await request('listAgents', {})).activeId).toBe('agent-terse')
    expect(await code(request('saveAgent', { ...agentBase, id: 'agent-plain', kind: 'reviewer' }))).toBeUndefined()
  })

  it('refuses a reviewer in plan and in explainRun before any model call or plan slot', async () => {
    let scripted = 0
    const { client, request } = make({
      agents: agentFixtures.reviewers,
      script: () => {
        scripted += 1
        return outcomeOf(results.workflow)
      },
    })
    const params: MethodParams<'plan'> = { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low', agentId: 'agent-reviewer' }
    expect(await code(request('plan', params))).toBe('AGENT_NOT_ASSISTANT')
    expect(scripted).toBe(0)
    expect(client.planAgentIds()).toEqual([])
    expect(await code(request('plan', { planId: 'p2', text: 'wait', turns: [], attachments: [], effort: 'low' }))).toBeUndefined()
    const explain = withExplainMethod(client, () => new RillError('INTERNAL', 'x'), { agents: client.agents })
    expect(await code(explain.request('explainRun', { runId: 'r', agentId: 'agent-reviewer' }))).toBe('AGENT_NOT_ASSISTANT')
  })

  it('removes a deleted skill from a stored agent without moving updatedAt', async () => {
    const { request } = make({ skills: skillFixtures.few })
    const saved = (await request('saveAgent', { ...agentBase, skillIds: ['skill-slack', 'skill-ko'] })).agent
    await request('deleteSkill', { id: 'skill-ko' })
    expect((await request('listAgents', {})).agents.at(-1)).toMatchObject({ skillIds: ['skill-slack'], updatedAt: saved.updatedAt })
  })

  it('answers with skills that are exactly what the protocol allows', async () => {
    const { request } = make({ skills: skillFixtures.few })
    const listed: Skill[] = (await request('listSkills', {})).skills
    expect(listed.map((skill) => skill.id).sort()).toEqual(['skill-ko', 'skill-receipts', 'skill-slack'])
  })
})
