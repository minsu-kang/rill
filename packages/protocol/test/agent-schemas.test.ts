import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  AGENT_DEFAULT_ID,
  AGENT_DESCRIPTION_MAX_CHARS,
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AGENT_MAX_ITEMS,
  AGENT_NAME_MAX_CHARS,
  AGENT_PERSONA_MAX_CHARS,
  AgentSchema,
  ERROR_CODES,
  IdSchema,
  METHODS,
  PlanMetaSchema,
  PlanRecordSchema,
  validateParams,
  type PlanMeta,
} from '../src/index'

const agent = {
  id: '3f2b8c1e-6a4d-4f5b-9c0e-1a2b3c4d5e6f',
  name: 'Terse reviewer',
  description: 'Short answers',
  persona: 'Calm and brief.',
  instructions: 'Prefer one node less.\nName every default you pick.',
  builtin: false,
  createdAt: 1000,
  updatedAt: 2000,
}

const fields = { name: 'Terse reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

describe('agent limits', () => {
  it('are 12 agents, a 60 character name, 200 for the description, 600 for the persona and 3000 for the instructions', () => {
    expect(AGENT_MAX_ITEMS).toBe(12)
    expect(AGENT_NAME_MAX_CHARS).toBe(60)
    expect(AGENT_DESCRIPTION_MAX_CHARS).toBe(200)
    expect(AGENT_PERSONA_MAX_CHARS).toBe(600)
    expect(AGENT_INSTRUCTIONS_MAX_CHARS).toBe(3000)
    expect(AGENT_DEFAULT_ID).toBe('default')
  })
})

describe('AgentSchema', () => {
  const valid = (value: unknown) => Value.Check(AgentSchema, value)

  it('accepts a saved agent and the built-in one', () => {
    expect(valid(agent)).toBe(true)
    expect(valid({ ...agent, id: 'default', builtin: true, description: '', persona: '', instructions: '', createdAt: 0, updatedAt: 0 })).toBe(true)
  })

  it('accepts every field at its limit and refuses one character more', () => {
    const limits = { name: 60, description: 200, persona: 600, instructions: 3000 } as const
    for (const [field, limit] of Object.entries(limits)) {
      expect(valid({ ...agent, [field]: 'x'.repeat(limit) }), field).toBe(true)
      expect(valid({ ...agent, [field]: 'x'.repeat(limit + 1) }), field).toBe(false)
    }
  })

  it('counts characters, not UTF-16 units', () => {
    expect(valid({ ...agent, name: '😀'.repeat(60) })).toBe(true)
    expect(valid({ ...agent, name: '😀'.repeat(61) })).toBe(false)
    expect(valid({ ...agent, instructions: '😀'.repeat(3000) })).toBe(true)
    expect(valid({ ...agent, instructions: '😀'.repeat(3001) })).toBe(false)
  })

  it('limits the id like every other id', () => {
    for (const candidate of ['', 'a', 'x'.repeat(128), 'x'.repeat(129)]) {
      expect(valid({ ...agent, id: candidate }), String(candidate.length)).toBe(Value.Check(IdSchema, candidate))
    }
  })

  it('needs a name, and lets the other texts be empty', () => {
    expect(valid({ ...agent, name: '' })).toBe(false)
    for (const field of ['description', 'persona', 'instructions']) expect(valid({ ...agent, [field]: '' }), field).toBe(true)
  })

  it('rejects extra properties, missing fields and wrong types', () => {
    expect(valid({ ...agent, extra: 1 })).toBe(false)
    expect(valid({ ...agent, kind: 'chat' })).toBe(false)
    expect(valid({ ...agent, skillIds: [] })).toBe(false)
    for (const key of Object.keys(agent)) {
      const rest: Record<string, unknown> = { ...agent }
      delete rest[key]
      expect(valid(rest), key).toBe(false)
    }
    expect(valid({ ...agent, id: '' })).toBe(false)
    expect(valid({ ...agent, builtin: 'no' })).toBe(false)
    expect(valid({ ...agent, name: 7 })).toBe(false)
    expect(valid({ ...agent, createdAt: '1' })).toBe(false)
  })
})

describe('listAgents', () => {
  it('takes no params', () => {
    expect(validateParams('listAgents', {})).toEqual({ ok: true, method: 'listAgents', params: {} })
    expect(validateParams('listAgents', undefined).ok).toBe(true)
    expect(validateParams('listAgents', { limit: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('returns the agents and the active id, at most 13 entries with the built-in one', () => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ ...agent, id: `agent-${index}` }))
    const result = (count: number, activeId = 'default') => ({ agents: entries(count), activeId })
    expect(Value.Check(METHODS.listAgents.result, result(1))).toBe(true)
    expect(Value.Check(METHODS.listAgents.result, result(AGENT_MAX_ITEMS + 1))).toBe(true)
    expect(Value.Check(METHODS.listAgents.result, result(AGENT_MAX_ITEMS + 2))).toBe(false)
    expect(Value.Check(METHODS.listAgents.result, { agents: entries(1) })).toBe(false)
    expect(Value.Check(METHODS.listAgents.result, { ...result(1), activeId: '' })).toBe(false)
    expect(Value.Check(METHODS.listAgents.result, { ...result(1), extra: 1 })).toBe(false)
    expect(Value.Check(METHODS.listAgents.result, { agents: [{ ...agent, extra: 1 }], activeId: 'default' })).toBe(false)
  })
})

describe('saveAgent', () => {
  it('creates without an id and updates with one', () => {
    expect(validateParams('saveAgent', fields)).toEqual({ ok: true, method: 'saveAgent', params: fields })
    expect(validateParams('saveAgent', { id: agent.id, ...fields })).toMatchObject({ ok: true })
  })

  it('needs all four texts and refuses extra properties, an empty id and wrong types', () => {
    for (const key of Object.keys(fields)) {
      const rest: Record<string, unknown> = { ...fields }
      delete rest[key]
      expect(validateParams('saveAgent', rest), key).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
    expect(validateParams('saveAgent', { ...fields, builtin: false })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, kind: 'chat' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, id: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, id: 'x'.repeat(129) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, name: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('leaves the field limits to the engine but refuses an absurd payload', () => {
    expect(validateParams('saveAgent', { ...fields, name: 'x'.repeat(AGENT_NAME_MAX_CHARS + 1) }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...fields, persona: 'x'.repeat(AGENT_PERSONA_MAX_CHARS + 1) }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...fields, instructions: 'x'.repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1) }).ok).toBe(true)
    expect(validateParams('saveAgent', { ...fields, name: 'x'.repeat(100_000) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, description: 'x'.repeat(100_000) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, persona: 'x'.repeat(100_000) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('saveAgent', { ...fields, instructions: 'x'.repeat(100_000) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('does not put the text into the problems of a bad request', () => {
    const marker = 'AGENT-MARKER-4e1c'
    for (const field of ['name', 'description', 'persona', 'instructions']) {
      const result = validateParams('saveAgent', { ...fields, [field]: marker.repeat(10_000) })
      expect(result.ok, field).toBe(false)
      expect(JSON.stringify(result), field).not.toContain(marker)
    }
    const extra = validateParams('saveAgent', { ...fields, [marker]: 1 })
    expect(extra.ok).toBe(false)
  })

  it('returns one agent', () => {
    expect(Value.Check(METHODS.saveAgent.result, { agent })).toBe(true)
    expect(Value.Check(METHODS.saveAgent.result, { agent: { ...agent, name: '' } })).toBe(false)
    expect(Value.Check(METHODS.saveAgent.result, {})).toBe(false)
  })
})

describe('deleteAgent and setActiveAgent', () => {
  it('take an id', () => {
    expect(validateParams('deleteAgent', { id: 'agent-1' })).toEqual({ ok: true, method: 'deleteAgent', params: { id: 'agent-1' } })
    expect(validateParams('deleteAgent', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('deleteAgent', { id: 'agent-1', name: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('setActiveAgent', { id: 'agent-1' })).toEqual({ ok: true, method: 'setActiveAgent', params: { id: 'agent-1' } })
    expect(validateParams('setActiveAgent', { id: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('setActiveAgent', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('answer whether an agent was deleted, and an empty result', () => {
    expect(Value.Check(METHODS.deleteAgent.result, { deleted: true })).toBe(true)
    expect(Value.Check(METHODS.deleteAgent.result, { deleted: 'yes' })).toBe(false)
    expect(Value.Check(METHODS.setActiveAgent.result, {})).toBe(true)
  })
})

describe('agentId on plan and explainRun', () => {
  const plan = { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low' }

  it('is optional and an id', () => {
    expect(validateParams('plan', plan).ok).toBe(true)
    expect(validateParams('plan', { ...plan, agentId: 'agent-1' }).ok).toBe(true)
    expect(validateParams('plan', { ...plan, agentId: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('plan', { ...plan, agentId: 5 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: 'r1' }).ok).toBe(true)
    expect(validateParams('explainRun', { runId: 'r1', agentId: 'agent-1' }).ok).toBe(true)
    expect(validateParams('explainRun', { runId: 'r1', agentId: '' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })

  it('refuses the agent text in the params, so a client cannot send a profile of its own', () => {
    expect(validateParams('plan', { ...plan, agent: { persona: 'x' } })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('plan', { ...plan, persona: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    expect(validateParams('explainRun', { runId: 'r1', instructions: 'x' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })
})

describe('the agent in plan records and meta', () => {
  const meta: PlanMeta = {
    rounds: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    costUsd: null,
    model: 'm',
    effort: 'low',
    fallbackUsed: false,
  }

  it('lets the meta say which agent was used and how many profiles were left out', () => {
    const valid = (value: unknown) => Value.Check(PlanMetaSchema, value)
    expect(valid(meta)).toBe(true)
    expect(valid({ ...meta, agentUsed: { id: 'agent-1', name: 'Terse reviewer' }, agentDropped: 0 })).toBe(true)
    expect(valid({ ...meta, agentDropped: 1 })).toBe(true)
    expect(valid({ ...meta, agentDropped: -1 })).toBe(false)
    expect(valid({ ...meta, agentDropped: 1.5 })).toBe(false)
    expect(valid({ ...meta, agentUsed: { id: 'agent-1' } })).toBe(false)
    expect(valid({ ...meta, agentUsed: { id: 'agent-1', name: 'x', persona: 'y' } })).toBe(false)
    expect(valid({ ...meta, agentUsed: { id: '', name: 'x' } })).toBe(false)
    expect(valid({ ...meta, agentUsed: { id: 'agent-1', name: 'x'.repeat(61) } })).toBe(false)
  })

  it('lets a plan record carry the id of the agent that made it', () => {
    const record = {
      planId: 'p1',
      createdAt: 1,
      status: 'failed',
      effort: 'low',
      model: null,
      requestText: 't',
      attachments: [],
      result: null,
      meta: null,
      error: 'x',
      flagKeys: [],
      workflowId: null,
      confirmed: null,
    }
    expect(Value.Check(PlanRecordSchema, record)).toBe(true)
    expect(Value.Check(PlanRecordSchema, { ...record, agentId: 'agent-1' })).toBe(true)
    expect(Value.Check(PlanRecordSchema, { ...record, agentId: '' })).toBe(false)
    expect(Value.Check(PlanRecordSchema, { ...record, agentId: null })).toBe(false)
  })
})

describe('agent error codes', () => {
  it('are listed next to the planner codes, once', () => {
    for (const code of ['AGENT_INVALID', 'AGENT_FULL', 'AGENT_DUPLICATE', 'AGENT_NOT_FOUND', 'AGENT_BUILTIN']) expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
