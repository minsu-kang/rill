import { describe, expect, it } from 'vitest'
import { LlmError, checkSchemaLimits, dropUnsupported, strictify, type JsonSchema } from '../src/index'

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required })

describe('strictify', () => {
  it('requires every property, closes every object and makes optional ones nullable', () => {
    const { schema } = strictify(object({ a: { type: 'string' }, b: { type: 'integer', description: 'count' } }, ['a']))
    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: ['integer', 'null'], description: 'count' } },
      required: ['a', 'b'],
      additionalProperties: false,
    })
  })

  it('does not change its input', () => {
    const input = object({ a: { type: 'string' } })
    const copy = structuredClone(input)
    strictify(input)
    expect(input).toEqual(copy)
  })

  it('adds null to an optional enum, wraps optional objects, arrays and unions', () => {
    const { schema } = strictify(
      object({
        kind: { type: 'string', enum: ['x', 'y'] },
        retry: object({ times: { type: 'number' } }, ['times']),
        tags: { type: 'array', items: { type: 'string' } },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      }),
    )
    const properties = schema.properties as Record<string, JsonSchema>
    expect(properties.kind).toEqual({ type: ['string', 'null'], enum: ['x', 'y', null] })
    expect(properties.retry).toEqual({
      anyOf: [{ type: 'object', properties: { times: { type: 'number' } }, required: ['times'], additionalProperties: false }, { type: 'null' }],
    })
    expect(properties.tags).toEqual({ anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] })
    expect(properties.either).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] })
  })

  it('leaves a schema that is already strict alone, including nullable fields', () => {
    const strict = {
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] }, b: { type: ['number', 'null'] } },
      required: ['a', 'b'],
      additionalProperties: false,
    }
    const { schema, restore } = strictify(strict)
    expect(schema).toEqual(strict)
    expect(restore({ a: null, b: null })).toEqual({ a: null, b: null })
  })

  it('strictifies objects inside arrays, unions and definitions', () => {
    const { schema } = strictify({
      type: 'object',
      properties: {
        nodes: { type: 'array', items: object({ id: { type: 'string' }, note: { type: 'string' } }, ['id']) },
        pick: { anyOf: [object({ p: { type: 'string' } }, ['p']), { type: 'string' }] },
        ref: { $ref: '#/$defs/leaf' },
      },
      required: ['nodes', 'pick', 'ref'],
      $defs: { leaf: object({ v: { type: 'number' }, w: { type: 'number' } }, ['v']) },
    })
    const nodes = (schema.properties as Record<string, { items: JsonSchema }>).nodes?.items
    expect(nodes).toMatchObject({ required: ['id', 'note'], additionalProperties: false })
    expect((nodes?.properties as Record<string, JsonSchema>).note).toEqual({ type: ['string', 'null'] })
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":true')
    expect((schema.$defs as Record<string, JsonSchema>).leaf).toMatchObject({ required: ['v', 'w'], additionalProperties: false })
  })

  it('refuses a free-form object, naming where it is', () => {
    const act = () => strictify(object({ meta: { type: 'object', additionalProperties: { type: 'string' } } }))
    expect(act).toThrow(LlmError)
    expect(act).toThrow('#/properties/meta')
    expect(() => strictify(object({ meta: { type: 'object' } }))).toThrow('#/properties/meta')
    expect(() => strictify(object({ meta: { type: 'object', properties: {}, additionalProperties: true } }))).toThrow('#/properties/meta')
  })
})

