import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { MIGRATIONS } from '../src/migrations'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-hooks-mig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the hooks migration', () => {
  it('is the eighth migration and creates the hooks table and the hook log', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(8)
    expect(MIGRATIONS[7]).toContain('CREATE TABLE hooks')
    expect(MIGRATIONS[7]).toContain('CREATE TABLE hook_log')
  })

  it('upgrades a database that stops at migration 7 in place and leaves its rows alone', () => {
    const path = join(dir, 'v7.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    for (const [index, sql] of MIGRATIONS.slice(0, 7).entries()) {
      raw.exec(sql)
      raw.exec(`INSERT INTO schema_migrations (version) VALUES (${index + 1})`)
    }
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 1, 5)")
    raw.exec("INSERT INTO runs (id, workflow_id, status, trigger_payload, created_at) VALUES ('r', 'w', 'failed', '{}', 6)")
    raw.exec("INSERT INTO memory_items (id, text, text_key, created_at, updated_at) VALUES ('m', 'Note', 'note', 1, 2)")
    raw.exec("INSERT INTO rules (id, kind, value, created_at) VALUES ('ru', 'forbidNode', 'http.request', 3)")
    raw.exec("INSERT INTO agents (id, name, name_key, description, persona, instructions, created_at, updated_at) VALUES ('a', 'A', 'a', '', '', '', 1, 2)")
    raw.exec("INSERT INTO app_state (key, value) VALUES ('active_agent', 'a')")
    raw.close()

    const db = Db.open(path)
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(db.get('SELECT id, name, dsl, active, created_at FROM workflows')).toEqual({ id: 'w', name: 'wf', dsl: '{}', active: 1, created_at: 5 })
    expect(db.get('SELECT id, status FROM runs')).toEqual({ id: 'r', status: 'failed' })
    expect(db.get('SELECT id, text FROM memory_items')).toEqual({ id: 'm', text: 'Note' })
    expect(db.get('SELECT id, kind, value FROM rules')).toEqual({ id: 'ru', kind: 'forbidNode', value: 'http.request' })
    expect(db.get('SELECT id, name FROM agents')).toEqual({ id: 'a', name: 'A' })
    expect(db.get('SELECT key, value FROM app_state')).toEqual({ key: 'active_agent', value: 'a' })
    expect(db.all('SELECT * FROM hooks')).toEqual([])
    expect(db.all('SELECT * FROM hook_log')).toEqual([])
    db.close()
  })

  it('creates the hooks table with its columns', () => {
    const db = Db.open(':memory:')
    expect(db.all<{ name: string; type: string; notnull: number; pk: number }>('PRAGMA table_info(hooks)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'event', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'scope_workflow_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'action_type', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'connection', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'channel', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'failure_count', type: 'INTEGER', notnull: 0, pk: 0 },
      { name: 'enabled', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'dedupe_key', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ])
    db.close()
  })

  it('creates the hook log with no link to a hook or a workflow, so that rows outlive both', () => {
    const db = Db.open(':memory:')
    expect(db.all<{ name: string; type: string; notnull: number; pk: number }>('PRAGMA table_info(hook_log)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'hook_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'event', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'workflow_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'outcome', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'code', type: 'TEXT', notnull: 0, pk: 0 },
    ])
    expect(db.all('PRAGMA foreign_key_list(hook_log)')).toEqual([])
    expect(db.run("INSERT INTO hook_log (hook_id, at, event, workflow_id, outcome) VALUES ('gone', 1, 'run.failed', 'gone-too', 'ok')")).toBe(1)
    db.close()
  })

  it('runs only once on a database that is already up to date', () => {
    const path = join(dir, 'again.db')
    const first = Db.open(path)
    first.run("INSERT INTO hook_log (hook_id, at, event, workflow_id, outcome) VALUES ('h', 1, 'run.failed', 'w', 'ok')")
    first.close()
    const second = Db.open(path)
    expect(second.all('SELECT hook_id, outcome FROM hook_log')).toEqual([{ hook_id: 'h', outcome: 'ok' }])
    expect(second.all('SELECT version FROM schema_migrations')).toHaveLength(MIGRATIONS.length)
    second.close()
  })
})
