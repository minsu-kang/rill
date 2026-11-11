import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Db } from '../src/db'
import { exited, waitFor } from './process'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-busy-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('waits for another process to release the write lock instead of failing at once', async () => {
  const path = join(dir, 'busy.db')
  const db = Db.open(path)
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite')
       const other = new DatabaseSync(process.argv[1])
       other.exec('BEGIN IMMEDIATE')
       console.log('locked')
       setTimeout(() => { other.exec('COMMIT'); process.exit(0) }, 400)`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  let output = ''
  holder.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  await waitFor(() => output.includes('locked'))

  const started = Date.now()
  db.run("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 0, 1)")
  expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  expect(db.all('SELECT id FROM workflows')).toHaveLength(1)
  expect(await exited(holder)).toBe(0)
  db.close()
})
