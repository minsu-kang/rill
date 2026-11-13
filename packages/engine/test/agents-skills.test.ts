import { createCoreRegistry } from '@rill/nodes-core'
import { AGENT_MAX_SKILLS, AGENT_SKILLS_MAX_CHARS, AgentSchema, type AgentFields, type AgentKind } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { AgentBuiltinError, AgentInvalidError, AgentNotAssistantError, AgentNotFoundError, builtinAgent } from '../src/agents'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { SkillInvalidError } from '../src/skills'

const base: AgentFields = { name: 'Reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

function make() {
  let tick = 1000
  const db = Db.open(':memory:')
  const engine = new Engine({ db, registry: createCoreRegistry(), now: () => (tick += 10) })
  return { db, engine }
}

type AgentInput = Partial<AgentFields> & { id?: string; kind?: AgentKind; skillIds?: string[] }

function agentOf(engine: Engine, overrides: AgentInput = {}) {
  return engine.saveAgent({ ...base, ...overrides })
}

function skillOf(engine: Engine, name: string, body = `${name} body`) {
  return engine.saveSkill({ name, description: '', body })
}

function problemsOf(action: () => unknown): string[] {
  try {
    action()
  } catch (error) {
    if (error instanceof AgentInvalidError || error instanceof SkillInvalidError) return error.problems
    throw error
  }
  return []
}

describe('the kind and the skills of an agent', () => {
  it('default to an assistant with no skills, for a new agent and for the built-in one', () => {
    const { engine } = make()
    const agent = agentOf(engine)
    expect(agent).toMatchObject({ kind: 'assistant', skillIds: [] })
    expect(builtinAgent()).toMatchObject({ kind: 'assistant', skillIds: [] })
    expect(Value.Check(AgentSchema, agent)).toBe(true)
    expect(Value.Check(AgentSchema, builtinAgent())).toBe(true)
    expect(engine.listAgents().agents).toEqual([builtinAgent(), agent])
  })

  it('are saved and listed: the kind, and the ids in the order the user gave them', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    const two = skillOf(engine, 'two')
    const agent = agentOf(engine, { kind: 'reviewer', skillIds: [two.id, one.id] })
    expect(agent).toMatchObject({ kind: 'reviewer', skillIds: [two.id, one.id] })
    expect(engine.listAgents().agents[1]).toEqual(agent)
  })

  it('are replaced by an edit that names them, and kept by an edit that leaves them out', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    const created = agentOf(engine, { skillIds: [one.id], kind: 'reviewer' })
    const renamed = agentOf(engine, { id: created.id, name: 'Renamed' })
    expect(renamed).toMatchObject({ kind: 'reviewer', skillIds: [one.id], name: 'Renamed' })
    const cleared = agentOf(engine, { id: created.id, skillIds: [] })
    expect(cleared).toMatchObject({ kind: 'reviewer', skillIds: [] })
    const backToAssistant = agentOf(engine, { id: created.id, kind: 'assistant', skillIds: [one.id] })
    expect(backToAssistant).toMatchObject({ kind: 'assistant', skillIds: [one.id] })
    expect(engine.listAgents().agents[1]).toEqual(backToAssistant)
  })

  it('cannot be set on the built-in agent', () => {
    const { engine } = make()
    expect(() => agentOf(engine, { id: 'default', kind: 'reviewer' })).toThrow(AgentBuiltinError)
    expect(() => agentOf(engine, { id: 'default', skillIds: [] })).toThrow(AgentBuiltinError)
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('are stored in the columns kind and skill_ids', () => {
    const { db, engine } = make()
    const one = skillOf(engine, 'one')
    agentOf(engine, { kind: 'reviewer', skillIds: [one.id] })
    expect(db.get('SELECT kind, skill_ids FROM agents')).toEqual({ kind: 'reviewer', skill_ids: JSON.stringify([one.id]) })
  })

  it('cannot hold any other kind in the database', () => {
    const { db, engine } = make()
    agentOf(engine)
    expect(() => db.run("UPDATE agents SET kind = 'chat'")).toThrow()
  })
})

describe('the skill ids of saveAgent', () => {
  it('refuses an id that is not a skill, with the problem skills.unknown and no id in it', () => {
    const { engine } = make()
    const marker = 'SKILL-ID-MARKER-6e1a'
    const problems = problemsOf(() => agentOf(engine, { skillIds: [marker] }))
    expect(problems).toEqual([expect.stringMatching(/^skills\.unknown: /)])
    expect(JSON.stringify(problems)).not.toContain(marker)
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('refuses one unknown id among known ones, and saves nothing', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    expect(problemsOf(() => agentOf(engine, { skillIds: [one.id, 'missing'] }))).toEqual([expect.stringMatching(/^skills\.unknown: /)])
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('refuses an id that is listed twice', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    expect(problemsOf(() => agentOf(engine, { skillIds: [one.id, one.id] }))).toEqual([expect.stringMatching(/^skills\.duplicate: /)])
  })

  it('accepts 8 skills and refuses a 9th', () => {
    const { engine } = make()
    const ids = Array.from({ length: AGENT_MAX_SKILLS + 1 }, (_, index) => skillOf(engine, `skill ${index}`).id)
    expect(agentOf(engine, { skillIds: ids.slice(0, AGENT_MAX_SKILLS) }).skillIds).toHaveLength(AGENT_MAX_SKILLS)
    expect(problemsOf(() => agentOf(engine, { name: 'other', skillIds: ids }))).toEqual([expect.stringMatching(/^skills\.too_many: /)])
  })

  it('accepts bodies that add up to 6000 characters and refuses 6001', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a', 'x'.repeat(4000))
    const b = skillOf(engine, 'b', 'y'.repeat(2000))
    const c = skillOf(engine, 'c', 'z'.repeat(2001))
    expect(agentOf(engine, { skillIds: [a.id, b.id] }).skillIds).toEqual([a.id, b.id])
    expect(problemsOf(() => agentOf(engine, { name: 'over', skillIds: [a.id, c.id] }))).toEqual([expect.stringMatching(/^skills\.too_large: /)])
    expect(AGENT_SKILLS_MAX_CHARS).toBe(6000)
  })

  it('counts characters, not UTF-16 units', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a', '😀'.repeat(3000))
    const b = skillOf(engine, 'b', '😀'.repeat(3000))
    const c = skillOf(engine, 'c', 'x')
    expect(agentOf(engine, { skillIds: [a.id, b.id] }).skillIds).toHaveLength(2)
    expect(problemsOf(() => agentOf(engine, { name: 'over', skillIds: [a.id, b.id, c.id] }))).toEqual([expect.stringMatching(/^skills\.too_large: /)])
  })

  it('reports the problems of the text and of the skill ids together', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    expect(problemsOf(() => agentOf(engine, { name: '', skillIds: [one.id, one.id] }))).toEqual([
      expect.stringMatching(/^name\.empty: /),
      expect.stringMatching(/^skills\.duplicate: /),
    ])
  })

  it('checks the skill ids of an edit before it looks the agent up', () => {
    const { engine } = make()
    expect(problemsOf(() => agentOf(engine, { id: 'missing', skillIds: ['nope'] }))).toEqual([expect.stringMatching(/^skills\.unknown: /)])
    expect(() => agentOf(engine, { id: 'missing' })).toThrow(AgentNotFoundError)
  })

  it('lets two agents share a skill and keeps one copy of the skill', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    agentOf(engine, { name: 'first', skillIds: [one.id] })
    agentOf(engine, { name: 'second', skillIds: [one.id] })
    expect(engine.listSkills()).toHaveLength(1)
  })
})

