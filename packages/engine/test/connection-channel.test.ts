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
