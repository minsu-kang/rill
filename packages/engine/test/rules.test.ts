import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { PLAN_EFFORTS, RULE_MAX_INPUT_CHARS, RULE_MAX_ITEMS, type RuleKind } from '@rill/protocol'
import { EFFORT_LEVELS } from '@rill/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RuleDuplicateError, RuleFullError, RuleInvalidError, RuleNotFoundError, normaliseRule } from '../src/rules'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-rules-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const registry = createCoreRegistry()
const nodeTypes = new Set(registry.list().map((def) => def.type.replace(/@\d+$/, '')))

function make(options: { db?: Db } = {}) {
  let tick = 1000
  const db = options.db ?? Db.open(':memory:')
  const engine = new Engine({ db, registry, now: () => (tick += 10) })
  return { db, engine }
}

function valueOf(kind: RuleKind, raw: string): string {
  return normaliseRule({ kind, value: raw }, nodeTypes).value
}

function problemOf(kind: RuleKind, raw: string): string | undefined {
  try {
    normaliseRule({ kind, value: raw }, nodeTypes)
  } catch (error) {
    if (error instanceof RuleInvalidError) return error.rule
    throw error
  }
  return undefined
}

describe('the effort names', () => {
  it('are the ones of the protocol and of the model layer', () => {
    expect([...PLAN_EFFORTS]).toEqual([...EFFORT_LEVELS])
  })
})

describe('normaliseRule, common to every kind', () => {
  it('refuses an empty value and a value of only whitespace', () => {
    for (const kind of ['forbidNode', 'allowHost', 'maxPlanEffort'] as const) {
      expect(problemOf(kind, ''), kind).toBe('empty')
      expect(problemOf(kind, '    　 '), kind).toBe('empty')
    }
  })

  it.each([
    ['a line feed', 'a\nb', 'control_character'],
    ['a tab', 'a\tb', 'control_character'],
    ['NUL', 'a\u0000b', 'control_character'],
    ['a C1 control', 'a\u0085b', 'control_character'],
    ['a line separator', 'a b', 'line_separator'],
    ['a paragraph separator', 'a b', 'line_separator'],
    ['a right-to-left override', 'a‮b', 'bidi_format'],
    ['an isolate', 'a⁦b', 'bidi_format'],
    ['a left-to-right mark', 'a‎b', 'bidi_format'],
    ['an Arabic letter mark', 'a؜b', 'bidi_format'],
    ['a zero-width space', 'a​b', 'format_character'],
    ['a word joiner', 'a⁠b', 'format_character'],
    ['a soft hyphen', 'a­b', 'format_character'],
    ['a tag character', 'a\u{e0041}b', 'format_character'],
    ['a variation selector supplement', 'a\u{e0100}b', 'format_character'],
  ])('refuses %s in every kind', (_name, raw, problem) => {
    for (const kind of ['forbidNode', 'allowHost', 'maxPlanEffort'] as const) expect(problemOf(kind, raw), kind).toBe(problem)
  })

  it('refuses a value over the input limit', () => {
    expect(problemOf('allowHost', 'x'.repeat(RULE_MAX_INPUT_CHARS + 1))).toBe('too_long')
  })

  it('names the rule that failed in the problems and never the value', () => {
    const marker = 'RULE-MARKER-31bd'
    for (const [kind, raw] of [
      ['allowHost', `${marker}\n${marker}`],
      ['allowHost', `https://${marker}.com`],
      ['allowHost', `${marker}.com:80`],
      ['forbidNode', marker],
      ['maxPlanEffort', marker],
    ] as const) {
      try {
        normaliseRule({ kind, value: raw }, nodeTypes)
        throw new Error('expected a RuleInvalidError')
      } catch (error) {
        expect(error).toBeInstanceOf(RuleInvalidError)
        const invalid = error as RuleInvalidError
        expect(invalid.problems).toEqual([expect.stringContaining(invalid.rule)])
        expect(JSON.stringify({ message: invalid.message, problems: invalid.problems, rule: invalid.rule })).not.toContain(marker)
      }
    }
  })
})