describe('restore', () => {
  const source = object(
    {
      name: { type: 'string' },
      note: { type: 'string' },
      count: { type: ['integer', 'null'] },
      retry: object({ times: { type: 'number' }, delay: { type: 'number' } }, ['times']),
      nodes: { type: 'array', items: object({ id: { type: 'string' }, config: { type: 'string' }, onError: { type: 'string', enum: ['fail', 'continue'] } }, ['id', 'config']) },
    },
    ['name', 'count'],
  )

  it('removes the nulls strictify introduced and keeps the rest', () => {
    const { restore } = strictify(source)
    const reply = {
      name: 'n',
      note: null,
      count: null,
      retry: { times: 3, delay: null },
      nodes: [
        { id: 'a', config: '{}', onError: null },
        { id: 'b', config: '{}', onError: 'fail' },
      ],
    }
    expect(restore(reply)).toEqual({
      name: 'n',
      count: null,
      retry: { times: 3 },
      nodes: [{ id: 'a', config: '{}' }, { id: 'b', config: '{}', onError: 'fail' }],
    })
  })

  it('removes a null optional object as a whole and does not mutate the reply', () => {
    const { restore } = strictify(source)
    const reply = { name: 'n', note: null, count: 1, retry: null, nodes: [] }
    const copy = structuredClone(reply)
    expect(restore(reply)).toEqual({ name: 'n', count: 1, nodes: [] })
    expect(reply).toEqual(copy)
  })

  it('restores through definitions, unions and nested arrays', () => {
    const { restore } = strictify({
      type: 'object',
      properties: {
        grid: { type: 'array', items: { type: 'array', items: { $ref: '#/$defs/cell' } } },
        pick: { anyOf: [object({ p: { type: 'string' }, q: { type: 'string' } }, ['p']), { type: 'string' }] },
      },
      required: ['grid', 'pick'],
      $defs: { cell: object({ v: { type: 'number' }, w: { type: 'string' } }, ['v']) },
    })
    expect(restore({ grid: [[{ v: 1, w: null }]], pick: { p: 'x', q: null } })).toEqual({ grid: [[{ v: 1 }]], pick: { p: 'x' } })
    expect(restore({ grid: [], pick: 'plain' })).toEqual({ grid: [], pick: 'plain' })
  })

  it('walks a recursive definition as deep as the data goes', () => {
    const { restore } = strictify({
      type: 'object',
      properties: { tree: { $ref: '#/$defs/node' } },
      required: ['tree'],
      $defs: { node: object({ label: { type: 'string' }, child: { $ref: '#/$defs/node' } }, ['label']) },
    })
    expect(restore({ tree: { label: 'a', child: { label: 'b', child: null } } })).toEqual({ tree: { label: 'a', child: { label: 'b' } } })
  })

  it('leaves values it does not understand and primitives alone', () => {
    const { restore } = strictify(source)
    expect(restore('text')).toBe('text')
    expect(restore(null)).toBeNull()
    expect(restore({ name: 'n', extra: null })).toEqual({ name: 'n', extra: null })
  })

  it('round-trips: restoring a strict reply gives data the original schema accepts', () => {
    const { restore } = strictify(source)
    const restored = restore({ name: 'n', note: null, count: 2, retry: null, nodes: [{ id: 'a', config: 'c', onError: null }] }) as Record<string, unknown>
    for (const key of ['name', 'count']) expect(restored).toHaveProperty(key)
    expect(Object.values(restored)).not.toContain(null)
    expect(JSON.stringify(restored)).not.toContain('null')
  })
})

describe('dropUnsupported', () => {
  it('removes the keywords at every schema position and keeps properties with the same names', () => {
    const input: JsonSchema = {
      type: 'object',
      properties: {
        format: { type: 'string', format: 'date', minLength: 2, pattern: '^a' },
        list: { type: 'array', items: { type: 'string', maxLength: 5 }, minItems: 1, uniqueItems: true },
        either: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'number', minimum: 0 }] },
      },
      required: ['format'],
      $defs: { x: { type: 'string', pattern: 'p' } },
    }
    const out = dropUnsupported(input, ['format', 'minLength', 'maxLength', 'pattern', 'uniqueItems'])
    expect(out).toEqual({
      type: 'object',
      properties: {
        format: { type: 'string' },
        list: { type: 'array', items: { type: 'string' }, minItems: 1 },
        either: { anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] },
      },
      required: ['format'],
      $defs: { x: { type: 'string' } },
    })
    expect(input.properties).toHaveProperty('format.format', 'date')
  })

  it('does not look inside enum and const values', () => {
    const out = dropUnsupported({ type: 'string', enum: [{ pattern: 'x' }], const: { pattern: 'x' } }, ['pattern'])
    expect(out).toEqual({ type: 'string', enum: [{ pattern: 'x' }], const: { pattern: 'x' } })
  })
})

