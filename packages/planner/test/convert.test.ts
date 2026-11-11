import { createCoreRegistry } from '@rill/nodes-core'
import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { convertSchema, restoreConverted, withoutHiddenFields } from '../src/index'

type Json = Record<string, unknown>

const registry = createCoreRegistry()
const FORBIDDEN = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'maxItems', 'uniqueItems', 'patternProperties', '$ref']

function walk(schema: Json, visit: (schema: Json) => void): void {
  visit(schema)
  for (const child of Object.values((schema.properties ?? {}) as Record<string, Json>)) walk(child, visit)
  if (schema.items !== undefined) walk(schema.items as Json, visit)
  for (const child of (schema.anyOf ?? []) as Json[]) walk(child, visit)
}

function keys(schema: Json): string[] {
  const found: string[] = []
  walk(schema, (s) => found.push(...Object.keys(s)))
  return found
}

describe('convertSchema', () => {
  for (const def of registry.list()) {
    it(`converts ${def.type} into the structured-output subset`, () => {
      const { schema } = convertSchema(withoutHiddenFields(def))
      let unions = 0
      walk(schema, (s) => {
        if (s.anyOf !== undefined) unions++
        if (s.type === 'object') {
          expect(s.additionalProperties).toBe(false)
          const names = Object.keys(s.properties as Json)
          expect(names.length - (s.required as string[]).length).toBeLessThanOrEqual(8)
        }
        if (typeof s.minItems === 'number') expect(s.minItems).toBeLessThanOrEqual(1)
        expect(Object.keys(s).length).toBeGreaterThan(0)
      })
      expect(unions).toBeLessThanOrEqual(1)
      for (const keyword of FORBIDDEN) expect(keys(schema)).not.toContain(keyword)
    })
  }

  it('turns string literal unions into enums and keeps constraints as description text', () => {
    const { schema, losses } = convertSchema(withoutHiddenFields(registry.get('http.request@1')!))
    const props = schema.properties as Record<string, Json>
    expect(props.method).toEqual({ type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
    expect(props.url).toEqual({ type: 'string', description: 'Constraint: pattern "^https?://".' })
    expect(losses).toContainEqual({ pointer: '/url', kind: 'constraint', detail: 'pattern="^https?://"' })
    expect(schema.required).toEqual(['url'])
  })

  it('turns open records into key/value entries and unknown values into JSON text', () => {
    const { schema, losses } = convertSchema(withoutHiddenFields(registry.get('http.request@1')!))
    const props = schema.properties as Record<string, Json>
    expect(props.headers).toEqual({
      type: 'array',
      description: 'Entries of a map, one per key.',
      items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false },
    })
    expect(props.body).toEqual({ type: 'string', description: 'JSON text of the value.' })
    expect(losses.map((l) => [l.pointer, l.kind])).toEqual(expect.arrayContaining([['/headers', 'record'], ['/body', 'unknown']]))
    const transform = convertSchema(registry.get('transform@1')!.configSchema).schema
    const values = (transform.properties as Record<string, Json>).values!
    expect((values.items as Json).properties).toEqual({ key: { type: 'string' }, value: { type: 'string', description: 'JSON text of the value.' } })
  })

  it('clamps minItems above 1 and drops unknown formats', () => {
    const { schema, losses } = convertSchema(Type.Object({ list: Type.Array(Type.String({ format: 'hostname' }), { minItems: 3 }), day: Type.String({ format: 'date' }) }))
    const props = schema.properties as Record<string, Json>
    expect(props.list).toMatchObject({ minItems: 1, description: 'Constraint: minItems 3.' })
    expect((props.list!.items as Json).format).toBeUndefined()
    expect(props.day!.format).toBe('date')
    expect(losses.map((l) => l.detail)).toEqual(expect.arrayContaining(['minItems=3', 'format=hostname']))
  })

  it('keeps non-literal unions and converts their branches', () => {
    const { schema } = convertSchema(Type.Object({ cell: Type.Union([Type.String({ maxLength: 3 }), Type.Null()]) }))
    expect((schema.properties as Record<string, Json>).cell).toEqual({ anyOf: [{ type: 'string', description: 'Constraint: maxLength 3.' }, { type: 'null' }] })
  })

  it('appends constraints to an existing description', () => {
    const { schema } = convertSchema(Type.Object({ n: Type.Integer({ description: 'Count.', minimum: 1 }) }))
    expect((schema.properties as Record<string, Json>).n!.description).toBe('Count. Constraint: minimum 1.')
  })
})

describe('restoreConverted', () => {
  const http = withoutHiddenFields(registry.get('http.request@1')!)

  it('turns entries into a record and JSON text into values', () => {
    const restored = restoreConverted(http, {
      url: 'https://x.test',
      headers: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }],
      body: '{"n":[1,2]}',
      auth: { connection: 'api' },
    })
    expect(restored.issues).toEqual([])
    expect(restored.value).toEqual({ url: 'https://x.test', headers: { a: '1', b: '2' }, body: { n: [1, 2] }, auth: { connection: 'api' } })
  })

  it('reports duplicate keys and JSON text that does not parse', () => {
    const restored = restoreConverted(http, { url: 'https://x', headers: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }], body: '{nope' }, '/nodes/3/config')
    expect(restored.issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/nodes/3/config/headers/1/key', 'config_duplicate_key'],
      ['/nodes/3/config/body', 'config_json_parse'],
    ])
    expect((restored.value as Json).headers).toEqual({ a: '1' })
  })

  it('restores JSON text inside record values and arrays', () => {
    const transform = registry.get('transform@1')!.configSchema
    expect(restoreConverted(transform, { values: [{ key: 'x', value: '[1,"a"]' }, { key: 'y', value: '"{{t1.output.file}}"' }] }).value).toEqual({
      values: { x: [1, 'a'], y: '{{t1.output.file}}' },
    })
    const list = Type.Object({ items: Type.Array(Type.Unknown()) })
    expect(restoreConverted(list, { items: ['1', 'true'] }).value).toEqual({ items: [1, true] })
  })

  it('leaves values it does not recognise unchanged', () => {
    expect(restoreConverted(http, 'text').value).toBe('text')
    expect(restoreConverted(http, { url: 'u', extra: 1, headers: 'h' }).value).toEqual({ url: 'u', extra: 1, headers: 'h' })
    expect(restoreConverted(Type.Unknown(), 5).value).toBe(5)
  })
})
