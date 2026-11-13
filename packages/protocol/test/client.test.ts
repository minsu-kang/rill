import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, RillClient, RillError, errorResponse, okResponse, type SocketLike } from '../src/index'

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void

class FakeSocket implements SocketLike {
  readyState = 1
  readonly sent: string[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<string, Listener[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  receive(message: unknown): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    for (const listener of this.listeners.get('message') ?? []) listener({ data })
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3
    for (const listener of this.listeners.get('close') ?? []) listener({ code, reason })
  }

  lastRequest(): { id: string; method: string; params: unknown } {
    return JSON.parse(this.sent.at(-1)!) as { id: string; method: string; params: unknown }
  }
}

const hello = { type: 'hello', protocol: PROTOCOL_VERSION }

describe('RillClient', () => {
  it('becomes ready on hello', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    let ready = false
    void client.ready.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    socket.receive(hello)
    await client.ready
    expect(ready).toBe(true)
  })

  it('rejects ready when the socket closes before hello', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    socket.serverClose(1006)
    await expect(client.ready).rejects.toThrow('closed before the server said hello')
  })

  it('sends a request and resolves with the typed result', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const pending = client.request('startRun', { workflowId: 'w', payload: { a: 1 } })
    const sent = socket.lastRequest()
    expect(sent).toMatchObject({ method: 'startRun', params: { workflowId: 'w', payload: { a: 1 } } })
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'request' })
    socket.receive(okResponse(sent.id, { runId: 'r1' }))
    expect(await pending).toEqual({ runId: 'r1' })
  })

  it('sends deleteWorkflow and resolves with the empty result', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const pending = client.request('deleteWorkflow', { workflowId: 'w' })
    const sent = socket.lastRequest()
    expect(sent).toMatchObject({ method: 'deleteWorkflow', params: { workflowId: 'w' } })
    socket.receive(okResponse(sent.id, {}))
    expect(await pending).toEqual({})
  })

  it('surfaces WORKFLOW_BUSY from deleteWorkflow as a RillError', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const pending = client.request('deleteWorkflow', { workflowId: 'w' })
    socket.receive(errorResponse(socket.lastRequest().id, { code: 'WORKFLOW_BUSY', message: 'a run is active' }))
    await expect(pending).rejects.toMatchObject({ code: 'WORKFLOW_BUSY', message: 'a run is active' })
  })

  it('uses a fresh id for every request and matches responses out of order', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const first = client.request('ping', {})
    const firstId = socket.lastRequest().id
    const second = client.request('listWorkflows', {})
    const secondId = socket.lastRequest().id
    expect(firstId).not.toBe(secondId)
    socket.receive(okResponse(secondId, { workflows: [] }))
    socket.receive(okResponse(firstId, { time: 5 }))
    expect(await second).toEqual({ workflows: [] })
    expect(await first).toEqual({ time: 5 })
  })

  it('rejects with a RillError carrying the code and problems', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const pending = client.request('deploy', { workflow: {} })
    socket.receive(
      errorResponse(socket.lastRequest().id, { code: 'INVALID_WORKFLOW', message: 'the workflow is not valid', problems: ['a', 'b'] }),
    )
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RillError)
    expect(error).toMatchObject({ code: 'INVALID_WORKFLOW', message: 'the workflow is not valid', problems: ['a', 'b'] })
  })

  it('rejects a result that does not match the method schema', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const pending = client.request('ping', {})
    socket.receive(okResponse(socket.lastRequest().id, { time: 'yesterday' }))
    await expect(pending).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('times out requests that never get an answer', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket, { requestTimeoutMs: 20 })
    await expect(client.request('ping', {})).rejects.toThrow('request timed out: ping')
    socket.receive(okResponse('1', { time: 1 }))
  })

  it('clears the request timer when the response arrives or the connection closes', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const client = new RillClient(socket)
      const answered = client.request('ping', {})
      expect(vi.getTimerCount()).toBe(1)
      socket.receive(okResponse(socket.lastRequest().id, { time: 1 }))
      await answered
      expect(vi.getTimerCount()).toBe(0)
      const dropped = client.request('ping', {})
      const rejected = dropped.catch(() => undefined)
      expect(vi.getTimerCount()).toBe(1)
      socket.serverClose()
      await rejected
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores responses it did not ask for', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    socket.receive(okResponse('999', { time: 1 }))
    const pending = client.request('ping', {})
    socket.receive(okResponse(socket.lastRequest().id, { time: 2 }))
    expect(await pending).toEqual({ time: 2 })
  })

  it('delivers events to listeners until they unsubscribe, and survives a throwing listener', () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const seen: string[] = []
    client.onEvent(() => {
      throw new Error('bad listener')
    })
    const off = client.onEvent((event) => seen.push(event.type))
    const event = { type: 'workflow.activated', at: 1, workflowId: 'w' }
    socket.receive({ type: 'event', event })
    off()
    socket.receive({ type: 'event', event })
    expect(seen).toEqual(['workflow.activated'])
  })

  it('closes the socket with 1002 on a message that is not part of the protocol', () => {
    const socket = new FakeSocket()
    new RillClient(socket)
    socket.receive('not json')
    socket.receive({ type: 'greeting' })
    expect(socket.closes).toEqual([
      { code: 1002, reason: 'invalid message' },
      { code: 1002, reason: 'invalid message' },
    ])
  })

  it('ignores events it does not know and keeps the connection', () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const seen: string[] = []
    client.onEvent((event) => seen.push(event.type))
    socket.receive({ type: 'event', event: { type: 'run.cancelled', at: 1, runId: 'r' } })
    socket.receive({ type: 'event', event: { type: 'workflow.activated', at: 1, workflowId: 'w' } })
    expect(seen).toEqual(['workflow.activated'])
    expect(socket.closes).toEqual([])
  })

  it('accepts a result that carries fields it does not know', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const pending = client.request('ping', {})
    socket.receive(okResponse(socket.lastRequest().id, { time: 5, uptime: 99 }))
    expect(await pending).toMatchObject({ time: 5 })
  })

  it('closes with 1002 and never becomes ready when the server speaks another protocol version', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    socket.receive({ type: 'hello', protocol: 2 })
    expect(socket.closes).toEqual([{ code: 1002, reason: 'unsupported protocol' }])
    socket.serverClose(1002)
    await expect(client.ready).rejects.toThrow('closed before the server said hello')
  })

  it('gives up when the server never says hello', async () => {
    const socket = new FakeSocket()
    await expect(
      RillClient.connect('ws://127.0.0.1:1/', 'secret-token', { socketFactory: () => socket, connectTimeoutMs: 20 }),
    ).rejects.toThrow('timed out waiting for the server to say hello')
    expect(socket.closes).toEqual([{ code: 1000, reason: 'handshake failed' }])
  })

  it('rejects pending requests and notifies listeners when the connection closes', async () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    const closes: Array<[number, string]> = []
    client.onClose((code, reason) => closes.push([code, reason]))
    const pending = client.request('ping', {})
    socket.serverClose(1001, 'server is shutting down')
    await expect(pending).rejects.toThrow('connection closed')
    expect(closes).toEqual([[1001, 'server is shutting down']])
    await expect(client.request('ping', {})).rejects.toThrow('connection is not open')
  })

  it('refuses requests while the socket is not open', async () => {
    const socket = new FakeSocket()
    socket.readyState = 0
    const client = new RillClient(socket)
    await expect(client.request('ping', {})).rejects.toThrow('connection is not open')
    expect(socket.sent).toEqual([])
  })

  it('closes the underlying socket on close()', () => {
    const socket = new FakeSocket()
    const client = new RillClient(socket)
    client.close(1000, 'bye')
    expect(socket.closes).toEqual([{ code: 1000, reason: 'bye' }])
  })

  it('connects through a socket factory with the subprotocols and waits for hello', async () => {
    const socket = new FakeSocket()
    let seen: { url: string; protocols: string[] } | undefined
    const connecting = RillClient.connect('ws://127.0.0.1:1/', 'secret-token', {
      socketFactory: (url, protocols) => {
        seen = { url, protocols }
        return socket
      },
    })
    socket.receive(hello)
    const client = await connecting
    expect(client).toBeInstanceOf(RillClient)
    expect(seen).toEqual({ url: 'ws://127.0.0.1:1/', protocols: ['rill.v1', 'rill.token.secret-token'] })
  })
})
