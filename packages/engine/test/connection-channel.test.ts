import { EventEmitter } from 'node:events'
import type { Workflow } from '@rill/dsl'
import { createCoreRegistry } from '@rill/nodes-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseConnections } from '../src/cli-config'
import { MAX_CHANNEL_SECRET, attachConnectionChannel, parseConnectionMessage, type ParentPortLike } from '../src/connection-channel'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { connectionSecrets } from '../src/explain'
import { linearWorkflow } from './helpers'
import { ScriptedProvider, planInput, workflowReply } from './plan-helpers'

const GOOGLE_TOKEN = 'ya29.TOKENMARKER0123456789'
const GOOGLE_TOKEN_2 = 'ya29.SECONDMARKER9876543210'
const MICROSOFT_TOKEN = 'eyJTOKENMARKER0123456789.payload.sig'
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const trigger = { id: 't1', type: 'trigger.manual@1' }

class FakeParentPort extends EventEmitter implements ParentPortLike {
  post(data: unknown): void {
    this.emit('message', { data, ports: [] })
  }
}

function setup(table = '{}') {
  const loaded = parseConnections(table)
  const port = new FakeParentPort()
  const channel = attachConnectionChannel(port, loaded.table)
  return { loaded, port, channel }
}

const engines: Engine[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const engine of engines.splice(0)) await engine.shutdown()
})