describe('the skills of an agent, as the prompt will read them', () => {
  it('come back ordered by the name of the skill, ignoring case, whatever the order of the ids', () => {
    const { engine } = make()
    const charlie = skillOf(engine, 'charlie')
    const alpha = skillOf(engine, 'Alpha')
    const bravo = skillOf(engine, 'bravo')
    const agent = agentOf(engine, { skillIds: [charlie.id, alpha.id, bravo.id] })
    expect(engine.store.skillsOf(agent.skillIds ?? []).map((skill) => skill.name)).toEqual(['Alpha', 'bravo', 'charlie'])
    engine.saveSkill({ id: alpha.id, name: 'zulu', description: '', body: 'x' })
    expect(engine.store.skillsOf(agent.skillIds ?? []).map((skill) => skill.name)).toEqual(['bravo', 'charlie', 'zulu'])
  })

  it('leave out an id that is not a skill any more', () => {
    const { engine } = make()
    const one = skillOf(engine, 'one')
    expect(engine.store.skillsOf([one.id, 'gone']).map((skill) => skill.name)).toEqual(['one'])
    expect(engine.store.skillsOf([])).toEqual([])
  })
})

describe('a skill change that would break an agent', () => {
  it('is refused when the new body pushes an agent over 6000 characters, with a count and nothing else', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a', 'x'.repeat(3000))
    const b = skillOf(engine, 'b', 'y'.repeat(3000))
    agentOf(engine, { name: 'secret agent name', skillIds: [a.id, b.id] })
    let thrown: unknown
    try {
      engine.saveSkill({ id: a.id, name: 'a', description: '', body: 'x'.repeat(3001) })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SkillInvalidError)
    const problems = (thrown as SkillInvalidError).problems
    expect(problems).toEqual(['body.too_large_for_agent: the body would make the skills of 1 agent longer than 6000 characters together'])
    expect(JSON.stringify({ message: (thrown as Error).message, problems })).not.toMatch(/secret agent name|xxx|yyy/)
    expect(engine.listSkills().find((skill) => skill.id === a.id)?.body).toHaveLength(3000)
  })

  it('counts every agent that would break', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a', 'x'.repeat(3000))
    const b = skillOf(engine, 'b', 'y'.repeat(3000))
    agentOf(engine, { name: 'one', skillIds: [a.id, b.id] })
    agentOf(engine, { name: 'two', skillIds: [b.id, a.id] })
    agentOf(engine, { name: 'three', skillIds: [a.id] })
    const problems = problemsOf(() => engine.saveSkill({ id: a.id, name: 'a', description: '', body: 'x'.repeat(3500) }))
    expect(problems).toEqual(['body.too_large_for_agent: the body would make the skills of 2 agents longer than 6000 characters together'])
  })

  it('does not count an agent that stays within the limit or one that does not use the skill', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a', 'x'.repeat(1000))
    const b = skillOf(engine, 'b', 'y'.repeat(4000))
    agentOf(engine, { name: 'big', skillIds: [b.id] })
    agentOf(engine, { name: 'small', skillIds: [a.id] })
    const edited = engine.saveSkill({ id: a.id, name: 'a', description: '', body: 'x'.repeat(4000) })
    expect(edited.body).toHaveLength(4000)
  })

  it('lets a body grow up to exactly 6000 characters together, and a body shrink', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a', 'x'.repeat(1000))
    const b = skillOf(engine, 'b', 'y'.repeat(2000))
    agentOf(engine, { skillIds: [a.id, b.id] })
    expect(engine.saveSkill({ id: a.id, name: 'a', description: '', body: 'x'.repeat(4000) }).body).toHaveLength(4000)
    expect(engine.saveSkill({ id: a.id, name: 'a', description: '', body: 'x' }).body).toBe('x')
  })

  it('does not touch the skill or the agents when it is refused', () => {
    const { engine, db } = make()
    const a = skillOf(engine, 'a', 'x'.repeat(3000))
    const b = skillOf(engine, 'b', 'y'.repeat(3000))
    agentOf(engine, { skillIds: [a.id, b.id] })
    const before = JSON.stringify([db.all('SELECT * FROM skills ORDER BY id'), db.all('SELECT * FROM agents ORDER BY id')])
    expect(() => engine.saveSkill({ id: a.id, name: 'renamed', description: 'changed', body: 'x'.repeat(4000) })).toThrow(SkillInvalidError)
    expect(JSON.stringify([db.all('SELECT * FROM skills ORDER BY id'), db.all('SELECT * FROM agents ORDER BY id')])).toBe(before)
  })
})

