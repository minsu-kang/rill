import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { MIGRATIONS } from '../src/migrations'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-rules-mig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the rules migration', () => {
  it('is the sixth migration', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(6)
    expect(MIGRATIONS[5]).toContain('CREATE TABLE rules')
  })

  it('upgrades a database that stops at migration 5 in place and leaves its rows alone', () => {
    const path = join(dir, 'v5.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    for (const [index, sql] of MIGRATIONS.slice(0, 5).entries()) {
      raw.exec(sql)
      raw.exec(`INSERT INTO schema_migrations (version) VALUES (${index + 1})`)
    }
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 1, 5)")
    raw.exec("INSERT INTO memory_items (id, text, text_key, created_at, updated_at) VALUES ('m', 'Note', 'note', 1, 2)")
    raw.close()

    const db = Db.open(path)
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(db.get('SELECT id, name, dsl, active, created_at FROM workflows')).toEqual({ id: 'w', name: 'wf', dsl: '{}', active: 1, created_at: 5 })
    expect(db.get('SELECT id, text, text_key FROM memory_items')).toEqual({ id: 'm', text: 'Note', text_key: 'note' })
    expect(db.all('SELECT * FROM rules')).toEqual([])
    db.close()
  })

  it('creates the rules table with its columns and its two unique constraints', () => {
    const db = Db.open(':memory:')
    expect(db.all<{ name: string; type: string; notnull: number; pk: number }>('PRAGMA table_info(rules)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ])
    expect(db.run("INSERT INTO rules (id, kind, value, created_at) VALUES ('a', 'allowHost', 'a.com', 1)")).toBe(1)
    expect(() => db.run("INSERT INTO rules (id, kind, value, created_at) VALUES ('b', 'allowHost', 'a.com', 2)")).toThrow()
    expect(() => db.run("INSERT INTO rules (id, kind, value, created_at) VALUES ('a', 'allowHost', 'b.com', 2)")).toThrow()
    db.close()
  })

  it('runs only once on a database that is already up to date', () => {
    const path = join(dir, 'again.db')
    const first = Db.open(path)
    first.run("INSERT INTO rules (id, kind, value, created_at) VALUES ('a', 'forbidNode', 'http.request', 1)")
    first.close()
    const second = Db.open(path)
    expect(second.all('SELECT id, kind, value FROM rules')).toEqual([{ id: 'a', kind: 'forbidNode', value: 'http.request' }])
    expect(second.all('SELECT version FROM schema_migrations')).toHaveLength(MIGRATIONS.length)
    second.close()
  })
})
