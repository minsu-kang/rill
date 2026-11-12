import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCoreRegistry } from '@rill/nodes-core'
import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS } from '@rill/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { MemoryDuplicateError, MemoryFullError, MemoryInvalidError, memoryKey, normaliseMemoryText } from '../src/memory'
import { MIGRATIONS } from '../src/migrations'
import { NotFoundError } from '../src/store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-memory-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function make(options: { db?: Db } = {}) {
  let tick = 1000
  const db = options.db ?? Db.open(':memory:')
  const engine = new Engine({ db, registry: createCoreRegistry(), now: () => (tick += 10) })
  return { db, engine }
}

function ruleOf(raw: string): string | undefined {
  try {
    normaliseMemoryText(raw)
  } catch (error) {
    if (error instanceof MemoryInvalidError) return error.rule
    throw error
  }
  return undefined
}

describe('normaliseMemoryText', () => {
  it('composes to NFC', () => {
    expect(normaliseMemoryText('cafe\u0301')).toBe('café')
    expect(normaliseMemoryText('\u1112\u1161\u11ab\u1100\u1173\u11af')).toBe('한글')
  })

  it('trims the ends, including no-break and ideographic spaces and a trailing line break', () => {
    expect(normaliseMemoryText('  note  ')).toBe('note')
    expect(normaliseMemoryText('\u00a0\u3000note\u3000\u00a0')).toBe('note')
    expect(normaliseMemoryText('note\n')).toBe('note')
    expect(normaliseMemoryText('\r\n note \t')).toBe('note')
  })

  it('collapses runs of inner spaces to one space', () => {
    expect(normaliseMemoryText('my   receipts \u00a0 live\u3000\u3000here')).toBe('my receipts live here')
  })

  it('keeps a note that is already clean', () => {
    expect(normaliseMemoryText('Alerts go to the connection team-alerts')).toBe('Alerts go to the connection team-alerts')
    expect(normaliseMemoryText('영수증은 ~/Receipts 폴더에 있어요 👍')).toBe('영수증은 ~/Receipts 폴더에 있어요 👍')
  })

  it('accepts 300 characters and refuses 301', () => {
    expect(normaliseMemoryText('x'.repeat(MEMORY_MAX_CHARS))).toHaveLength(MEMORY_MAX_CHARS)
    expect(ruleOf('x'.repeat(MEMORY_MAX_CHARS + 1))).toBe('too_long')
  })

  it('counts a character outside the BMP once', () => {
    expect(ruleOf('😀'.repeat(MEMORY_MAX_CHARS))).toBeUndefined()
    expect(ruleOf('😀'.repeat(MEMORY_MAX_CHARS + 1))).toBe('too_long')
  })

  it('measures the length after trimming and collapsing', () => {
    expect(ruleOf(`   ${'x'.repeat(MEMORY_MAX_CHARS)}   `)).toBeUndefined()
    expect(ruleOf(`${'a'.repeat(148)}${' '.repeat(50)}${'b'.repeat(151)}`)).toBeUndefined()
    expect(ruleOf(`${'a'.repeat(148)}${' '.repeat(50)}${'b'.repeat(152)}`)).toBe('too_long')
  })

  it('refuses an empty note and a note of only whitespace', () => {
    expect(ruleOf('')).toBe('empty')
    expect(ruleOf('   \u00a0\u3000 ')).toBe('empty')
    expect(ruleOf('\n\t')).toBe('empty')
  })

  it.each([
    ['a line feed', 'one\ntwo'],
    ['a carriage return', 'one\rtwo'],
    ['a tab', 'one\ttwo'],
    ['NUL', 'one\u0000two'],
    ['escape', 'one\u001btwo'],
    ['DEL', 'one\u007ftwo'],
    ['a C1 control', 'one\u0085two'],
    ['a C1 control at the end of the range', 'one\u009ftwo'],
  ])('refuses %s inside the note as a control character', (_name, raw) => {
    expect(ruleOf(raw)).toBe('control_character')
  })

  it.each([
    ['a line separator', 'one\u2028two'],
    ['a paragraph separator', 'one\u2029two'],
  ])('refuses %s inside the note', (_name, raw) => {
    expect(ruleOf(raw)).toBe('line_separator')
  })

  it.each(['\u200e', '\u200f', '\u061c', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'])(
    'refuses the bidi format character U+%s',
    (character) => {
      expect(ruleOf(`one${character}two`)).toBe('bidi_format')
      expect(ruleOf(`${character}one`)).toBe('bidi_format')
    },
  )

  it('does not treat the zero-width joiner of an emoji sequence as a bidi character', () => {
    expect(ruleOf('family 👨\u200d👩\u200d👧')).toBeUndefined()
  })

  it('never puts the note into the error', () => {
    const marker = 'NOTE-MARKER-77a2'
    for (const raw of [`${marker}\n${marker}`, `${marker}\u202e`, marker.repeat(100)]) {
      try {
        normaliseMemoryText(raw)
        throw new Error('expected a MemoryInvalidError')
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryInvalidError)
        expect(JSON.stringify({ message: (error as Error).message, problems: (error as MemoryInvalidError).problems, rule: (error as MemoryInvalidError).rule })).not.toContain(marker)
      }
    }
  })

  it('names the rule that failed in the problems', () => {
    try {
      normaliseMemoryText('a\nb')
      throw new Error('expected a MemoryInvalidError')
    } catch (error) {
      expect((error as MemoryInvalidError).problems).toEqual([expect.stringContaining('control_character')])
    }
  })
})

