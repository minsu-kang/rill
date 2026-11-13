import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCoreRegistry } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { MIGRATIONS } from '../src/migrations'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-skills-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const AGENTS_MIGRATION = 7
const SKILLS_MIGRATION = 8

function previous(path: string): void {
  const raw = new DatabaseSync(path)
  raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
  for (const [index, sql] of MIGRATIONS.slice(0, AGENTS_MIGRATION).entries()) {
    raw.exec(sql)
    raw.exec(`INSERT INTO schema_migrations (version) VALUES (${index + 1})`)
  }
  raw.exec("INSERT INTO agents (id, name, name_key, description, persona, instructions, created_at, updated_at) VALUES ('a1', 'Terse', 'terse', 'd', 'p', 'i', 5, 6)")
  raw.exec("INSERT INTO agents (id, name, name_key, description, persona, instructions, created_at, updated_at) VALUES ('a2', 'Zed', 'zed', '', '', '', 7, 8)")
  raw.exec("INSERT INTO app_state (key, value) VALUES ('active_agent', 'a2')")
  raw.exec("INSERT INTO plans (id, created_at, status, effort, model, request_text, attachments, agent_id) VALUES ('old-plan', 3, 'failed', 'low', NULL, 'old text', '[]', 'a1')")
  raw.close()
}

describe('the skills migration', () => {
  it('is the migration after the hooks one', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(SKILLS_MIGRATION)
    expect(MIGRATIONS[AGENTS_MIGRATION]).toMatch(/CREATE TABLE hooks/)
    expect(MIGRATIONS[SKILLS_MIGRATION]).toMatch(/CREATE TABLE skills/)
  })

  it('upgrades the previous schema in place: agents become assistants without skills, and nothing else changes', () => {
    const path = join(dir, 'before-skills.db')
    previous(path)
    const db = Db.open(path)
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    )
    expect(db.all('SELECT id, name, kind, skill_ids, created_at, updated_at FROM agents ORDER BY id')).toEqual([
      { id: 'a1', name: 'Terse', kind: 'assistant', skill_ids: '[]', created_at: 5, updated_at: 6 },
      { id: 'a2', name: 'Zed', kind: 'assistant', skill_ids: '[]', created_at: 7, updated_at: 8 },
    ])
    expect(db.all('SELECT * FROM skills')).toEqual([])
    expect(db.get('SELECT id, request_text, agent_id FROM plans')).toEqual({ id: 'old-plan', request_text: 'old text', agent_id: 'a1' })
    const engine = new Engine({ db, registry: createCoreRegistry() })
    const listed = engine.listAgents()
    expect(listed.activeId).toBe('a2')
    expect(listed.agents.slice(1)).toMatchObject([
      { id: 'a1', kind: 'assistant', skillIds: [], persona: 'p', instructions: 'i' },
      { id: 'a2', kind: 'assistant', skillIds: [] },
    ])
    expect(engine.listSkills()).toEqual([])
    db.close()
  })

  it('is safe to open the migrated file again, and keeps what was saved in between', () => {
    const path = join(dir, 'again.db')
    previous(path)
    const first = Db.open(path)
    const engine = new Engine({ db: first, registry: createCoreRegistry() })
    const skill = engine.saveSkill({ name: 'Kept', description: '', body: 'body' })
    engine.saveAgent({ id: 'a1', name: 'Terse', description: 'd', persona: 'p', instructions: 'i', kind: 'reviewer', skillIds: [skill.id] })
    first.close()
    const again = Db.open(path)
    expect(again.all('SELECT version FROM schema_migrations')).toHaveLength(MIGRATIONS.length)
    const reopened = new Engine({ db: again, registry: createCoreRegistry() })
    expect(reopened.listSkills()).toEqual([skill])
    expect(reopened.listAgents().agents.find((agent) => agent.id === 'a1')).toMatchObject({ kind: 'reviewer', skillIds: [skill.id] })
    again.close()
  })

  it('creates the skills table with the unique key, and the new agent columns after the old ones', () => {
    const db = Db.open(':memory:')
    const columns = (table: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name)
    expect(columns('skills')).toEqual(['id', 'name', 'name_key', 'description', 'body', 'created_at', 'updated_at'])
    expect(columns('agents')).toEqual(['id', 'name', 'name_key', 'description', 'persona', 'instructions', 'created_at', 'updated_at', 'kind', 'skill_ids'])
    db.close()
  })

  it('does not change the migrations that were there before', () => {
    expect(MIGRATIONS.slice(0, AGENTS_MIGRATION)).toHaveLength(AGENTS_MIGRATION)
    expect(MIGRATIONS[AGENTS_MIGRATION - 1]).toMatch(/CREATE TABLE agents/)
  })
})
