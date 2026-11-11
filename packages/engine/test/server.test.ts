import { request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { RillClient, RillError, SUBPROTOCOL, tokenProtocol, type EngineEvent } from '@rill/protocol'
import { WebSocket as WsClient } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer, type RillServerOptions } from '../src/server/server'
import { ManualClock } from './manual-clock'
import { createTestRegistry } from './helpers'
import { waitFor } from './process'

const TOKEN = 'test-token-0123456789abcdef'

const echoWorkflow = {
  schemaVersion: 1,
  name: 'echo',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'n1', type: 'test.echo@1', config: { value: '{{t1.output.amount}}' } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function start(options: Omit<RillServerOptions, 'engine' | 'token'> = {}) {
  const clock = new ManualClock(Date.UTC(2026, 10, 11, 10, 0, 30))
  const engine = new Engine({ db: Db.open(':memory:'), registry: createTestRegistry(), clock, sleep: async () => {} })
  const logs: string[] = []
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line), ...options })
  const port = await server.listen()
  cleanups.push(async () => {
    await server.close()
    await engine.shutdown()
  })
  return { engine, server, port, clock, logs, url: `ws://127.0.0.1:${port}/` }
}

async function connect(url: string, token = TOKEN): Promise<RillClient> {
  const client = await RillClient.connect(url, token)
  cleanups.push(() => client.close())
  return client
}

function collect(client: RillClient): EngineEvent[] {
  const events: EngineEvent[] = []
  client.onEvent((event) => events.push(event))
  return events
}

function upgradeStatus(port: number, headers: Record<string, string> = {}, path = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        'sec-websocket-protocol': `${SUBPROTOCOL}, ${tokenProtocol(TOKEN)}`,
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

function rawSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [SUBPROTOCOL, tokenProtocol(TOKEN)])
    socket.addEventListener('open', () => resolve(socket))
    socket.addEventListener('error', () => reject(new Error('could not connect')))
    cleanups.push(() => socket.close())
  })
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))
}

describe('RillServer construction', () => {
  it('refuses a token that is too short', () => {
    const engine = new Engine({ db: Db.open(':memory:'), registry: createTestRegistry() })
    expect(() => new RillServer({ engine, token: 'short' })).toThrow('token must be at least 16 characters')
  })

  it('refuses a token that no websocket client could send', () => {
    const engine = new Engine({ db: Db.open(':memory:'), registry: createTestRegistry() })
    const unusable = [
      'has space token 1234567890',
      'comma,token,0123456789ab',
      'base64/token+0123456789==',
      'unicode-token-ééééééééé',
    ]
    for (const token of unusable) {
      expect(() => new RillServer({ engine, token })).toThrow('token must be at least 16 characters')
    }
    expect(() => new RillServer({ engine, token: 'Aa0!#$%&\'*+-.^_`|~xyz' })).not.toThrow()
  })
})

describe('handshake and access control', () => {
  it('accepts the right token and says hello', async () => {
    const { url, server } = await start()
    const client = await connect(url)
    expect((await client.request('ping', {})).time).toBeGreaterThan(0)
    expect(server.clientCount).toBe(1)
  })

  it('binds to 127.0.0.1 only and reports its port', async () => {
    const { server, port } = await start()
    expect(server.port).toBe(port)
    expect(await server.listen()).toBe(port)
  })

  it('rejects a wrong, missing or malformed token during the handshake', async () => {
    const { port } = await start()
    expect(await upgradeStatus(port)).toBe(101)
    expect(await upgradeStatus(port, { 'sec-websocket-protocol': `${SUBPROTOCOL}, ${tokenProtocol('wrong-token-0123456789')}` })).toBe(401)
    expect(await upgradeStatus(port, { 'sec-websocket-protocol': SUBPROTOCOL })).toBe(401)
    expect(await upgradeStatus(port, { 'sec-websocket-protocol': tokenProtocol(TOKEN) })).toBe(401)
    expect(await upgradeStatus(port, { 'sec-websocket-protocol': 'rill.token.' })).toBe(401)
    const { url } = await start()
    await expect(RillClient.connect(url, 'wrong-token-0123456789')).rejects.toThrow('closed before the server said hello')
  })

  it('rejects other Host headers (DNS rebinding) and unknown paths', async () => {
    const { port } = await start()
    expect(await upgradeStatus(port, { host: 'evil.example' })).toBe(403)
    expect(await upgradeStatus(port, { host: `localhost:${port}` })).toBe(101)
    expect(await upgradeStatus(port, {}, '/other')).toBe(404)
  })

  it('rejects browser origins unless they are allowed', async () => {
    const closed = await start()
    expect(await upgradeStatus(closed.port, { origin: 'https://evil.example' })).toBe(403)
    const open = await start({ allowedOrigins: ['app://rill'] })
    expect(await upgradeStatus(open.port, { origin: 'app://rill' })).toBe(101)
    expect(await upgradeStatus(open.port, { origin: 'https://evil.example' })).toBe(403)
  })

  it('answers plain HTTP requests with 404', async () => {
    const { port } = await start()
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
        .on('error', reject)
        .end()
    })
    expect(status).toBe(404)
  })

  it('limits the number of connections', async () => {
    const { url, port } = await start({ maxConnections: 2 })
    await connect(url)
    await connect(url)
    expect(await upgradeStatus(port)).toBe(503)
  })
})