describe('parseConnectionMessage', () => {
  it('accepts connection.set for google and microsoft', () => {
    expect(parseConnectionMessage({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })).toEqual({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    expect(parseConnectionMessage({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_TOKEN })).toEqual({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_TOKEN })
  })

  it('accepts connection.remove for both names', () => {
    expect(parseConnectionMessage({ type: 'connection.remove', name: 'google' })).toEqual({ type: 'connection.remove', name: 'google' })
    expect(parseConnectionMessage({ type: 'connection.remove', name: 'microsoft' })).toEqual({ type: 'connection.remove', name: 'microsoft' })
  })

  it('accepts a secret of exactly the maximum length and refuses one character more', () => {
    expect(parseConnectionMessage({ type: 'connection.set', name: 'google', kind: 'google', secret: 'a'.repeat(MAX_CHANNEL_SECRET) })).toBeDefined()
    expect(parseConnectionMessage({ type: 'connection.set', name: 'google', kind: 'google', secret: 'a'.repeat(MAX_CHANNEL_SECRET + 1) })).toBeUndefined()
  })

  it('ignores every other shape', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'connection.set',
      5,
      [],
      {},
      { type: 'connection.set' },
      { type: 'connection.set', name: 'slack', kind: 'google', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'google', kind: 'slack', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'google', kind: 'http', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'Google', kind: 'google', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'sheets', kind: 'google', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'google', kind: 'microsoft', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'microsoft', kind: 'google', secret: GOOGLE_TOKEN },
      { type: 'connection.set', name: 'google', kind: 'google', secret: '' },
      { type: 'connection.set', name: 'google', kind: 'google', secret: 5 },
      { type: 'connection.set', name: 'google', kind: 'google', secret: null },
      { type: 'connection.set', name: 'google', kind: 'google' },
      { type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN, extra: 1 },
      { type: 'connection.set', name: 'google', secret: GOOGLE_TOKEN },
      { type: 'connection.remove' },
      { type: 'connection.remove', name: 'slack' },
      { type: 'connection.remove', name: 'sheets' },
      { type: 'connection.remove', name: 'google', kind: 'google' },
      { type: 'connection.remove', name: ['google'] },
      { type: 'connection.clear', name: 'google' },
      { type: 5, name: 'google' },
    ]
    for (const message of bad) expect(parseConnectionMessage(message), JSON.stringify(message)).toBeUndefined()
  })

  it('ignores an object that inherits the fields from its prototype', () => {
    const inherited = Object.create({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    expect(parseConnectionMessage(inherited)).toBeUndefined()
  })
})

describe('attachConnectionChannel', () => {
  it('does nothing without a parent port', () => {
    const loaded = parseConnections('{}')
    const channel = attachConnectionChannel(undefined, loaded.table)
    expect(channel.ignored()).toBe(0)
    expect(loaded.resolver.get('google')).toBeUndefined()
  })

  it('stores the secret and the kind for the next read and lists the connection for the planner', () => {
    const { loaded, port } = setup()
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    expect(loaded.resolver.get('google')).toBe(GOOGLE_TOKEN)
    expect(loaded.resolver.kindOf?.('google')).toBe('google')
    expect(loaded.planConnections).toEqual([{ name: 'google', kind: 'google' }])
    port.post({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_TOKEN })
    expect(loaded.planConnections).toEqual([
      { name: 'google', kind: 'google' },
      { name: 'microsoft', kind: 'microsoft' },
    ])
  })

  it('replaces the secret of a connection that exists without listing it twice', () => {
    const { loaded, port } = setup()
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(loaded.resolver.get('google')).toBe(GOOGLE_TOKEN_2)
    expect(loaded.planConnections).toEqual([{ name: 'google', kind: 'google' }])
  })

  it('removes the connection and its listing, and ignores a remove for a connection that is not there', () => {
    const { loaded, port, channel } = setup()
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    port.post({ type: 'connection.remove', name: 'google' })
    expect(loaded.resolver.get('google')).toBeUndefined()
    expect(loaded.resolver.kindOf?.('google')).toBeUndefined()
    expect(loaded.planConnections).toEqual([])
    port.post({ type: 'connection.remove', name: 'microsoft' })
    expect(channel.ignored()).toBe(0)
  })

  it('counts every ignored message and changes nothing for it', () => {
    const { loaded, port, channel } = setup(JSON.stringify({ team: { secret: 'https://hooks.example.test/x', kind: 'slack' } }))
    const before = JSON.stringify(loaded.planConnections)
    for (const message of [null, 'x', { type: 'connection.set', name: 'google', kind: 'slack', secret: 'x'.repeat(10) }, { type: 'connection.set', name: 'google', kind: 'google', secret: 'a'.repeat(MAX_CHANNEL_SECRET + 1) }, { type: 'connection.set', name: 'team', kind: 'slack', secret: 'y' }, { type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN, extra: true }]) {
      port.post(message)
    }
    expect(channel.ignored()).toBe(6)
    expect(loaded.resolver.get('google')).toBeUndefined()
    expect(loaded.resolver.get('team')).toBe('https://hooks.example.test/x')
    expect(JSON.stringify(loaded.planConnections)).toBe(before)
  })

  it('survives an event that has no data', () => {
    const { port, channel } = setup()
    port.emit('message', undefined)
    port.emit('message', {})
    port.emit('message', null)
    expect(channel.ignored()).toBe(3)
  })

  it('keeps the entries that came from the environment or the file', () => {
    const { loaded, port } = setup(JSON.stringify({ api: { secret: 'plain-api-key', kind: 'http' }, bare: 'plain' }))
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    port.post({ type: 'connection.remove', name: 'google' })
    expect(loaded.resolver.get('api')).toBe('plain-api-key')
    expect(loaded.resolver.get('bare')).toBe('plain')
    expect(loaded.planConnections).toEqual([{ name: 'api', kind: 'http' }])
  })

  it('leaves an entry of another kind that has the same name alone and counts the message', () => {
    const { loaded, port, channel } = setup(JSON.stringify({ google: { secret: 'plain-api-key', kind: 'http' }, microsoft: 'bare-secret' }))
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    port.post({ type: 'connection.remove', name: 'google' })
    port.post({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_TOKEN })
    port.post({ type: 'connection.remove', name: 'microsoft' })
    expect(channel.ignored()).toBe(4)
    expect(loaded.resolver.get('google')).toBe('plain-api-key')
    expect(loaded.resolver.kindOf?.('google')).toBe('http')
    expect(loaded.resolver.get('microsoft')).toBe('bare-secret')
    expect(loaded.planConnections).toEqual([{ name: 'google', kind: 'http' }])
  })

  it('lets a table that the environment seeded with a google entry take a newer token from the channel', () => {
    const { loaded, port } = setup(JSON.stringify({ google: { secret: GOOGLE_TOKEN, kind: 'google' } }))
    expect(loaded.planConnections).toEqual([{ name: 'google', kind: 'google' }])
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(loaded.resolver.get('google')).toBe(GOOGLE_TOKEN_2)
    expect(loaded.planConnections).toEqual([{ name: 'google', kind: 'google' }])
  })
})

describe('a node after the channel changed the connection', () => {
  function engineFor(loaded: ReturnType<typeof parseConnections>) {
    return new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), sleep: async () => {}, random: () => 1, connections: loaded.resolver, planConnections: loaded.planConnections })
  }

  const workflow = linearWorkflow([trigger, { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'google', spreadsheetId: SHEET, values: ['a'] } }])

  it('reads the new secret at call time, and fails with unknown connection after a remove', async () => {
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'))
      return new Response(JSON.stringify({ updates: { updatedRange: 'Sheet1!A1' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { loaded, port } = setup()
    const engine = engineFor(loaded)
    const id = engine.deploy(workflow)

    const before = await engine.startRun(id)
    expect(before.status).toBe('failed')
    expect(before.error).toBe('node n1 failed: unknown connection: google')

    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    expect((await engine.startRun(id)).status).toBe('succeeded')
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect((await engine.startRun(id)).status).toBe('succeeded')
    expect(seen).toEqual([`Bearer ${GOOGLE_TOKEN}`, `Bearer ${GOOGLE_TOKEN_2}`])

    port.post({ type: 'connection.remove', name: 'google' })
    const after = await engine.startRun(id)
    expect(after.status).toBe('failed')
    expect(after.error).toBe('node n1 failed: unknown connection: google')
    expect(seen).toHaveLength(2)
  })

  it('keeps the kind on the entry, so a plain http.request that names it is still refused', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    const { loaded, port } = setup()
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    const engine = engineFor(loaded)
    const id = engine.deploy(linearWorkflow([trigger, { id: 'n1', type: 'http.request@1', config: { url: 'https://collect.example.test/ingest', auth: { connection: 'google' } } }]))
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('node n1 failed: connection google is a Google connection')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lets the planner see a connection that only the channel set, and never shows it the token', async () => {
    const reply = workflowReply({
      schemaVersion: 1,
      name: 'sheet',
      nodes: [
        { id: 't1', type: 'trigger.manual@1', config: {} },
        { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'google', spreadsheetId: SHEET, values: ['a'] } },
      ],
      edges: [{ from: 't1', to: 'n1' }],
    })
    const plan = async (set: boolean) => {
      const { loaded, port } = setup()
      if (set) port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
      const provider = new ScriptedProvider([{ data: reply }])
      const engine = new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), llm: provider, connections: loaded.resolver, planConnections: loaded.planConnections })
      engines.push(engine)
      const outcome = await engine.plan(planInput())
      return { kind: outcome.result.kind, requests: JSON.stringify(provider.requests) }
    }
    expect((await plan(false)).kind).toBe('questions')
    const connected = await plan(true)
    expect(connected.kind).toBe('workflow')
    expect(connected.requests).toContain('connections\\":[{\\"name\\":\\"google\\",\\"kind\\":\\"google\\"}]')
    expect(connected.requests).not.toContain('TOKENMARKER')
  })
})

