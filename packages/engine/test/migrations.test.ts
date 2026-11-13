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

describe('migration 4', () => {
  it('upgrades a v3 database in place and leaves its rows alone', () => {
    const path = join(dir, 'v3.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    for (const [index, sql] of MIGRATIONS.slice(0, 3).entries()) {
      raw.exec(sql)
      raw.exec(`INSERT INTO schema_migrations (version) VALUES (${index + 1})`)
    }
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 1, 5)")
    raw.exec("INSERT INTO runs (id, workflow_id, status, trigger_payload, created_at) VALUES ('r', 'w', 'succeeded', '{\"a\":1}', 6)")
    raw.exec("INSERT INTO seen_files (workflow_id, fingerprint, path, seen_at, run_id) VALUES ('w', 'f', '/p', 7, 'r')")
    raw.close()

    const db = Db.open(path)
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(db.get('SELECT id, name, dsl, active, created_at FROM workflows')).toEqual({ id: 'w', name: 'wf', dsl: '{}', active: 1, created_at: 5 })
    expect(db.get<{ trigger_payload: string }>('SELECT trigger_payload FROM runs')?.trigger_payload).toBe('{"a":1}')
    expect(db.all('SELECT * FROM seen_files')).toHaveLength(1)
    expect(db.all('SELECT * FROM plans')).toEqual([])
    db.close()
  })

  it('creates the plans table with its checks, defaults, foreign key and indexes', () => {
    const db = Db.open(':memory:')
    const insert = (status: string) =>
      db.run(
        "INSERT INTO plans (id, created_at, status, effort, request_text, attachments) VALUES ('p' || ?, 1, ?, 'medium', 'text', '[]')",
        status,
        status,
      )
    expect(insert('planned')).toBe(1)
    expect(insert('failed')).toBe(1)
    expect(insert('cancelled')).toBe(1)
    expect(() => insert('running')).toThrow()
    expect(db.get('SELECT flag_keys, result, meta, error, workflow_hash, workflow_id, confirmed, model FROM plans WHERE id = ?', 'pplanned')).toEqual({
      flag_keys: '[]',
      result: null,
      meta: null,
      error: null,
      workflow_hash: null,
      workflow_id: null,
      confirmed: null,
      model: null,
    })
    expect(() => db.run("UPDATE plans SET workflow_id = 'missing' WHERE id = 'pplanned'")).toThrow()
    expect(() => db.run("INSERT INTO plans (id, created_at, status, effort, request_text, attachments) VALUES ('pplanned', 1, 'planned', 'low', 't', '[]')")).toThrow()
    const indexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plans'").map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining(['plans_workflow_hash', 'plans_created']))
    db.close()
  })
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
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7])
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