describe('deleting a skill', () => {
  it('removes its id from every agent that has it, and leaves the other ids in their order', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a')
    const b = skillOf(engine, 'b')
    const c = skillOf(engine, 'c')
    const first = agentOf(engine, { name: 'first', skillIds: [c.id, b.id, a.id] })
    const second = agentOf(engine, { name: 'second', skillIds: [b.id] })
    const third = agentOf(engine, { name: 'third', skillIds: [c.id] })
    expect(engine.deleteSkill(b.id)).toBe(true)
    const byId = new Map(engine.listAgents().agents.map((agent) => [agent.id, agent]))
    expect(byId.get(first.id)?.skillIds).toEqual([c.id, a.id])
    expect(byId.get(second.id)?.skillIds).toEqual([])
    expect(byId.get(third.id)?.skillIds).toEqual([c.id])
    expect(engine.listSkills().map((skill) => skill.id).sort()).toEqual([a.id, c.id].sort())
  })

  it('does not change anything else about the agents', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a')
    const agent = agentOf(engine, { kind: 'reviewer', skillIds: [a.id] })
    engine.deleteSkill(a.id)
    expect(engine.listAgents().agents[1]).toEqual({ ...agent, skillIds: [] })
  })

  it('is one transaction: a failure halfway leaves the skill and every agent as they were', () => {
    const { engine, db } = make()
    const a = skillOf(engine, 'a')
    const first = agentOf(engine, { name: 'first', skillIds: [a.id] })
    agentOf(engine, { name: 'second', skillIds: [a.id] })
    const before = JSON.stringify(engine.listAgents())
    const run = db.run.bind(db)
    let updates = 0
    db.run = ((sql: string, ...params: never[]) => {
      if (sql.startsWith('UPDATE agents') && (updates += 1) === 2) throw new Error('disk full')
      return run(sql, ...params)
    }) as typeof db.run
    expect(() => engine.deleteSkill(a.id)).toThrow('disk full')
    db.run = run
    expect(updates).toBe(2)
    expect(JSON.stringify(engine.listAgents())).toBe(before)
    expect(engine.listSkills().map((skill) => skill.id)).toEqual([a.id])
    expect(engine.listAgents().agents.find((agent) => agent.id === first.id)?.skillIds).toEqual([a.id])
  })

  it('says false for a skill that is not there and leaves the agents alone', () => {
    const { engine } = make()
    const a = skillOf(engine, 'a')
    const agent = agentOf(engine, { skillIds: [a.id] })
    expect(engine.deleteSkill('missing')).toBe(false)
    expect(engine.listAgents().agents[1]).toEqual(agent)
  })
})

