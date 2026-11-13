import { createCoreRegistry } from '@rill/nodes-core'
import { RULE_MAX_INPUT_CHARS, RULE_MAX_ITEMS, RillClient, RillError } from '@rill/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'

const TOKEN = 'rules-token-0123456789abcdef'
const MARKER = 'rule-marker-c41d'

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
    socketFactory: (target, protocols) => {
      const socket = new WebSocket(target, protocols)
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

describe('rule methods over the websocket, with no model provider', () => {
  it('lists nothing at first, then saves, lists and deletes', async () => {
    const { client } = await start()
    expect(await client.request('listRules', {})).toEqual({ rules: [] })

    const host = (await client.request('saveRule', { kind: 'allowHost', value: ' API.example.com ' })).rule
    expect(host).toMatchObject({ kind: 'allowHost', value: 'api.example.com' })
    const node = (await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })).rule
    expect((await client.request('listRules', {})).rules).toEqual([host, node])

    expect(await client.request('deleteRule', { id: host.id })).toEqual({ deleted: true })
    expect((await client.request('listRules', {})).rules).toEqual([node])
  })

  it('replaces the effort cap when it is saved again', async () => {
    const { client } = await start()
    const first = (await client.request('saveRule', { kind: 'maxPlanEffort', value: 'high' })).rule
    const second = (await client.request('saveRule', { kind: 'maxPlanEffort', value: 'low' })).rule
    expect(second.id).toBe(first.id)
    expect((await client.request('listRules', {})).rules).toEqual([second])
  })

  it('is not blocked by a missing model: plan says LLM_UNAVAILABLE while rules work', async () => {
    const { client } = await start()
    const planned = await failure(client.request('plan', { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low' }))
    expect(planned.code).toBe('LLM_UNAVAILABLE')
    expect((await client.request('saveRule', { kind: 'forbidNode', value: 'notify.slack' })).rule.value).toBe('notify.slack')
  })

  it('answers RULE_INVALID with the rule that failed, for each kind of bad value', async () => {
    const { client } = await start()
    const cases: Array<['forbidNode' | 'allowHost' | 'maxPlanEffort', string, string]> = [
      ['allowHost', '', 'empty'],
      ['allowHost', `${MARKER}\n.com`, 'control_character'],
      ['allowHost', `${MARKER}‮.com`, 'bidi_format'],
      ['allowHost', `https://${MARKER}.com`, 'host_scheme'],
      ['allowHost', `${MARKER}.com/path`, 'host_path'],
      ['allowHost', `${MARKER}.com:81`, 'host_port'],
      ['allowHost', `me@${MARKER}.com`, 'host_user_info'],
      ['allowHost', `*.*.${MARKER}.com`, 'host_wildcard'],
      ['forbidNode', MARKER, 'unknown_node_type'],
      ['maxPlanEffort', MARKER, 'unknown_effort'],
    ]
    for (const [kind, value, rule] of cases) {
      const error = await failure(client.request('saveRule', { kind, value }))
      expect(error.code, rule).toBe('RULE_INVALID')
      expect(error.problems, rule).toEqual([expect.stringContaining(rule)])
    }
    expect((await client.request('listRules', {})).rules).toEqual([])
  })

  it('answers RULE_DUPLICATE for a copy and RULE_FULL for the 31st rule', async () => {
    const { client } = await start()
    await client.request('saveRule', { kind: 'allowHost', value: 'a.example.com' })
    expect((await failure(client.request('saveRule', { kind: 'allowHost', value: 'A.EXAMPLE.COM' }))).code).toBe('RULE_DUPLICATE')
    for (let index = 1; index < RULE_MAX_ITEMS; index++) await client.request('saveRule', { kind: 'allowHost', value: `h${index}.example.com` })
    expect((await failure(client.request('saveRule', { kind: 'allowHost', value: 'one-too-many.example.com' }))).code).toBe('RULE_FULL')
    expect((await client.request('listRules', {})).rules).toHaveLength(RULE_MAX_ITEMS)
  })

  it('answers RULE_NOT_FOUND for a delete of an unknown id', async () => {
    const { client } = await start()
    expect((await failure(client.request('deleteRule', { id: 'missing' }))).code).toBe('RULE_NOT_FOUND')
  })

  it('answers INVALID_PARAMS for a bad request shape and for an absurd payload', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveRule', { kind: 'allowHost', value: 'a.com', extra: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveRule', { kind: 'allowHost' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveRule', { kind: 'other', value: 'a.com' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('deleteRule', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listRules', { limit: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveRule', { kind: 'allowHost', value: 'x'.repeat(RULE_MAX_INPUT_CHARS + 1) }))).code).toBe('INVALID_PARAMS')
  })

  it('never echoes the value in an error response or in a log line', async () => {
    const { client, frames, logs } = await start()
    await client.request('saveRule', { kind: 'allowHost', value: `${MARKER}.example.com` })
    const attempts: Array<() => Promise<unknown>> = [
      () => client.request('saveRule', { kind: 'allowHost', value: `${MARKER}\n.example.com` }),
      () => client.request('saveRule', { kind: 'allowHost', value: `https://${MARKER}.example.com` }),
      () => client.request('saveRule', { kind: 'allowHost', value: `${MARKER.toUpperCase()}.EXAMPLE.COM` }),
      () => client.request('saveRule', { kind: 'allowHost', value: MARKER.repeat(RULE_MAX_INPUT_CHARS) }),
      () => client.request('saveRule', { kind: 'forbidNode', value: MARKER }),
      () => client.request('saveRule', { kind: 'maxPlanEffort', value: MARKER }),
      () => client.request('saveRule', { kind: 'allowHost', value: `${MARKER}.example.com`, extra: 1 } as never),
      () => client.request('deleteRule', { id: MARKER }),
    ]
    for (const attempt of attempts) await failure(attempt())
    const errorFrames = frames.filter((frame) => frame.includes('"ok":false'))
    expect(errorFrames).toHaveLength(attempts.length)
    expect(errorFrames.join('\n').toLowerCase()).not.toContain(MARKER)
    expect(logs.join('\n').toLowerCase()).not.toContain(MARKER)
  })

  it('logs only the error name when saveRule or deleteRule fails unexpectedly', async () => {
    const fail = () => {
      throw new TypeError(`broke on ${MARKER}`)
    }
    const engine = { on: () => () => undefined, saveRule: fail, deleteRule: fail } as unknown as Engine
    const { client, frames, logs } = await start(engine)
    expect(await failure(client.request('saveRule', { kind: 'allowHost', value: `${MARKER}.com` }))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(await failure(client.request('deleteRule', { id: MARKER }))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', method: 'saveRule', name: 'TypeError' },
      { type: 'error', method: 'deleteRule', name: 'TypeError' },
    ])
    expect(frames.filter((frame) => frame.includes('"ok":false')).join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it('does not write rule values to the log when the rules are listed or saved normally', async () => {
    const { client, logs } = await start()
    await client.request('saveRule', { kind: 'allowHost', value: `${MARKER}.example.com` })
    await client.request('listRules', {})
    expect(logs).toEqual([])
  })
})
