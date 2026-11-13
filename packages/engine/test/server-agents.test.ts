import { createCoreRegistry } from '@rill/nodes-core'
import { AGENT_MAX_ITEMS, ERROR_CODES, RillClient, RillError, type AgentFields } from '@rill/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'

const TOKEN = 'agents-token-0123456789abcdef'
const MARKER = 'AGENT-MARKER-c41d'

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

const fields: AgentFields = { name: 'Reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

describe('agent methods over the websocket, with no model provider', () => {
  it('lists the built-in agent first, then saves, edits, activates, lists and deletes', async () => {
    const { client } = await start()
    const first = await client.request('listAgents', {})
    expect(first.activeId).toBe('default')
    expect(first.agents).toHaveLength(1)
    expect(first.agents[0]).toMatchObject({ id: 'default', builtin: true, persona: '', instructions: '' })

    const one = (await client.request('saveAgent', { ...fields, name: '  Terse   one ' })).agent
    const two = (await client.request('saveAgent', { ...fields, name: 'Zed' })).agent
    expect(one).toMatchObject({ name: 'Terse one', builtin: false })
    expect((await client.request('listAgents', {})).agents.map((agent) => agent.id)).toEqual(['default', one.id, two.id])

    const edited = (await client.request('saveAgent', { ...fields, id: one.id, name: 'Terse two', persona: 'different' })).agent
    expect(edited).toMatchObject({ id: one.id, createdAt: one.createdAt, name: 'Terse two', persona: 'different' })

    expect(await client.request('setActiveAgent', { id: two.id })).toEqual({})
    expect((await client.request('listAgents', {})).activeId).toBe(two.id)

    expect(await client.request('deleteAgent', { id: two.id })).toEqual({ deleted: true })
    expect(await client.request('deleteAgent', { id: two.id })).toEqual({ deleted: false })
    const after = await client.request('listAgents', {})
    expect(after.activeId).toBe('default')
    expect(after.agents.map((agent) => agent.id)).toEqual(['default', one.id])
  })

  it('is not blocked by a missing model: plan says LLM_UNAVAILABLE while agents work', async () => {
    const { client } = await start()
    expect((await failure(client.request('plan', { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low' }))).code).toBe('LLM_UNAVAILABLE')
    expect((await client.request('saveAgent', fields)).agent.name).toBe('Reviewer')
  })

  it('answers AGENT_INVALID with the field and the rule that failed, for each kind of bad text', async () => {
    const { client } = await start()
    const cases: Array<[Partial<AgentFields>, string]> = [
      [{ name: '' }, 'name.empty'],
      [{ name: `one\n${MARKER}` }, 'name.control_character'],
      [{ description: `one\u2028${MARKER}` }, 'description.line_separator'],
      [{ persona: `one\u202e${MARKER}` }, 'persona.bidi_format'],
      [{ instructions: `one\u200b${MARKER}` }, 'instructions.format_character'],
      [{ instructions: MARKER.repeat(200) }, 'instructions.too_long'],
      [{ persona: MARKER.repeat(40) }, 'persona.too_long'],
    ]
    for (const [override, rule] of cases) {
      const error = await failure(client.request('saveAgent', { ...fields, ...override }))
      expect(error.code, rule).toBe('AGENT_INVALID')
      expect(error.problems, rule).toEqual([expect.stringMatching(new RegExp(`^${rule.replace('.', '\\.')}: `))])
    }
    expect((await client.request('listAgents', {})).agents).toHaveLength(1)
  })

  it('lists every field that is wrong in one answer', async () => {
    const { client } = await start()
    const error = await failure(client.request('saveAgent', { name: '', description: 'a\nb', persona: '', instructions: 'x'.repeat(3001) }))
    expect(error.code).toBe('AGENT_INVALID')
    expect(error.problems).toHaveLength(3)
  })

  it('answers AGENT_DUPLICATE for a copy of a name and AGENT_FULL for the 13th agent', async () => {
    const { client } = await start()
    const first = (await client.request('saveAgent', { ...fields, name: 'Same name' })).agent
    expect((await failure(client.request('saveAgent', { ...fields, name: 'SAME   name' }))).code).toBe('AGENT_DUPLICATE')
    const other = (await client.request('saveAgent', { ...fields, name: 'other' })).agent
    expect((await failure(client.request('saveAgent', { ...fields, id: other.id, name: 'same NAME' }))).code).toBe('AGENT_DUPLICATE')
    for (let index = 2; index < AGENT_MAX_ITEMS; index++) await client.request('saveAgent', { ...fields, name: `agent ${index}` })
    expect((await failure(client.request('saveAgent', { ...fields, name: 'one too many' }))).code).toBe('AGENT_FULL')
    expect((await client.request('listAgents', {})).agents).toHaveLength(AGENT_MAX_ITEMS + 1)
    expect((await client.request('saveAgent', { ...fields, id: first.id, name: 'edited while full' })).agent.name).toBe('edited while full')
  })

  it('answers AGENT_NOT_FOUND for an edit or an activation of an unknown id', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveAgent', { ...fields, id: 'missing' }))).code).toBe('AGENT_NOT_FOUND')
    expect((await failure(client.request('setActiveAgent', { id: 'missing' }))).code).toBe('AGENT_NOT_FOUND')
  })

  it('answers AGENT_BUILTIN for a save over or a delete of the built-in agent', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveAgent', { ...fields, id: 'default' }))).code).toBe('AGENT_BUILTIN')
    expect((await failure(client.request('deleteAgent', { id: 'default' }))).code).toBe('AGENT_BUILTIN')
    expect(await client.request('setActiveAgent', { id: 'default' })).toEqual({})
  })

  it('answers INVALID_PARAMS for a bad request shape and for an absurd payload', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveAgent', { ...fields, extra: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveAgent', { name: 'x' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveAgent', { ...fields, kind: 'chat' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveAgent', { ...fields, skillIds: 'none' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('deleteAgent', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('setActiveAgent', { id: '' }))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listAgents', { limit: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveAgent', { ...fields, instructions: 'x'.repeat(100_000) }))).code).toBe('INVALID_PARAMS')
  })

  it('never echoes the agent text in an error response or in a log line', async () => {
    const { client, frames, logs } = await start()
    await client.request('saveAgent', { ...fields, name: `${MARKER} first`, persona: `${MARKER} persona`, instructions: `${MARKER} instructions` })
    const attempts: Array<() => Promise<unknown>> = [
      () => client.request('saveAgent', { ...fields, name: `${MARKER}\nsecond` }),
      () => client.request('saveAgent', { ...fields, persona: `${MARKER}\u202e` }),
      () => client.request('saveAgent', { ...fields, instructions: MARKER.repeat(500) }),
      () => client.request('saveAgent', { ...fields, instructions: MARKER.repeat(20_000) }),
      () => client.request('saveAgent', { ...fields, name: `${MARKER.toLowerCase()}   FIRST` }),
      () => client.request('saveAgent', { ...fields, id: 'missing', name: `${MARKER} edit` }),
      () => client.request('saveAgent', { ...fields, name: `${MARKER} extra`, extra: 1 } as never),
      () => client.request('saveAgent', { ...fields, id: 'default', name: MARKER }),
    ]
    for (const attempt of attempts) await failure(attempt())
    const errorFrames = frames.filter((frame) => frame.includes('"ok":false'))
    expect(errorFrames).toHaveLength(attempts.length)
    expect(errorFrames.join('\n')).not.toContain(MARKER)
    expect(errorFrames.join('\n').toLowerCase()).not.toContain(MARKER.toLowerCase())
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it('logs only the error name when saveAgent fails unexpectedly', async () => {
    const fail = () => {
      throw new TypeError(`broke on ${MARKER}`)
    }
    const engine = { on: () => () => undefined, saveAgent: fail } as unknown as Engine
    const { client, frames, logs } = await start(engine)
    expect(await failure(client.request('saveAgent', { ...fields, name: MARKER }))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(logs.map((line) => JSON.parse(line))).toEqual([{ type: 'error', method: 'saveAgent', name: 'TypeError' }])
    expect(frames.filter((frame) => frame.includes('"ok":false')).join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it('lists the agent codes in ERROR_CODES', () => {
    for (const code of ['AGENT_INVALID', 'AGENT_FULL', 'AGENT_DUPLICATE', 'AGENT_NOT_FOUND', 'AGENT_BUILTIN']) expect(ERROR_CODES as readonly string[]).toContain(code)
  })
})
