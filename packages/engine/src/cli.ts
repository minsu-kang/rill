import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createCoreRegistry } from '@rill/nodes-core'
import { Db } from './db'
import { Engine, WorkflowValidationError } from './engine'

const USAGE = `usage:
  rill-engine run <workflow.json> [--db <path>] [--payload <json>] [--dry-run]
  rill-engine recover [--db <path>]`

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      payload: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  })
  const [command, file] = positionals
  const db = Db.open(values.db ?? 'rill.db')
  const engine = new Engine({ db, registry: createCoreRegistry() })
  try {
    if (command === 'run' && file) {
      const id = engine.deploy(JSON.parse(readFileSync(file, 'utf8')))
      const payload = JSON.parse(values.payload ?? '{}')
      const result = await engine.startRun(id, payload, { dryRun: values['dry-run'] ?? false })
      console.log(JSON.stringify(result))
      return result.status === 'succeeded' ? 0 : 1
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
    db.close()
  }
}

process.exitCode = await main(process.argv.slice(2))
