import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCoreRegistry } from '@rill/nodes-core'
import { AGENT_BUILTIN_NAMES, AGENT_DEFAULT_ID, AGENT_MAX_ITEMS, AgentSchema, type AgentFields } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentBuiltinError,
  AgentDuplicateError,
  AgentFullError,
  AgentInvalidError,
  AgentNotFoundError,
  builtinAgent,
  normaliseAgent,
} from '../src/agents'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { normaliseMemoryText, MemoryInvalidError } from '../src/memory'
import { MIGRATIONS } from '../src/migrations'
import { Store } from '../src/store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-agents-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base: AgentFields = { name: 'Reviewer', description: 'Short answers', persona: 'Calm and brief.', instructions: 'Prefer one node less.' }

function make(options: { db?: Db } = {}) {
  let tick = 1000
  const db = options.db ?? Db.open(':memory:')
  const engine = new Engine({ db, registry: createCoreRegistry(), now: () => (tick += 10) })
  return { db, engine }
}

function save(engine: Engine, overrides: Partial<AgentFields> & { id?: string } = {}) {
  return engine.saveAgent({ ...base, ...overrides })
}

function problemsOf(input: Partial<AgentFields>): string[] {
  try {
    normaliseAgent({ ...base, ...input })
  } catch (error) {
    if (error instanceof AgentInvalidError) return error.problems.map((line) => line.split(':')[0]!)
    throw error
  }
  return []
}

