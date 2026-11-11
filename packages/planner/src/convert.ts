import { joinPointer, type PlanIssue } from '@rill/dsl'

type Json = Record<string, unknown>

export interface ConvertLoss {
  pointer: string
  kind: 'constraint' | 'record' | 'unknown'
  detail: string
}

export interface Converted {
  schema: Json
  losses: ConvertLoss[]
}

const DROP = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const

const KEEP_FORMATS = new Set(['date', 'date-time', 'time', 'email', 'uri', 'uuid'])

const JSON_TEXT = 'JSON text of the value.'

function isOpen(schema: Json): boolean {
  return Object.keys(schema).filter((key) => key !== 'description').length === 0
}

function isRecord(schema: Json): boolean {
  return schema.type === 'object' && (schema.patternProperties !== undefined || (schema.additionalProperties !== undefined && schema.additionalProperties !== false))
}

function recordValueSchema(schema: Json): Json {
  const patterns = schema.patternProperties as Record<string, Json> | undefined
  const first = patterns === undefined ? undefined : Object.values(patterns)[0]
  if (first !== undefined) return first
  return typeof schema.additionalProperties === 'object' ? (schema.additionalProperties as Json) : {}
}

function isStringEnum(parts: readonly Json[]): boolean {
  return parts.length > 0 && parts.every((part) => typeof part.const === 'string')
}

function walk(source: Json, pointer: string, losses: ConvertLoss[]): Json {
  const schema: Json = { ...source }
  const notes: string[] = []
  for (const key of DROP) {
    if (!(key in schema)) continue
    notes.push(`${key} ${JSON.stringify(schema[key])}`)
    losses.push({ pointer, kind: 'constraint', detail: `${key}=${JSON.stringify(schema[key])}` })
    delete schema[key]
  }
  if (typeof schema.minItems === 'number' && schema.minItems > 1) {
    notes.push(`minItems ${schema.minItems}`)
    losses.push({ pointer, kind: 'constraint', detail: `minItems=${schema.minItems}` })
    schema.minItems = 1
  }
  if (typeof schema.format === 'string' && !KEEP_FORMATS.has(schema.format)) {
    notes.push(`format ${schema.format}`)
    losses.push({ pointer, kind: 'constraint', detail: `format=${schema.format}` })
    delete schema.format
  }
  const describe = (out: Json): Json => {
    if (notes.length === 0) return out
    const extra = `Constraint: ${notes.join(', ')}.`
    return { ...out, description: typeof out.description === 'string' ? `${out.description} ${extra}` : extra }
  }
  if (isOpen(schema)) {
    losses.push({ pointer, kind: 'unknown', detail: 'any JSON value -> JSON text string' })
    const description = typeof schema.description === 'string' ? `${schema.description} ${JSON_TEXT}` : JSON_TEXT
    return describe({ type: 'string', description })
  }
  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf as Json[]
    const rest = { ...schema }
    delete rest.anyOf
    if (isStringEnum(parts)) return describe({ ...rest, type: 'string', enum: parts.map((part) => part.const) })
    return describe({ ...rest, anyOf: parts.map((part, i) => walk(part, `${pointer}/anyOf/${i}`, losses)) })
  }
  if (isRecord(schema)) {
    losses.push({ pointer, kind: 'record', detail: 'open record -> array of {key, value} entries' })
    const value = walk(recordValueSchema(schema), `${pointer}/*`, losses)
    return describe({
      type: 'array',
      description: typeof schema.description === 'string' ? `${schema.description} Entries of a map, one per key.` : 'Entries of a map, one per key.',
      items: { type: 'object', properties: { key: { type: 'string' }, value }, required: ['key', 'value'], additionalProperties: false },
    })
  }
  if (schema.type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Json>
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
    const properties = Object.fromEntries(Object.entries(props).map(([name, child]) => [name, walk(child, joinPointer(pointer, name), losses)]))
    return describe({
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
      type: 'object',
      properties,
      required: Object.keys(props).filter((name) => required.has(name)),
      additionalProperties: false,
    })
  }
  if (schema.type === 'array') {
    return describe({ ...schema, items: walk((schema.items ?? {}) as Json, `${pointer}/items`, losses) })
  }
  return describe(schema)
}

export function convertSchema(schema: unknown): Converted {
  const losses: ConvertLoss[] = []
  const plain = JSON.parse(JSON.stringify(schema)) as Json
  return { schema: walk(plain, '', losses), losses }
}

export interface Restored {
  value: unknown
  issues: PlanIssue[]
}

export function restoreConverted(schema: unknown, value: unknown, base = ''): Restored {
  const issues: PlanIssue[] = []
  const restore = (source: Json, input: unknown, pointer: string): unknown => {
    if (isOpen(source)) {
      if (typeof input !== 'string') return input
      try {
        return JSON.parse(input)
      } catch {
        issues.push({ stage: 1, pointer, code: 'config_json_parse', message: 'the value is not valid JSON text', hint: 'send this value as JSON text' })
        return undefined
      }
    }
    if (Array.isArray(source.anyOf)) return input
    if (isRecord(source)) {
      if (!Array.isArray(input)) return input
      const valueSchema = recordValueSchema(source)
      const out: Record<string, unknown> = {}
      input.forEach((entry, i) => {
        const { key, value } = (entry ?? {}) as { key?: unknown; value?: unknown }
        if (typeof key !== 'string') return
        if (Object.hasOwn(out, key)) {
          issues.push({ stage: 1, pointer: joinPointer(pointer, i, 'key'), code: 'config_duplicate_key', message: `key ${key} appears twice` })
          return
        }
        out[key] = restore(valueSchema, value, joinPointer(pointer, key))
      })
      return out
    }
    if (source.type === 'object' && input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const props = (source.properties ?? {}) as Record<string, Json>
      return Object.fromEntries(
        Object.entries(input).map(([key, child]) => [key, Object.hasOwn(props, key) ? restore(props[key]!, child, joinPointer(pointer, key)) : child]),
      )
    }
    if (source.type === 'array' && Array.isArray(input)) {
      const items = (source.items ?? {}) as Json
      return input.map((item, i) => restore(items, item, joinPointer(pointer, i)))
    }
    return input
  }
  const plain = JSON.parse(JSON.stringify(schema)) as Json
  return { value: restore(plain, value, base), issues }
}
