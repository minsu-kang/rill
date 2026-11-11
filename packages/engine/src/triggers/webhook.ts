import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebhookTriggerConfig } from '@rill/nodes-core'
import type { TriggerHost, TriggerRuntime } from './types'

const MAX_BODY_BYTES = 1_048_576
const DRAIN_LIMIT_BYTES = 16 * MAX_BODY_BYTES
const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'x-rill-secret'])

export interface WebhookRoute {
  method: string
  path: string
  secret?: string
}

export interface WebhookRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

export type WebhookHandler = (request: WebhookRequest) => { runId: string }

interface Entry {
  owner: string
  route: WebhookRoute
  handler: WebhookHandler
}

function sameSecret(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(given).digest()
  return timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function isBrowserRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return req.headers.origin !== undefined || (site !== undefined && site !== 'none')
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > DRAIN_LIMIT_BYTES) {
      req.destroy()
      return null
    }
    if (total <= MAX_BODY_BYTES) chunks.push(buffer)
  }
  return total > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')
}

export class WebhookHub {
  private readonly preferredPort: number
  private readonly routes = new Map<string, Entry>()
  private server: Server | undefined
  private boundPort: number | undefined
  private listening: Promise<number> | undefined

  constructor(preferredPort = 0) {
    this.preferredPort = preferredPort
  }

  get port(): number | undefined {
    return this.boundPort
  }

  listen(): Promise<number> {
    this.listening ??= this.start()
    return this.listening
  }

  register(owner: string, route: WebhookRoute, handler: WebhookHandler): void {
    const key = `${route.method} ${route.path}`
    if (this.routes.has(key)) throw new Error(`webhook route already in use: ${key}`)
    this.routes.set(key, { owner, route, handler })
  }

  unregister(owner: string): void {
    for (const [key, entry] of [...this.routes.entries()]) {
      if (entry.owner === owner) this.routes.delete(key)
    }
  }

  async close(): Promise<void> {
    await this.listening?.catch(() => undefined)
    const server = this.server
    this.server = undefined
    this.boundPort = undefined
    this.listening = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async start(): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal error' })
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.preferredPort, '127.0.0.1', () => resolve())
      })
    } catch (error) {
      this.listening = undefined
      throw error
    }
    this.server = server
    this.boundPort = (server.address() as AddressInfo).port
    return this.boundPort
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.boundPort
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    if (!allowedHosts.includes(req.headers.host ?? '')) {
      send(res, 403, { error: 'forbidden host' })
      return
    }
    const target = req.url ?? '/'
    const queryStart = target.indexOf('?')
    const pathname = queryStart === -1 ? target : target.slice(0, queryStart)
    const key = `${req.method ?? ''} ${pathname}`
    const entry = this.routes.get(key)
    if (!entry) {
      send(res, 404, { error: 'not found' })
      return
    }
    if (entry.route.secret === undefined && isBrowserRequest(req)) {
      send(res, 403, { error: 'browser requests need a secret' })
      return
    }
    const given = req.headers['x-rill-secret']
    if (entry.route.secret !== undefined && !sameSecret(entry.route.secret, Array.isArray(given) ? given[0] : given)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }
    const raw = await readBody(req)
    if (raw === null) {
      send(res, 413, { error: 'payload too large' })
      return
    }
    if (this.routes.get(key) !== entry) {
      send(res, 404, { error: 'not found' })
      return
    }
    let body: unknown = raw === '' ? null : raw
    if (raw !== '' && (req.headers['content-type'] ?? '').includes('json')) {
      try {
        body = JSON.parse(raw)
      } catch {
        send(res, 400, { error: 'invalid JSON' })
        return
      }
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (REDACTED_HEADERS.has(name) || value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    try {
      const { runId } = entry.handler({
        method: req.method ?? '',
        path: pathname,
        query: Object.fromEntries(new URLSearchParams(queryStart === -1 ? '' : target.slice(queryStart + 1))),
        headers,
        body,
      })
      send(res, 202, { runId })
    } catch {
      send(res, 500, { error: 'internal error' })
    }
  }
}

export class WebhookRuntime implements TriggerRuntime {
  private readonly workflowId: string
  private readonly hub: WebhookHub

  constructor(
    workflowId: string,
    config: WebhookTriggerConfig,
    secret: string | undefined,
    hub: WebhookHub,
    host: TriggerHost,
  ) {
    this.workflowId = workflowId
    this.hub = hub
    hub.register(workflowId, { method: config.method ?? 'POST', path: config.path, secret }, (request) => {
      try {
        return host.fire(workflowId, request)
      } catch (error) {
        host.emit({
          type: 'trigger.error',
          workflowId,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })
  }

  stop(): void {
    this.hub.unregister(this.workflowId)
  }
}
