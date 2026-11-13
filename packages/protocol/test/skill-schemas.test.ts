import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  AGENT_KINDS,
  AGENT_MAX_SKILLS,
  AGENT_SKILLS_MAX_CHARS,
  AgentSchema,
  ERROR_CODES,
  METHODS,
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_MAX_ITEMS,
  SKILL_NAME_MAX_CHARS,
  SkillSchema,
  agentSkillProblemLine,
  checkAgentSkillIds,
  parseAgentSkillProblemLine,
  validateParams,
} from '../src/index'

const skill = {
  id: '3f2b8c1e-6a4d-4f5b-9c0e-1a2b3c4d5e6f',
  name: 'Receipts checklist',
  description: 'How to plan a receipts ledger',
  body: 'Ask for the folder.\nName every default you pick.',
  createdAt: 1000,
  updatedAt: 2000,
}

const skillFields = { name: skill.name, description: skill.description, body: skill.body }

const agent = {
  id: 'agent-1',
  name: 'Terse reviewer',
  description: 'Short answers',
  persona: 'Calm and brief.',
  instructions: 'Prefer one node less.',
  builtin: false,
  createdAt: 1000,
  updatedAt: 2000,
}

const agentFields = { name: 'Terse reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

describe('skill limits', () => {
  it('are 24 skills, 8 per agent and 6000 characters for the bodies of one agent together', () => {
    expect(SKILL_MAX_ITEMS).toBe(24)
    expect(AGENT_MAX_SKILLS).toBe(8)
    expect(AGENT_SKILLS_MAX_CHARS).toBe(6000)
  })
})

describe('SkillSchema', () => {
  const valid = (value: unknown) => Value.Check(SkillSchema, value)

  it('accepts a saved skill', () => {
    expect(valid(skill)).toBe(true)
  })

  it('accepts every text at its limit and refuses one character more', () => {
    const limits = { name: SKILL_NAME_MAX_CHARS, description: SKILL_DESCRIPTION_MAX_CHARS, body: SKILL_BODY_MAX_CHARS } as const
    for (const [field, limit] of Object.entries(limits)) {
      expect(valid({ ...skill, [field]: 'x'.repeat(limit) }), field).toBe(true)
      expect(valid({ ...skill, [field]: 'x'.repeat(limit + 1) }), field).toBe(false)
    }
  })

  it('counts characters, not UTF-16 units', () => {
    expect(valid({ ...skill, body: '😀'.repeat(4000) })).toBe(true)
    expect(valid({ ...skill, body: '😀'.repeat(4001) })).toBe(false)
  })

  it('needs a name and a body, and lets the description be empty', () => {
    expect(valid({ ...skill, name: '' })).toBe(false)
    expect(valid({ ...skill, body: '' })).toBe(false)
    expect(valid({ ...skill, description: '' })).toBe(true)
  })

  it('rejects extra properties, missing fields, an empty id and wrong types', () => {
    expect(valid({ ...skill, extra: 1 })).toBe(false)
    expect(valid({ ...skill, builtin: false })).toBe(false)
    for (const key of Object.keys(skill)) {
      const rest: Record<string, unknown> = { ...skill }
      delete rest[key]
      expect(valid(rest), key).toBe(false)
    }
    expect(valid({ ...skill, id: '' })).toBe(false)
    expect(valid({ ...skill, id: 'x'.repeat(129) })).toBe(false)
    expect(valid({ ...skill, name: 7 })).toBe(false)
    expect(valid({ ...skill, createdAt: '1' })).toBe(false)
  })
})

describe('listSkills', () => {
  it('takes no params', () => {
    expect(validateParams('listSkills', {})).toEqual({ ok: true, method: 'listSkills', params: {} })
    expect(validateParams('listSkills', undefined).ok).toBe(true)
    expect(validateParams('listSkills', { limit: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns at most 24 skills', () => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ ...skill, id: `skill-${index}` }))
    expect(Value.Check(METHODS.listSkills.result, { skills: [] })).toBe(true)
    expect(Value.Check(METHODS.listSkills.result, { skills: entries(SKILL_MAX_ITEMS) })).toBe(true)
    expect(Value.Check(METHODS.listSkills.result, { skills: entries(SKILL_MAX_ITEMS + 1) })).toBe(false)
    expect(Value.Check(METHODS.listSkills.result, {})).toBe(false)
    expect(Value.Check(METHODS.listSkills.result, { skills: [{ ...skill, extra: 1 }] })).toBe(false)
    expect(Value.Check(METHODS.listSkills.result, { skills: [], extra: 1 })).toBe(false)
  })
})

describe('saveSkill', () => {
  it('creates without an id and updates with one', () => {
    expect(validateParams('saveSkill', skillFields)).toEqual({ ok: true, method: 'saveSkill', params: skillFields })
    expect(validateParams('saveSkill', { id: skill.id, ...skillFields })).toMatchObject({ ok: true })
  })

  it('needs all three texts and refuses extra properties, an empty id and wrong types', () => {
    for (const key of Object.keys(skillFields)) {
      const rest: Record<string, unknown> = { ...skillFields }
      delete rest[key]
      expect(validateParams('saveSkill', rest), key).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
    expect(validateParams('saveSkill', { ...skillFields, createdAt: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveSkill', { ...skillFields, persona: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveSkill', { ...skillFields, id: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveSkill', { ...skillFields, id: 'x'.repeat(129) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveSkill', { ...skillFields, body: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('leaves the field limits to the engine but refuses an absurd payload', () => {
    expect(validateParams('saveSkill', { ...skillFields, name: 'x'.repeat(SKILL_NAME_MAX_CHARS + 1) }).ok).toBe(true)
    expect(validateParams('saveSkill', { ...skillFields, body: 'x'.repeat(SKILL_BODY_MAX_CHARS + 1) }).ok).toBe(true)
    for (const field of ['name', 'description', 'body']) {
      expect(validateParams('saveSkill', { ...skillFields, [field]: 'x'.repeat(100_000) }), field).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
  })

  it('does not put the text into the problems of a bad request', () => {
    const marker = 'SKILL-MARKER-4e1c'
    for (const field of ['name', 'description', 'body']) {
      const result = validateParams('saveSkill', { ...skillFields, [field]: marker.repeat(10_000) })
      expect(result.ok, field).toBe(false)
      expect(JSON.stringify(result), field).not.toContain(marker)
    }
    expect(validateParams('saveSkill', { ...skillFields, [marker]: 1 }).ok).toBe(false)
  })

  it('returns one skill', () => {
    expect(Value.Check(METHODS.saveSkill.result, { skill })).toBe(true)
    expect(Value.Check(METHODS.saveSkill.result, { skill: { ...skill, body: '' } })).toBe(false)
    expect(Value.Check(METHODS.saveSkill.result, {})).toBe(false)
    expect(Value.Check(METHODS.saveSkill.result, { skill, extra: 1 })).toBe(false)
  })
})

describe('deleteSkill', () => {
  it('takes an id and answers whether a skill was deleted', () => {
    expect(validateParams('deleteSkill', { id: 'skill-1' })).toEqual({ ok: true, method: 'deleteSkill', params: { id: 'skill-1' } })
    expect(validateParams('deleteSkill', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteSkill', { id: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteSkill', { id: 'skill-1', name: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(Value.Check(METHODS.deleteSkill.result, { deleted: true })).toBe(true)
    expect(Value.Check(METHODS.deleteSkill.result, { deleted: 'yes' })).toBe(false)
  })
})

describe('the kind and the skills of an agent', () => {
  const valid = (value: unknown) => Value.Check(AgentSchema, value)

  it('knows two kinds', () => {
    expect([...AGENT_KINDS]).toEqual(['assistant', 'reviewer'])
  })

  it('lets an agent carry a kind and the ids of its skills, and leaves both optional', () => {
    expect(valid(agent)).toBe(true)
    expect(valid({ ...agent, kind: 'assistant', skillIds: [] })).toBe(true)
    expect(valid({ ...agent, kind: 'reviewer', skillIds: ['skill-1', 'skill-2'] })).toBe(true)
    expect(valid({ ...agent, kind: 'reviewer' })).toBe(true)
    expect(valid({ ...agent, skillIds: ['skill-1'] })).toBe(true)
  })

  it('refuses another kind, ids that are not text, an empty id and more than 8 skills', () => {
    expect(valid({ ...agent, kind: 'chat' })).toBe(false)
    expect(valid({ ...agent, kind: 'Reviewer' })).toBe(false)
    expect(valid({ ...agent, kind: 1 })).toBe(false)
    expect(valid({ ...agent, kind: null })).toBe(false)
    expect(valid({ ...agent, skillIds: 'skill-1' })).toBe(false)
    expect(valid({ ...agent, skillIds: [1] })).toBe(false)
    expect(valid({ ...agent, skillIds: [''] })).toBe(false)
    expect(valid({ ...agent, skillIds: ['x'.repeat(129)] })).toBe(false)
    expect(valid({ ...agent, skillIds: Array.from({ length: AGENT_MAX_SKILLS }, (_, index) => `s${index}`) })).toBe(true)
    expect(valid({ ...agent, skillIds: Array.from({ length: AGENT_MAX_SKILLS + 1 }, (_, index) => `s${index}`) })).toBe(false)
    expect(valid({ ...agent, skills: [] })).toBe(false)
  })

  it('lets saveAgent carry a kind and skill ids, both optional', () => {
    expect(validateParams('saveAgent', agentFields).ok).toBe(true)
    expect(validateParams('saveAgent', { ...agentFields, kind: 'reviewer' }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...agentFields, kind: 'assistant', skillIds: ['s1', 's2'] }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...agentFields, skillIds: [] }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...agentFields, kind: 'chat' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...agentFields, kind: 1 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...agentFields, skillIds: 'a' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...agentFields, skillIds: [''] })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...agentFields, skills: [] })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('leaves the number of skills to the engine but refuses an absurd list', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`)
    expect(validateParams('saveAgent', { ...agentFields, skillIds: ids(AGENT_MAX_SKILLS + 1) }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...agentFields, skillIds: ids(4 * AGENT_MAX_SKILLS) }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...agentFields, skillIds: ids(4 * AGENT_MAX_SKILLS + 1) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('lets listAgents and saveAgent results carry the kind and the skill ids', () => {
    const withKind = { ...agent, kind: 'reviewer', skillIds: ['skill-1'] }
    expect(Value.Check(METHODS.listAgents.result, { agents: [withKind], activeId: 'default' })).toBe(true)
    expect(Value.Check(METHODS.saveAgent.result, { agent: withKind })).toBe(true)
    expect(Value.Check(METHODS.saveAgent.result, { agent: { ...withKind, kind: 'chat' } })).toBe(false)
  })
})

describe('checkAgentSkillIds', () => {
  it('accepts a list of distinct ids up to the limit', () => {
    expect(checkAgentSkillIds([])).toEqual([])
    expect(checkAgentSkillIds(['a', 'b'])).toEqual([])
    expect(checkAgentSkillIds(Array.from({ length: AGENT_MAX_SKILLS }, (_, index) => `s${index}`))).toEqual([])
  })

  it('names a repeated id and a list that is too long, once each', () => {
    expect(checkAgentSkillIds(['a', 'b', 'a'])).toEqual(['duplicate'])
    expect(checkAgentSkillIds(['a', 'a', 'a'])).toEqual(['duplicate'])
    expect(checkAgentSkillIds(Array.from({ length: AGENT_MAX_SKILLS + 1 }, (_, index) => `s${index}`))).toEqual(['too_many'])
    expect(checkAgentSkillIds(Array.from({ length: AGENT_MAX_SKILLS + 2 }, () => 'same'))).toEqual(['duplicate', 'too_many'])
  })
})

describe('agentSkillProblemLine and parseAgentSkillProblemLine', () => {
  it('write the field and the rule first, then a fixed sentence without ids or names', () => {
    expect(agentSkillProblemLine('unknown')).toBe('skills.unknown: a skill of the agent does not exist')
    expect(agentSkillProblemLine('duplicate')).toBe('skills.duplicate: a skill is listed twice')
    expect(agentSkillProblemLine('too_many')).toBe('skills.too_many: an agent has at most 8 skills')
    expect(agentSkillProblemLine('too_large')).toBe('skills.too_large: the skills of an agent are at most 6000 characters together')
  })

  it('round-trip every rule and refuse anything else', () => {
    for (const rule of ['unknown', 'duplicate', 'too_many', 'too_large'] as const) expect(parseAgentSkillProblemLine(agentSkillProblemLine(rule))).toBe(rule)
    for (const line of ['', 'skills', 'skills.nope: x', 'name.too_long: x', 'skills.unknown', 'skills.unknown:', 'skill.unknown: x']) {
      expect(parseAgentSkillProblemLine(line), line).toBeUndefined()
    }
  })
})

describe('skill and agent kind error codes', () => {
  it('are listed once, next to the agent codes', () => {
    for (const code of ['AGENT_NOT_ASSISTANT', 'SKILL_INVALID', 'SKILL_FULL', 'SKILL_DUPLICATE', 'SKILL_NOT_FOUND']) {
      expect(ERROR_CODES as readonly string[]).toContain(code)
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
