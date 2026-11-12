import { describe, expect, it } from 'vitest'
import { LlmError, type JsonSchema } from '../../src/index'
import { GrokProvider } from '../../src/grok'
import { prepareGrokSchema } from '../../src/grok/schema'
import { CONFORMANCE_SCHEMA } from '../conformance'
import { createFakeTransport } from '../fake-transport'
import { GROK_MODEL, okReply, OUTPUT_NAME } from './wire'

function dig(value: unknown, ...path: (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Record<string | number, unknown>)[key] : undefined), value)
}

const refused = (schema: JsonSchema): LlmError => {
  try {
    prepareGrokSchema(schema)
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).kind).toBe('invalid_request')
    return error as LlmError
  }
  throw new Error('the schema was accepted')
}

describe('prepareGrokSchema', () => {
  it('leaves a schema that is inside every limit exactly as it is, and does not touch the input', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[a-z]+$', format: 'uuid' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 256 },
        meta: { type: 'object', properties: { k: { type: ['string', 'null'] } }, minProperties: 0, maxProperties: 64, additionalProperties: false },
        kind: { enum: ['a', 'b'] },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        age: { type: 'integer', minimum: 0, maximum: 1e12 },
      },
      required: ['name'],
      additionalProperties: false,
    }
    const before = structuredClone(schema)
    expect(prepareGrokSchema(schema)).toEqual(before)
    expect(schema).toEqual(before)
    expect(prepareGrokSchema(CONFORMANCE_SCHEMA)).toEqual(CONFORMANCE_SCHEMA)
  })

  it('drops the length, item and property bounds that are over the documented limits and keeps the rest', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 2049, maxLength: 2049, pattern: '^x$' },
        list: { type: 'array', items: { type: 'string', maxLength: 2048 }, minItems: 257, maxItems: 257, uniqueItems: true },
        bag: { type: 'object', properties: { a: { type: 'string' } }, minProperties: 65, maxProperties: 65 },
        count: { type: 'integer', minimum: -1e15, maximum: 1e15 },
      },
      required: ['text'],
      maxProperties: 65,
    }
    expect(prepareGrokSchema(schema)).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', pattern: '^x$' },
        list: { type: 'array', items: { type: 'string', maxLength: 2048 }, uniqueItems: true },
        bag: { type: 'object', properties: { a: { type: 'string' } } },
        count: { type: 'integer', minimum: -1e15, maximum: 1e15 },
      },
      required: ['text'],
    })
  })

  it('drops far-over-limit bounds too', () => {
    const schema: JsonSchema = { type: 'object', properties: { a: { type: 'string', maxLength: 1e9 }, b: { type: 'array', items: { type: 'string' }, maxItems: 1e9 } } }
    expect(prepareGrokSchema(schema)).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' } } } })
  })

  it('drops over-limit bounds inside items, anyOf, $defs, prefixItems and additionalProperties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object', properties: { s: { type: 'string', maxLength: 9999 } } } },
        pick: { anyOf: [{ type: 'string', maxLength: 9999 }, { type: 'null' }] },
        ref: { $ref: '#/$defs/big' },
        pair: { type: 'array', prefixItems: [{ type: 'string', minLength: 3000 }], items: false },
      },
      $defs: { big: { type: 'array', items: { type: 'string' }, maxItems: 300 } },
    }
    const out = prepareGrokSchema(schema)
    expect(dig(out, 'properties', 'rows', 'items', 'properties', 's')).toEqual({ type: 'string' })
    expect(dig(out, 'properties', 'pick', 'anyOf', 0)).toEqual({ type: 'string' })
    expect(dig(out, '$defs', 'big')).toEqual({ type: 'array', items: { type: 'string' } })
    expect(dig(out, 'properties', 'pair', 'prefixItems', 0)).toEqual({ type: 'string' })
  })

  it('returns a copy that shares nothing with the input', () => {
    const schema: JsonSchema = { type: 'object', properties: { x: { enum: ['a'] } }, required: ['x'], default: { k: [1] } }
    const out = prepareGrokSchema(schema)
    ;(dig(out, 'properties', 'x', 'enum') as unknown[]).push('z')
    ;(dig(out, 'required') as unknown[]).push('y')
    ;(dig(out, 'default', 'k') as unknown[]).push(2)
    expect(schema).toEqual({ type: 'object', properties: { x: { enum: ['a'] } }, required: ['x'], default: { k: [1] } })
  })

  it('does not drop a property that is merely named like a keyword', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { maxLength: { type: 'integer' }, minItems: { type: 'string', maxLength: 9999 }, enum: { type: 'string' } },
      required: ['maxLength'],
    }
    expect(prepareGrokSchema(schema)).toEqual({
      type: 'object',
      properties: { maxLength: { type: 'integer' }, minItems: { type: 'string' }, enum: { type: 'string' } },
      required: ['maxLength'],
    })
  })

  it('does not drop a value named like a keyword inside enum, const or default', () => {
    const schema: JsonSchema = { type: 'object', properties: { x: { enum: [{ maxLength: 9999 }, 'maxLength'] }, y: { const: { minItems: 999 } }, z: { type: 'string', default: { maxItems: 999 } } } }
    expect(prepareGrokSchema(schema)).toEqual(schema)
  })

  it('refuses a recursive schema and names where it recurses', () => {
    const tree: JsonSchema = { type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } } }
    expect(refused(tree).message).toMatch(/recursive/)
    const defs: JsonSchema = { type: 'object', properties: { node: { $ref: '#/$defs/node' } }, $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } } }
    const error = refused(defs)
    expect(error.message).toMatch(/recursive/)
    expect(error.message).toContain('#/$defs/node')
  })

  it('accepts a $ref that is reused without recursion', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/item' }, b: { $ref: '#/$defs/item' } },
      $defs: { item: { type: 'object', properties: { v: { type: 'string' } } } },
    }
    expect(prepareGrokSchema(schema)).toEqual(schema)
  })

  it.each([
    ['an empty enum', { type: 'object', properties: { a: { enum: [] } } }, '#/properties/a'],
    ['an anyOf with no variants', { type: 'object', properties: { a: { anyOf: [] } } }, '#/properties/a'],
    ['a oneOf with no variants', { type: 'object', properties: { a: { oneOf: [] } } }, '#/properties/a'],
    ['a property whose schema is true', { type: 'object', properties: { a: true } }, '#/properties/a'],
    ['a property whose schema is false', { type: 'object', properties: { a: false } }, '#/properties/a'],
    ['minContains', { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, contains: { type: 'string' }, minContains: 1 } } }, '#/properties/a'],
    ['maxContains', { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, contains: { type: 'string' }, maxContains: 2 } } }, '#/properties/a'],
    ['items as an array', { type: 'object', properties: { a: { type: 'array', items: [{ type: 'string' }] } } }, '#/properties/a'],
    ['an empty enum under $defs', { type: 'object', properties: { a: { $ref: '#/$defs/e' } }, $defs: { e: { enum: [] } } }, '#/$defs/e'],
    ['an empty anyOf in an array item', { type: 'object', properties: { a: { type: 'array', items: { anyOf: [] } } } }, '#/properties/a/items'],
  ])('refuses %s with the pointer to it', (_, schema, pointer) => {
    const error = refused(schema as JsonSchema)
    expect(error.message).toContain(pointer)
  })

  it('does not mistake a property named enum or anyOf for the keyword', () => {
    const schema: JsonSchema = { type: 'object', properties: { enum: { type: 'string' }, anyOf: { type: 'string' }, items: { type: 'string' }, minContains: { type: 'integer' } } }
    expect(prepareGrokSchema(schema)).toEqual(schema)
  })

  it('accepts optional fields, nullable types, oneOf and a single-schema allOf as they are', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: { type: ['string', 'null'] }, b: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, c: { allOf: [{ type: 'object', properties: { d: { type: 'string' } } }] } },
      required: [],
    }
    expect(prepareGrokSchema(schema)).toEqual(schema)
  })
})

describe('the schema in a request', () => {
  const send = async (schema: JsonSchema) => {
    const transport = createFakeTransport()
    const provider = new GrokProvider({ model: GROK_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, sleep: transport.sleep, random: transport.random })
    transport.script(okReply())
    const outcome = await provider.generate({ messages: [{ role: 'user', content: 'x' }], schema, maxTokens: 100 }).then(
      () => undefined,
      (error: unknown) => error as LlmError,
    )
    return { transport, error: outcome }
  }

  it('goes out as text.format with a stable name, strict true and the prepared schema', async () => {
    const { transport } = await send({ type: 'object', properties: { a: { type: 'string', maxLength: 9999 } } })
    expect((transport.requests[0]?.json as { text: unknown }).text).toEqual({
      format: { type: 'json_schema', name: OUTPUT_NAME, strict: true, schema: { type: 'object', properties: { a: { type: 'string' } } } },
    })
  })

  it('refuses a recursive schema before any request is sent', async () => {
    const { transport, error } = await send({ type: 'object', properties: { next: { $ref: '#' } } })
    expect(error?.kind).toBe('invalid_request')
    expect(transport.requests).toHaveLength(0)
  })
})
