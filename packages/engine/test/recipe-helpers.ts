import { createCoreRegistry } from '@rill/nodes-core'
import { RillClient, RillError } from '@rill/protocol'
import { afterEach } from 'vitest'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { RillServer } from '../src/server/server'

export const TOKEN = 'recipes-token-0123456789abcdef'
export const SLACK_URL = 'https://example.test/hooks/slack-ops'

const cleanups: Array<() => Promise<void> | void> = []

export function useCleanups(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
}

export async function startRecipeEnv(engineOptions: Partial<EngineOptions> = {}) {
  const db = Db.open(':memory:')
  const engine = new Engine({
    db,
    registry: createCoreRegistry(),
    allowedRoots: ['/Users/demo'],
    planConnections: [{ name: 'slack-ops', kind: 'slack' }],
    connections: { get: (name) => (name === 'slack-ops' ? SLACK_URL : undefined) },
    sleep: async () => undefined,
    random: () => 1,
    ...engineOptions,
  })
  cleanups.push(() => engine.shutdown())
  const logs: string[] = []
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const connect = async () => {
    const frames: string[] = []
    const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN, {
      socketFactory: (target, protocols) => {
        const socket = new WebSocket(target, protocols)
        socket.addEventListener('message', (event) => frames.push(String(event.data)))
        return socket as never
      },
    })
    cleanups.push(() => client.close())
    return { client, frames }
  }
  return { engine, db, logs, connect, ...(await connect()) }
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

export function snapshot(db: Db): Record<string, string> {
  const names = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => row.name)
  return Object.fromEntries(names.map((name) => [name, JSON.stringify(db.all(`SELECT * FROM "${name}"`))]))
}
