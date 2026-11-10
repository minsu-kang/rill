import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { MIGRATIONS } from '../src/migrations'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-mig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migration 2', () => {
  it('upgrades a v1 database in place and keeps its data', () => {
    const path = join(dir, 'v1.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    raw.exec(MIGRATIONS[0]!)
    raw.exec('INSERT INTO schema_migrations (version) VALUES (1)')
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 0, 1)")
    raw.exec("INSERT INTO runs (id, workflow_id, status, trigger_payload, created_at) VALUES ('r', 'w', 'running', '{}', 1)")
    raw.exec(
      "INSERT INTO step_attempts (run_id, node_id, attempt, status, input, output, idempotency_key, started_at, finished_at) VALUES ('r', 'n1', 1, 'succeeded', '{}', '{\"a\":1}', 'r:n1', 1, 2)",
    )
    raw.close()

    const db = Db.open(path)
    const versions = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.map((r) => r.version)).toEqual([1, 2])
    const rows = db.all<{ id: number; node_id: string; status: string; output: string }>(
      'SELECT id, node_id, status, output FROM step_attempts',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 1, node_id: 'n1', status: 'succeeded', output: '{"a":1}' })
    db.close()
  })

  it('accepts skipped attempts after upgrading, and still rejects unknown statuses', () => {
    const db = Db.open(':memory:')
    db.run("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 0, 1)")
    db.run("INSERT INTO runs (id, workflow_id, status, trigger_payload, created_at) VALUES ('r', 'w', 'running', '{}', 1)")
    const insert = (status: string, attempt = 1) =>
      db.run(
        'INSERT INTO step_attempts (run_id, node_id, attempt, status, idempotency_key, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        'r',
        'n1',
        attempt,
        status,
        'r:n1',
        1,
      )
    expect(() => insert('bogus')).toThrow()
    expect(insert('skipped')).toBe(1)
    expect(insert('continued', 2)).toBe(1)
    db.close()
  })

  it('keeps the foreign key from step_attempts to runs', () => {
    const db = Db.open(':memory:')
    expect(() =>
      db.run(
        "INSERT INTO step_attempts (run_id, node_id, attempt, status, idempotency_key, started_at) VALUES ('missing', 'n1', 1, 'running', 'k', 1)",
      ),
    ).toThrow()
    db.close()
  })

  it('is safe to open a migrated database again', () => {
    const path = join(dir, 'again.db')
    Db.open(path).close()
    const db = Db.open(path)
    expect(db.all('SELECT version FROM schema_migrations')).toHaveLength(MIGRATIONS.length)
    db.close()
  })
})
