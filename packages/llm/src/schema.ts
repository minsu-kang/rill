import { LlmError, type JsonSchema } from './types'

type Node = Record<string, unknown>

export interface Strictified {
  schema: JsonSchema
  restore(data: unknown): unknown
}

export interface SchemaLimits {
  maxDepth: number
  maxProperties: number
  maxChars: number
  allowRecursion: boolean
  rootObject?: boolean
  maxEnumValues?: number
}

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
const SCHEMA_SLOTS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

function isObjectSchema(node: Node): boolean {
  return node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) || isNode(node.properties)
}

function resolveRef(root: Node, ref: string): Node | undefined {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const part of ref.slice(2).split('/')) {
    if (!isNode(current)) return undefined
    current = current[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return isNode(current) ? current : undefined
}

function allowsNull(node: unknown, root: Node, seen: ReadonlySet<string> = new Set()): boolean {
  if (!isNode(node)) return node === true
  if (typeof node.$ref === 'string') {
    const target = seen.has(node.$ref) ? undefined : resolveRef(root, node.$ref)
    return target !== undefined && allowsNull(target, root, new Set([...seen, node.$ref]))
  }
  if ('const' in node && node.const !== null) return false
  if (Array.isArray(node.enum) && !node.enum.includes(null)) return false
  if (node.type !== undefined && node.type !== 'null' && !(Array.isArray(node.type) && node.type.includes('null'))) return false
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key]
    if (Array.isArray(branches)) return branches.some((branch) => allowsNull(branch, root, seen))
  }
  return true
}

export function dropUnsupported(schema: JsonSchema, keywords: readonly string[]): JsonSchema {
  const dropped = new Set(keywords)
  const visit = (node: Node): Node => {
    const out: Node = {}
    for (const [key, value] of Object.entries(node)) {
      if (dropped.has(key)) continue
      if (SCHEMA_MAPS.includes(key) && isNode(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, isNode(child) ? visit(child) : child]))
      } else if ((SCHEMA_LISTS.includes(key) || key === 'items') && Array.isArray(value)) {
        out[key] = value.map((child) => (isNode(child) ? visit(child) : child))
      } else if (SCHEMA_SLOTS.includes(key) && isNode(value)) {
        out[key] = visit(value)
      } else out[key] = structuredClone(value)
    }
    return out
  }
  return visit(schema)
}

function nullable(node: Node): Node {
  const { type } = node
  const scalar = typeof type === 'string' ? SCALAR_TYPES.has(type) : Array.isArray(type) && type.length > 0 && type.every((entry) => SCALAR_TYPES.has(String(entry)))
  if (scalar && !('const' in node) && !('anyOf' in node)) {
    const out: Node = { ...node, type: [...(Array.isArray(type) ? type : [type]), 'null'] }
    if (Array.isArray(node.enum)) out.enum = [...node.enum, null]
    return out
  }
  if (Array.isArray(node.anyOf) && Object.keys(node).every((key) => key === 'anyOf' || key === 'description' || key === 'title')) {
    return { ...node, anyOf: [...node.anyOf, { type: 'null' }] }
  }
  return { anyOf: [node, { type: 'null' }] }
}

function strictNode(node: Node, root: Node, pointer: string): Node {
  const out: Node = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') continue
    if ((SCHEMA_LISTS.includes(key) || key === 'items') && Array.isArray(value)) {
      out[key] = value.map((child, index) => (isNode(child) ? strictNode(child, root, `${pointer}/${key}/${index}`) : child))
    } else if (key === 'items' && isNode(value)) out[key] = strictNode(value, root, `${pointer}/items`)
    else if ((key === '$defs' || key === 'definitions') && isNode(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, isNode(child) ? strictNode(child, root, `${pointer}/${key}/${escapePointer(name)}`) : child]),
      )
    } else out[key] = structuredClone(value)
  }
  if (!isObjectSchema(node)) return out
  const open = node.additionalProperties
  if (isNode(open) || open === true || isNode(node.patternProperties) || (node.properties === undefined && open !== false)) {
    throw new LlmError('invalid_request', `strict mode cannot express an object with free-form keys (at ${pointer})`)
  }
  const properties = isNode(node.properties) ? node.properties : {}
  const required = Array.isArray(node.required) ? node.required : []
  const strictProperties: Node = {}
  for (const [name, child] of Object.entries(properties)) {
    if (!isNode(child)) {
      strictProperties[name] = child
      continue
    }
    const converted = strictNode(child, root, `${pointer}/properties/${escapePointer(name)}`)
    strictProperties[name] = required.includes(name) || allowsNull(child, root) ? converted : nullable(converted)
  }
  out.properties = strictProperties
  out.required = Object.keys(properties)
  out.additionalProperties = false
  return out
}

function pickBranch(node: Node, root: Node, value: Node): Node | undefined {
  if (isNode(node.properties)) return node
  const branches = [node.anyOf, node.oneOf]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .map((branch) => (isNode(branch) && typeof branch.$ref === 'string' ? resolveRef(root, branch.$ref) : branch))
    .filter((branch): branch is Node => isNode(branch) && isNode(branch.properties))
  const keys = Object.keys(value)
  return branches.find((branch) => keys.every((key) => key in (branch.properties as Node))) ?? branches[0]
}

