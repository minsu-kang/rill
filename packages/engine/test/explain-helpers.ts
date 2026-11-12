import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workflow, WorkflowNode } from '@rill/dsl'
import { createCoreRegistry } from '@rill/nodes-core'
import { RillClient, RillError } from '@rill/protocol'
import { afterEach, beforeEach } from 'vitest'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { RillServer } from '../src/server/server'
import { ScriptedProvider, type Step } from './plan-helpers'

export const TOKEN = 'explain-token-0123456789abcdef'
export const GOOD = { explanation: 'The service rejected the request of node n1.', likelyCause: 'external_service', suggestedActions: ['wait_and_retry'] }
export const CONNECTION_SECRET = 'conn-secret-value-4455'
export const LITERAL_SECRET = 'SECRET-MARKER-literal-91'
export const RUN_MARKER = 'RUN-TEXT-MARKER-6b2f'

export interface Env {
  dir: string
  base: string
  engine: Engine
  db: Db
  provider: ScriptedProvider
  client: RillClient
  frames: string[]
  logs: string[]
  url: string
  connect(): Promise<{ client: RillClient; frames: string[] }>
  workflow(nodes: WorkflowNode[]): string
  run(nodes: WorkflowNode[], payload?: unknown): Promise<string>
}

const cleanups: Array<() => Promise<void> | void> = []

export function useCleanups(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
}

export function useTempDir(): { get(): string } {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rill-explain-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  return { get: () => dir }
}

async function startLocalServer(): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    const status = /^\/status\/(\d+)$/.exec(req.url ?? '')
    if (status !== null) {
      res.statusCode = Number(status[1])
      res.end(`${RUN_MARKER} answer ${status[1]}`)
      return
    }
    if (req.url === '/echo-token') {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'bad token', received: req.headers['x-api-token'] ?? null }))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

export async function startEnv(dir: string, steps: Step[] = [], engineOptions: Partial<EngineOptions> = {}, options: { llm?: boolean } = {}): Promise<Env> {
  const local = await startLocalServer()
  cleanups.push(async () => {
    local.server.closeAllConnections()
    await new Promise<void>((resolve) => local.server.close(() => resolve()))
  })
  const provider = new ScriptedProvider(steps)
  const db = Db.open(':memory:')
  const connections: Record<string, string> = { api: CONNECTION_SECRET }
  const engine = new Engine({
    db,
    registry: createCoreRegistry(),
    allowedRoots: [dir],
    connections: { get: (name) => connections[name] },
    ...(options.llm === false ? {} : { llm: provider }),
    ...engineOptions,
  })
  cleanups.push(() => engine.shutdown())
  const logs: string[] = []
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const url = `ws://127.0.0.1:${port}/`
  const connect = async () => {
    const frames: string[] = []
    const client = await RillClient.connect(url, TOKEN, {
      socketFactory: (target, protocols) => {
        const socket = new WebSocket(target, protocols)
        socket.addEventListener('message', (event) => frames.push(String(event.data)))
        return socket as never
      },
    })
    cleanups.push(() => client.close())
    return { client, frames }
  }
  const first = await connect()
  const workflow = (nodes: WorkflowNode[]): string => {
    const all: Workflow = {
      schemaVersion: 1,
      name: 'explain me',
      nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }, ...nodes],
      edges: nodes.map((node, index) => ({ from: index === 0 ? 't1' : nodes[index - 1]!.id, to: node.id })),
    }
    return engine.store.saveWorkflow(all)
  }
  return {
    dir,
    base: local.base,
    engine,
    db,
    provider,
    client: first.client,
    frames: first.frames,
    logs,
    url,
    connect,
    workflow,
    run: async (nodes, payload = {}) => (await engine.startRun(workflow(nodes), payload)).runId,
  }
}

export async function failure(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

export const http = (base: string, path: string, extra: Partial<WorkflowNode> = {}, config: Record<string, unknown> = {}): WorkflowNode => ({
  id: 'n1',
  type: 'http.request@1',
  config: { url: `${base}${path}`, ...config },
  ...extra,
})

export function allTables(db: Db): Record<string, string> {
  const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name)
  return Object.fromEntries(names.map((name) => [name, JSON.stringify(db.all(`SELECT * FROM "${name}"`))]))
}
