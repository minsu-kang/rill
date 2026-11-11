import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Workflow } from '@rill/dsl'
import { RillClient, type EngineEvent } from '@rill/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Store } from '../src/store'
import { exited, waitFor } from './process'

function exitCode(child: ChildProcess): Promise<number | null> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve(child.exitCode) : exited(child)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')
const TOKEN = 'cli-serve-token-0123456789abcdef'

let dir: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-serve-'))
})

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

interface Listening {
  type: string
  host: string
  port: number
  protocol: number
  token?: string
}

async function startServe(args: string[], env: Record<string, string> = { RILL_TOKEN: TOKEN }) {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'serve', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  await waitFor(() => stdout.includes('\n') || child.exitCode !== null)
  const line = stdout.split('\n')[0]!
  return { child, stderr: () => stderr, listening: line.startsWith('{') ? (JSON.parse(line) as Listening) : undefined }
}

const csvWorkflow = (csv: string) => ({
  schemaVersion: 1,
  name: 'csv',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'n1', type: 'csv.append@1', config: { file: csv, row: ['{{t1.output.amount}}'] } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
})

const delayWorkflow = (ms: number) => ({
  schemaVersion: 1,
  name: 'slow',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'n1', type: 'delay@1', config: { ms } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
})

function seedRun(dbPath: string, workflow: unknown): string {
  const db = Db.open(dbPath)
  const store = new Store(db)
  const run = store.createRun({ workflowId: store.saveWorkflow(workflow as Workflow), payload: {}, dryRun: false })
  db.close()
  return run.id
}

