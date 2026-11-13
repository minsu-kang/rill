import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-db-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Db', () => {
  it('creates the schema on open', () => {
    const db = Db.open(':memory:')
    const names = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name)
    for (const table of ['workflows', 'runs', 'step_attempts', 'idempotency_journal', 'schema_migrations']) {
      expect(names).toContain(table)
    }
    db.close()
  })

  it('is safe to open twice and records one migration row per version', () => {
    const path = join(dir, 'a.db')
    Db.open(path).close()
    const db = Db.open(path)
    const versions = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    db.close()
  })

  it('uses WAL for file databases', () => {
    const db = Db.open(join(dir, 'b.db'))
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal')
    db.close()
  })

  it('reports the number of changed rows from run', () => {
    const db = Db.open(':memory:')
    db.run('INSERT INTO idempotency_journal (key, state, data, updated_at) VALUES (?, ?, ?, ?)', 'k', 'intent', null, 1)
    expect(db.run("UPDATE idempotency_journal SET state = 'done' WHERE key = ?", 'k')).toBe(1)
    expect(db.run("UPDATE idempotency_journal SET state = 'done' WHERE key = ?", 'nope')).toBe(0)
    db.close()
  })

  it('rolls a transaction back when the callback throws', () => {
    const db = Db.open(':memory:')
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO idempotency_journal (key, state, data, updated_at) VALUES (?, ?, ?, ?)', 'k', 'intent', null, 1)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.all('SELECT key FROM idempotency_journal')).toHaveLength(0)
    db.close()
  })

  it('enforces foreign keys', () => {
    const db = Db.open(':memory:')
    expect(() =>
      db.run(
        "INSERT INTO runs (id, workflow_id, status, trigger_payload, created_at) VALUES ('r', 'missing', 'queued', '{}', 1)",
      ),
    ).toThrow()
    db.close()
  })
})
