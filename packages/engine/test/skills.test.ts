import { createCoreRegistry } from '@rill/nodes-core'
import { AgentSchema, SKILL_MAX_ITEMS, SkillSchema, type SkillFields } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { SkillDuplicateError, SkillFullError, SkillInvalidError, SkillNotFoundError, normaliseSkill } from '../src/skills'

const base: SkillFields = { name: 'Receipts checklist', description: 'How to plan a receipts ledger', body: 'Ask for the folder.\nName every default you pick.' }

function make() {
  let tick = 1000
  const db = Db.open(':memory:')
  const engine = new Engine({ db, registry: createCoreRegistry(), now: () => (tick += 10) })
  return { db, engine }
}

function save(engine: Engine, overrides: Partial<SkillFields> & { id?: string } = {}) {
  return engine.saveSkill({ ...base, ...overrides })
}

function problemsOf(input: Partial<SkillFields>): string[] {
  try {
    normaliseSkill({ ...base, ...input })
  } catch (error) {
    if (error instanceof SkillInvalidError) return error.problems.map((line) => line.split(':')[0]!)
    throw error
  }
  return []
}

describe('skills in the engine', () => {
  it('starts with no skill', () => {
    const { engine } = make()
    expect(engine.listSkills()).toEqual([])
  })

  it('creates a skill with a generated id, both timestamps and normalised text', () => {
    const { engine } = make()
    const skill = save(engine, { name: '  My   Skill ', description: ' short   one ', body: '\nline one\n  line two\n\nline four\n' })
    expect(skill).toMatchObject({ name: 'My Skill', description: 'short one', body: 'line one\n  line two\n\nline four' })
    expect(skill.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(skill.createdAt).toBe(skill.updatedAt)
    expect(Value.Check(SkillSchema, skill)).toBe(true)
    expect(engine.listSkills()).toEqual([skill])
  })

  it('gives every skill its own random id', () => {
    const { engine } = make()
    const ids = new Set(Array.from({ length: 5 }, (_, index) => save(engine, { name: `skill ${index}` }).id))
    expect(ids.size).toBe(5)
  })

  it('lists the skills by name, ignoring case', () => {
    const { engine } = make()
    save(engine, { name: 'charlie' })
    save(engine, { name: 'Alpha' })
    save(engine, { name: 'bravo' })
    expect(engine.listSkills().map((skill) => skill.name)).toEqual(['Alpha', 'bravo', 'charlie'])
  })

  it('keeps the order by name when a skill is renamed', () => {
    const { engine } = make()
    const first = save(engine, { name: 'a-skill' })
    save(engine, { name: 'b-skill' })
    save(engine, { id: first.id, name: 'z-skill' })
    expect(engine.listSkills().map((skill) => skill.name)).toEqual(['b-skill', 'z-skill'])
  })

  it('edits a skill in place: the id and createdAt stay, updatedAt moves', () => {
    const { engine } = make()
    const created = save(engine)
    const edited = save(engine, { id: created.id, name: 'Renamed', body: 'new body' })
    expect(edited).toMatchObject({ id: created.id, name: 'Renamed', body: 'new body', createdAt: created.createdAt })
    expect(edited.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(engine.listSkills()).toEqual([edited])
  })

  it('lets a skill be saved again with its own name, or with only the case of its name changed', () => {
    const { engine } = make()
    const skill = save(engine, { name: 'my skill' })
    expect(save(engine, { id: skill.id, name: 'my skill' }).name).toBe('my skill')
    expect(save(engine, { id: skill.id, name: 'My Skill' }).name).toBe('My Skill')
  })

  it('refuses an edit of an unknown id with SkillNotFoundError, and checks the text first', () => {
    const { engine } = make()
    expect(() => save(engine, { id: 'missing' })).toThrow(SkillNotFoundError)
    expect(() => save(engine, { id: 'missing', name: '' })).toThrow(SkillInvalidError)
  })

  it('refuses invalid text and saves nothing', () => {
    const { engine } = make()
    expect(() => save(engine, { name: 'bad\nname' })).toThrow(SkillInvalidError)
    expect(() => save(engine, { body: 'x'.repeat(4001) })).toThrow(SkillInvalidError)
    expect(() => save(engine, { body: '' })).toThrow(SkillInvalidError)
    expect(engine.listSkills()).toEqual([])
  })

  it('refuses a duplicate name, ignoring case, spacing and NFC form', () => {
    const { engine } = make()
    save(engine, { name: 'café helper' })
    expect(() => save(engine, { name: 'café helper' })).toThrow(SkillDuplicateError)
    expect(() => save(engine, { name: 'CAFÉ HELPER' })).toThrow(SkillDuplicateError)
    expect(() => save(engine, { name: 'café   helper' })).toThrow(SkillDuplicateError)
    expect(engine.listSkills()).toHaveLength(1)
  })

  it('refuses a name that looks the same apart from invisible characters', () => {
    const { engine } = make()
    save(engine, { name: 'Work' })
    for (const name of ['Wo\u200drk', 'Wo\u200crk', 'Wo\u034frk', 'WORK\ufe0f', 'Wo\u3164rk']) expect(() => save(engine, { name }), name).toThrow(SkillDuplicateError)
    expect(engine.listSkills()).toHaveLength(1)
  })

  it('refuses a name that shows nothing, and saves nothing', () => {
    const { engine } = make()
    for (const name of ['\u200d', '\u3164', '\u2800', '\u034f\ufe0f']) expect(() => save(engine, { name }), name).toThrow(SkillInvalidError)
    expect(engine.listSkills()).toEqual([])
  })

  it('does not reserve the names of the built-in agent', () => {
    const { engine } = make()
    expect(save(engine, { name: 'Default' }).name).toBe('Default')
    expect(save(engine, { name: '기본' }).name).toBe('기본')
  })

  it('refuses to rename a skill into a copy of another name', () => {
    const { engine } = make()
    save(engine, { name: 'first' })
    const second = save(engine, { name: 'second' })
    expect(() => save(engine, { id: second.id, name: 'FIRST' })).toThrow(SkillDuplicateError)
    expect(engine.listSkills().map((skill) => skill.name)).toEqual(['first', 'second'])
  })

  it('lets two skills share a description and a body', () => {
    const { engine } = make()
    save(engine, { name: 'one' })
    expect(save(engine, { name: 'two' }).body).toBe(base.body)
  })

  it('lets a deleted name be used again', () => {
    const { engine } = make()
    const skill = save(engine, { name: 'again' })
    engine.deleteSkill(skill.id)
    expect(save(engine, { name: 'AGAIN' }).id).not.toBe(skill.id)
  })

  it('deletes a skill once: the second delete says false', () => {
    const { engine } = make()
    const skill = save(engine)
    expect(engine.deleteSkill(skill.id)).toBe(true)
    expect(engine.deleteSkill(skill.id)).toBe(false)
    expect(engine.deleteSkill('never-existed')).toBe(false)
    expect(engine.listSkills()).toEqual([])
  })

  it('accepts 24 skills and refuses the 25th with SkillFullError', () => {
    const { engine } = make()
    for (let index = 0; index < SKILL_MAX_ITEMS; index++) save(engine, { name: `skill ${index}` })
    expect(() => save(engine, { name: 'one too many' })).toThrow(SkillFullError)
    expect(engine.listSkills()).toHaveLength(SKILL_MAX_ITEMS)
  })

  it('frees a slot when a skill is deleted, and still edits when full', () => {
    const { engine } = make()
    const ids = Array.from({ length: SKILL_MAX_ITEMS }, (_, index) => save(engine, { name: `skill ${index}` }).id)
    expect(save(engine, { id: ids[0]!, name: 'skill zero, edited' }).name).toBe('skill zero, edited')
    engine.deleteSkill(ids[1]!)
    expect(save(engine, { name: 'fits again' }).name).toBe('fits again')
    expect(() => save(engine, { name: 'and now full again' })).toThrow(SkillFullError)
  })

  it('reports a duplicate before a full list, and invalid text before both', () => {
    const { engine } = make()
    for (let index = 0; index < SKILL_MAX_ITEMS; index++) save(engine, { name: `skill ${index}` })
    expect(() => save(engine, { name: 'SKILL 3' })).toThrow(SkillDuplicateError)
    expect(() => save(engine, { name: '' })).toThrow(SkillInvalidError)
  })

  it('stores the case-folded name as the key and the normalised name as the name', () => {
    const { db, engine } = make()
    save(engine, { name: '  Mixed   CASE Name ' })
    expect(db.get('SELECT name, name_key FROM skills')).toEqual({ name: 'Mixed CASE Name', name_key: 'mixed case name' })
  })

  it('enforces the name key as unique in the database itself', () => {
    const { db } = make()
    const insert = "INSERT INTO skills (id, name, name_key, description, body, created_at, updated_at) VALUES (?, 'N', 'n', '', 'b', 1, 1)"
    db.run(insert, 'a')
    expect(() => db.run(insert, 'b')).toThrow()
  })

  it('keeps the skills when an agent is saved or deleted, and works with no model provider', () => {
    const { engine } = make()
    const skill = save(engine)
    const agent = engine.saveAgent({ name: 'Uses it', description: '', persona: '', instructions: '', skillIds: [skill.id] })
    engine.deleteAgent(agent.id)
    expect(engine.listSkills()).toEqual([skill])
  })

  it('returns skills that are valid for the schema of the method', () => {
    const { engine } = make()
    save(engine, { description: '' })
    expect(Value.Check(SkillSchema, engine.listSkills()[0])).toBe(true)
    expect(Value.Check(AgentSchema, engine.listAgents().agents[0])).toBe(true)
  })
})

describe('normaliseSkill', () => {
  it('names the field and the rule in the problems and keeps the text out of them', () => {
    const marker = 'SKILL-MARKER-91d3'
    try {
      normaliseSkill({ name: `${marker}\nx`, description: `${marker}\u202e`, body: marker.repeat(1000) })
      throw new Error('expected a SkillInvalidError')
    } catch (error) {
      expect(error).toBeInstanceOf(SkillInvalidError)
      const invalid = error as SkillInvalidError
      expect(invalid.problems).toEqual([
        expect.stringMatching(/^name\.control_character: /),
        expect.stringMatching(/^description\.bidi_format: /),
        expect.stringMatching(/^body\.too_long: /),
      ])
      expect(JSON.stringify({ message: invalid.message, problems: invalid.problems })).not.toContain(marker)
    }
  })

  it('refuses a carriage return in the body, but allows a line feed', () => {
    expect(problemsOf({ body: 'a\rb' })).toEqual(['body.control_character'])
    expect(problemsOf({ body: 'a\nb' })).toEqual([])
    expect(problemsOf({ description: 'a\nb' })).toEqual(['description.control_character'])
  })

  it('needs a body that shows something', () => {
    expect(problemsOf({ body: '' })).toEqual(['body.empty'])
    expect(problemsOf({ body: '\n \u3164 \n' })).toEqual(['body.empty'])
  })

  it('rejects the same characters as agent text does', () => {
    const samples = ['\u0000', '\t', '\u0085', '\u2028', '\u2029', '\u202e', '\u200f', '\u200b', '\ufeff', '\u{e0041}', '\u{e0100}', '\u00ad', 'plain', '👨\u200d👩', 'a\u200cb']
    for (const sample of samples) {
      const { engine } = make()
      let agentVerdict = true
      try {
        engine.saveAgent({ name: `one${sample}two`, description: '', persona: '', instructions: '' })
      } catch {
        agentVerdict = false
      }
      expect(problemsOf({ name: `one${sample}two` }).length === 0, JSON.stringify(sample)).toBe(agentVerdict)
    }
  })
})

describe('skill writes are one transaction', () => {
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
    const skill = save(engine)
    save(engine, { id: skill.id, body: 'changed' })
    engine.deleteSkill(skill.id)
    expect(log).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
  })
})