describe('checkSchemaLimits', () => {
  const limits = { maxDepth: 10, maxProperties: 5000, maxChars: 120_000, allowRecursion: true }
  const nested = (depth: number): JsonSchema => (depth === 0 ? { type: 'string' } : object({ next: nested(depth - 1) }, ['next']))
  const fail = (schema: JsonSchema, change: Partial<typeof limits> & { rootObject?: boolean; maxEnumValues?: number } = {}) => {
    try {
      checkSchemaLimits(schema, { ...limits, ...change })
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).kind).toBe('invalid_request')
      return (error as LlmError).message
    }
    throw new Error('expected checkSchemaLimits to throw')
  }

  it('accepts a schema at the depth limit and names the pointer one level past it', () => {
    expect(() => checkSchemaLimits(nested(10), limits)).not.toThrow()
    const message = fail(nested(11))
    expect(message).toContain('#' + '/properties/next'.repeat(10))
    expect(message).not.toContain('#' + '/properties/next'.repeat(11))
  })

  it('does not count arrays and unions as levels of their own', () => {
    const deep = (n: number): JsonSchema => (n === 0 ? { type: 'string' } : { type: 'array', items: { anyOf: [object({ k: deep(n - 1) }, ['k'])] } })
    expect(() => checkSchemaLimits(deep(10), limits)).not.toThrow()
    expect(fail(deep(11))).toContain('/items/anyOf/0/properties/k')
  })

  it('counts every property and names the one that crosses the limit', () => {
    const props = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, { type: 'string' }]))
    expect(() => checkSchemaLimits(object(props), { ...limits, maxProperties: 6 })).not.toThrow()
    expect(fail(object(props), { maxProperties: 5 })).toContain('#/properties/p5')
  })

  it('counts property names, definition names, enum values and const values as characters', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { abcd: { type: 'string', enum: ['xx', 'yyy'] }, c: { const: 'zzzz' } },
      $defs: { defn: { type: 'string' } },
    }
    expect(() => checkSchemaLimits(schema, { ...limits, maxChars: 4 + 2 + 3 + 1 + 4 + 4 })).not.toThrow()
    expect(fail(schema, { maxChars: 4 + 2 + 3 + 1 + 4 + 3 })).toContain('characters')
  })

  it('rejects recursion only when asked to, naming the reference', () => {
    const recursive: JsonSchema = {
      type: 'object',
      properties: { tree: { $ref: '#/$defs/node' } },
      $defs: { node: object({ child: { $ref: '#/$defs/node' } }) },
    }
    expect(() => checkSchemaLimits(recursive, limits)).not.toThrow()
    expect(fail(recursive, { allowRecursion: false })).toContain('#/$defs/node/properties/child')
    expect(() => checkSchemaLimits({ type: 'object', properties: { a: { $ref: '#' } } }, limits)).not.toThrow()
    expect(fail({ type: 'object', properties: { a: { $ref: '#' } } }, { allowRecursion: false })).toContain('#/properties/a')
  })

  it('follows references for depth', () => {
    const viaRef: JsonSchema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/one' } },
      $defs: { one: object({ b: { $ref: '#/$defs/two' } }), two: object({ c: { type: 'string' } }) },
    }
    expect(() => checkSchemaLimits(viaRef, { ...limits, maxDepth: 3 })).not.toThrow()
    expect(fail(viaRef, { maxDepth: 2 })).toContain('depth')
  })

  it('can require a plain object at the root', () => {
    expect(() => checkSchemaLimits(object({ a: { type: 'string' } }), { ...limits, rootObject: true })).not.toThrow()
    expect(fail({ anyOf: [object({}), { type: 'null' }] }, { rootObject: true })).toContain('#')
    expect(fail({ type: 'array', items: { type: 'string' } }, { rootObject: true })).toContain('root')
  })

  it('can cap enum values', () => {
    const schema = object({ a: { type: 'string', enum: ['1', '2', '3'] }, b: { type: 'string', enum: ['4', '5'] } })
    expect(() => checkSchemaLimits(schema, { ...limits, maxEnumValues: 5 })).not.toThrow()
    expect(fail(schema, { maxEnumValues: 4 })).toContain('#/properties/b')
  })

  it('rejects a reference it cannot resolve', () => {
    expect(fail(object({ a: { $ref: '#/$defs/missing' } }))).toContain('#/properties/a')
    expect(fail(object({ a: { $ref: 'https://example.com/x.json' } }))).toContain('#/properties/a')
  })
})
