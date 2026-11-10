import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Store } from '../src/store'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const harness = join(root, 'packages/engine/test/fixtures/harness.ts')

let dir: string
let dbPath: string
let csvPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-kill-'))
  dbPath = join(dir, 'rill.db')
  csvPath = join(dir, 'ledger.csv')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function launch(mode: 'start' | 'recover', hang: boolean) {
  const child = spawn(process.execPath, ['--import', 'tsx', harness, mode, dbPath, csvPath], {
    cwd: root,
    env: { ...process.env, RILL_HANG: hang ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  return { child, output: () => stdout }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

it('resumes after kill -9 without duplicating side effects', async () => {
  const first = launch('start', true)
  await waitFor(() => first.output().includes('READY'))
  first.child.kill('SIGKILL')
  await exited(first.child)

  const db = Db.open(dbPath)
  const store = new Store(db)
  const [interrupted] = store.listRunsByStatus('running')
  expect(interrupted).toBeDefined()
  expect(readFileSync(csvPath, 'utf8')).toBe('receipt,12.5\n')

  const second = launch('recover', false)
  expect(await exited(second.child)).toBe(0)
  const lastLine = second.output().trim().split('\n').at(-1)!
  const [result] = JSON.parse(lastLine) as Array<{ status: string }>
  expect(result?.status).toBe('succeeded')

  expect(readFileSync(csvPath, 'utf8')).toBe('receipt,12.5\n')
  expect(store.getRun(interrupted!.id).status).toBe('succeeded')
  expect(store.listAttempts(interrupted!.id).map((a) => `${a.nodeId}:${a.attempt}:${a.status}`)).toEqual([
    'n1:1:succeeded',
    'n2:1:abandoned',
    'n2:2:succeeded',
  ])
  db.close()
})
