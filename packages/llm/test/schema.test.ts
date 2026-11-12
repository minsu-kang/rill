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

describe('strictify: which optional properties get a null', () => {
  const only = (property: JsonSchema, extra: Record<string, JsonSchema> = {}, definitions?: Record<string, JsonSchema>): JsonSchema => ({
    ...object({ p: property }),
    ...(definitions === undefined ? {} : { $defs: definitions }),
    ...extra,
  })
  const propertyOf = (schema: JsonSchema) => (schema.properties as Record<string, JsonSchema>).p

  it('leaves an optional property alone when its type list already has null', () => {
    expect(propertyOf(strictify(only({ type: ['string', 'null'] })).schema)).toEqual({ type: ['string', 'null'] })
  })

  it('leaves an optional union alone when one branch is null, and adds null to one that has none', () => {
    expect(propertyOf(strictify(only({ anyOf: [{ type: 'string' }, { type: 'null' }] })).schema)).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(propertyOf(strictify(only({ anyOf: [{ type: 'string' }, { type: 'number' }] })).schema)).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] })
  })

  it('follows a reference to see whether the target already takes null', () => {
    const nullable = strictify(only({ $ref: '#/$defs/maybe' }, {}, { maybe: { type: ['string', 'null'] } }))
    expect(propertyOf(nullable.schema)).toEqual({ $ref: '#/$defs/maybe' })
    const plain = strictify(only({ $ref: '#/$defs/text' }, {}, { text: { type: 'string' } }))
    expect(propertyOf(plain.schema)).toEqual({ anyOf: [{ $ref: '#/$defs/text' }, { type: 'null' }] })
  })

  it('wraps an optional const and an optional enum that has no type, because neither takes null', () => {
    expect(propertyOf(strictify(only({ const: 'x' })).schema)).toEqual({ anyOf: [{ const: 'x' }, { type: 'null' }] })
    expect(propertyOf(strictify(only({ enum: ['a', 'b'] })).schema)).toEqual({ anyOf: [{ enum: ['a', 'b'] }, { type: 'null' }] })
  })

  it('treats a const null and an enum with null as already taking null', () => {
    expect(propertyOf(strictify(only({ const: null })).schema)).toEqual({ const: null })
    expect(propertyOf(strictify(only({ enum: ['a', null] })).schema)).toEqual({ enum: ['a', null] })
  })

  it('adds null to the type list of an optional scalar, integer included, and wraps a type list that is not all scalars', () => {
    expect(propertyOf(strictify(only({ type: 'integer' })).schema)).toEqual({ type: ['integer', 'null'] })
    expect(propertyOf(strictify(only({ type: ['string', 'integer'] })).schema)).toEqual({ type: ['string', 'integer', 'null'] })
    expect(propertyOf(strictify(only({ type: ['string', 'array'] })).schema)).toEqual({ anyOf: [{ type: ['string', 'array'] }, { type: 'null' }] })
  })

  it('closes the objects inside each branch of a union and inside array items', () => {
    const { schema } = strictify(only({ anyOf: [object({ a: { type: 'string' } }), { type: 'array', items: object({ b: { type: 'string' } }) }] }))
    const branches = (propertyOf(schema) as { anyOf: JsonSchema[] }).anyOf
    expect(branches[0]).toEqual({ type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'], additionalProperties: false })
    expect(branches[1]).toEqual({ type: 'array', items: { type: 'object', properties: { b: { type: ['string', 'null'] } }, required: ['b'], additionalProperties: false } })
  })

  it('closes the objects in definitions and in tuple items', () => {
    const { schema } = strictify(only({ type: 'array', prefixItems: [object({ t: { type: 'string' } })] }, {}, { leaf: object({ l: { type: 'string' } }) }))
    expect((schema.$defs as Record<string, JsonSchema>).leaf).toMatchObject({ required: ['l'], additionalProperties: false })
    expect(((propertyOf(schema) as { anyOf: JsonSchema[] }).anyOf[0] as { prefixItems: JsonSchema[] }).prefixItems[0]).toMatchObject({ required: ['t'], additionalProperties: false })
  })

  it('refuses an object that has properties and also a schema for the rest, or pattern properties', () => {
    expect(() => strictify(only({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } }))).toThrow('#/properties/p')
    expect(() => strictify(only({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }))).toThrow('#/properties/p')
    expect(() => strictify(only({ type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x': { type: 'string' } } }))).toThrow('#/properties/p')
    expect(() => strictify(only({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }))).not.toThrow()
  })
})

describe('restore: edge cases', () => {
  it('keeps a null that the original schema allowed, and a null on a required property it does not allow', () => {
    const original = object({ maybe: { type: ['string', 'null'] }, must: { type: 'string' }, extra: { type: 'string' } }, ['must'])
    const { restore } = strictify(original)
    expect(restore({ maybe: null, must: null, extra: null })).toEqual({ maybe: null, must: null })
  })

  it('restores the elements of a tuple by their own position', () => {
    const { restore } = strictify(object({ pair: { type: 'array', prefixItems: [object({ a: { type: 'string' } }), object({ b: { type: 'string' } })] } }, ['pair']))
    expect(restore({ pair: [{ a: null }, { b: 'x' }] })).toEqual({ pair: [{}, { b: 'x' }] })
    expect(restore({ pair: [{ a: 'y' }, { b: null }] })).toEqual({ pair: [{ a: 'y' }, {}] })
  })

  it('follows a chain of references longer than one hop', () => {
    const { restore } = strictify({
      ...object({ top: { $ref: '#/$defs/one' } }, ['top']),
      $defs: { one: { $ref: '#/$defs/two' }, two: { $ref: '#/$defs/three' }, three: object({ a: { type: 'string' } }) },
    })
    expect(restore({ top: { a: null } })).toEqual({ top: {} })
  })

  it('stops following references that loop back on themselves', () => {
    const { restore } = strictify({ ...object({ top: { $ref: '#/$defs/loop' } }, ['top']), $defs: { loop: { $ref: '#/$defs/loop' } } })
    expect(restore({ top: { a: null } })).toEqual({ top: { a: null } })
  })

  it('picks the union branch that has every key of the value, then falls back to the first branch', () => {
    const { restore } = strictify(
      object({ pick: { anyOf: [object({ a: { type: 'string' } }, ['a']), object({ a: { type: 'string' }, b: { type: 'string' } }, ['a'])] } }, ['pick']),
    )
    expect(restore({ pick: { a: 'x', b: null } })).toEqual({ pick: { a: 'x' } })
    const first = strictify(object({ pick: { anyOf: [object({ a: { type: 'string' }, b: { type: 'string' } }, ['a']), object({ c: { type: 'string' } }, ['c'])] } }, ['pick']))
    expect(first.restore({ pick: { a: 'x', b: null, z: 1 } })).toEqual({ pick: { a: 'x', z: 1 } })
  })

  it('leaves unknown keys of an object as they are', () => {
    const { restore } = strictify(object({ a: { type: 'string' } }))
    expect(restore({ a: null, other: null })).toEqual({ other: null })
  })
})

describe('checkSchemaLimits: root and pointers', () => {
  const limits = { maxDepth: 10, maxProperties: 5000, maxChars: 120_000, allowRecursion: true, rootObject: true }

  it('refuses a root that is an object but also a union', () => {
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      expect(() => checkSchemaLimits({ ...object({ a: { type: 'string' } }), [keyword]: [{ type: 'object' }] }, limits), keyword).toThrow('root')
    }
  })

  it('escapes slash and tilde in a property name inside the pointer it reports', () => {
    const schema = object({ 'a/b': object({ 'c~d': { type: 'string' } }) })
    expect(() => checkSchemaLimits(schema, { ...limits, maxProperties: 1 })).toThrow('#/properties/a~1b/properties/c~0d')
    expect(() => checkSchemaLimits(schema, { ...limits, maxDepth: 1 })).toThrow('#/properties/a~1b')
  })

  it('counts the characters of every property name, including ones inside definitions', () => {
    const schema: JsonSchema = { ...object({ ab: { type: 'string' } }), $defs: { leaf: object({ cde: { type: 'string' } }) } }
    expect(() => checkSchemaLimits(schema, { ...limits, maxChars: 2 + 4 + 3 })).not.toThrow()
    expect(() => checkSchemaLimits(schema, { ...limits, maxChars: 2 + 4 + 2 })).toThrow('characters')
  })
})