describe('memoryKey', () => {
  it('folds case and whitespace so that copies collide', () => {
    expect(memoryKey('My Receipts LIVE here')).toBe(memoryKey('my receipts live here'))
    expect(memoryKey('CafÉ')).toBe(memoryKey('café'))
    expect(memoryKey('one note')).not.toBe(memoryKey('another note'))
  })
})

describe('memory notes in the engine', () => {
  it('creates a note with a generated id and both timestamps', () => {
    const { engine } = make()
    const item = engine.saveMemory({ text: '  My receipts   live in ~/Receipts ' })
    expect(item.text).toBe('My receipts live in ~/Receipts')
    expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(item.createdAt).toBe(item.updatedAt)
    expect(engine.listMemory()).toEqual([item])
  })

  it('gives every note its own random id', () => {
    const { engine } = make()
    const ids = new Set(Array.from({ length: 5 }, (_, index) => engine.saveMemory({ text: `note ${index}` }).id))
    expect(ids.size).toBe(5)
  })

  it('lists the oldest note first and keeps the order when a note is edited', () => {
    const { engine } = make()
    const first = engine.saveMemory({ text: 'first' })
    const second = engine.saveMemory({ text: 'second' })
    const third = engine.saveMemory({ text: 'third' })
    engine.saveMemory({ id: first.id, text: 'first, edited' })
    expect(engine.listMemory().map((item) => item.text)).toEqual(['first, edited', 'second', 'third'])
    expect(engine.listMemory().map((item) => item.id)).toEqual([first.id, second.id, third.id])
  })

  it('edits a note in place: the id and createdAt stay, updatedAt moves', () => {
    const { engine } = make()
    const created = engine.saveMemory({ text: 'before' })
    const edited = engine.saveMemory({ id: created.id, text: '  after  ' })
    expect(edited).toMatchObject({ id: created.id, text: 'after', createdAt: created.createdAt })
    expect(edited.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(engine.listMemory()).toEqual([edited])
  })

  it('deletes a note once: the second delete says false', () => {
    const { engine } = make()
    const item = engine.saveMemory({ text: 'gone soon' })
    expect(engine.deleteMemory(item.id)).toBe(true)
    expect(engine.deleteMemory(item.id)).toBe(false)
    expect(engine.deleteMemory('never-existed')).toBe(false)
    expect(engine.listMemory()).toEqual([])
  })

  it('refuses an edit of an unknown id with NotFoundError', () => {
    const { engine } = make()
    expect(() => engine.saveMemory({ id: 'missing', text: 'text' })).toThrow(NotFoundError)
  })

  it('checks the text before it looks the id up', () => {
    const { engine } = make()
    expect(() => engine.saveMemory({ id: 'missing', text: '' })).toThrow(MemoryInvalidError)
  })

  it('refuses a duplicate, a differently cased copy and a copy with other whitespace', () => {
    const { engine } = make()
    engine.saveMemory({ text: 'Receipts live in ~/Receipts' })
    expect(() => engine.saveMemory({ text: 'Receipts live in ~/Receipts' })).toThrow(MemoryDuplicateError)
    expect(() => engine.saveMemory({ text: 'RECEIPTS LIVE IN ~/RECEIPTS' })).toThrow(MemoryDuplicateError)
    expect(() => engine.saveMemory({ text: ' receipts   live in ~/receipts ' })).toThrow(MemoryDuplicateError)
    expect(engine.listMemory()).toHaveLength(1)
  })

  it('refuses to edit a note into a copy of another note', () => {
    const { engine } = make()
    engine.saveMemory({ text: 'first' })
    const second = engine.saveMemory({ text: 'second' })
    expect(() => engine.saveMemory({ id: second.id, text: 'FIRST' })).toThrow(MemoryDuplicateError)
    expect(engine.listMemory().map((item) => item.text)).toEqual(['first', 'second'])
  })

  it('lets a note be saved again with its own text, or with only its case changed', () => {
    const { engine } = make()
    const item = engine.saveMemory({ text: 'alerts go to team-alerts' })
    expect(engine.saveMemory({ id: item.id, text: 'Alerts go to team-alerts' }).text).toBe('Alerts go to team-alerts')
    expect(engine.saveMemory({ id: item.id, text: 'Alerts go to team-alerts' }).text).toBe('Alerts go to team-alerts')
  })

  it('lets a deleted note be saved again', () => {
    const { engine } = make()
    const item = engine.saveMemory({ text: 'again' })
    engine.deleteMemory(item.id)
    expect(engine.saveMemory({ text: 'again' }).id).not.toBe(item.id)
  })

  it('accepts 20 notes and refuses the 21st with MemoryFullError', () => {
    const { engine } = make()
    for (let index = 0; index < MEMORY_MAX_ITEMS; index++) engine.saveMemory({ text: `note ${index}` })
    expect(() => engine.saveMemory({ text: 'one too many' })).toThrow(MemoryFullError)
    expect(engine.listMemory()).toHaveLength(MEMORY_MAX_ITEMS)
  })

  it('frees a slot when a note is deleted, and still edits when full', () => {
    const { engine } = make()
    const ids = Array.from({ length: MEMORY_MAX_ITEMS }, (_, index) => engine.saveMemory({ text: `note ${index}` }).id)
    expect(engine.saveMemory({ id: ids[0]!, text: 'note zero, edited' }).text).toBe('note zero, edited')
    engine.deleteMemory(ids[1]!)
    expect(engine.saveMemory({ text: 'fits again' }).text).toBe('fits again')
    expect(() => engine.saveMemory({ text: 'and now full again' })).toThrow(MemoryFullError)
  })

  it('reports a duplicate before a full list', () => {
    const { engine } = make()
    for (let index = 0; index < MEMORY_MAX_ITEMS; index++) engine.saveMemory({ text: `note ${index}` })
    expect(() => engine.saveMemory({ text: 'NOTE 3' })).toThrow(MemoryDuplicateError)
  })

  it('stores the case-folded text as the key and the normalised text as the text', () => {
    const { db, engine } = make()
    engine.saveMemory({ text: '  Mixed   CASE Note ' })
    expect(db.get('SELECT text, text_key FROM memory_items')).toEqual({ text: 'Mixed CASE Note', text_key: 'mixed case note' })
  })

  it('enforces the key as unique in the database itself', () => {
    const { db } = make()
    db.run("INSERT INTO memory_items (id, text, text_key, created_at, updated_at) VALUES ('a', 'A', 'a', 1, 1)")
    expect(() => db.run("INSERT INTO memory_items (id, text, text_key, created_at, updated_at) VALUES ('b', 'a', 'a', 1, 1)")).toThrow()
  })

  it('works on an engine that has no model provider', () => {
    const { engine } = make()
    const item = engine.saveMemory({ text: 'no model needed' })
    expect(engine.listMemory()).toEqual([item])
    expect(engine.deleteMemory(item.id)).toBe(true)
  })

  it('keeps the notes across a reopened database file', () => {
    const path = join(dir, 'notes.db')
    const first = make({ db: Db.open(path) })
    const item = first.engine.saveMemory({ text: 'survives a restart' })
    first.db.close()
    const second = make({ db: Db.open(path) })
    expect(second.engine.listMemory()).toEqual([item])
    second.db.close()
  })
})

describe('memory writes are one transaction', () => {
  it('counts and inserts between BEGIN and COMMIT', () => {
    const { db, engine } = make()
    const log: string[] = []
    const get = db.get.bind(db) as <T>(sql: string, ...params: never[]) => T | undefined
    const run = db.run.bind(db)
    const transaction = db.transaction.bind(db)
    db.get = ((sql: string, ...params: never[]) => {
      log.push(sql)
      return get(sql, ...params)
    }) as typeof db.get
    db.run = (sql, ...params) => {
      log.push(sql)
      return run(sql, ...params)
    }
    db.transaction = ((fn: () => unknown) => {
      log.push('BEGIN')
      const result = transaction(fn)
      log.push('COMMIT')
      return result
    }) as typeof db.transaction
    engine.saveMemory({ text: 'in a transaction' })
    const begin = log.indexOf('BEGIN')
    const commit = log.indexOf('COMMIT')
    const count = log.findIndex((sql) => /COUNT\(\*\)/i.test(sql))
    const insert = log.findIndex((sql) => /INSERT INTO memory_items/i.test(sql))
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(count).toBeGreaterThan(begin)
    expect(insert).toBeGreaterThan(count)
    expect(commit).toBeGreaterThan(insert)
  })

  it('keeps a second connection out while the first has counted, so two saves cannot both take the last slot', () => {
    const path = join(dir, 'race.db')
    const first = make({ db: Db.open(path) })
    const second = make({ db: Db.open(path) })
    second.db.exec('PRAGMA busy_timeout = 20')
    for (let index = 0; index < MEMORY_MAX_ITEMS - 1; index++) first.engine.saveMemory({ text: `note ${index}` })

    let rival: unknown = 'not attempted'
    const get = first.db.get.bind(first.db) as <T>(sql: string, ...params: never[]) => T | undefined
    first.db.get = ((sql: string, ...params: never[]) => {
      const row = get(sql, ...params)
      if (/COUNT\(\*\)/i.test(sql) && rival === 'not attempted') {
        try {
          rival = second.engine.saveMemory({ text: 'the rival' })
        } catch (error) {
          rival = error
        }
      }
      return row
    }) as typeof first.db.get

    first.engine.saveMemory({ text: 'the last slot' })
    expect(rival).toBeInstanceOf(Error)
    expect(rival).not.toBeInstanceOf(MemoryFullError)
    const check = Db.open(path)
    expect(check.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_items')?.n).toBe(MEMORY_MAX_ITEMS)
    expect(() => second.engine.saveMemory({ text: 'the rival, later' })).toThrow(MemoryFullError)
    expect(check.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_items')?.n).toBe(MEMORY_MAX_ITEMS)
    check.close()
    first.db.close()
    second.db.close()
  })
})

describe('migration 5', () => {
  it('upgrades a v4 database in place and keeps its rows', () => {
    const path = join(dir, 'v4.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    for (const [index, sql] of MIGRATIONS.slice(0, 4).entries()) {
      raw.exec(sql)
      raw.exec(`INSERT INTO schema_migrations (version) VALUES (${index + 1})`)
    }
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 1, 5)")
    raw.exec("INSERT INTO plans (id, created_at, status, effort, request_text, attachments) VALUES ('p1', 9, 'planned', 'low', 'text', '[]')")
    raw.close()

    const db = Db.open(path)
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version)).toEqual([1, 2, 3, 4, 5])
    expect(db.get('SELECT id, name FROM workflows')).toEqual({ id: 'w', name: 'wf' })
    expect(db.get('SELECT id, request_text, memory_ids FROM plans')).toEqual({ id: 'p1', request_text: 'text', memory_ids: '[]' })
    expect(db.all('SELECT * FROM memory_items')).toEqual([])
    db.close()
  })

  it('creates the memory table with a text key that must be unique', () => {
    const db = Db.open(':memory:')
    const columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('memory_items')").map((row) => row.name)
    expect(columns).toEqual(['id', 'text', 'text_key', 'created_at', 'updated_at'])
    db.close()
  })

  it('is safe to open a migrated database again', () => {
    const path = join(dir, 'again.db')
    Db.open(path).close()
    const db = Db.open(path)
    expect(db.all('SELECT version FROM schema_migrations')).toHaveLength(MIGRATIONS.length)
    expect(MIGRATIONS).toHaveLength(5)
    db.close()
  })
})