describe('rill-engine serve', () => {
  it('serves the protocol: deploy, run, stream events, inspect, and stop cleanly on SIGTERM', async () => {
    const csv = join(dir, 'out.csv')
    const { child, listening } = await startServe(['--db', join(dir, 'serve.db'), '--allow', dir])
    expect(listening).toMatchObject({ type: 'listening', host: '127.0.0.1', protocol: 1 })
    expect(listening?.token).toBeUndefined()
    const client = await RillClient.connect(`ws://127.0.0.1:${listening!.port}/`, TOKEN)
    const events: EngineEvent[] = []
    client.onEvent((event) => events.push(event))
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)))

    const { workflowId } = await client.request('deploy', { workflow: csvWorkflow(csv) })
    const { runId } = await client.request('startRun', { workflowId, payload: { amount: 7 } })
    await waitFor(() => events.some((e) => e.type === 'run.finished'))
    expect(events.map((e) => e.type)).toEqual(['run.started', 'step.started', 'step.succeeded', 'run.finished'])
    expect(readFileSync(csv, 'utf8')).toBe('7\n')
    const detail = await client.request('getRun', { runId })
    expect(detail.steps[0]).toMatchObject({ nodeId: 'n1', status: 'succeeded' })
    expect((await client.request('nodeCatalog', {})).nodes.map((n) => n.type)).toContain('csv.append@1')

    child.kill('SIGTERM')
    expect(await exitCode(child)).toBe(0)
    expect(await closed).toBe(1001)
  })

  it('rejects clients with the wrong token', async () => {
    const { listening } = await startServe(['--db', join(dir, 'serve.db')])
    await expect(RillClient.connect(`ws://127.0.0.1:${listening!.port}/`, 'wrong-token-0123456789')).rejects.toThrow(
      'closed before the server said hello',
    )
  })

  it('generates a token when none is given and prints it once', async () => {
    const { child, listening } = await startServe(['--db', join(dir, 'serve.db')], {})
    expect(listening?.token).toMatch(/^[0-9a-f]{64}$/)
    const client = await RillClient.connect(`ws://127.0.0.1:${listening!.port}/`, listening!.token!)
    expect((await client.request('ping', {})).time).toBeGreaterThan(0)
    client.close()
    child.kill('SIGTERM')
    expect(await exitCode(child)).toBe(0)
  })

  it('refuses a token that is too short', async () => {
    const { child, stderr } = await startServe(['--db', join(dir, 'serve.db')], { RILL_TOKEN: 'short' })
    expect(await exitCode(child)).toBe(1)
    expect(stderr()).toContain('token must be at least 16 characters')
  })

  it('finishes runs left over from a crash before it accepts clients', async () => {
    const dbPath = join(dir, 'serve.db')
    const csv = join(dir, 'left.csv')
    const db = Db.open(dbPath)
    const store = new Store(db)
    const workflowId = store.saveWorkflow(csvWorkflow(csv) as Workflow)
    const run = store.createRun({ workflowId, payload: { amount: 9 }, dryRun: false })
    db.close()
    const { child, listening } = await startServe(['--db', dbPath, '--allow', dir])
    const client = await RillClient.connect(`ws://127.0.0.1:${listening!.port}/`, TOKEN)
    expect((await client.request('getRun', { runId: run.id })).run.status).toBe('succeeded')
    expect(readFileSync(csv, 'utf8')).toBe('9\n')
    client.close()
    child.kill('SIGTERM')
    expect(await exitCode(child)).toBe(0)
  })

  it('listens before it recovers, and stops within the shutdown timeout while a run is active', async () => {
    const dbPath = join(dir, 'serve.db')
    const runId = seedRun(dbPath, delayWorkflow(30_000))
    const { child, listening, stderr } = await startServe(['--db', dbPath, '--shutdown-timeout', '300'])
    const client = await RillClient.connect(`ws://127.0.0.1:${listening!.port}/`, TOKEN)
    let status = ''
    for (let i = 0; i < 200 && status !== 'running'; i += 1) {
      status = (await client.request('getRun', { runId })).run.status
      if (status !== 'running') await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(status).toBe('running')
    client.close()
    const stopped = Date.now()
    child.kill('SIGTERM')
    expect(await exitCode(child)).toBe(0)
    expect(Date.now() - stopped).toBeLessThan(5000)
    await waitFor(() => stderr().includes('runs are still active'))
    const db = Db.open(dbPath)
    expect(new Store(db).getRunSummary(runId).status).toBe('running')
    db.close()
  })

  it('exits with 1 on a second signal while it is still shutting down', async () => {
    const dbPath = join(dir, 'serve.db')
    seedRun(dbPath, delayWorkflow(30_000))
    const { child } = await startServe(['--db', dbPath, '--shutdown-timeout', '60000'])
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    child.kill('SIGTERM')
    expect(await exitCode(child)).toBe(1)
  })

  it.each([
    [['--port', 'abc'], '--port must be a whole number'],
    [['--port', '70000'], '--port must be a whole number'],
    [['--webhook-port=-1'], '--webhook-port must be a whole number'],
    [['--shutdown-timeout', 'soon'], '--shutdown-timeout must be a whole number'],
  ])('rejects %j with the usage and exit 2', async (args, message) => {
    const { child, stderr } = await startServe(['--db', join(dir, 'serve.db'), ...args])
    expect(await exitCode(child)).toBe(2)
    await waitFor(() => stderr().includes(message))
    expect(stderr()).toContain('usage:')
  })

  it('prints one line when the database cannot be opened', async () => {
    const { child, stderr } = await startServe(['--db', join(dir, 'missing', 'x.db')])
    expect(await exitCode(child)).toBe(1)
    await waitFor(() => stderr().includes('unable to open database file'))
    expect(stderr().trim().split('\n')).toHaveLength(1)
  })

  it('refuses a token that no websocket client could send', async () => {
    const { child, stderr } = await startServe(['--db', join(dir, 'serve.db')], {
      RILL_TOKEN: 'has space token 1234567890',
    })
    expect(await exitCode(child)).toBe(1)
    await waitFor(() => stderr().includes('token must be at least 16 characters'))
  })

  it('activates a folder trigger over the protocol and resumes it after a restart', async () => {
    const folder = join(dir, 'in')
    mkdirSync(folder)
    const csv = join(dir, 'files.csv')
    const dbPath = join(dir, 'serve.db')
    const workflow = {
      schemaVersion: 1,
      name: 'folder',
      nodes: [
        { id: 't1', type: 'trigger.folderWatch@1', config: { folder, glob: '*.txt', pollMs: 200, stableMs: 0 } },
        { id: 'n1', type: 'csv.append@1', config: { file: csv, row: ['{{t1.output.name}}'] } },
      ],
      edges: [{ from: 't1', to: 'n1' }],
    }

    const first = await startServe(['--db', dbPath, '--allow', dir])
    const client = await RillClient.connect(`ws://127.0.0.1:${first.listening!.port}/`, TOKEN)
    const events: EngineEvent[] = []
    client.onEvent((event) => events.push(event))
    const { workflowId } = await client.request('deploy', { workflow })
    await client.request('activate', { workflowId })
    writeFileSync(join(folder, 'a.txt'), 'x')
    await waitFor(() => events.some((e) => e.type === 'run.finished'))
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['workflow.activated', 'trigger.fired']))
    first.child.kill('SIGTERM')
    expect(await exitCode(first.child)).toBe(0)

    writeFileSync(join(folder, 'b.txt'), 'y')
    const second = await startServe(['--db', dbPath, '--allow', dir])
    const again = await RillClient.connect(`ws://127.0.0.1:${second.listening!.port}/`, TOKEN)
    await waitFor(() => readFileSync(csv, 'utf8') === 'a.txt\nb.txt\n')
    const { workflows } = await again.request('listWorkflows', {})
    expect(workflows).toEqual([expect.objectContaining({ id: workflowId, active: true })])
    second.child.kill('SIGTERM')
    expect(await exitCode(second.child)).toBe(0)
  })
})