function flow(node: Workflow['nodes'][number]): Workflow {
  return { schemaVersion: 1, name: 'w', nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }, node], edges: [{ from: 't1', to: node.id }] }
}

describe('the failure explanation after the channel set a token', () => {
  it('hides the token of a connection that only the channel knows, even when no step names it', () => {
    const { loaded, port } = setup()
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    const workflow = flow({ id: 'n1', type: 'delay@1', config: { ms: 1 } })
    const names = loaded.planConnections.map((connection) => connection.name)
    expect(connectionSecrets(workflow, [], createCoreRegistry(), loaded.resolver, names)).toEqual([GOOGLE_TOKEN])
  })

  it('hides the token that replaced an earlier one and nothing for a removed connection', () => {
    const { loaded, port } = setup()
    const workflow = flow({ id: 'n1', type: 'google.sheets.append@1', config: { connection: 'google', spreadsheetId: SHEET, values: ['a'] } })
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(connectionSecrets(workflow, [], createCoreRegistry(), loaded.resolver)).toEqual([GOOGLE_TOKEN_2])
    port.post({ type: 'connection.remove', name: 'google' })
    expect(connectionSecrets(workflow, [], createCoreRegistry(), loaded.resolver)).toEqual([])
  })
})

class RenewPort extends FakeParentPort {
  readonly sent: unknown[] = []
  failPost = false
  reply: (() => unknown) | undefined