describe('normaliseRule, forbidNode', () => {
  it('accepts every node type of the catalog without its version', () => {
    expect(nodeTypes.has('http.request')).toBe(true)
    for (const type of nodeTypes) expect(valueOf('forbidNode', type), type).toBe(type)
  })

  it('accepts the Plan 11 nodes and the triggers', () => {
    for (const type of ['google.sheets.append', 'microsoft.excel.append', 'notify.slack', 'trigger.webhook']) expect(valueOf('forbidNode', type)).toBe(type)
  })

  it('trims and composes, ignores case and keeps the spelling of the catalog', () => {
    expect(valueOf('forbidNode', '  HTTP.Request \n')).toBe('http.request')
    expect(valueOf('forbidNode', 'TRIGGER.FOLDERWATCH')).toBe('trigger.folderWatch')
    expect(nodeTypes.has('trigger.folderWatch')).toBe(true)
  })

  it('refuses a type that is not in the catalog, a type with a version and a type with a space', () => {
    expect(problemOf('forbidNode', 'http.requests')).toBe('unknown_node_type')
    expect(problemOf('forbidNode', 'http.request@1')).toBe('unknown_node_type')
    expect(problemOf('forbidNode', 'http request')).toBe('unknown_node_type')
    expect(problemOf('forbidNode', 'http')).toBe('unknown_node_type')
    expect(problemOf('forbidNode', '*')).toBe('unknown_node_type')
  })
})

describe('normaliseRule, maxPlanEffort', () => {
  it('accepts each effort name', () => {
    for (const effort of PLAN_EFFORTS) expect(valueOf('maxPlanEffort', effort)).toBe(effort)
  })

  it('trims and lower-cases', () => {
    expect(valueOf('maxPlanEffort', ' XHigh ')).toBe('xhigh')
  })

  it('refuses anything else', () => {
    for (const raw of ['ultra', 'mid', 'high effort', 'medium,low', '0', 'none']) expect(problemOf('maxPlanEffort', raw), raw).toBe('unknown_effort')
  })
})