function restoreValue(schema: unknown, root: Node, value: unknown): unknown {
  if (!isNode(schema)) return value
  let node = schema
  for (let hop = 0; hop < 32 && typeof node.$ref === 'string'; hop++) {
    const target = resolveRef(root, node.$ref)
    if (target === undefined) return value
    node = target
  }
  if (Array.isArray(value)) {
    const arrayNode = isNode(node.items) || Array.isArray(node.prefixItems) ? node : [node.anyOf, node.oneOf].flat().find((branch) => isNode(branch) && (isNode(branch.items) || Array.isArray(branch.prefixItems)))
    if (!isNode(arrayNode)) return value
    const prefix = Array.isArray(arrayNode.prefixItems) ? arrayNode.prefixItems : []
    return value.map((entry, index) => restoreValue(prefix[index] ?? arrayNode.items, root, entry))
  }
  if (!isNode(value)) return value
  const branch = pickBranch(node, root, value)
  if (branch === undefined) return value
  const properties = branch.properties as Node
  const required = Array.isArray(branch.required) ? branch.required : []
  const out: Node = {}
  for (const [key, entry] of Object.entries(value)) {
    const child = properties[key]
    if (child === undefined) out[key] = entry
    else if (entry === null && !required.includes(key) && !allowsNull(child, root)) continue
    else out[key] = restoreValue(child, root, entry)
  }
  return out
}

export function strictify(schema: JsonSchema): Strictified {
  const original = structuredClone(schema)
  return { schema: strictNode(original, original, '#'), restore: (data) => restoreValue(original, original, data) }
}

export function checkSchemaLimits(schema: JsonSchema, limits: SchemaLimits): void {
  const fail = (pointer: string, text: string) => new LlmError('invalid_request', `the schema ${text} (at ${pointer})`)
  if (limits.rootObject === true && !(isObjectSchema(schema) && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined)) {
    throw fail('#', 'must have a plain object at its root')
  }
  let properties = 0
  let chars = 0
  let enums = 0
  const addChars = (pointer: string, text: string) => {
    chars += text.length
    if (chars > limits.maxChars) throw fail(pointer, `is longer than ${limits.maxChars} characters in names and values`)
  }
  const count = (node: Node, pointer: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isNode(value)) {
        for (const [name, child] of Object.entries(value)) {
          const at = `${pointer}/properties/${escapePointer(name)}`
          properties += 1
          if (properties > limits.maxProperties) throw fail(at, `has more than ${limits.maxProperties} properties`)
          addChars(at, name)
          if (isNode(child)) count(child, at)
        }
      } else if ((key === '$defs' || key === 'definitions') && isNode(value)) {
        for (const [name, child] of Object.entries(value)) {
          const at = `${pointer}/${key}/${escapePointer(name)}`
          addChars(at, name)
          if (isNode(child)) count(child, at)
        }
      } else if (key === 'enum' && Array.isArray(value)) {
        enums += value.length
        if (limits.maxEnumValues !== undefined && enums > limits.maxEnumValues) throw fail(pointer, `has more than ${limits.maxEnumValues} enum values`)
        for (const entry of value) addChars(pointer, String(entry))
      } else if (key === 'const') addChars(pointer, String(value))
      else if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) {
        value.forEach((child, index) => isNode(child) && count(child, `${pointer}/${key}/${index}`))
      } else if (SCHEMA_SLOTS.includes(key)) {
        if (isNode(value)) count(value, `${pointer}/${key}`)
        else if (key === 'items' && Array.isArray(value)) value.forEach((child, index) => isNode(child) && count(child, `${pointer}/items/${index}`))
      }
    }
  }
  count(schema, '#')

  const seen = new Map<string, number>()
  const depth = (node: unknown, pointer: string, level: number, stack: readonly string[]): void => {
    if (!isNode(node)) return
    if (typeof node.$ref === 'string') {
      const ref = node.$ref
      if (stack.includes(ref)) {
        if (!limits.allowRecursion) throw fail(pointer, `is recursive through ${ref}, which this provider does not accept`)
        return
      }
      const target = resolveRef(schema, ref)
      if (target === undefined) throw fail(pointer, `has a $ref that cannot be resolved (${ref})`)
      if ((seen.get(ref) ?? -1) >= level) return
      seen.set(ref, level)
      depth(target, ref, level, [...stack, ref])
      return
    }
    const here = isObjectSchema(node) ? level + 1 : level
    if (here > limits.maxDepth) throw fail(pointer, `exceeds the depth limit of ${limits.maxDepth}: objects nest ${here} deep`)
    if (isNode(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) depth(child, `${pointer}/properties/${escapePointer(name)}`, here, stack)
    }
    for (const key of [...SCHEMA_LISTS, 'items']) {
      const value = node[key]
      if (Array.isArray(value)) value.forEach((child, index) => depth(child, `${pointer}/${key}/${index}`, here, stack))
      else if (key === 'items') depth(value, `${pointer}/items`, here, stack)
    }
    depth(node.additionalProperties, `${pointer}/additionalProperties`, here, stack)
  }
  depth(schema, '#', 0, [])
}
