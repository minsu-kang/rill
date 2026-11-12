import { checkSchemaLimits, dropUnsupported, strictify, type SchemaLimits, type Strictified } from '../schema'
import type { JsonSchema } from '../types'

export const OPENAI_SCHEMA_LIMITS: SchemaLimits = {
  maxDepth: 10,
  maxProperties: 5000,
  maxChars: 120_000,
  maxEnumValues: 1000,
  allowRecursion: true,
  rootObject: true,
}

const DOCUMENTED_UNSUPPORTED = ['allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas']
const NOT_RELIED_ON = ['default', 'minLength', 'maxLength']

const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_SLOTS = new Set(['items', 'additionalProperties', 'contains', 'propertyNames'])

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)

function convert(node: unknown): unknown {
  if (!isNode(node)) return node
  const out: Node = {}
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAPS.has(key) && isNode(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, convert(child)]))
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) out[key] = value.map(convert)
    else if (SCHEMA_SLOTS.has(key)) out[key] = Array.isArray(value) ? value.map(convert) : convert(value)
    else out[key] = value
  }
  if ('oneOf' in out) {
    const branches = out.oneOf
    delete out.oneOf
    if (!('anyOf' in out)) out.anyOf = branches
  }
  if ('const' in out) {
    const value = out.const
    delete out.const
    if (!('enum' in out)) out.enum = [value]
  }
  return out
}

export function prepareSchema(schema: JsonSchema): Strictified {
  const supported = convert(dropUnsupported(schema, [...DOCUMENTED_UNSUPPORTED, ...NOT_RELIED_ON])) as JsonSchema
  const strict = strictify(supported)
  checkSchemaLimits(strict.schema, OPENAI_SCHEMA_LIMITS)
  return strict
}
