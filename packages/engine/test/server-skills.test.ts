import { createCoreRegistry } from '@rill/nodes-core'
import { ERROR_CODES, RillClient, RillError, SKILL_MAX_ITEMS, type AgentFields, type MethodParams, type SkillFields } from '@rill/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'
import { GOOD, failure as explainFailure, http, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { plainWorkflow, workflowReply } from './plan-helpers'

const TOKEN = 'skills-token-0123456789abcdef'
const MARKER = 'SKILL-MARKER-c41d'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(engine?: Engine) {
  const logs: string[] = []
  const real = engine ?? new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry() })
  if (engine === undefined) cleanups.push(() => real.shutdown())
  const server = new RillServer({ engine: real, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const frames: string[] = []
  const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN, {
    socketFactory: (target, protocol) => {
      const socket = new WebSocket(target, protocol)
      socket.addEventListener('message', (event) => frames.push(String(event.data)))
      return socket as never
    },
  })
  cleanups.push(() => client.close())
  return { client, frames, logs, engine: real }
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

const fields: SkillFields = { name: 'Receipts checklist', description: 'How to plan a receipts ledger', body: 'Ask for the folder.\nName every default you pick.' }
const agentFields: AgentFields = { name: 'Reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

describe('skill methods over the websocket, with no model provider', () => {
  it('lists nothing at first, then saves, edits, lists and deletes', async () => {
    const { client } = await start()
    expect(await client.request('listSkills', {})).toEqual({ skills: [] })
    const one = (await client.request('saveSkill', { ...fields, name: '  Terse   one ' })).skill
    const two = (await client.request('saveSkill', { ...fields, name: 'Zed' })).skill
    expect(one).toMatchObject({ name: 'Terse one', body: fields.body })
    expect((await client.request('listSkills', {})).skills.map((skill) => skill.id)).toEqual([one.id, two.id])
    const edited = (await client.request('saveSkill', { ...fields, id: one.id, name: 'Terse two', body: 'different' })).skill
    expect(edited).toMatchObject({ id: one.id, createdAt: one.createdAt, name: 'Terse two', body: 'different' })
    expect(await client.request('deleteSkill', { id: two.id })).toEqual({ deleted: true })
    expect(await client.request('deleteSkill', { id: two.id })).toEqual({ deleted: false })
    expect((await client.request('listSkills', {})).skills.map((skill) => skill.id)).toEqual([one.id])
  })

  it('answers SKILL_INVALID with the field and the rule that failed, for each kind of bad text', async () => {
    const { client } = await start()
    const cases: Array<[Partial<SkillFields>, string]> = [
      [{ name: '' }, 'name.empty'],
      [{ name: `one\n${MARKER}` }, 'name.control_character'],
      [{ description: `one\u2028${MARKER}` }, 'description.line_separator'],
      [{ body: `one\u202e${MARKER}` }, 'body.bidi_format'],
      [{ body: `one\u200b${MARKER}` }, 'body.format_character'],
      [{ body: `one\r${MARKER}` }, 'body.control_character'],
      [{ body: MARKER.repeat(400) }, 'body.too_long'],
      [{ body: '' }, 'body.empty'],
    ]
    for (const [override, rule] of cases) {
      const error = await failure(client.request('saveSkill', { ...fields, ...override }))
      expect(error.code, rule).toBe('SKILL_INVALID')
      expect(error.problems, rule).toEqual([expect.stringMatching(new RegExp(`^${rule.replace('.', '\\.')}: `))])
    }
    expect((await client.request('listSkills', {})).skills).toEqual([])
  })

  it('answers SKILL_DUPLICATE for a copy of a name, SKILL_FULL for the 25th skill and SKILL_NOT_FOUND for an unknown id', async () => {
    const { client } = await start()
    const first = (await client.request('saveSkill', { ...fields, name: 'Same name' })).skill
    expect((await failure(client.request('saveSkill', { ...fields, name: 'SAME   name' }))).code).toBe('SKILL_DUPLICATE')
    expect((await failure(client.request('saveSkill', { ...fields, id: 'missing' }))).code).toBe('SKILL_NOT_FOUND')
    for (let index = 1; index < SKILL_MAX_ITEMS; index++) await client.request('saveSkill', { ...fields, name: `skill ${index}` })
    expect((await failure(client.request('saveSkill', { ...fields, name: 'one too many' }))).code).toBe('SKILL_FULL')
    expect((await client.request('saveSkill', { ...fields, id: first.id, name: 'edited while full' })).skill.name).toBe('edited while full')
  })

  it('answers SKILL_INVALID with the body.too_large_for_agent problem when an edit would break an agent', async () => {
    const { client } = await start()
    const a = (await client.request('saveSkill', { ...fields, name: 'a', body: 'x'.repeat(3000) })).skill
    const b = (await client.request('saveSkill', { ...fields, name: 'b', body: 'y'.repeat(3000) })).skill
    await client.request('saveAgent', { ...agentFields, skillIds: [a.id, b.id] })
    const error = await failure(client.request('saveSkill', { ...fields, id: a.id, name: 'a', body: 'x'.repeat(3500) }))
    expect(error.code).toBe('SKILL_INVALID')
    expect(error.problems).toEqual(['body.too_large_for_agent: the body would make the skills of 1 agent longer than 6000 characters together'])
  })

  it('answers INVALID_PARAMS for a bad request shape and for an absurd payload', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveSkill', { ...fields, extra: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveSkill', { name: 'x' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveSkill', { ...fields, persona: 'x' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveSkill', { ...fields, body: 'x'.repeat(100_000) }))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('deleteSkill', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listSkills', { limit: 1 } as never))).code).toBe('INVALID_PARAMS')
  })

  it('never echoes the skill text in an error response or in a log line', async () => {
    const { client, frames, logs } = await start()
    await client.request('saveSkill', { ...fields, name: `${MARKER} first`, body: `${MARKER} body` })
    const attempts: Array<() => Promise<unknown>> = [
      () => client.request('saveSkill', { ...fields, name: `${MARKER}\nsecond` }),
      () => client.request('saveSkill', { ...fields, body: `${MARKER}\u202e` }),
      () => client.request('saveSkill', { ...fields, body: MARKER.repeat(500) }),
      () => client.request('saveSkill', { ...fields, body: MARKER.repeat(20_000) }),
      () => client.request('saveSkill', { ...fields, name: `${MARKER.toLowerCase()}   FIRST` }),
      () => client.request('saveSkill', { ...fields, id: 'missing', name: `${MARKER} edit` }),
      () => client.request('saveSkill', { ...fields, name: `${MARKER} extra`, extra: 1 } as never),
      () => client.request('saveAgent', { ...agentFields, name: MARKER, skillIds: [MARKER] }),
    ]
    for (const attempt of attempts) await failure(attempt())
    const errorFrames = frames.filter((frame) => frame.includes('"ok":false'))
    expect(errorFrames).toHaveLength(attempts.length)
    expect(errorFrames.join('\n').toLowerCase()).not.toContain(MARKER.toLowerCase())
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it('logs only the error name when saveSkill fails unexpectedly', async () => {
    const fail = () => {
      throw new TypeError(`broke on ${MARKER}`)
    }
    const engine = { on: () => () => undefined, saveSkill: fail } as unknown as Engine
    const { client, frames, logs } = await start(engine)
    expect(await failure(client.request('saveSkill', { ...fields, name: MARKER }))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(logs.map((line) => JSON.parse(line))).toEqual([{ type: 'error', method: 'saveSkill', name: 'TypeError' }])
    expect(frames.filter((frame) => frame.includes('"ok":false')).join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it('lists the skill codes in ERROR_CODES', () => {
    for (const code of ['AGENT_NOT_ASSISTANT', 'SKILL_INVALID', 'SKILL_FULL', 'SKILL_DUPLICATE', 'SKILL_NOT_FOUND']) expect(ERROR_CODES as readonly string[]).toContain(code)
  })
})

describe('agents with a kind and skills over the websocket', () => {
  it('saves and lists the kind and the skill ids, and answers AGENT_INVALID for a bad list', async () => {
    const { client } = await start()
    const one = (await client.request('saveSkill', fields)).skill
    const reviewer = (await client.request('saveAgent', { ...agentFields, kind: 'reviewer', skillIds: [one.id] })).agent
    expect(reviewer).toMatchObject({ kind: 'reviewer', skillIds: [one.id] })
    expect((await client.request('listAgents', {})).agents[1]).toEqual(reviewer)
    const unknown = await failure(client.request('saveAgent', { ...agentFields, name: 'other', skillIds: ['missing'] }))
    expect(unknown.code).toBe('AGENT_INVALID')
    expect(unknown.problems).toEqual([expect.stringMatching(/^skills\.unknown: /)])
    const twice = await failure(client.request('saveAgent', { ...agentFields, name: 'other', skillIds: [one.id, one.id] }))
    expect(twice.problems).toEqual([expect.stringMatching(/^skills\.duplicate: /)])
    const many = await failure(client.request('saveAgent', { ...agentFields, name: 'other', skillIds: Array.from({ length: 9 }, (_, index) => `s${index}`) }))
    expect(many.problems.some((line) => line.startsWith('skills.too_many: '))).toBe(true)
  })

  it('deletes a skill out of the agents that use it', async () => {
    const { client } = await start()
    const one = (await client.request('saveSkill', fields)).skill
    const agent = (await client.request('saveAgent', { ...agentFields, skillIds: [one.id] })).agent
    await client.request('deleteSkill', { id: one.id })
    expect((await client.request('listAgents', {})).agents.find((entry) => entry.id === agent.id)?.skillIds).toEqual([])
  })

  it('answers AGENT_NOT_ASSISTANT when a reviewer is made the active agent, and when the active agent becomes a reviewer', async () => {
    const { client } = await start()
    const reviewer = (await client.request('saveAgent', { ...agentFields, name: 'reviewer', kind: 'reviewer' })).agent
    const assistant = (await client.request('saveAgent', { ...agentFields, name: 'assistant' })).agent
    expect((await failure(client.request('setActiveAgent', { id: reviewer.id }))).code).toBe('AGENT_NOT_ASSISTANT')
    await client.request('setActiveAgent', { id: assistant.id })
    expect((await failure(client.request('saveAgent', { ...agentFields, id: assistant.id, name: 'assistant', kind: 'reviewer' }))).code).toBe('AGENT_NOT_ASSISTANT')
    expect((await client.request('listAgents', {})).activeId).toBe(assistant.id)
  })
})

describe('a reviewer agent in plan and explainRun', () => {
  const dirOf = useTempDir()
  useCleanups()

  it('is refused in plan with AGENT_NOT_ASSISTANT before any model call, and the plan id stays free', async () => {
    const env = await startEnv(dirOf.get(), [{ data: workflowReply(plainWorkflow()) }])
    const reviewer = (await env.client.request('saveAgent', { ...agentFields, kind: 'reviewer' })).agent
    const params: MethodParams<'plan'> = { planId: 'plan-1', text: 'Wait a little', turns: [], attachments: [], effort: 'low' }
    const error = await explainFailure(env.client.request('plan', { ...params, agentId: reviewer.id }))
    expect(error).toMatchObject({ code: 'AGENT_NOT_ASSISTANT' })
    expect(env.provider.requests).toHaveLength(0)
    expect(env.engine.listPlans()).toEqual([])
    await env.client.request('plan', params)
    expect(env.provider.requests).toHaveLength(1)
  })

  it('is refused in explainRun with AGENT_NOT_ASSISTANT before any model call', async () => {
    const env = await startEnv(dirOf.get(), [{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    const reviewer = (await env.client.request('saveAgent', { ...agentFields, kind: 'reviewer' })).agent
    expect(await explainFailure(env.client.request('explainRun', { runId, agentId: reviewer.id }))).toMatchObject({ code: 'AGENT_NOT_ASSISTANT' })
    expect(env.provider.requests).toHaveLength(0)
    expect((await env.client.request('explainRun', { runId })).runId).toBe(runId)
  })

  it('is refused with a fixed text that names neither the agent nor its text', async () => {
    const env = await startEnv(dirOf.get(), [])
    const reviewer = (await env.client.request('saveAgent', { ...agentFields, name: MARKER, persona: `${MARKER} persona`, kind: 'reviewer' })).agent
    const error = await explainFailure(env.client.request('plan', { planId: 'plan-1', text: 'x', turns: [], attachments: [], effort: 'low', agentId: reviewer.id }))
    expect(error.message).toBe('only an assistant agent can be the active agent or be used to plan or explain')
    expect(JSON.stringify(error)).not.toContain(MARKER)
    expect(env.logs.join('\n')).not.toContain(MARKER)
  })
})
