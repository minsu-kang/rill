import { checkSchemaLimits } from '../schema'
import { LlmError, type JsonSchema } from '../types'

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
const SCHEMA_SLOTS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']
const EMPTY_FORBIDDEN = ['enum', 'anyOf', 'oneOf']
const CONTAINS_BOUNDS = ['minContains', 'maxContains']

const ENFORCED_LIMITS: ReadonlyMap<string, number> = new Map([
  ['minLength', 2048],
  ['maxLength', 2048],
  ['minItems', 256],
  ['maxItems', 256],
  ['minProperties', 64],
  ['maxProperties', 64],
])

const refuse = (pointer: string, text: string) => new LlmError('invalid_request', `the schema ${text} (at ${pointer})`)

function visit(node: Node, pointer: string): Node {
  if (Array.isArray(node.items)) throw refuse(pointer, 'uses items as an array, which this provider rejects; use prefixItems')
  for (const key of CONTAINS_BOUNDS) if (key in node) throw refuse(pointer, `uses ${key}, which this provider rejects`)
  for (const key of EMPTY_FORBIDDEN) {
    const value = node[key]
    if (Array.isArray(value) && value.length === 0) throw refuse(pointer, `has an empty ${key}, which this provider rejects`)
  }
  const out: Node = {}
  for (const [key, value] of Object.entries(node)) {
    const limit = ENFORCED_LIMITS.get(key)
    if (limit !== undefined && typeof value === 'number' && value > limit) continue
    if (SCHEMA_MAPS.includes(key) && isNode(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => {
          const at = `${pointer}/${key}/${escapePointer(name)}`
          if (key === 'properties' && typeof child === 'boolean') throw refuse(at, 'has a property whose schema is true or false, which this provider rejects')
          return [name, isNode(child) ? visit(child, at) : structuredClone(child)]
        }),
      )
    } else if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) {
      out[key] = value.map((child, index) => (isNode(child) ? visit(child, `${pointer}/${key}/${index}`) : structuredClone(child)))
    } else if (SCHEMA_SLOTS.includes(key) && isNode(value)) {
      out[key] = visit(value, `${pointer}/${key}`)
    } else out[key] = structuredClone(value)
  }
  return out
}

export function prepareGrokSchema(schema: JsonSchema): JsonSchema {
  checkSchemaLimits(schema, { maxDepth: Infinity, maxProperties: Infinity, maxChars: Infinity, allowRecursion: false })
  return visit(schema, '#')
}