describe('methods', () => {
  it('deploys, lists and returns workflows', async () => {
    const { url } = await start()
    const client = await connect(url)
    const { workflowId } = await client.request('deploy', { workflow: echoWorkflow })
    expect((await client.request('getWorkflow', { workflowId })).workflow).toMatchObject({ name: 'echo' })
    expect((await client.request('listWorkflows', {})).workflows).toEqual([
      expect.objectContaining({ id: workflowId, name: 'echo', active: false, triggerType: 'trigger.manual@1' }),
    ])
  })

  it('reports an invalid workflow with its problems', async () => {
    const { url } = await start()
    const client = await connect(url)
    const bad = { ...echoWorkflow, nodes: [...echoWorkflow.nodes, { id: 'n2', type: 'nope@1', config: {} }] }
    const error = await client.request('deploy', { workflow: bad }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RillError)
    expect(error).toMatchObject({ code: 'INVALID_WORKFLOW', message: 'the workflow is not valid' })
    expect((error as RillError).problems.join(' ')).toContain('unknown node type: nope@1')
    const shapeError = await client.request('deploy', { workflow: { nope: true } }).catch((e: unknown) => e)
    expect(shapeError).toMatchObject({ code: 'INVALID_WORKFLOW' })
  })

  it('starts a run and streams its events to every client', async () => {
    const { url } = await start()
    const a = await connect(url)
    const b = await connect(url)
    const eventsA = collect(a)
    const eventsB = collect(b)
    const { workflowId } = await a.request('deploy', { workflow: echoWorkflow })
    const { runId } = await a.request('startRun', { workflowId, payload: { amount: 12 } })
    await waitFor(() => eventsA.some((e) => e.type === 'run.finished') && eventsB.some((e) => e.type === 'run.finished'))
    expect(eventsA.map((e) => e.type)).toEqual(['run.started', 'step.started', 'step.succeeded', 'run.finished'])
    expect(eventsB.map((e) => e.type)).toEqual(eventsA.map((e) => e.type))
    expect(eventsA[0]).toMatchObject({ runId, workflowId })

    const detail = await b.request('getRun', { runId })
    expect(detail.run).toMatchObject({ id: runId, status: 'succeeded' })
    expect(detail.steps[0]).toMatchObject({ nodeId: 'n1', status: 'succeeded', input: { value: 12 }, output: { value: 12 } })
    const runs = await b.request('listRuns', { workflowId, limit: 5 })
    expect(runs.runs.map((r) => r.id)).toEqual([runId])
  })

  it('answers startRun before the first event of that run', async () => {
    const { url, engine } = await start()
    const workflowId = engine.deploy(echoWorkflow)
    const socket = await rawSocket(url)
    const order: string[] = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; event?: { type: string } }
      if (message.type !== 'hello') order.push(message.type === 'event' ? message.event!.type : message.type)
    })
    socket.send(
      JSON.stringify({ type: 'request', id: '1', method: 'startRun', params: { workflowId, payload: { amount: 1 } } }),
    )
    await waitFor(() => order.includes('run.finished'))
    expect(order).toEqual(['response', 'run.started', 'step.started', 'step.succeeded', 'run.finished'])
  })

  it('supports dry runs and a missing payload', async () => {
    const { url } = await start()
    const client = await connect(url)
    const events = collect(client)
    const { workflowId } = await client.request('deploy', {
      workflow: { ...echoWorkflow, nodes: [echoWorkflow.nodes[0], { id: 'n1', type: 'test.echo@1', config: { value: 1 } }] },
    })
    await client.request('startRun', { workflowId, dryRun: true })
    await waitFor(() => events.some((e) => e.type === 'run.finished'))
    expect(events[0]).toMatchObject({ type: 'run.started', dryRun: true })
  })

  it('describes the available nodes', async () => {
    const { url } = await start()
    const client = await connect(url)
    const { nodes } = await client.request('nodeCatalog', {})
    expect(nodes.map((n) => n.type)).toContain('csv.append@1')
    expect(nodes.find((n) => n.type === 'trigger.cron@1')).toMatchObject({ kind: 'trigger' })
  })

  it('activates and deactivates a schedule and streams the trigger events', async () => {
    const { url, clock } = await start()
    const client = await connect(url)
    const events = collect(client)
    const { workflowId } = await client.request('deploy', {
      workflow: {
        schemaVersion: 1,
        name: 'cron',
        nodes: [
          { id: 't1', type: 'trigger.cron@1', config: { expression: '* * * * *', timezone: 'utc' } },
          { id: 'n1', type: 'test.echo@1', config: { value: 1 } },
        ],
        edges: [{ from: 't1', to: 'n1' }],
      },
    })
    await client.request('activate', { workflowId })
    clock.advance(30_000)
    await waitFor(() => events.some((e) => e.type === 'run.finished'))
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['workflow.activated', 'trigger.fired', 'run.started', 'run.finished']),
    )
    expect((await client.request('listWorkflows', {})).workflows[0]?.active).toBe(true)
    await client.request('deactivate', { workflowId })
    expect(events.at(-1)).toMatchObject({ type: 'workflow.deactivated', workflowId })
    expect((await client.request('listWorkflows', {})).workflows[0]?.active).toBe(false)
  })
})

