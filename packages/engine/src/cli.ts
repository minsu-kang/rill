import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createCoreRegistry, type ConnectionResolver } from '@rill/nodes-core'
import { Db } from './db'
import { Engine, WorkflowValidationError } from './engine'

const USAGE = `usage:
  rill-engine run <workflow.json> [--db <path>] [--payload <json>] [--dry-run] [--allow <dir>]... [--connections <file.json>]
  rill-engine watch <workflow.json> [--db <path>] [--allow <dir>]... [--connections <file.json>] [--port <n>]
  rill-engine recover [--db <path>] [--allow <dir>]... [--connections <file.json>]`

function loadConnections(file: string | undefined): ConnectionResolver {
  const table: Record<string, string> = file ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { get: (id) => (Object.hasOwn(table, id) ? table[id] : undefined) }
}

function waitForStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
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
    },
  })
  const [command, file] = positionals
  const db = Db.open(values.db ?? 'rill.db')
  let engine: Engine | undefined
  try {
    engine = new Engine({
      db,
      registry: createCoreRegistry(),
      allowedRoots: values.allow,
      connections: loadConnections(values.connections),
      webhookPort: values.port === undefined ? undefined : Number(values.port),
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
    if (command === 'recover') {
      const results = await engine.recover()
      console.log(JSON.stringify(results))
      return results.every((r) => r.status === 'succeeded') ? 0 : 1
    }
    console.error(USAGE)
    return 2
  } catch (error) {
    console.error(error instanceof WorkflowValidationError ? error.message : String(error))
    return 1
  } finally {
    await engine?.shutdown()
    db.close()
  }
}

process.exitCode = await main(process.argv.slice(2))
