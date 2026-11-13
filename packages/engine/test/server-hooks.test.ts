import { HOOK_MAX_ITEMS, RillClient, RillError, type HookInput } from '@rill/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'
import { echoWorkflow, openEngine } from './hook-helpers'

const TOKEN = 'hooks-token-0123456789abcdef'
const MARKER = 'HOOK-MARKER-8e41'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(engine?: Engine) {
  const logs: string[] = []
  const real = engine ?? openEngine().engine
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

const record: HookInput = { event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true }
const notify = (connection: string, channel?: string): HookInput => ({ ...record, action: { type: 'notify', connection, ...(channel === undefined ? {} : { channel }) } })

describe('hook methods over the websocket, with no model provider', () => {
  it('lists, saves, edits, lists the log and deletes', async () => {
    const { client, engine } = await start()
    expect(await client.request('listHooks', {})).toEqual({ hooks: [] })
    const workflowId = engine.deploy(echoWorkflow('w'))
    const one = (await client.request('saveHook', { ...notify('team-slack', '#ops'), scope: { type: 'workflow', workflowId } })).hook
    const two = (await client.request('saveHook', { ...record, event: 'plan.deployed' })).hook
    expect(one).toMatchObject({ event: 'run.failed', scope: { type: 'workflow', workflowId }, action: { type: 'notify', connection: 'team-slack', channel: '#ops' }, enabled: true })
    expect((await client.request('listHooks', {})).hooks.map((hook) => hook.id)).toEqual([one.id, two.id])

    const edited = (await client.request('saveHook', { ...record, event: 'run.succeeded', enabled: false, id: two.id })).hook
    expect(edited).toMatchObject({ id: two.id, createdAt: two.createdAt, event: 'run.succeeded', enabled: false })

    engine.store.appendHookLog({ hookId: one.id, at: 5, event: 'run.failed', workflowId, outcome: 'ok', code: null })
    engine.store.appendHookLog({ hookId: two.id, at: 6, event: 'run.succeeded', workflowId, outcome: 'failed', code: 'timeout' })
    expect((await client.request('listHookLog', {})).entries.map((entry) => entry.at)).toEqual([6, 5])
    expect((await client.request('listHookLog', { hookId: one.id })).entries.map((entry) => entry.at)).toEqual([5])
    expect((await client.request('listHookLog', { limit: 1 })).entries).toHaveLength(1)

    expect(await client.request('deleteHook', { id: two.id })).toEqual({ deleted: true })
    expect(await client.request('deleteHook', { id: two.id })).toEqual({ deleted: false })
    expect((await client.request('listHooks', {})).hooks.map((hook) => hook.id)).toEqual([one.id])
    expect((await client.request('listHookLog', { hookId: two.id })).entries).toHaveLength(1)
  })

  it('is not blocked by a missing model', async () => {
    const { client } = await start()
    expect((await failure(client.request('plan', { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low' }))).code).toBe('LLM_UNAVAILABLE')
    expect((await client.request('saveHook', record)).hook.action).toEqual({ type: 'record' })
  })

  it('answers HOOK_INVALID with the field and the rule that failed, for each kind of bad hook', async () => {
    const { client, engine } = await start()
    engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' })
    const cases: Array<[HookInput, string]> = [
      [{ ...record, scope: { type: 'workflow', workflowId: 'missing' } }, 'scope.unknown_workflow'],
      [notify(''), 'connection.empty'],
      [notify(`one\n${MARKER}`), 'connection.control_character'],
      [notify(`one\u202e${MARKER}`), 'connection.bidi_format'],
      [notify(`one\u200b${MARKER}`), 'connection.format_character'],
      [notify(MARKER.repeat(10)), 'connection.too_long'],
      [notify('api'), 'connection.not_slack_connection'],
      [notify('nobody'), 'connection.unknown_connection'],
      [{ ...notify('team-slack'), action: { type: 'notify', connection: 'team-slack', channel: `#a ${MARKER}` } }, 'channel.whitespace'],
      [{ ...record, event: 'run.succeeded', action: { type: 'deactivateAfterFailures', count: 3 } }, 'action.only_for_run_failed'],
      [{ ...record, action: { type: 'deactivateAfterFailures', count: 1 } }, 'count.out_of_range'],
      [{ ...record, action: { type: 'deactivateAfterFailures', count: 9999 } }, 'count.out_of_range'],
      [notify('team-slack'), 'action.forbidden_by_rule'],
    ]
    for (const [input, rule] of cases) {
      const error = await failure(client.request('saveHook', input))
      expect(error.code, rule).toBe('HOOK_INVALID')
      expect(error.problems, rule).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${rule.replace('.', '\\.')}: `))]))
    }
    expect((await client.request('listHooks', {})).hooks).toEqual([])
  })

  it('answers HOOK_INVALID for a duplicate, HOOK_FULL for the 21st hook and HOOK_NOT_FOUND for an edit of an unknown id', async () => {
    const { client } = await start()
    await client.request('saveHook', record)
    const duplicate = await failure(client.request('saveHook', record))
    expect(duplicate.code).toBe('HOOK_INVALID')
    expect(duplicate.problems).toEqual([expect.stringMatching(/^hook\.duplicate: /)])
    for (let index = 1; index < HOOK_MAX_ITEMS; index++) await client.request('saveHook', notify('team-slack', `#c${index}`))
    expect((await failure(client.request('saveHook', notify('team-slack', '#one-too-many')))).code).toBe('HOOK_FULL')
    expect((await client.request('listHooks', {})).hooks).toHaveLength(HOOK_MAX_ITEMS)
    expect((await failure(client.request('saveHook', { ...record, id: 'missing' }))).code).toBe('HOOK_NOT_FOUND')
  })

  it('answers INVALID_PARAMS for a bad request shape and for an absurd payload', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveHook', { ...record, extra: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { event: 'run.failed' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { ...record, event: 'run.started' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { ...record, action: { type: 'startRun', workflowId: 'w' } } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { ...record, action: { type: 'record', text: 'free text' } } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { ...record, action: { type: 'notify', connection: 'team-slack', text: 'my own message' } } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { ...record, scope: 'all' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', { ...record, action: { type: 'deactivateAfterFailures', count: 2.5 } }))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveHook', notify('x'.repeat(100_000))))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('deleteHook', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listHooks', { limit: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listHookLog', { limit: 201 }))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listHookLog', { limit: 0 }))).code).toBe('INVALID_PARAMS')
  })

  it('never echoes a hook value in an error response or in a log line', async () => {
    const { client, frames, logs } = await start()
    const attempts: Array<() => Promise<unknown>> = [
      () => client.request('saveHook', notify(`${MARKER}\nname`)),
      () => client.request('saveHook', notify(`${MARKER} unknown`)),
      () => client.request('saveHook', notify('team-slack', `#${MARKER} x`)),
      () => client.request('saveHook', { ...record, scope: { type: 'workflow', workflowId: MARKER } }),
      () => client.request('saveHook', { ...record, id: MARKER }),
      () => client.request('saveHook', notify(MARKER.repeat(5000))),
      () => client.request('saveHook', { ...record, extra: MARKER } as never),
      () => client.request('saveHook', { ...record, action: { type: 'record', text: MARKER } } as never),
    ]
    for (const attempt of attempts) await failure(attempt())
    const errorFrames = frames.filter((frame) => frame.includes('"ok":false'))
    expect(errorFrames).toHaveLength(attempts.length)
    expect(errorFrames.join('\n')).not.toContain(MARKER)
    expect(errorFrames.join('\n').toLowerCase()).not.toContain(MARKER.toLowerCase())
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it.each(['saveHook', 'deleteHook', 'listHooks', 'listHookLog'] as const)('logs only the error name when %s fails unexpectedly', async (method) => {
    const fail = () => {
      throw new TypeError(`broke on ${MARKER}`)
    }
    const engine = { on: () => () => undefined, saveHook: fail, deleteHook: fail, listHooks: fail, listHookLog: fail } as unknown as Engine
    const { client, frames, logs } = await start(engine)
    const params = { saveHook: { ...record, id: MARKER }, deleteHook: { id: MARKER }, listHooks: {}, listHookLog: { hookId: MARKER } }[method]
    expect(await failure(client.request(method, params as never))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(logs.map((line) => JSON.parse(line))).toEqual([{ type: 'error', method, name: 'TypeError' }])
    expect(frames.filter((frame) => frame.includes('"ok":false')).join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })
})