describe('the built-in agent', () => {
  it('is virtual: id default, built in, no persona and no instructions, timestamps zero', () => {
    const agent = builtinAgent()
    expect(agent).toMatchObject({ id: AGENT_DEFAULT_ID, builtin: true, persona: '', instructions: '', createdAt: 0, updatedAt: 0 })
    expect(agent.name).not.toBe('')
    expect(Value.Check(AgentSchema, agent)).toBe(true)
  })

  it('is always first in the list, also on an empty database, and is never stored', () => {
    const { engine, db } = make()
    expect(engine.listAgents()).toEqual({ agents: [builtinAgent()], activeId: 'default' })
    save(engine, { name: 'Another' })
    expect(engine.listAgents().agents[0]).toEqual(builtinAgent())
    expect(db.all('SELECT * FROM agents WHERE id = ?', 'default')).toEqual([])
  })

  it('cannot be saved over, with or without an id, and cannot be deleted', () => {
    const { engine } = make()
    expect(() => save(engine, { id: 'default' })).toThrow(AgentBuiltinError)
    expect(() => save(engine, { id: 'default', name: '' })).toThrow(AgentBuiltinError)
    expect(() => engine.deleteAgent('default')).toThrow(AgentBuiltinError)
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('is returned by the store for its id, without a row, and an unknown id is undefined', () => {
    const store = new Store(Db.open(':memory:'))
    expect(store.getAgent('default')).toEqual(builtinAgent())
    expect(store.getAgent('missing')).toBeUndefined()
  })

  it('can be made the active agent', () => {
    const { engine } = make()
    const agent = save(engine)
    engine.setActiveAgent(agent.id)
    engine.setActiveAgent('default')
    expect(engine.listAgents().activeId).toBe('default')
  })
})

describe('agents in the engine', () => {
  it('creates an agent with a generated id, both timestamps and normalised text', () => {
    const { engine } = make()
    const agent = save(engine, { name: '  My   Agent ', persona: ' calm \n', instructions: '\nline one\nline two\n' })
    expect(agent).toMatchObject({ name: 'My Agent', persona: 'calm', instructions: 'line one\nline two', description: 'Short answers', builtin: false })
    expect(agent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(agent.createdAt).toBe(agent.updatedAt)
    expect(Value.Check(AgentSchema, agent)).toBe(true)
    expect(engine.listAgents().agents).toEqual([builtinAgent(), agent])
  })

  it('gives every agent its own random id', () => {
    const { engine } = make()
    const ids = new Set(Array.from({ length: 5 }, (_, index) => save(engine, { name: `agent ${index}` }).id))
    expect(ids.size).toBe(5)
  })

  it('lists the built-in agent first and then the saved agents by name', () => {
    const { engine } = make()
    save(engine, { name: 'charlie' })
    save(engine, { name: 'Alpha' })
    save(engine, { name: 'bravo' })
    expect(engine.listAgents().agents.slice(1).map((agent) => agent.name)).toEqual(['Alpha', 'bravo', 'charlie'])
    expect(engine.listAgents().agents[0]!.id).toBe('default')
  })

  it('keeps the order by name when an agent is renamed', () => {
    const { engine } = make()
    const first = save(engine, { name: 'a-agent' })
    save(engine, { name: 'b-agent' })
    save(engine, { id: first.id, name: 'z-agent' })
    expect(engine.listAgents().agents.slice(1).map((agent) => agent.name)).toEqual(['b-agent', 'z-agent'])
  })

  it('edits an agent in place: the id and createdAt stay, updatedAt moves', () => {
    const { engine } = make()
    const created = save(engine)
    const edited = save(engine, { id: created.id, name: 'Renamed', persona: 'new persona' })
    expect(edited).toMatchObject({ id: created.id, name: 'Renamed', persona: 'new persona', createdAt: created.createdAt })
    expect(edited.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(engine.listAgents().agents.slice(1)).toEqual([edited])
  })

  it('lets an agent be saved again with its own name, or with only the case of its name changed', () => {
    const { engine } = make()
    const agent = save(engine, { name: 'my agent' })
    expect(save(engine, { id: agent.id, name: 'my agent' }).name).toBe('my agent')
    expect(save(engine, { id: agent.id, name: 'My Agent' }).name).toBe('My Agent')
  })

  it('refuses an edit of an unknown id with AgentNotFoundError', () => {
    const { engine } = make()
    expect(() => save(engine, { id: 'missing' })).toThrow(AgentNotFoundError)
  })

  it('checks the text before it looks the id up', () => {
    const { engine } = make()
    expect(() => save(engine, { id: 'missing', name: '' })).toThrow(AgentInvalidError)
  })

  it('refuses invalid text and saves nothing', () => {
    const { engine } = make()
    expect(() => save(engine, { name: 'bad\nname' })).toThrow(AgentInvalidError)
    expect(() => save(engine, { instructions: 'x'.repeat(3001) })).toThrow(AgentInvalidError)
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('refuses a duplicate name, ignoring case, spacing and NFC form', () => {
    const { engine } = make()
    save(engine, { name: 'café helper' })
    expect(() => save(engine, { name: 'café helper' })).toThrow(AgentDuplicateError)
    expect(() => save(engine, { name: 'CAFÉ HELPER' })).toThrow(AgentDuplicateError)
    expect(() => save(engine, { name: 'café   helper' })).toThrow(AgentDuplicateError)
    expect(engine.listAgents().agents).toHaveLength(2)
  })

  it('refuses a name that looks the same apart from invisible characters', () => {
    const { engine } = make()
    save(engine, { name: 'Work' })
    for (const name of ['Wo\u200drk', 'Wo\u200crk', 'Wo\u034frk', 'WORK\ufe0f', 'Wo\u3164rk']) expect(() => save(engine, { name }), name).toThrow(AgentDuplicateError)
    expect(engine.listAgents().agents).toHaveLength(2)
  })

  it('refuses a name that shows nothing, and saves nothing', () => {
    const { engine } = make()
    for (const name of ['\u200d', '\u3164', '\u2800', '\u034f\ufe0f']) expect(() => save(engine, { name }), name).toThrow(AgentInvalidError)
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('keeps the names of the built-in agent for itself, when creating and when renaming', () => {
    const { engine } = make()
    const other = save(engine, { name: 'other' })
    expect(AGENT_BUILTIN_NAMES).toContain(builtinAgent().name)
    for (const name of ['Default', 'default', ' DEFAULT ', 'D\u200default', '기본']) {
      expect(() => save(engine, { name }), name).toThrow(AgentDuplicateError)
      expect(() => save(engine, { id: other.id, name }), name).toThrow(AgentDuplicateError)
    }
    expect(engine.listAgents().agents.map((agent) => agent.name)).toEqual(['Default', 'other'])
    expect(save(engine, { name: 'Default agent' }).name).toBe('Default agent')
  })

  it('refuses to rename an agent into a copy of another name', () => {
    const { engine } = make()
    save(engine, { name: 'first' })
    const second = save(engine, { name: 'second' })
    expect(() => save(engine, { id: second.id, name: 'FIRST' })).toThrow(AgentDuplicateError)
    expect(engine.listAgents().agents.slice(1).map((agent) => agent.name)).toEqual(['first', 'second'])
  })

  it('lets two agents share a description, a persona and instructions', () => {
    const { engine } = make()
    save(engine, { name: 'one' })
    expect(save(engine, { name: 'two' }).persona).toBe(base.persona)
  })

  it('lets a deleted name be used again', () => {
    const { engine } = make()
    const agent = save(engine, { name: 'again' })
    engine.deleteAgent(agent.id)
    expect(save(engine, { name: 'AGAIN' }).id).not.toBe(agent.id)
  })

  it('deletes an agent once: the second delete says false', () => {
    const { engine } = make()
    const agent = save(engine)
    expect(engine.deleteAgent(agent.id)).toBe(true)
    expect(engine.deleteAgent(agent.id)).toBe(false)
    expect(engine.deleteAgent('never-existed')).toBe(false)
    expect(engine.listAgents().agents).toEqual([builtinAgent()])
  })

  it('accepts 12 agents and refuses the 13th with AgentFullError', () => {
    const { engine } = make()
    for (let index = 0; index < AGENT_MAX_ITEMS; index++) save(engine, { name: `agent ${index}` })
    expect(() => save(engine, { name: 'one too many' })).toThrow(AgentFullError)
    expect(engine.listAgents().agents).toHaveLength(AGENT_MAX_ITEMS + 1)
  })

  it('frees a slot when an agent is deleted, and still edits when full', () => {
    const { engine } = make()
    const ids = Array.from({ length: AGENT_MAX_ITEMS }, (_, index) => save(engine, { name: `agent ${index}` }).id)
    expect(save(engine, { id: ids[0]!, name: 'agent zero, edited' }).name).toBe('agent zero, edited')
    engine.deleteAgent(ids[1]!)
    expect(save(engine, { name: 'fits again' }).name).toBe('fits again')
    expect(() => save(engine, { name: 'and now full again' })).toThrow(AgentFullError)
  })

  it('reports a duplicate before a full list, and invalid text before both', () => {
    const { engine } = make()
    for (let index = 0; index < AGENT_MAX_ITEMS; index++) save(engine, { name: `agent ${index}` })
    expect(() => save(engine, { name: 'AGENT 3' })).toThrow(AgentDuplicateError)
    expect(() => save(engine, { name: '' })).toThrow(AgentInvalidError)
  })

  it('stores the case-folded name as the key and the normalised name as the name', () => {
    const { db, engine } = make()
    save(engine, { name: '  Mixed   CASE Name ' })
    expect(db.get('SELECT name, name_key FROM agents')).toEqual({ name: 'Mixed CASE Name', name_key: 'mixed case name' })
  })

  it('enforces the name key as unique in the database itself', () => {
    const { db } = make()
    const insert = "INSERT INTO agents (id, name, name_key, description, persona, instructions, created_at, updated_at) VALUES (?, 'N', 'n', '', '', '', 1, 1)"
    db.run(insert, 'a')
    expect(() => db.run(insert, 'b')).toThrow()
  })

  it('works on an engine that has no model provider', () => {
    const { engine } = make()
    const agent = save(engine)
    expect(engine.listAgents().agents).toContainEqual(agent)
    expect(engine.deleteAgent(agent.id)).toBe(true)
  })
})

describe('normaliseAgent', () => {
  it('names the field and the rule in the problems and keeps the text out of them', () => {
    const marker = 'AGENT-MARKER-91d3'
    try {
      normaliseAgent({ name: `${marker}\nx`, description: '', persona: `${marker}\u202e`, instructions: marker.repeat(1000) })
      throw new Error('expected an AgentInvalidError')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentInvalidError)
      const invalid = error as AgentInvalidError
      expect(invalid.problems).toEqual([
        expect.stringMatching(/^name\.control_character: /),
        expect.stringMatching(/^persona\.bidi_format: /),
        expect.stringMatching(/^instructions\.too_long: /),
      ])
      expect(JSON.stringify({ message: invalid.message, problems: invalid.problems })).not.toContain(marker)
    }
  })

  it('refuses a persona or instructions with a carriage return, but allows a line feed', () => {
    expect(problemsOf({ persona: 'a\rb' })).toEqual(['persona.control_character'])
    expect(problemsOf({ instructions: 'a\nb' })).toEqual([])
    expect(problemsOf({ name: 'a\nb' })).toEqual(['name.control_character'])
  })

  it('rejects the same characters as a memory note does, apart from the line feed of the long fields', () => {
    const samples = ['\u0000', '\t', '\u0085', '\u2028', '\u2029', '\u202e', '\u200f', '\u200b', '\ufeff', '\u{e0041}', '\u{e0100}', '\u00ad', 'plain', '👨\u200d👩', 'a\u200cb']
    for (const sample of samples) {
      let memory = true
      try {
        normaliseMemoryText(`one${sample}two`)
      } catch (error) {
        if (!(error instanceof MemoryInvalidError)) throw error
        memory = false
      }
      expect(problemsOf({ name: `one${sample}two` }).length === 0, JSON.stringify(sample)).toBe(memory)
    }
  })
})

describe('the active agent', () => {
  it('starts as the built-in agent', () => {
    const { engine } = make()
    expect(engine.listAgents().activeId).toBe('default')
  })

  it('is stored by setActiveAgent and shown by listAgents', () => {
    const { engine } = make()
    const agent = save(engine)
    engine.setActiveAgent(agent.id)
    expect(engine.listAgents().activeId).toBe(agent.id)
  })

  it('refuses an unknown id with AgentNotFoundError and keeps the active agent', () => {
    const { engine } = make()
    const agent = save(engine)
    engine.setActiveAgent(agent.id)
    expect(() => engine.setActiveAgent('missing')).toThrow(AgentNotFoundError)
    expect(engine.listAgents().activeId).toBe(agent.id)
  })

  it('goes back to the built-in agent when the active agent is deleted', () => {
    const { engine } = make()
    const keep = save(engine, { name: 'keep' })
    const gone = save(engine, { name: 'gone' })
    engine.setActiveAgent(gone.id)
    engine.deleteAgent(gone.id)
    expect(engine.listAgents().activeId).toBe('default')
    engine.setActiveAgent(keep.id)
    engine.deleteAgent(gone.id)
    expect(engine.listAgents().activeId).toBe(keep.id)
  })

  it('stays when another agent is deleted', () => {
    const { engine } = make()
    const active = save(engine, { name: 'active' })
    const other = save(engine, { name: 'other' })
    engine.setActiveAgent(active.id)
    engine.deleteAgent(other.id)
    expect(engine.listAgents().activeId).toBe(active.id)
  })

  it('reads as the built-in agent when the stored id points at an agent that is not there', () => {
    const { engine, db } = make()
    db.run("INSERT INTO app_state (key, value) VALUES ('active_agent', 'ghost')")
    expect(engine.listAgents().activeId).toBe('default')
  })

  it('persists across a reopened database file, with the agents', () => {
    const path = join(dir, 'agents.db')
    const first = make({ db: Db.open(path) })
    const agent = save(first.engine)
    first.engine.setActiveAgent(agent.id)
    first.db.close()
    const second = make({ db: Db.open(path) })
    expect(second.engine.listAgents()).toEqual({ agents: [builtinAgent(), agent], activeId: agent.id })
    second.db.close()
  })

  it('is one row of the state table, replaced and not added to', () => {
    const { engine, db } = make()
    const one = save(engine, { name: 'one' })
    const two = save(engine, { name: 'two' })
    engine.setActiveAgent(one.id)
    engine.setActiveAgent(two.id)
    expect(db.all('SELECT key, value FROM app_state')).toEqual([{ key: 'active_agent', value: two.id }])
  })
})

describe('agent writes are one transaction', () => {
  it('checks and writes between BEGIN and COMMIT', () => {
    const { db, engine } = make()
    const log: string[] = []
    const transaction = db.transaction.bind(db)
    db.transaction = ((fn: () => unknown) => {
      log.push('BEGIN')
      const result = transaction(fn)
      log.push('COMMIT')
      return result
    }) as typeof db.transaction
    const agent = save(engine)
    engine.setActiveAgent(agent.id)
    engine.deleteAgent(agent.id)
    expect(log).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
  })

  it('leaves the active agent in place when a delete fails halfway', () => {
    const { db, engine } = make()
    const agent = save(engine)
    engine.setActiveAgent(agent.id)
    const run = db.run.bind(db)
    db.run = ((sql: string, ...params: never[]) => {
      if (sql.startsWith('DELETE FROM app_state')) throw new Error('disk full')
      return run(sql, ...params)
    }) as typeof db.run
    expect(() => engine.deleteAgent(agent.id)).toThrow('disk full')
    db.run = run
    expect(engine.listAgents().agents).toContainEqual(agent)
    expect(engine.listAgents().activeId).toBe(agent.id)
  })
})

describe('the agents migration', () => {
  function previous(path: string): void {
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    for (const [index, sql] of MIGRATIONS.slice(0, 5).entries()) {
      raw.exec(sql)
      raw.exec(`INSERT INTO schema_migrations (version) VALUES (${index + 1})`)
    }
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 1, 5)")
    raw.exec("INSERT INTO memory_items (id, text, text_key, created_at, updated_at) VALUES ('m1', 'A note', 'a note', 1, 2)")
    raw.exec(
      "INSERT INTO plans (id, created_at, status, effort, model, request_text, attachments, memory_ids) VALUES ('old-plan', 3, 'failed', 'low', NULL, 'old text', '[]', '[\"m1\"]')",
    )
    raw.close()
  }

  it('upgrades the previous schema in place and keeps the old plans, the memory and the workflows', () => {
    const path = join(dir, 'before-agents.db')
    previous(path)
    const db = Db.open(path)
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(db.get('SELECT id, name, active FROM workflows')).toEqual({ id: 'w', name: 'wf', active: 1 })
    expect(db.get('SELECT id, text FROM memory_items')).toEqual({ id: 'm1', text: 'A note' })
    expect(db.get('SELECT id, request_text, memory_ids, agent_id FROM plans')).toEqual({ id: 'old-plan', request_text: 'old text', memory_ids: '["m1"]', agent_id: null })
    expect(db.all('SELECT * FROM agents')).toEqual([])
    expect(db.all('SELECT * FROM app_state')).toEqual([])
    const engine = new Engine({ db, registry: createCoreRegistry() })
    expect(engine.getPlan('old-plan').agentId).toBeUndefined()
    expect(engine.listMemory()).toHaveLength(1)
    expect(engine.listAgents()).toEqual({ agents: [builtinAgent()], activeId: 'default' })
    db.close()
  })

  it('is safe to open the migrated file again', () => {
    const path = join(dir, 'again.db')
    previous(path)
    Db.open(path).close()
    const again = Db.open(path)
    expect(again.all('SELECT version FROM schema_migrations')).toHaveLength(MIGRATIONS.length)
    again.close()
  })

  it('creates the agents table with the unique key and the state table', () => {
    const db = Db.open(':memory:')
    const columns = (table: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name)
    expect(columns('agents')).toEqual(['id', 'name', 'name_key', 'description', 'persona', 'instructions', 'created_at', 'updated_at', 'kind', 'skill_ids'])
    expect(columns('app_state')).toEqual(['key', 'value'])
    expect(columns('plans')).toContain('agent_id')
    db.close()
  })
})