describe('normaliseRule, allowHost', () => {
  it.each([
    ['api.example.com', 'api.example.com'],
    ['  API.Example.COM  ', 'api.example.com'],
    ['example.com', 'example.com'],
    ['localhost', 'localhost'],
    ['a-b.example.com', 'a-b.example.com'],
    ['a_b.example.com', 'a_b.example.com'],
    ['xn--bcher-kva.de', 'xn--bcher-kva.de'],
    ['é.example.com', 'xn--9ca.example.com'],
    ['*.example.com', '*.example.com'],
    ['*.API.Example.COM', '*.api.example.com'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]', '[::1]'],
    ['::1', '[::1]'],
    ['2001:DB8::1', '[2001:db8::1]'],
    ['[2001:db8:0:0:0:0:0:1]', '[2001:db8::1]'],
  ])('accepts %s as %s', (raw, expected) => {
    expect(valueOf('allowHost', raw)).toBe(expected)
  })

  it('converts an internationalised name to punycode, also behind a wildcard', () => {
    expect(valueOf('allowHost', 'bücher.de')).toBe('xn--bcher-kva.de')
    expect(valueOf('allowHost', 'BÜCHER.de')).toBe('xn--bcher-kva.de')
    expect(valueOf('allowHost', '*.bücher.de')).toBe('*.xn--bcher-kva.de')
    expect(valueOf('allowHost', '日本語.jp')).toBe('xn--wgv71a119e.jp')
    expect(valueOf('allowHost', '😀.example.com')).toBe('xn--e28h.example.com')
  })

  it('composes to NFC before it converts, so both spellings of a letter give one host', () => {
    expect(valueOf('allowHost', 'ü.de')).toBe(valueOf('allowHost', 'ü.de'))
  })

  it.each([
    ['a scheme', 'https://api.example.com', 'host_scheme'],
    ['a scheme without a host', 'http://', 'host_scheme'],
    ['an ftp scheme', 'ftp://api.example.com', 'host_scheme'],
    ['a path', 'api.example.com/v1', 'host_path'],
    ['a trailing slash', 'api.example.com/', 'host_path'],
    ['a query', 'api.example.com?x=1', 'host_path'],
    ['a fragment', 'api.example.com#top', 'host_path'],
    ['a backslash', 'api.example.com\\v1', 'host_path'],
    ['a port', 'api.example.com:8080', 'host_port'],
    ['a port on an address', '127.0.0.1:3000', 'host_port'],
    ['a port on a bracketed address', '[::1]:3000', 'host_port'],
    ['a port on a wildcard', '*.example.com:443', 'host_port'],
    ['user info', 'user@api.example.com', 'host_user_info'],
    ['user info with a password', 'user:secret@api.example.com', 'host_user_info'],
    ['a space', 'api example.com', 'host_space'],
    ['a no-break space', 'api example.com', 'host_space'],
    ['an ideographic space', 'api　example.com', 'host_space'],
    ['an empty label', 'a..example.com', 'host_empty_label'],
    ['a leading dot', '.example.com', 'host_empty_label'],
    ['a trailing dot', 'example.com.', 'host_empty_label'],
    ['a lone dot', '.', 'host_empty_label'],
    ['a lone star', '*', 'host_wildcard'],
    ['a star and a dot', '*.', 'host_wildcard'],
    ['two stars', '*.*.example.com', 'host_wildcard'],
    ['a double star', '**.example.com', 'host_wildcard'],
    ['a star inside a label', 'a*.example.com', 'host_wildcard'],
    ['a star without a dot', '*example.com', 'host_wildcard'],
    ['a star at the end', 'example.*', 'host_wildcard'],
    ['a star in the middle', 'api.*.com', 'host_wildcard'],
    ['a wildcard on an address', '*.127.0.0.1', 'host_wildcard'],
    ['a wildcard on a bracketed address', '*.[::1]', 'host_wildcard'],
    ['a wildcard with an empty label', '*..example.com', 'host_empty_label'],
    ['an address in short form', '127.1', 'host_characters'],
    ['an address with a number over 255', '999.1.1.1', 'host_characters'],
    ['a hexadecimal address', '0x7f.0.0.1', 'host_characters'],
    ['a name with a number as its last label', 'example.123', 'host_characters'],
    ['a percent sign', 'ex%61mple.com', 'host_characters'],
    ['an underscore-free forbidden character', 'ex$mple.com', 'host_characters'],
    ['a bracket in a name', 'exa[mple.com', 'host_characters'],
    ['an unclosed bracket', '[::1', 'host_characters'],
    ['a label that starts with a hyphen', '-a.example.com', 'host_characters'],
    ['a label that ends with a hyphen', 'a-.example.com', 'host_characters'],
    ['a comma', 'a.com,b.com', 'host_characters'],
    ['a quote', '"a.com"', 'host_characters'],
    ['an invalid address in brackets', '[not-an-ip]', 'host_characters'],
  ])('refuses %s', (_name, raw, problem) => {
    expect(problemOf('allowHost', raw)).toBe(problem)
  })

  it('refuses a label of 64 characters and accepts one of 63', () => {
    expect(problemOf('allowHost', `${'a'.repeat(63)}.example.com`)).toBeUndefined()
    expect(problemOf('allowHost', `${'a'.repeat(64)}.example.com`)).toBe('host_label_length')
  })

  it('refuses a name over 253 characters and accepts one of 253', () => {
    const label = 'a'.repeat(61)
    const name = (count: number) => Array.from({ length: count }, () => label).join('.')
    expect(name(4).length).toBe(247)
    expect(problemOf('allowHost', `${name(4)}.bbbbb`)).toBeUndefined()
    expect(problemOf('allowHost', `${name(4)}.bbbbbb`)).toBe('host_too_long')
  })

  it('reports a character that cannot be converted as an internationalised-name problem', () => {
    expect(problemOf('allowHost', 'a�b.com')).toBe('host_idn')
  })

  it('stores a wildcard and its apex as two different values', () => {
    expect(valueOf('allowHost', '*.example.com')).not.toBe(valueOf('allowHost', 'example.com'))
  })
})