  postMessage(message: unknown): void {
    if (this.failPost) throw new Error(`port closed ${GOOGLE_TOKEN}`)
    this.sent.push(message)
    const reply = this.reply
    if (reply !== undefined) queueMicrotask(() => this.post(reply()))
  }
}

function renewSetup(table = '{}') {
  const loaded = parseConnections(table)
  const port = new RenewPort()
  const channel = attachConnectionChannel(port, loaded.table)
  return { loaded, port, channel, renew: (name: string) => loaded.resolver.renew!(name) }
}

const SIGNED_IN = JSON.stringify({ google: { secret: GOOGLE_TOKEN, kind: 'google' }, microsoft: { secret: MICROSOFT_TOKEN, kind: 'microsoft' } })

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('renewing an account token over the channel', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts exactly one message with the type and the name, and nothing else', async () => {
    const { port, renew } = renewSetup(SIGNED_IN)
    const pending = renew('google')
    expect(port.sent).toEqual([{ type: 'connection.renew', name: 'google' }])
    expect(Object.keys(port.sent[0] as object)).toEqual(['type', 'name'])
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(await pending).toBe(GOOGLE_TOKEN_2)
    const second = renew('microsoft')
    expect(port.sent[1]).toEqual({ type: 'connection.renew', name: 'microsoft' })
    port.post({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: 'eyJNEWMARKER0123456789.payload.sig' })
    expect(await second).toBe('eyJNEWMARKER0123456789.payload.sig')
  })

  it('answers with the secret of the next connection.set of that name, and the table already holds it', async () => {
    const { loaded, port, renew } = renewSetup(SIGNED_IN)
    const pending = renew('google')
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(loaded.resolver.get('google')).toBe(GOOGLE_TOKEN_2)
    expect(await pending).toBe(GOOGLE_TOKEN_2)
  })

  it('is single flight per name: two callers, one message, the same answer', async () => {
    const { port, renew } = renewSetup(SIGNED_IN)
    const first = renew('google')
    const second = renew('google')
    expect(port.sent).toEqual([{ type: 'connection.renew', name: 'google' }])
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(await Promise.all([first, second])).toEqual([GOOGLE_TOKEN_2, GOOGLE_TOKEN_2])
    const third = renew('google')
    expect(port.sent).toHaveLength(2)
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    expect(await third).toBe(GOOGLE_TOKEN)
  })

  it('keeps one flight per name, so google and microsoft do not wait for each other', async () => {
    const { port, renew } = renewSetup(SIGNED_IN)
    const google = renew('google')
    const microsoft = renew('microsoft')
    expect(port.sent).toEqual([
      { type: 'connection.renew', name: 'google' },
      { type: 'connection.renew', name: 'microsoft' },
    ])
    port.post({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: 'eyJNEWMARKER0123456789.payload.sig' })
    expect(await microsoft).toBe('eyJNEWMARKER0123456789.payload.sig')
    port.post({ type: 'connection.remove', name: 'google' })
    expect(await google).toBeUndefined()
  })

  it('does not answer for a connection.set of another name', async () => {
    vi.useFakeTimers()
    const { port, renew } = renewSetup(SIGNED_IN)
    let answer: string | undefined | 'pending' = 'pending'
    void renew('google').then((value) => {
      answer = value
    })
    port.post({ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: 'eyJNEWMARKER0123456789.payload.sig' })
    port.post({ type: 'connection.remove', name: 'microsoft' })
    await flush()
    expect(answer).toBe('pending')
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    await flush()
    expect(answer).toBe(GOOGLE_TOKEN_2)
  })

  it('answers undefined on a connection.remove of that name', async () => {
    const { loaded, port, renew } = renewSetup(SIGNED_IN)
    const pending = renew('google')
    port.post({ type: 'connection.remove', name: 'google' })
    expect(await pending).toBeUndefined()
    expect(loaded.resolver.get('google')).toBeUndefined()
  })

  it('does not answer for a message that was ignored', async () => {
    vi.useFakeTimers()
    const { port, channel, renew } = renewSetup(SIGNED_IN)
    let answer: string | undefined | 'pending' = 'pending'
    void renew('google').then((value) => {
      answer = value
    })
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2, extra: 1 })
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: '' })
    port.post({ type: 'connection.renew', name: 'google' })
    await flush()
    expect(answer).toBe('pending')
    expect(channel.ignored()).toBe(3)
  })

  it('gives up after 20 seconds with undefined, and asks again on the next call', async () => {
    vi.useFakeTimers()
    const { port, renew } = renewSetup(SIGNED_IN)
    let answer: string | undefined | 'pending' = 'pending'
    void renew('google').then((value) => {
      answer = value
    })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(answer).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBeUndefined()
    expect(port.sent).toHaveLength(1)
    const again = renew('google')
    expect(port.sent).toHaveLength(2)
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(await again).toBe(GOOGLE_TOKEN_2)
  })

  it('leaves no timer behind once it was answered', async () => {
    vi.useFakeTimers()
    const { port, renew } = renewSetup(SIGNED_IN)
    const answered = renew('google')
    expect(vi.getTimerCount()).toBe(1)
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    await answered
    expect(vi.getTimerCount()).toBe(0)
    const removed = renew('microsoft')
    port.post({ type: 'connection.remove', name: 'microsoft' })
    await removed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers undefined at once without a parent port, or when the port cannot post', async () => {
    const loaded = parseConnections(SIGNED_IN)
    attachConnectionChannel(undefined, loaded.table)
    expect(await loaded.resolver.renew!('google')).toBeUndefined()
    const bare = parseConnections(SIGNED_IN)
    attachConnectionChannel(new FakeParentPort(), bare.table)
    expect(await bare.resolver.renew!('google')).toBeUndefined()
    const detached = parseConnections(SIGNED_IN)
    expect(await detached.resolver.renew!('google')).toBeUndefined()
  })

  it('answers undefined when the port throws on posting, without keeping the throw or a waiter', async () => {
    vi.useFakeTimers()
    const { port, renew } = renewSetup(SIGNED_IN)
    port.failPost = true
    expect(await renew('google')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    port.failPost = false
    const again = renew('google')
    expect(port.sent).toEqual([{ type: 'connection.renew', name: 'google' }])
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(await again).toBe(GOOGLE_TOKEN_2)
  })

  it('posts nothing for a name that is not an account, a name that has no connection, or an entry of another kind', async () => {
    const { port, renew } = renewSetup(JSON.stringify({ team: { secret: 'https://hooks.example.test/x', kind: 'slack' }, bare: 'plain-secret', microsoft: { secret: 'plain-api-key', kind: 'http' } }))
    for (const name of ['team', 'bare', 'other', 'microsoft', 'google', '']) expect(await renew(name), name).toBeUndefined()
    expect(port.sent).toEqual([])
  })

  it('posts nothing for an account that the channel removed before the call', async () => {
    const { port, renew } = renewSetup(SIGNED_IN)
    port.post({ type: 'connection.remove', name: 'google' })
    expect(await renew('google')).toBeUndefined()
    expect(port.sent).toEqual([])
  })

  it('works for an account that the channel itself set', async () => {
    const { port, renew } = renewSetup()
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN })
    const pending = renew('google')
    expect(port.sent).toEqual([{ type: 'connection.renew', name: 'google' }])
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    expect(await pending).toBe(GOOGLE_TOKEN_2)
  })

  it('keeps get, kindOf and every earlier behaviour as they were', () => {
    const { loaded, port } = renewSetup(SIGNED_IN)
    expect(loaded.resolver.get('google')).toBe(GOOGLE_TOKEN)
    expect(loaded.resolver.kindOf?.('google')).toBe('google')
    expect(port.sent).toEqual([])
    expect(loaded.planConnections).toEqual([
      { name: 'google', kind: 'google' },
      { name: 'microsoft', kind: 'microsoft' },
    ])
  })

  it('keeps the token out of anything the call posts', async () => {
    const { port, renew } = renewSetup(SIGNED_IN)
    const pending = renew('google')
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    await pending
    expect(JSON.stringify(port.sent)).not.toContain('TOKENMARKER')
    expect(JSON.stringify(port.sent)).not.toContain('MARKER')
  })
})