describe('only an assistant can be the active agent', () => {
  it('refuses setActiveAgent for a reviewer and keeps the active agent', () => {
    const { engine } = make()
    const assistant = agentOf(engine, { name: 'assistant' })
    const reviewer = agentOf(engine, { name: 'reviewer', kind: 'reviewer' })
    engine.setActiveAgent(assistant.id)
    expect(() => engine.setActiveAgent(reviewer.id)).toThrow(AgentNotAssistantError)
    expect(engine.listAgents().activeId).toBe(assistant.id)
  })

  it('refuses to turn the active agent into a reviewer, and keeps it as it was', () => {
    const { engine } = make()
    const agent = agentOf(engine)
    engine.setActiveAgent(agent.id)
    expect(() => agentOf(engine, { id: agent.id, kind: 'reviewer' })).toThrow(AgentNotAssistantError)
    expect(engine.listAgents().agents[1]).toEqual(agent)
    expect(engine.listAgents().activeId).toBe(agent.id)
  })

  it('lets an agent that is not active become a reviewer, and an assistant again', () => {
    const { engine } = make()
    const active = agentOf(engine, { name: 'active' })
    const other = agentOf(engine, { name: 'other' })
    engine.setActiveAgent(active.id)
    expect(agentOf(engine, { id: other.id, kind: 'reviewer' }).kind).toBe('reviewer')
    expect(() => engine.setActiveAgent(other.id)).toThrow(AgentNotAssistantError)
    expect(agentOf(engine, { id: other.id, kind: 'assistant' }).kind).toBe('assistant')
    engine.setActiveAgent(other.id)
    expect(engine.listAgents().activeId).toBe(other.id)
  })

  it('lets the active agent change anything but its kind, and a reviewer be created while another agent is active', () => {
    const { engine } = make()
    const agent = agentOf(engine)
    engine.setActiveAgent(agent.id)
    expect(agentOf(engine, { id: agent.id, name: 'renamed', kind: 'assistant' }).name).toBe('renamed')
    expect(agentOf(engine, { id: agent.id, name: 'renamed again' }).kind).toBe('assistant')
    expect(agentOf(engine, { name: 'a reviewer', kind: 'reviewer' }).kind).toBe('reviewer')
    expect(engine.listAgents().activeId).toBe(agent.id)
  })

  it('still lets the built-in agent be active, and says not found for an unknown id before it looks at the kind', () => {
    const { engine } = make()
    engine.setActiveAgent('default')
    expect(() => engine.setActiveAgent('missing')).toThrow(AgentNotFoundError)
  })
})