describe('rules in the engine', () => {
  it('lists nothing at first', () => {
    const { engine } = make()
    expect(engine.listRules()).toEqual([])
  })

  it('creates a rule with a generated id and the normalised value', () => {
    const { engine } = make()
    const rule = engine.saveRule({ kind: 'allowHost', value: '  API.Example.com ' })
    expect(rule).toMatchObject({ kind: 'allowHost', value: 'api.example.com' })
    expect(rule.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(typeof rule.createdAt).toBe('number')
    expect(engine.listRules()).toEqual([rule])
  })

  it('lists the oldest rule first and gives every rule its own id', () => {
    const { engine } = make()
    const a = engine.saveRule({ kind: 'forbidNode', value: 'http.request' })
    const b = engine.saveRule({ kind: 'allowHost', value: 'a.example.com' })
    const c = engine.saveRule({ kind: 'maxPlanEffort', value: 'high' })
    expect(engine.listRules().map((rule) => rule.id)).toEqual([a.id, b.id, c.id])
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
  })

  it('refuses an invalid value with RuleInvalidError and stores nothing', () => {
    const { engine, db } = make()
    expect(() => engine.saveRule({ kind: 'allowHost', value: 'https://a.com' })).toThrow(RuleInvalidError)
    expect(() => engine.saveRule({ kind: 'forbidNode', value: 'nope' })).toThrow(RuleInvalidError)
    expect(() => engine.saveRule({ kind: 'maxPlanEffort', value: 'nope' })).toThrow(RuleInvalidError)
    expect(db.all('SELECT * FROM rules')).toEqual([])
  })

  it('refuses a duplicate, including one that differs in case, whitespace or the form of the host', () => {
    const { engine } = make()
    engine.saveRule({ kind: 'allowHost', value: 'bücher.de' })
    for (const value of ['bücher.de', 'BÜCHER.DE', ' xn--bcher-kva.de ']) expect(() => engine.saveRule({ kind: 'allowHost', value })).toThrow(RuleDuplicateError)
    engine.saveRule({ kind: 'forbidNode', value: 'http.request' })
    expect(() => engine.saveRule({ kind: 'forbidNode', value: 'HTTP.REQUEST' })).toThrow(RuleDuplicateError)
    expect(engine.listRules()).toHaveLength(2)
  })

  it('does not let a host count as a node type', () => {
    const { engine } = make()
    engine.saveRule({ kind: 'allowHost', value: 'localhost' })
    expect(() => engine.saveRule({ kind: 'forbidNode', value: 'localhost' })).toThrow(RuleInvalidError)
    expect(engine.listRules()).toHaveLength(1)
  })

  it('treats a wildcard and its apex as different rules', () => {
    const { engine } = make()
    engine.saveRule({ kind: 'allowHost', value: 'example.com' })
    engine.saveRule({ kind: 'allowHost', value: '*.example.com' })
    expect(engine.listRules().map((rule) => rule.value)).toEqual(['example.com', '*.example.com'])
  })

  it('accepts 30 rules and refuses the 31st with RuleFullError', () => {
    const { engine } = make()
    for (let index = 0; index < RULE_MAX_ITEMS; index++) engine.saveRule({ kind: 'allowHost', value: `h${index}.example.com` })
    expect(() => engine.saveRule({ kind: 'allowHost', value: 'one-too-many.example.com' })).toThrow(RuleFullError)
    expect(engine.listRules()).toHaveLength(RULE_MAX_ITEMS)
  })

  it('reports a duplicate before a full list, and an invalid value before both', () => {
    const { engine } = make()
    for (let index = 0; index < RULE_MAX_ITEMS; index++) engine.saveRule({ kind: 'allowHost', value: `h${index}.example.com` })
    expect(() => engine.saveRule({ kind: 'allowHost', value: 'H3.example.com' })).toThrow(RuleDuplicateError)
    expect(() => engine.saveRule({ kind: 'allowHost', value: 'https://x.com' })).toThrow(RuleInvalidError)
  })

  it('frees a slot when a rule is deleted', () => {
    const { engine } = make()
    const ids = Array.from({ length: RULE_MAX_ITEMS }, (_, index) => engine.saveRule({ kind: 'allowHost', value: `h${index}.example.com` }).id)
    engine.deleteRule(ids[4]!)
    expect(engine.saveRule({ kind: 'allowHost', value: 'fits-again.example.com' }).value).toBe('fits-again.example.com')
    expect(() => engine.saveRule({ kind: 'allowHost', value: 'full-again.example.com' })).toThrow(RuleFullError)
  })

  it('keeps one maxPlanEffort rule: saving it again replaces it and keeps the id and the position', () => {
    const { engine } = make()
    engine.saveRule({ kind: 'allowHost', value: 'a.example.com' })
    const first = engine.saveRule({ kind: 'maxPlanEffort', value: 'high' })
    engine.saveRule({ kind: 'allowHost', value: 'b.example.com' })
    const second = engine.saveRule({ kind: 'maxPlanEffort', value: 'low' })
    expect(second).toMatchObject({ id: first.id, kind: 'maxPlanEffort', value: 'low', createdAt: first.createdAt })
    expect(engine.listRules().filter((rule) => rule.kind === 'maxPlanEffort')).toEqual([second])
    expect(engine.listRules().map((rule) => rule.value)).toEqual(['a.example.com', 'low', 'b.example.com'])
  })

  it('saves the same effort again without an error and without a second rule', () => {
    const { engine } = make()
    const first = engine.saveRule({ kind: 'maxPlanEffort', value: 'medium' })
    expect(engine.saveRule({ kind: 'maxPlanEffort', value: ' MEDIUM ' })).toEqual(first)
    expect(engine.listRules()).toEqual([first])
  })

  it('replaces the effort cap even when the list is full', () => {
    const { engine } = make()
    engine.saveRule({ kind: 'maxPlanEffort', value: 'high' })
    for (let index = 0; index < RULE_MAX_ITEMS - 1; index++) engine.saveRule({ kind: 'allowHost', value: `h${index}.example.com` })
    expect(engine.saveRule({ kind: 'maxPlanEffort', value: 'low' }).value).toBe('low')
    expect(engine.listRules()).toHaveLength(RULE_MAX_ITEMS)
  })

  it('deletes a rule and refuses to delete one that is not there with RuleNotFoundError', () => {
    const { engine } = make()
    const rule = engine.saveRule({ kind: 'allowHost', value: 'a.example.com' })
    expect(engine.deleteRule(rule.id)).toBe(true)
    expect(() => engine.deleteRule(rule.id)).toThrow(RuleNotFoundError)
    expect(() => engine.deleteRule('never-existed')).toThrow(RuleNotFoundError)
    expect(engine.listRules()).toEqual([])
  })

  it('lets a deleted rule be saved again', () => {
    const { engine } = make()
    const rule = engine.saveRule({ kind: 'forbidNode', value: 'http.request' })
    engine.deleteRule(rule.id)
    expect(engine.saveRule({ kind: 'forbidNode', value: 'http.request' }).id).not.toBe(rule.id)
  })

  it('works on an engine that has no model provider', () => {
    const { engine } = make()
    const rule = engine.saveRule({ kind: 'allowHost', value: 'no-model.example.com' })
    expect(engine.listRules()).toEqual([rule])
  })

  it('keeps the rules across a reopened database file', () => {
    const path = join(dir, 'rules.db')
    const first = make({ db: Db.open(path) })
    const rule = first.engine.saveRule({ kind: 'allowHost', value: 'survives.example.com' })
    first.db.close()
    const second = make({ db: Db.open(path) })
    expect(second.engine.listRules()).toEqual([rule])
    second.db.close()
  })

  it('enforces the pair as unique and one effort cap in the database itself', () => {
    const { db } = make()
    const insert = (id: string, kind: string, value: string) => db.run('INSERT INTO rules (id, kind, value, created_at) VALUES (?, ?, ?, 1)', id, kind, value)
    insert('a', 'allowHost', 'a.com')
    expect(() => insert('b', 'allowHost', 'a.com')).toThrow()
    insert('c', 'maxPlanEffort', 'low')
    expect(() => insert('d', 'maxPlanEffort', 'high')).toThrow()
    insert('e', 'forbidNode', 'a.com')
  })

  it('does not touch the rules when a different table changes', () => {
    const { engine, db } = make()
    engine.saveRule({ kind: 'allowHost', value: 'a.example.com' })
    engine.saveMemory({ text: 'a note' })
    expect(db.all('SELECT kind, value FROM rules')).toEqual([{ kind: 'allowHost', value: 'a.example.com' }])
  })
})
