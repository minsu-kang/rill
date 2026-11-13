import { describe, expect, it } from 'vitest'
import { FIELD_ROLES, createCoreRegistry, fieldRoles, isEgressField, isWriteField, valueAtPointer } from '../src/index'

type Json = Record<string, unknown>

interface StringField {
  pointer: string
  name: string
  pattern?: string
}

const ROLE_NAME = /path|file|folder|dir|url|uri|link|endpoint|host|connection|secret|token|channel|recipient|email|webhook|^to$/i

const NOT_A_ROLE: Record<string, string[]> = {
  'trigger.webhook@1': ['/path'],
}

function isStringSchema(schema: Json): boolean {
  if (schema.type === 'string') return true
  return Array.isArray(schema.anyOf) && (schema.anyOf as Json[]).some((part) => part.type === 'string' && part.const === undefined)
}

function stringFields(schema: Json, pointer = ''): StringField[] {
  const fields: StringField[] = []
  for (const [name, child] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
    const at = `${pointer}/${name}`
    if (isStringSchema(child)) fields.push({ pointer: at, name, pattern: child.pattern as string | undefined })
    fields.push(...stringFields(child, at))
    if (child.items && typeof child.items === 'object') fields.push(...stringFields(child.items as Json, `${at}/*`))
  }
  return fields
}

function pointerExists(schema: Json, pointer: string): Json | undefined {
  let current: Json | undefined = schema
  for (const segment of pointer.slice(1).split('/')) {
    current = (current?.properties as Record<string, Json> | undefined)?.[segment]
  }
  return current
}

const registry = createCoreRegistry()

describe('node roles', () => {
  it('declares a role for every config string that names a path, URL, connection or recipient', () => {
    const missing: string[] = []
    for (const def of registry.list()) {
      for (const field of stringFields(def.configSchema as unknown as Json)) {
        const suggests = ROLE_NAME.test(field.name) || /https?|^\^\//.test(field.pattern ?? '')
        const declared = def.roles?.[field.pointer] !== undefined
        const allowed = (NOT_A_ROLE[def.type] ?? []).includes(field.pointer)
        if (suggests && !declared && !allowed) missing.push(`${def.type} ${field.pointer}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps the allow-list honest: every allow-listed field exists and has no role', () => {
    for (const [type, pointers] of Object.entries(NOT_A_ROLE)) {
      const def = registry.get(type)!
      for (const pointer of pointers) {
        expect(pointerExists(def.configSchema as unknown as Json, pointer), `${type} ${pointer}`).toBeDefined()
        expect(def.roles?.[pointer]).toBeUndefined()
      }
    }
  })

  it('points every declared role at an existing string field with a known role', () => {
    for (const def of registry.list()) {
      for (const { pointer, role } of fieldRoles(def)) {
        const schema = pointerExists(def.configSchema as unknown as Json, pointer)
        expect(schema, `${def.type} ${pointer}`).toBeDefined()
        expect(isStringSchema(schema!), `${def.type} ${pointer}`).toBe(true)
        expect(FIELD_ROLES).toContain(role)
      }
    }
  })

  it('declares the expected roles of the core nodes', () => {
    const roles = Object.fromEntries(registry.list().map((def) => [def.type, def.roles ?? {}]))
    expect(roles).toEqual({
      'trigger.manual@1': {},
      'trigger.cron@1': {},
      'trigger.folderWatch@1': { '/folder': 'path' },
      'trigger.webhook@1': { '/secretConnection': 'connection' },
      'transform@1': {},
      'csv.append@1': { '/file': 'path' },
      'condition@1': {},
      'delay@1': {},
      'file.read@1': { '/path': 'path' },
      'llm.extract@1': { '/file': 'path' },
      'http.request@1': { '/url': 'url', '/auth/connection': 'connection' },
      'notify.slack@1': { '/connection': 'connection', '/channel': 'recipient', '/text': 'message' },
    })
  })

  it('the heuristic catches an undeclared field', () => {
    const fields = stringFields({ properties: { target: { type: 'string', pattern: '^https://' }, outputFolder: { type: 'string' } } })
    const flagged = fields.filter((f) => ROLE_NAME.test(f.name) || /https?|^\^\//.test(f.pattern ?? '')).map((f) => f.pointer)
    expect(flagged).toEqual(['/target', '/outputFolder'])
  })
})

describe('role helpers', () => {
  const get = (type: string) => registry.get(type)!

  it('treats paths of side-effecting actions as writes', () => {
    expect(isWriteField(get('csv.append@1'), '/file')).toBe(true)
    expect(isWriteField(get('file.read@1'), '/path')).toBe(false)
    expect(isWriteField(get('llm.extract@1'), '/file')).toBe(false)
    expect(isWriteField(get('trigger.folderWatch@1'), '/folder')).toBe(false)
    expect(isWriteField(get('http.request@1'), '/url')).toBe(false)
  })

  it('treats URLs and connections of external actions and write paths as egress', () => {
    expect(isEgressField(get('http.request@1'), '/url')).toBe(true)
    expect(isEgressField(get('http.request@1'), '/auth/connection')).toBe(true)
    expect(isEgressField(get('notify.slack@1'), '/connection')).toBe(true)
    expect(isEgressField(get('notify.slack@1'), '/channel')).toBe(true)
    expect(isEgressField(get('notify.slack@1'), '/text')).toBe(false)
    expect(isEgressField(get('csv.append@1'), '/file')).toBe(true)
    expect(isEgressField(get('trigger.webhook@1'), '/secretConnection')).toBe(false)
    expect(isEgressField(get('file.read@1'), '/path')).toBe(false)
    expect(isEgressField(get('http.request@1'), '/method')).toBe(false)
  })

  it('reads values at RFC 6901 pointers', () => {
    const config = { auth: { connection: 'c' }, 'a/b': { '~': 1 }, list: ['x'] }
    expect(valueAtPointer(config, '/auth/connection')).toBe('c')
    expect(valueAtPointer(config, '/a~1b/~0')).toBe(1)
    expect(valueAtPointer(config, '/list/0')).toBe('x')
    expect(valueAtPointer(config, '/auth/missing')).toBeUndefined()
    expect(valueAtPointer(config, '/auth/connection/deeper')).toBeUndefined()
    expect(valueAtPointer(config, '')).toBe(config)
  })
})
