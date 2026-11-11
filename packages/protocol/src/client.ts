import Value from 'typebox/value'
import type { EngineEvent } from './events'
import {
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  parseEvent,
  parseServerMessage,
  tokenProtocol,
  type ClientRequest,
} from './messages'
import { METHODS, type MethodName, type MethodParams, type MethodResult } from './methods'

const OPEN = 1

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void
}

export interface ClientOptions {
  requestTimeoutMs?: number
}

export interface ConnectOptions extends ClientOptions {
  connectTimeoutMs?: number
  socketFactory?: (url: string, protocols: string[]) => SocketLike
}

export class RillError extends Error {
  readonly code: string
  readonly problems: string[]

  constructor(code: string, message: string, problems: string[] = []) {
    super(message)
    this.name = 'RillError'
    this.code = code
    this.problems = problems
  }
}

interface Pending {
  method: MethodName
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class RillClient {
  readonly ready: Promise<void>
  private readonly socket: SocketLike
  private readonly timeoutMs: number
  private readonly pending = new Map<string, Pending>()
  private readonly eventListeners = new Set<(event: EngineEvent) => void>()
  private readonly closeListeners = new Set<(code: number, reason: string) => void>()
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private isReady = false
  private closed = false
  private nextId = 1

  constructor(socket: SocketLike, options: ClientOptions = {}) {
    this.socket = socket
    this.timeoutMs = options.requestTimeoutMs ?? 30_000
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.ready.catch(() => undefined)
    socket.addEventListener('message', (event) => this.handleMessage(event.data))
    socket.addEventListener('close', (event) => this.handleClose(event.code ?? 1006, event.reason ?? ''))
  }

  static async connect(url: string, token: string, options: ConnectOptions = {}): Promise<RillClient> {
    const protocols = [SUBPROTOCOL, tokenProtocol(token)]
    const socket = options.socketFactory
      ? options.socketFactory(url, protocols)
      : (new WebSocket(url, protocols) as unknown as SocketLike)
    const client = new RillClient(socket, options)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out waiting for the server to say hello')),
        options.connectTimeoutMs ?? 10_000,
      )
    })
    try {
      await Promise.race([client.ready, timeout])
    } catch (error) {
      socket.close(1000, 'handshake failed')
      throw error
    } finally {
      clearTimeout(timer)
    }
    return client
  }

  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (this.closed || this.socket.readyState !== OPEN) return Promise.reject(new Error('connection is not open'))
    const id = String(this.nextId++)
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      const request: ClientRequest = { type: 'request', id, method, params }
      try {
        this.socket.send(JSON.stringify(request))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }

  private handleMessage(data: unknown): void {
    const parsed = parseServerMessage(typeof data === 'string' ? data : String(data))
    if (!parsed.ok) {
      this.socket.close(1002, 'invalid message')
      return
    }
    const message = parsed.value
    if (message.type === 'hello') {
      if (message.protocol !== PROTOCOL_VERSION) {
        this.socket.close(1002, 'unsupported protocol')
        return
      }
      this.isReady = true
      this.resolveReady()
      return
    }
    if (message.type === 'event') {
      const event = parseEvent(message.event)
      if (!event) return
      for (const listener of [...this.eventListeners]) {
        try {
          listener(event)
        } catch {
          continue
        }
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (!message.ok) {
      pending.reject(new RillError(message.error.code, message.error.message, message.error.problems))
      return
    }
    if (!Value.Check(METHODS[pending.method].result, message.result)) {
      pending.reject(new RillError('BAD_RESPONSE', `the response to ${pending.method} does not match the protocol`))
      return
    }
    pending.resolve(message.result)
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true
    if (!this.isReady) {
      this.rejectReady(new Error(`connection closed before the server said hello (code ${code})`))
    }
    for (const [id, pending] of [...this.pending.entries()]) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error('connection closed'))
    }
    for (const listener of [...this.closeListeners]) {
      try {
        listener(code, reason)
      } catch {
        continue
      }
    }
  }
}
