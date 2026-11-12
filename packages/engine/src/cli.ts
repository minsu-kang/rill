import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { PROVIDER_IDS, providerDescriptor } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { PROTOCOL_VERSION } from '@rill/protocol'
import { UsageError, chooseLlm, prepareAttachmentsDir, resolveConnections } from './cli-config'
import { Db } from './db'
import { Engine, WorkflowValidationError } from './engine'
import { RillServer } from './server/server'

const PROVIDER_TABLE = PROVIDER_IDS.map((id) => `  ${id.padEnd(10)}${providerDescriptor(id).keyEnv}`).join('\n')

const USAGE = `usage:
  rill-engine run <workflow.json> [--db <path>] [--payload <json>] [--dry-run] [--allow <dir>]... [--connections <file.json>]
  rill-engine watch <workflow.json> [--db <path>] [--allow <dir>]... [--connections <file.json>] [--port <n>]
  rill-engine serve [--db <path>] [--allow <dir>]... [--connections <file.json>] [--attachments-dir <dir>] [--port <n>] [--webhook-port <n>] [--shutdown-timeout <ms>]
  rill-engine recover [--db <path>] [--allow <dir>]... [--connections <file.json>]

Every command accepts --llm-provider <id> (default anthropic), --llm-model <id> and --llm-no-fallback. The chosen provider serves llm.extract steps and, for serve, the planner. Providers and the environment variable that holds each key:
${PROVIDER_TABLE}
--llm-model defaults to claude-opus-5-5 for anthropic and is required for every other provider; an unknown model, or a Meta model whose id ends in -contributor, is refused. --llm-no-fallback turns off the Anthropic refusal fallback and has no effect on the other providers. When the key of a provider other than anthropic is missing the engine starts without a model provider: plan requests fail with LLM_UNAVAILABLE and llm.extract steps fail. The llmModels method lists the models, which providers have a key and the active model, and never returns a key.

Connections can also come from the RILL_CONNECTIONS environment variable, which holds the same JSON text as the file. It is read once and removed from the environment, and it cannot be combined with --connections.

serve reads its access token from the RILL_TOKEN environment variable (16 or more characters from A-Z, a-z, 0-9 and !#$%&'*+-.^_\`|~) and prints a generated one when it is not set.

Connections file: a JSON object that maps a connection name to either a secret string or {"secret": "...", "kind": "slack" | "http" | "webhookSecret"}. Nodes can use both forms. Only the second form is offered to the planner, by name and kind and never with the secret.

Planning: serve answers the planner methods (plan, cancelPlan, getPlan, listPlans, deployPlan) with the chosen provider and the key in its environment variable (ANTHROPIC_API_KEY unless --llm-provider says otherwise). It can only propose file paths inside the --allow folders, so without --allow it cannot propose reading or writing files. Plan attachments are read from --attachments-dir (created with mode 0700 when missing, and inside an --allow folder when any is given). A client puts each file there as <id>.<ext> and sends only the id over the protocol.`

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

function toModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(value)) {
    throw new UsageError('--llm-model must be a model id such as claude-opus-5-5')
  }
  return value
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
      'llm-provider': { type: 'string' },
      'llm-model': { type: 'string' },
      'llm-no-fallback': { type: 'boolean' },
      'attachments-dir': { type: 'string' },
    },
  })
  const [command, file] = positionals
  let db: Db | undefined
  let engine: Engine | undefined
  try {
    const port = toPort('--port', values.port)
    const webhookPort = toPort('--webhook-port', values['webhook-port'])
    const shutdownTimeout = toMillis('--shutdown-timeout', values['shutdown-timeout'], 10_000)
    const llmModel = toModel(values['llm-model'])
    const chosen = chooseLlm({
      ...(values['llm-provider'] === undefined ? {} : { provider: values['llm-provider'] }),
      ...(llmModel === undefined ? {} : { model: llmModel }),
      noFallback: values['llm-no-fallback'] ?? false,
      env: process.env,
    })
    const unconfigured = chosen.llm === undefined ? PROVIDER_IDS.find((id) => id === values['llm-provider']) : undefined
    if (unconfigured !== undefined) {
      console.error(`${providerDescriptor(unconfigured).keyEnv} is not set; planning and llm.extract are unavailable`)
    }
    const connections = resolveConnections({ file: values.connections, env: process.env })
    if (values['attachments-dir'] !== undefined && command !== 'serve') {
      throw new UsageError('--attachments-dir is only used by serve')
    }
    const attachmentsRoot =
      values['attachments-dir'] === undefined ? undefined : prepareAttachmentsDir(values['attachments-dir'], values.allow)
    db = Db.open(values.db ?? 'rill.db')
    engine = new Engine({
      db,
      registry: createCoreRegistry(),
      allowedRoots: values.allow,
      connections: connections.resolver,
      planConnections: connections.planConnections,
      ...(attachmentsRoot === undefined ? {} : { attachmentsRoot }),
      webhookPort: command === 'serve' ? webhookPort : port,
      ...(chosen.llm === undefined ? {} : { llm: chosen.llm }),
      llmInfo: chosen.info,
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
