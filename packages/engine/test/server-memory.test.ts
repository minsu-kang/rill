import { createCoreRegistry } from '@rill/nodes-core'
import { MEMORY_MAX_CHARS, MEMORY_MAX_INPUT_CHARS, MEMORY_MAX_ITEMS, RillClient, RillError } from '@rill/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'

const TOKEN = 'memory-token-0123456789abcdef'
const MARKER = 'NOTE-MARKER-c41d'

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

describe('memory methods over the websocket, with no model provider', () => {
  it('lists nothing at first, then saves, edits, lists and deletes', async () => {
    const { client } = await start()
    expect(await client.request('listMemory', {})).toEqual({ items: [] })

    const first = (await client.request('saveMemory', { text: '  My receipts   live in ~/Receipts ' })).item
    expect(first.text).toBe('My receipts live in ~/Receipts')
    const second = (await client.request('saveMemory', { text: 'Alerts go to the connection team-alerts' })).item
    expect((await client.request('listMemory', {})).items).toEqual([first, second])

    const edited = (await client.request('saveMemory', { id: first.id, text: 'My receipts live in ~/Documents/Receipts' })).item
    expect(edited).toMatchObject({ id: first.id, createdAt: first.createdAt, text: 'My receipts live in ~/Documents/Receipts' })
    expect((await client.request('listMemory', {})).items.map((item) => item.id)).toEqual([first.id, second.id])

    expect(await client.request('deleteMemory', { id: first.id })).toEqual({ deleted: true })
    expect(await client.request('deleteMemory', { id: first.id })).toEqual({ deleted: false })
    expect((await client.request('listMemory', {})).items.map((item) => item.id)).toEqual([second.id])
  })

  it('is not blocked by a missing model: plan says LLM_UNAVAILABLE while memory works', async () => {
    const { client } = await start()
    const planned = await failure(client.request('plan', { planId: 'p1', text: 'wait', turns: [], attachments: [], effort: 'low' }))
    expect(planned.code).toBe('LLM_UNAVAILABLE')
    expect((await client.request('saveMemory', { text: 'still works' })).item.text).toBe('still works')
  })

  it('answers MEMORY_INVALID with the rule that failed, for each kind of bad note', async () => {
    const { client } = await start()
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'empty'],
      [`one\n${MARKER}`, 'control_character'],
      [`one\t${MARKER}`, 'control_character'],
      [`one\u2028${MARKER}`, 'line_separator'],
      [`one\u202e${MARKER}`, 'bidi_format'],
      [MARKER.repeat(40), 'too_long'],
    ]
    for (const [text, rule] of cases) {
      const error = await failure(client.request('saveMemory', { text }))
      expect(error.code, rule).toBe('MEMORY_INVALID')
      expect(error.problems, rule).toEqual([expect.stringContaining(rule)])
    }
    expect((await client.request('listMemory', {})).items).toEqual([])
  })

  it('answers MEMORY_DUPLICATE for a copy and MEMORY_FULL for the 21st note', async () => {
    const { client } = await start()
    const first = (await client.request('saveMemory', { text: 'Receipts live in ~/Receipts' })).item
    expect((await failure(client.request('saveMemory', { text: 'RECEIPTS live in ~/receipts' }))).code).toBe('MEMORY_DUPLICATE')
    const other = (await client.request('saveMemory', { text: 'something else' })).item
    expect((await failure(client.request('saveMemory', { id: other.id, text: 'receipts   LIVE in ~/Receipts' }))).code).toBe('MEMORY_DUPLICATE')
    for (let index = 2; index < MEMORY_MAX_ITEMS; index++) await client.request('saveMemory', { text: `note ${index}` })
    expect((await failure(client.request('saveMemory', { text: 'one too many' }))).code).toBe('MEMORY_FULL')
    expect((await client.request('listMemory', {})).items).toHaveLength(MEMORY_MAX_ITEMS)
    expect((await client.request('saveMemory', { id: first.id, text: 'edited while full' })).item.text).toBe('edited while full')
  })

  it('answers NOT_FOUND for an edit of an unknown id', async () => {
    const { client } = await start()
    const error = await failure(client.request('saveMemory', { id: 'missing', text: 'text' }))
    expect(error.code).toBe('NOT_FOUND')
  })

  it('answers INVALID_PARAMS for a bad request shape and for an absurd payload', async () => {
    const { client } = await start()
    expect((await failure(client.request('saveMemory', { text: 'x', extra: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveMemory', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('deleteMemory', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('listMemory', { limit: 1 } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(client.request('saveMemory', { text: 'x'.repeat(MEMORY_MAX_INPUT_CHARS + 1) }))).code).toBe('INVALID_PARAMS')
  })

  it('never echoes the note in an error response or in a log line', async () => {
    const { client, frames, logs } = await start()
    await client.request('saveMemory', { text: `${MARKER} first` })
    const attempts: Array<() => Promise<unknown>> = [
      () => client.request('saveMemory', { text: `${MARKER}\nsecond` }),
      () => client.request('saveMemory', { text: `${MARKER}\u202e` }),
      () => client.request('saveMemory', { text: MARKER.repeat(MEMORY_MAX_CHARS) }),
      () => client.request('saveMemory', { text: MARKER.repeat(MEMORY_MAX_INPUT_CHARS) }),
      () => client.request('saveMemory', { text: `${MARKER.toLowerCase()}   FIRST` }),
      () => client.request('saveMemory', { id: 'missing', text: `${MARKER} edit` }),
      () => client.request('saveMemory', { text: `${MARKER} extra`, extra: 1 } as never),
    ]
    for (const attempt of attempts) await failure(attempt())
    const errorFrames = frames.filter((frame) => frame.includes('"ok":false'))
    expect(errorFrames).toHaveLength(attempts.length)
    expect(errorFrames.join('\n')).not.toContain(MARKER)
    expect(errorFrames.join('\n').toLowerCase()).not.toContain(MARKER.toLowerCase())
    expect(logs.join('\n')).not.toContain(MARKER)
  })

  it('logs only the error name when saveMemory fails unexpectedly', async () => {
    const fail = () => {
      throw new TypeError(`broke on ${MARKER}`)
    }
    const engine = { on: () => () => undefined, saveMemory: fail } as unknown as Engine
    const { client, frames, logs } = await start(engine)
    expect(await failure(client.request('saveMemory', { text: MARKER }))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(logs.map((line) => JSON.parse(line))).toEqual([{ type: 'error', method: 'saveMemory', name: 'TypeError' }])
    expect(frames.filter((frame) => frame.includes('"ok":false')).join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })
})
