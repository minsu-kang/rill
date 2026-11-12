import { describe, expect, it } from 'vitest'
import { LlmError } from '../src/index'
import { prepareSchema } from '../src/openai/schema'

const strict = (schema: Record<string, unknown>) => prepareSchema(schema).schema

function nested(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' }
  for (let level = 0; level < levels; level++) schema = { type: 'object', properties: { next: schema }, required: ['next'], additionalProperties: false }
  return schema
}

describe('prepareSchema', () => {
  it('turns oneOf into anyOf and const into a one-value enum, including inside $defs, items and nested properties', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { oneOf: [{ const: 'a' }, { const: 7 }] } },
        ref: { $ref: '#/$defs/kind' },
      },
      required: ['list', 'ref'],
      additionalProperties: false,
      $defs: { kind: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
    }
    expect(strict(schema)).toEqual({
      type: 'object',
      properties: { list: { type: 'array', items: { anyOf: [{ enum: ['a'] }, { enum: [7] }] } }, ref: { $ref: '#/$defs/kind' } },
      required: ['list', 'ref'],
      additionalProperties: false,
      $defs: { kind: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    })
  })

  it('keeps an existing anyOf or enum when oneOf or const come with it', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { anyOf: [{ type: 'string' }], oneOf: [{ type: 'number' }] },
        b: { type: 'string', enum: ['x', 'y'], const: 'x' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    }
    expect(strict(schema).properties).toEqual({ a: { anyOf: [{ type: 'string' }] }, b: { type: 'string', enum: ['x', 'y'] } })
  })

  it('does not touch a property that is merely named like a keyword', () => {
    const schema = {
      type: 'object',
      properties: { oneOf: { type: 'string' }, const: { type: 'string' }, default: { type: 'string' }, allOf: { type: 'string' } },
      required: ['oneOf', 'const', 'default', 'allOf'],
      additionalProperties: false,
    }
    expect(strict(schema)).toEqual(schema)
  })

  it('drops what the guide says is unsupported and what it does not list', () => {
    const schema = {
      type: 'object',
      properties: { s: { type: 'string', minLength: 1, maxLength: 3, default: 'x', pattern: '^a', format: 'email' }, n: { type: 'integer', minimum: 1, maximum: 5, multipleOf: 1 }, l: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } },
      required: ['s', 'n', 'l'],
      additionalProperties: false,
      not: { required: ['s'] },
      allOf: [{ required: ['n'] }],
      if: { required: ['s'] },
      then: { required: ['n'] },
      else: { required: ['l'] },
      dependentRequired: { s: ['n'] },
      dependentSchemas: { s: {} },
    }
    expect(strict(schema)).toEqual({
      type: 'object',
      properties: { s: { type: 'string', pattern: '^a', format: 'email' }, n: { type: 'integer', minimum: 1, maximum: 5, multipleOf: 1 }, l: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } },
      required: ['s', 'n', 'l'],
      additionalProperties: false,
    })
  })

  it('makes optional properties nullable and restores them out of the reply', () => {
    const prepared = prepareSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'number' } }, additionalProperties: false } } }, required: ['a'], additionalProperties: false })
    expect((prepared.schema.properties as Record<string, unknown>).b).toEqual({
      anyOf: [{ type: 'array', items: { type: 'object', properties: { c: { type: ['number', 'null'] } }, required: ['c'], additionalProperties: false } }, { type: 'null' }],
    })
    expect(prepared.restore({ a: 'x', b: [{ c: null }, { c: 2 }] })).toEqual({ a: 'x', b: [{}, { c: 2 }] })
    expect(prepared.restore({ a: 'x', b: null })).toEqual({ a: 'x' })
  })

  it('accepts ten levels and refuses eleven, naming where', () => {
    expect(() => strict(nested(10))).not.toThrow()
    const error = (() => {
      try {
        strict(nested(11))
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).kind).toBe('invalid_request')
    expect((error as LlmError).message).toMatch(/depth limit of 10.*at #/)
  })

  it('accepts 5000 properties and refuses 5001', () => {
    const wide = (count: number) => ({
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, { type: 'string' }])),
      required: Array.from({ length: count }, (_, index) => `p${index}`),
      additionalProperties: false,
    })
    expect(() => strict(wide(5000))).not.toThrow()
    expect(() => strict(wide(5001))).toThrow(/more than 5000 properties/)
  })

  it('refuses more than 1000 enum values and more than 120,000 characters of names and values', () => {
    const enumOf = (count: number) => ({ type: 'object', properties: { e: { type: 'string', enum: Array.from({ length: count }, (_, index) => `v${index}`) } }, required: ['e'], additionalProperties: false })
    expect(() => strict(enumOf(1000))).not.toThrow()
    expect(() => strict(enumOf(1001))).toThrow(/more than 1000 enum values/)
    const long = (chars: number) => ({ type: 'object', properties: { [`n${'x'.repeat(chars - 1)}`]: { type: 'string' } }, required: [`n${'x'.repeat(chars - 1)}`], additionalProperties: false })
    expect(() => strict(long(120_000))).not.toThrow()
    expect(() => strict(long(120_001))).toThrow(/120000 characters/)
  })

  it('refuses a root that is not a plain object and an object with free-form keys', () => {
    expect(() => strict({ type: 'array', items: { type: 'string' } })).toThrow(/plain object at its root/)
    expect(() => strict({ anyOf: [{ type: 'object', properties: {}, additionalProperties: false }] })).toThrow(LlmError)
    expect(() => strict({ type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['m'], additionalProperties: false })).toThrow(/free-form keys/)
  })

  it('accepts recursion through $ref', () => {
    const tree = { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#' } } }, required: ['kids'], additionalProperties: false }
    expect(strict(tree)).toEqual(tree)
  })

  it('does not change the schema it is given', () => {
    const schema = { type: 'object', properties: { a: { const: 1 }, b: { type: 'string', default: 'x' } }, required: ['a'], additionalProperties: false }
    const copy = structuredClone(schema)
    prepareSchema(schema)
    expect(schema).toEqual(copy)
  })
})
