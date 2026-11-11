import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createCoreRegistry, type ConnectionResolver } from '@rill/nodes-core'
import { PROTOCOL_VERSION } from '@rill/protocol'
import { Db } from './db'
import { Engine, WorkflowValidationError } from './engine'
import { RillServer } from './server/server'

const USAGE = `usage:
  rill-engine run <workflow.json> [--db <path>] [--payload <json>] [--dry-run] [--allow <dir>]... [--connections <file.json>]
  rill-engine watch <workflow.json> [--db <path>] [--allow <dir>]... [--connections <file.json>] [--port <n>]
  rill-engine serve [--db <path>] [--allow <dir>]... [--connections <file.json>] [--port <n>] [--webhook-port <n>] [--shutdown-timeout <ms>]
  rill-engine recover [--db <path>] [--allow <dir>]... [--connections <file.json>]

serve reads its access token from the RILL_TOKEN environment variable (16 or more characters from A-Z, a-z, 0-9 and !#$%&'*+-.^_\`|~) and prints a generated one when it is not set.`

class UsageError extends Error {}

function loadConnections(file: string | undefined): ConnectionResolver {
  const table: Record<string, string> = file ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { get: (id) => (Object.hasOwn(table, id) ? table[id] : undefined) }
}

function waitForStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false
    const onSignal = () => {
      if (stopping) process.exit(1)
      stopping = true
      resolve()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}

function toPort(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    throw new UsageError(`${name} must be a whole number from 0 to 65535`)
  }
  return Number(value)
}

function toMillis(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d{1,9}$/.test(value)) throw new UsageError(`${name} must be a whole number of milliseconds`)
  return Number(value)
}

async function finishedWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([work.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      payload: { type: 'string' },
      'dry-run': { type: 'boolean' },
      allow: { type: 'string', multiple: true },
      connections: { type: 'string' },
      port: { type: 'string' },
      'webhook-port': { type: 'string' },
      'shutdown-timeout': { type: 'string' },
    },
  })
  const [command, file] = positionals
  let db: Db | undefined
  let engine: Engine | undefined
  try {
    const port = toPort('--port', values.port)
    const webhookPort = toPort('--webhook-port', values['webhook-port'])
    const shutdownTimeout = toMillis('--shutdown-timeout', values['shutdown-timeout'], 10_000)
    db = Db.open(values.db ?? 'rill.db')
    engine = new Engine({
      db,
      registry: createCoreRegistry(),
      allowedRoots: values.allow,
      connections: loadConnections(values.connections),
      webhookPort: command === 'serve' ? webhookPort : port,
    })
    if (command === 'run' && file) {
      const id = engine.deploy(JSON.parse(readFileSync(file, 'utf8')))
      const payload = JSON.parse(values.payload ?? '{}')
      const result = await engine.startRun(id, payload, { dryRun: values['dry-run'] ?? false })
      console.log(JSON.stringify(result))
      return result.status === 'succeeded' ? 0 : 1
    }
    if (command === 'watch' && file) {
      engine.on((event) => console.log(JSON.stringify(event)))
      await engine.recover()
      const id = engine.deploy(JSON.parse(readFileSync(file, 'utf8')))
      await engine.activate(id)
      await waitForStopSignal()
      engine.deactivate(id)
      await engine.shutdown()
      return 0
    }
    if (command === 'serve') {
      const given = process.env.RILL_TOKEN
      delete process.env.RILL_TOKEN
      const generated = given === undefined || given === ''
      const token = generated ? randomBytes(32).toString('hex') : given
      const server = new RillServer({ engine, token, port })
      const stop = waitForStopSignal()
      const listeningPort = await server.listen()
      console.log(
        JSON.stringify({
          type: 'listening',
          host: '127.0.0.1',
          port: listeningPort,
          protocol: PROTOCOL_VERSION,
          ...(generated ? { token } : {}),
        }),
      )
      const running = engine
      const startup = running
        .recover()
        .then(() => running.resumeActive())
        .catch((error: unknown) => {
          console.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      await stop
      await server.close()
      const drained = await finishedWithin(
        startup.then(() => running.shutdown()),
        shutdownTimeout,
      )
      if (!drained) {
        console.error('runs are still active; they resume at the next start')
        process.exit(0)
      }
      return 0
    }
    if (command === 'recover') {
      const results = await engine.recover()
      console.log(JSON.stringify(results))
      return results.every((r) => r.status === 'succeeded') ? 0 : 1
    }
    console.error(USAGE)
    return 2
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`)
      return 2
    }
    console.error(error instanceof WorkflowValidationError ? error.message : String(error))
    return 1
  } finally {
    await engine?.shutdown()
    db?.close()
  }
}

process.exitCode = await main(process.argv.slice(2))