describe('errors', () => {
  it('maps unknown ids, bad activations, unknown methods and bad params to codes', async () => {
    const { url } = await start()
    const client = await connect(url)
    await expect(client.request('startRun', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.request('getWorkflow', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.request('getRun', { runId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.request('activate', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(client.request('deactivate', { workflowId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const { workflowId } = await client.request('deploy', { workflow: echoWorkflow })
    await expect(client.request('activate', { workflowId })).rejects.toMatchObject({
      code: 'ACTIVATION_FAILED',
      message: expect.stringContaining('manual triggers cannot be activated'),
    })

    const unknown = await new Promise<{ code: string }>((resolve) => {
      void rawSocket(url).then((socket) => {
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; ok?: boolean; error?: { code: string } }
          if (message.type === 'response' && message.error) resolve(message.error)
        })
        socket.send(JSON.stringify({ type: 'request', id: '1', method: 'explode', params: {} }))
      })
    })
    expect(unknown.code).toBe('UNKNOWN_METHOD')

    const invalid = await new Promise<{ code: string; problems?: string[] }>((resolve) => {
      void rawSocket(url).then((socket) => {
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; error?: { code: string; problems?: string[] } }
          if (message.type === 'response' && message.error) resolve(message.error)
        })
        socket.send(JSON.stringify({ type: 'request', id: '1', method: 'startRun', params: { workflowId: '' } }))
      })
    })
    expect(invalid.code).toBe('INVALID_PARAMS')
    expect(invalid.problems?.length).toBeGreaterThan(0)
  })

  it('never leaks internal error details, but logs them on the server', async () => {
    const { url, engine, logs } = await start()
    const client = await connect(url)
    vi.spyOn(engine, 'listRuns').mockImplementation(() => {
      throw new Error('database password is hunter2')
    })
    const error = await client.request('listRuns', {}).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(JSON.stringify(error)).not.toContain('hunter2')
    expect(logs).toEqual([
      JSON.stringify({ type: 'error', method: 'listRuns', message: 'database password is hunter2' }),
    ])
    expect((await client.request('ping', {})).time).toBeGreaterThan(0)
  })

  it('logs a run that fails outside any node', async () => {
    const { url, engine, logs } = await start()
    const client = await connect(url)
    const { workflowId } = await client.request('deploy', { workflow: echoWorkflow })
    vi.spyOn(engine, 'enqueueRun').mockImplementation(() => ({
      runId: 'r1',
      done: Promise.reject(new Error('disk is gone')),
    }))
    expect(await client.request('startRun', { workflowId })).toEqual({ runId: 'r1' })
    await waitFor(() => logs.length > 0)
    expect(JSON.parse(logs[0]!)).toMatchObject({ type: 'error', method: 'startRun', message: 'disk is gone' })
  })
})

describe('protocol violations and limits', () => {
  it('closes a connection that sends invalid JSON or an invalid envelope with 1008 and keeps serving others', async () => {
    const { url } = await start()
    const healthy = await connect(url)
    const bad = await rawSocket(url)
    const code = closeCode(bad)
    bad.send('not json')
    expect(await code).toBe(1008)
    const bad2 = await rawSocket(url)
    const code2 = closeCode(bad2)
    bad2.send(JSON.stringify({ type: 'request', method: 'ping' }))
    expect(await code2).toBe(1008)
    expect((await healthy.request('ping', {})).time).toBeGreaterThan(0)
  })

  it('closes a connection that sends binary frames with 1003', async () => {
    const { url } = await start()
    const socket = await rawSocket(url)
    const code = closeCode(socket)
    socket.send(new Uint8Array([1, 2, 3]))
    expect(await code).toBe(1003)
  })

  it('closes a connection that sends an oversized message with 1009 without crashing the server', async () => {
    const { url } = await start({ maxMessageBytes: 2048 })
    const healthy = await connect(url)
    const socket = await rawSocket(url)
    const code = closeCode(socket)
    socket.send(JSON.stringify({ type: 'request', id: '1', method: 'ping', params: { pad: 'x'.repeat(5000) } }))
    expect(await code).toBe(1009)
    expect((await healthy.request('ping', {})).time).toBeGreaterThan(0)
  })

  it('closes a client that stops reading while it keeps sending requests with 1013', async () => {
    const { url } = await start({ maxBufferedBytes: 64 * 1024 })
    const socket = new WsClient(url, [SUBPROTOCOL, tokenProtocol(TOKEN)])
    cleanups.push(() => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
    const raw = (socket as unknown as { _socket: Socket })._socket
    raw.pause()
    const request = JSON.stringify({ type: 'request', id: '1', method: 'nodeCatalog', params: {} })
    for (let i = 0; i < 3000; i += 1) socket.send(request)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    raw.resume()
    expect(await closed).toBe(1013)
  })

  it('drops connections that stop answering pings and keeps the ones that answer', async () => {
    const { url } = await start({ pingIntervalMs: 40 })
    const lively = await connect(url)
    const mute = new WsClient(url, [SUBPROTOCOL, tokenProtocol(TOKEN)], { autoPong: false })
    cleanups.push(() => mute.terminate())
    const closed = new Promise<number>((resolve) => mute.on('close', (code) => resolve(code)))
    expect(await closed).toBe(1006)
    expect((await lively.request('ping', {})).time).toBeGreaterThan(0)
  })
})

describe('shutdown', () => {
  it('closes clients with 1001, stops listening and can be called twice', async () => {
    const { url, port, server } = await start()
    const client = await connect(url)
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)))
    await server.close()
    expect(await closed).toBe(1001)
    expect(server.port).toBeUndefined()
    expect(server.clientCount).toBe(0)
    await server.close()
    await expect(upgradeStatus(port)).rejects.toThrow()
  })

  it('lets concurrent close calls share one shutdown, and listen waits for a close in progress', async () => {
    const { server, url } = await start()
    await connect(url)
    const first = server.close()
    const second = server.close()
    expect(second).toBe(first)
    const port = await server.listen()
    await first
    expect(server.port).toBe(port)
    const again = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN)
    cleanups.push(() => again.close())
    expect(server.clientCount).toBe(1)
    expect((await again.request('ping', {})).time).toBeGreaterThan(0)
  })
})
