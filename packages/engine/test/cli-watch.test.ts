import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Store } from '../src/store'
import { exited, waitFor } from './process'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-watch-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeWatchWorkflow(folder: string, csv: string): string {
  const file = join(dir, 'wf.json')
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      name: 'watch',
      nodes: [
        { id: 't1', type: 'trigger.folderWatch@1', config: { folder, glob: '*.txt', pollMs: 200, stableMs: 0 } },
        { id: 'n1', type: 'csv.append@1', config: { file: csv, row: ['{{t1.output.name}}'] } },
      ],
      edges: [{ from: 't1', to: 'n1' }],
    }),
  )
  return file
}

async function watchSession(workflowFile: string, dbPath: string, expectedRuns: number, afterActivated: () => void) {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'watch', workflowFile, '--db', dbPath, '--allow', dir], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const finished = () => (output.match(/"type":"run\.finished"/g) ?? []).length
  try {
    await waitFor(() => output.includes('workflow.activated'))
    afterActivated()
    await waitFor(() => finished() >= expectedRuns)
    await new Promise((resolve) => setTimeout(resolve, 600))
    child.kill('SIGTERM')
    expect(await exited(child)).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; status?: string })
}

it('watches a folder, runs the workflow for a new file, and stops cleanly on SIGTERM', async () => {
  const folder = join(dir, 'in')
  mkdirSync(folder)
  const csv = join(dir, 'out.csv')
  const dbPath = join(dir, 'watch.db')
  const file = writeWatchWorkflow(folder, csv)

  const events = await watchSession(file, dbPath, 1, () => writeFileSync(join(folder, 'a.txt'), 'x'))

  expect(events.map((e) => e.type)).toEqual(
    expect.arrayContaining(['workflow.activated', 'trigger.fired', 'run.started', 'step.succeeded', 'run.finished']),
  )
  expect(events.find((e) => e.type === 'run.finished')?.status).toBe('succeeded')
  expect(events.at(-1)?.type).toBe('workflow.deactivated')
  expect(readFileSync(csv, 'utf8')).toBe('a.txt\n')

  const db = Db.open(dbPath)
  expect(new Store(db).listActiveWorkflowIds()).toEqual([])
  db.close()
})

it('picks up a file that arrived while it was stopped, and does not repeat an earlier file', async () => {
  const folder = join(dir, 'in')
  mkdirSync(folder)
  const csv = join(dir, 'out.csv')
  const dbPath = join(dir, 'watch.db')
  const file = writeWatchWorkflow(folder, csv)

  await watchSession(file, dbPath, 1, () => writeFileSync(join(folder, 'a.txt'), 'x'))
  writeFileSync(join(folder, 'b.txt'), 'y')
  await watchSession(file, dbPath, 1, () => undefined)

  expect(readFileSync(csv, 'utf8')).toBe('a.txt\nb.txt\n')
  const db = Db.open(dbPath)
  expect(db.all('SELECT id FROM workflows')).toHaveLength(1)
  db.close()
})

it('exits 1 with a message when the watched workflow cannot be activated', async () => {
  const file = join(dir, 'wf.json')
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      name: 'bad',
      nodes: [{ id: 't1', type: 'trigger.folderWatch@1', config: { folder: join(dir, 'missing') } }],
      edges: [],
    }),
  )
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'watch', file, '--db', join(dir, 'bad.db')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  expect(await exited(child)).toBe(1)
  expect(stderr).toContain('folder does not exist')
})