describe('a run that is refused with a 401 while the desktop app renews the token', () => {
  const workflow = linearWorkflow([trigger, { id: 'n1', type: 'google.sheets.append@1', config: { connection: 'google', spreadsheetId: SHEET, values: ['a'] } }])

  function engineFor(loaded: ReturnType<typeof parseConnections>) {
    return new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), sleep: async () => {}, random: () => 1, connections: loaded.resolver, planConnections: loaded.planConnections })
  }

  function answerWith(port: RenewPort, reply: () => unknown) {
    port.reply = reply
  }

  function stubSheets(statuses: number[]) {
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'))
      const status = statuses[Math.min(seen.length, statuses.length) - 1]!
      return status === 200 ? new Response(JSON.stringify({ updates: { updatedRange: 'Sheet1!A1' } }), { status, headers: { 'content-type': 'application/json' } }) : new Response('expired', { status })
    })
    return seen
  }

  it('retries once with the token the app sent and succeeds', async () => {
    const seen = stubSheets([401, 200])
    const { loaded, port } = renewSetup(SIGNED_IN)
    answerWith(port, () => ({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 }))
    const engine = engineFor(loaded)
    engines.push(engine)
    const result = await engine.startRun(engine.deploy(workflow))
    expect(result.status).toBe('succeeded')
    expect(seen).toEqual([`Bearer ${GOOGLE_TOKEN}`, `Bearer ${GOOGLE_TOKEN_2}`])
    expect(port.sent).toEqual([{ type: 'connection.renew', name: 'google' }])
    expect(loaded.resolver.get('google')).toBe(GOOGLE_TOKEN_2)
  })

  it('fails with the usual 401 text when the app removes the connection', async () => {
    const seen = stubSheets([401])
    const { loaded, port } = renewSetup(SIGNED_IN)
    answerWith(port, () => ({ type: 'connection.remove', name: 'google' }))
    const engine = engineFor(loaded)
    engines.push(engine)
    const result = await engine.startRun(engine.deploy(workflow))
    expect(result.status).toBe('failed')
    expect(result.error).toBe('node n1 failed: HTTP 401: the sign-in is no longer valid, reconnect the account')
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('TOKENMARKER')
  })

  it('fails with the usual 401 text when the new token is refused too, after exactly one message', async () => {
    const seen = stubSheets([401])
    const { loaded, port } = renewSetup(SIGNED_IN)
    answerWith(port, () => ({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 }))
    const engine = engineFor(loaded)
    engines.push(engine)
    const result = await engine.startRun(engine.deploy(workflow))
    expect(result.status).toBe('failed')
    expect(result.error).toBe('node n1 failed: HTTP 401: the sign-in is no longer valid, reconnect the account')
    expect(seen).toHaveLength(2)
    expect(port.sent).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('TOKENMARKER')
  })

  it('uses the token that the app sent while the call was in flight, for the 401 that arrives later, and posts nothing', async () => {
    const seen: Array<string | null> = []
    let gate!: () => void
    const waiting = new Promise<void>((resolve) => {
      gate = resolve
    })
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization')
      seen.push(token)
      if (token !== `Bearer ${GOOGLE_TOKEN}`) return new Response(JSON.stringify({ updates: { updatedRange: 'Sheet1!A1' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      await waiting
      return new Response('expired', { status: 401 })
    })
    const { loaded, port } = renewSetup(SIGNED_IN)
    const engine = engineFor(loaded)
    engines.push(engine)
    const running = engine.startRun(engine.deploy(workflow))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    port.post({ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_TOKEN_2 })
    gate()
    const result = await running
    expect(result.status).toBe('succeeded')
    expect(seen).toEqual([`Bearer ${GOOGLE_TOKEN}`, `Bearer ${GOOGLE_TOKEN_2}`])
    expect(port.sent).toEqual([])
  })

  it('fails the same way, without renewing, when no parent port exists', async () => {
    const seen = stubSheets([401])
    const loaded = parseConnections(SIGNED_IN)
    const engine = engineFor(loaded)
    engines.push(engine)
    const result = await engine.startRun(engine.deploy(workflow))
    expect(result.status).toBe('failed')
    expect(result.error).toBe('node n1 failed: HTTP 401: the sign-in is no longer valid, reconnect the account')
    expect(seen).toHaveLength(1)
  })
})
