import {
  ancestorIndex,
  extractRefs,
  findMalformedTemplates,
  graphIssues,
  isTrigger,
  joinPointer,
  matchWholeRef,
  referenceIssues,
  replaceRefs,
  schemaIssues,
  shapeIssues,
  sortIssues,
  stringLeaves,
  type IssueCode,
  type IssueStage,
  type PlanIssue,
  type SchemaErrorLike,
  type TemplateRef,
  type Workflow,
  type WorkflowNode,
} from '@rill/dsl'
import type Type from 'typebox'
import { Settings } from 'typebox/system'
import Value from 'typebox/value'
import { declaredBranches } from './branches'
import { assertPathAllowed } from './guard'
import type { NodeRegistry } from './registry'
import { fieldRoles, valueAtPointer } from './roles'
import type { NodeDefinition } from './types'
import { watchedFolderIssues } from './watched-folder'

export interface ValidateEnv {
  registry: NodeRegistry
  allowedRoots?: string[]
  connections?: readonly string[]
  stages?: readonly IssueStage[]
}

type Json = Record<string, unknown>

type Resolved = { kind: 'schema'; schema: Json } | { kind: 'open' } | { kind: 'missing'; segment: string; known: string[]; depth: number }

interface Placeholder {
  value: unknown
  nullable: boolean
  fractional: boolean
}

interface Filled {
  check: unknown
  hook: unknown
  templated: Map<string, Placeholder | undefined>
  open: Set<string>
}

const OPEN = Symbol('open')

function asJson(schema: Type.TSchema): Json {
  return schema as unknown as Json
}

function isOpenSchema(schema: Json): boolean {
  return Object.keys(schema).length === 0
}

function recordValue(schema: Json, segment: string): Json | undefined {
  const entries = Object.entries((schema.patternProperties ?? {}) as Record<string, Json>)
  if (entries.length !== 1) return undefined
  const [[pattern, value]] = entries as [[string, Json]]
  return new RegExp(pattern).test(segment) ? value : undefined
}

function nonNullBranches(schema: Json): Json[] {
  const branches = Array.isArray(schema.anyOf) ? (schema.anyOf as Json[]) : [schema]
  return branches.filter((branch) => branch.type !== 'null')
}

export function walkOutput(schema: Json, path: readonly string[]): Resolved {
  let current = schema
  for (const [depth, segment] of path.entries()) {
    if (Array.isArray(current.anyOf)) {
      const branches = nonNullBranches(current)
      if (branches.length !== 1) return { kind: 'open' }
      current = branches[0]!
    }
    if (isOpenSchema(current)) return { kind: 'open' }
    if (current.type === 'array' && /^\d+$/.test(segment)) {
      if (current.items === undefined || typeof current.items !== 'object') return { kind: 'open' }
      current = current.items as Json
      continue
    }
    const properties = current.properties as Record<string, Json> | undefined
    if (current.patternProperties !== undefined && !(properties && Object.hasOwn(properties, segment))) {
      const value = recordValue(current, segment)
      if (value === undefined) return { kind: 'open' }
      current = value
      continue
    }
    if (current.type !== 'object' || properties === undefined) return { kind: 'missing', segment, known: [], depth }
    if (!Object.hasOwn(properties, segment)) return { kind: 'missing', segment, known: Object.keys(properties), depth }
    current = properties[segment]!
  }
  return isOpenSchema(current) ? { kind: 'open' } : { kind: 'schema', schema: current }
}

function scalarPlaceholder(schema: Json): unknown {
  switch (schema.type) {
    case 'string':
      if (schema.const !== undefined) return schema.const
      return Array.isArray(schema.enum) && schema.enum.length > 0 ? schema.enum[0] : 'x'
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return OPEN
  }
}

function kindOf(value: unknown): string {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
}

function isFreeText(schema: Json): boolean {
  const [first] = nonNullBranches(schema)
  return first?.type === 'string' && first.const === undefined && !(Array.isArray(first.enum) && first.enum.length > 0)
}

export function placeholderFor(schema: Json): Placeholder | undefined {
  const branches = Array.isArray(schema.anyOf) ? (schema.anyOf as Json[]) : [schema]
  const nullable = branches.some((branch) => branch.type === 'null')
  const rest = nonNullBranches(schema)
  if (rest.length === 0) return nullable ? { value: null, nullable, fractional: false } : undefined
  const values = rest.map(scalarPlaceholder)
  if (values.some((value) => value === OPEN)) return undefined
  if (new Set(values.map(kindOf)).size !== 1) return undefined
  return { value: values[0], nullable, fractional: rest.some((branch) => branch.type === 'number') }
}

export function subschemaAt(schema: Json, pointer: string): Json | undefined {
  if (pointer === '') return schema
  let current: Json | undefined = schema
  for (const raw of pointer.slice(1).split('/')) {
    if (current === undefined) return undefined
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current.anyOf)) {
      const containers: Json[] = (current.anyOf as Json[]).filter((b) => b.type === 'object' || b.type === 'array')
      if (containers.length !== 1) return undefined
      current = containers[0]!
    }
    if (current.type === 'array') {
      current = typeof current.items === 'object' ? (current.items as Json) : undefined
      continue
    }
    const properties = current.properties as Record<string, Json> | undefined
    if (properties && Object.hasOwn(properties, segment)) {
      current = properties[segment]
      continue
    }
    const patterns = current.patternProperties as Record<string, Json> | undefined
    const matching = Object.entries(patterns ?? {}).find(([pattern]) => new RegExp(pattern).test(segment))
    if (matching) {
      current = matching[1]
      continue
    }
    current = typeof current.additionalProperties === 'object' ? (current.additionalProperties as Json) : undefined
  }
  return current
}

function isUnder(pointer: string, base: string): boolean {
  return pointer === base || pointer.startsWith(base + '/')
}

function shallow(schema: Json): Json {
  const copy: Json = { ...schema }
  for (const key of ['properties', 'patternProperties'] as const) {
    const map = schema[key] as Record<string, Json> | undefined
    if (map !== undefined) copy[key] = Object.fromEntries(Object.keys(map).map((name) => [name, {}]))
  }
  if (Array.isArray(schema.prefixItems)) copy.prefixItems = schema.prefixItems.map(() => ({}))
  if (typeof schema.items === 'object') copy.items = {}
  if (typeof schema.additionalProperties === 'object') copy.additionalProperties = {}
  return copy
}

function childrenOf(schema: Json, value: unknown, pointer: string): [Json, unknown, string][] {
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : value !== null && typeof value === 'object'
      ? Object.entries(value)
      : []
  return entries.flatMap(([key, child]) => {
    const target = subschemaAt(schema, joinPointer('', key))
    return target === undefined ? [] : [[target, child, joinPointer(pointer, key)] as [Json, unknown, string]]
  })
}

function errorKey(error: SchemaErrorLike): string {
  return [error.instancePath, error.keyword, JSON.stringify(error.params)].join('|')
}

function schemaErrors(
  schema: Json,
  value: unknown,
  pointer: string,
  skipped: (pointer: string) => boolean,
): SchemaErrorLike[] {
  if (skipped(pointer)) return []
  const collect = (target: Json): { kept: SchemaErrorLike[]; full: boolean } => {
    const raw = [...Value.Errors(target as Type.TSchema, value)]
    const kept: SchemaErrorLike[] = []
    for (const found of raw) {
      const error = { ...found, instancePath: pointer + found.instancePath }
      if (skipped(error.instancePath)) continue
      if (error.keyword === 'required') {
        const names = ((error.params as { requiredProperties?: string[] }).requiredProperties ?? []).filter(
          (name) => !skipped(joinPointer(error.instancePath, name)),
        )
        if (names.length > 0) kept.push({ ...error, params: { requiredProperties: names } })
        continue
      }
      kept.push(error)
    }
    return { kept, full: raw.length >= Settings.Get().maxErrors }
  }
  const own = collect(schema)
  if (!own.full) return own.kept
  const found = [
    ...own.kept,
    ...collect(shallow(schema)).kept,
    ...childrenOf(schema, value, pointer).flatMap(([child, item, at]) => schemaErrors(child, item, at, skipped)),
  ]
  const seen = new Set<string>()
  return found.filter((error) => {
    const key = errorKey(error)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

class NodeChecker {
  private readonly byId = new Map<string, WorkflowNode>()
  private readonly ancestorsOf: (id: string) => ReadonlySet<string>
  private readonly outputCache = new Map<string, Json | undefined>()

  constructor(
    private readonly wf: Workflow,
    private readonly env: ValidateEnv,
    private readonly issues: PlanIssue[],
  ) {
    for (const node of wf.nodes) if (!this.byId.has(node.id)) this.byId.set(node.id, node)
    this.ancestorsOf = ancestorIndex(wf)
  }

  add(pointer: string, code: IssueCode, message: string, hint?: string): void {
    this.issues.push({ stage: 3, pointer, code, message, ...(hint === undefined ? {} : { hint }) })
  }

  private outputOf(nodeId: string): Json | undefined {
    if (this.outputCache.has(nodeId)) return this.outputCache.get(nodeId)
    const node = this.byId.get(nodeId)
    const def = node && this.env.registry.get(node.type)
    let schema: Json | undefined
    if (node && def) {
      schema = asJson(def.outputSchema)
      if (def.kind === 'action' && def.outputSchemaFor && Value.Check(def.configSchema, node.config)) {
        try {
          schema = asJson(def.outputSchemaFor(node.config))
        } catch {
          schema = asJson(def.outputSchema)
        }
      }
    }
    this.outputCache.set(nodeId, schema)
    return schema
  }

  resolve(node: WorkflowNode, ref: TemplateRef): Resolved | undefined {
    if (!this.byId.has(ref.nodeId) || !this.ancestorsOf(node.id).has(ref.nodeId)) return undefined
    const schema = this.outputOf(ref.nodeId)
    return schema === undefined ? undefined : walkOutput(schema, ref.path)
  }

  fieldReferences(node: WorkflowNode, index: number, label: string): void {
    for (const leaf of stringLeaves(node.config, `/nodes/${index}/config`)) {
      const seen = new Set<string>()
      for (const ref of extractRefs(leaf.value)) {
        const resolved = this.resolve(node, ref)
        if (resolved?.kind !== 'missing') continue
        const shown = [ref.nodeId, 'output', ...ref.path].join('.')
        if (seen.has(shown)) continue
        seen.add(shown)
        const parent = [ref.nodeId, 'output', ...ref.path.slice(0, resolved.depth)].join('.')
        const hint =
          resolved.known.length > 0 ? `available: ${resolved.known.join(', ')}` : `${parent} is not an object`
        this.add(leaf.pointer, 'unknown_output_field', `${label}: ${parent} has no field ${resolved.segment}`, hint)
      }
    }
  }

  fill(node: WorkflowNode): Filled {
    const templated = new Map<string, Placeholder | undefined>()
    const open = new Set<string>()
    const literals = new Set<unknown>(
      stringLeaves(node.config, '')
        .filter((leaf) => extractRefs(leaf.value).length === 0)
        .map((leaf) => leaf.value),
    )
    let counter = 0
    const fresh = (make: (token: string) => string): string => {
      for (;;) {
        const text = make(`x${++counter}`)
        if (!literals.has(text)) return text
      }
    }
    const walk = (value: unknown, pointer: string): { check: unknown; hook: unknown } => {
      if (typeof value === 'string') {
        if (extractRefs(value).length === 0) return { check: value, hook: value }
        const whole = matchWholeRef(value)
        if (!whole) {
          templated.set(pointer, undefined)
          return { check: replaceRefs(value, () => 'x'), hook: fresh((token) => replaceRefs(value, () => token)) }
        }
        const resolved = this.resolve(node, whole)
        const placeholder = resolved?.kind === 'schema' ? placeholderFor(resolved.schema) : undefined
        if (placeholder === undefined) {
          open.add(pointer)
          return { check: OPEN, hook: value }
        }
        templated.set(pointer, placeholder)
        const unique = resolved?.kind === 'schema' && isFreeText(resolved.schema)
        return { check: placeholder.value, hook: unique ? fresh((token) => token) : placeholder.value }
      }
      if (Array.isArray(value)) {
        const parts = value.map((item, i) => walk(item, joinPointer(pointer, i)))
        return { check: parts.map((p) => (p.check === OPEN ? undefined : p.check)), hook: parts.map((p) => p.hook) }
      }
      if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value).map(([k, v]) => [k, walk(v, joinPointer(pointer, k))] as const)
        return {
          check: Object.fromEntries(entries.filter(([, p]) => p.check !== OPEN).map(([k, p]) => [k, p.check])),
          hook: Object.fromEntries(entries.map(([k, p]) => [k, p.hook])),
        }
      }
      return { check: value, hook: value }
    }
    const { check, hook } = walk(node.config, '')
    return { check, hook, templated, open }
  }

  config(node: WorkflowNode, index: number, def: NodeDefinition, label: string): void {
    const base = `/nodes/${index}/config`
    const schema = asJson(def.configSchema)
    const filled = this.fill(node)
    const skipped = (pointer: string) =>
      [...filled.open].some((p) => isUnder(pointer, p)) || [...filled.templated.keys()].some((p) => isUnder(pointer, p))
    const errors = schemaErrors(schema, filled.check, '', skipped)
    const describe = (pointer: string, message: string) => `${label}: invalid config: ${pointer || '/'}: ${message}`
    this.issues.push(...schemaIssues(errors, { stage: 3, prefix: 'config', base, describe }))
    let mismatches = 0
    for (const [pointer, placeholder] of filled.templated) {
      if (this.templated(schema, pointer, placeholder, base, label)) mismatches++
    }
    if (errors.length === 0 && mismatches === 0) this.rule(def, filled.hook, base, label)
  }

  private templated(
    schema: Json,
    pointer: string,
    placeholder: Placeholder | undefined,
    base: string,
    label: string,
  ): boolean {
    const target = subschemaAt(schema, pointer)
    if (target === undefined) return false
    const value = placeholder === undefined ? 'x' : placeholder.value
    const errors = [...Value.Errors(target as Type.TSchema, value)].filter((e) => e.instancePath === '')
    const anyOf = errors.some((e) => e.keyword === 'anyOf')
    const groups = new Map<string, string[]>()
    for (const error of errors) {
      if (error.keyword === 'anyOf') continue
      groups.set(error.schemaPath, [...(groups.get(error.schemaPath) ?? []), error.keyword])
    }
    const mismatch = anyOf
      ? groups.size > 0 && [...groups.values()].every((keywords) => keywords.includes('type'))
      : errors.some((e) => e.keyword === 'type')
    if (mismatch) {
      const expected = [...new Set(errors.filter((e) => e.keyword === 'type').map((e) => String((e.params as { type?: unknown }).type)))]
      this.add(
        base + pointer,
        'config_type',
        `${label}: invalid config: ${pointer}: must be ${expected.join(' or ')}, but the reference gives ${kindOf(value)}`,
        'reference a field of the right type or use a literal value',
      )
      return true
    }
    if (placeholder === undefined) return false
    if (placeholder.nullable && !Value.Check(target as Type.TSchema, null)) {
      this.add(
        base + pointer,
        'nullable_into_required',
        `${label}: ${pointer}: the referenced field can be null, which this field rejects`,
        'make sure the upstream value is never null, or add a condition before this node',
      )
    }
    const fractional = [...Value.Errors(target as Type.TSchema, 0.5)].some((e) => e.instancePath === '' && e.keyword === 'type')
    if (placeholder.fractional && fractional) {
      this.add(
        base + pointer,
        'number_into_integer',
        `${label}: ${pointer}: the referenced field is a number, but this field needs an integer`,
        'reference an integer field',
      )
    }
    return false
  }

  private rule(def: NodeDefinition, config: unknown, base: string, label: string): void {
    const code = (def.ruleIssue?.code ?? 'config_rule') as IssueCode
    const pointer = base + (def.ruleIssue?.pointer ?? '')
    let messages: string[]
    try {
      messages = def.validate?.(config) ?? []
    } catch (error) {
      messages = [error instanceof Error ? error.message : String(error)]
    }
    for (const message of messages) this.add(pointer, code, `${label}: ${message}`)
  }

  environment(node: WorkflowNode, index: number, def: NodeDefinition, label: string): void {
    for (const { pointer, role } of fieldRoles(def)) {
      const value = valueAtPointer(node.config, pointer)
      if (typeof value !== 'string' || extractRefs(value).length > 0 || findMalformedTemplates(value).length > 0) continue
      const at = `/nodes/${index}/config${pointer}`
      const roots = this.env.allowedRoots
      if (role === 'path' && roots !== undefined) {
        try {
          assertPathAllowed(value, roots)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.add(at, 'path_outside_roots', `${label}: ${message}`, `allowed folders: ${roots.join(', ') || '(none)'}`)
        }
      }
      const names = this.env.connections
      if (role === 'connection' && names !== undefined && !names.includes(value)) {
        const hint = names.length > 0 ? `configured: ${names.join(', ')}` : 'no connections are configured'
        this.add(at, 'unknown_connection', `${label}: unknown connection: ${value}`, hint)
      }
    }
  }

  branches(): void {
    const typeOf = new Map(this.wf.nodes.map((n) => [n.id, n.type]))
    this.wf.edges.forEach((edge, index) => {
      if (edge.when === undefined) return
      const source = this.env.registry.get(typeOf.get(edge.from) ?? '')
      if (!source || source.kind === 'trigger') return
      const labels = declaredBranches(source)
      const pointer = `/edges/${index}/when`
      if (labels === null) {
        this.add(
          pointer,
          'when_not_branching',
          `edge ${edge.from} -> ${edge.to}: ${edge.from} never produces a branch, remove "when"`,
        )
      } else if (labels !== 'any' && !labels.includes(edge.when)) {
        this.add(
          pointer,
          'when_unknown_label',
          `edge ${edge.from} -> ${edge.to}: "${edge.when}" is not one of ${labels.join(', ')}`,
          `use one of: ${labels.join(', ')}`,
        )
      }
    })
    this.wf.nodes.forEach((node, index) => {
      const def = this.env.registry.get(node.type)
      if (!def || def.kind === 'trigger' || isTrigger(node.type)) return
      const labels = declaredBranches(def)
      if (labels === null) return
      if (this.wf.edges.some((edge) => edge.from === node.id && edge.when !== undefined)) return
      const hint = labels === 'any' ? 'label outgoing edges with when' : `label outgoing edges with when: ${labels.join(', ')}`
      this.add(`/nodes/${index}`, 'branch_unused', `node ${node.id}: produces a branch but no outgoing edge uses when`, hint)
    })
  }
}

function typeIssues(wf: Workflow, registry: NodeRegistry): PlanIssue[] {
  const catalog = registry
    .list()
    .map((def) => def.type)
    .sort()
  const issues: PlanIssue[] = []
  wf.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    const pointer = `/nodes/${index}/type`
    if (!def) {
      issues.push({
        stage: 1,
        pointer,
        code: 'unknown_node_type',
        message: `unknown node type: ${node.type}`,
        hint: `use one of: ${catalog.join(', ')}`,
      })
    } else if ((def.kind === 'trigger') !== isTrigger(node.type)) {
      issues.push({ stage: 2, pointer, code: 'kind_mismatch', message: `node type kind mismatch: ${node.type}` })
    }
  })
  return issues
}

function semanticIssues(wf: Workflow, env: ValidateEnv): PlanIssue[] {
  const issues = referenceIssues(wf)
  const checker = new NodeChecker(wf, env, issues)
  wf.nodes.forEach((node, index) => {
    const def = env.registry.get(node.type)
    if (!def || (def.kind === 'trigger') !== isTrigger(node.type)) return
    const label = `${def.kind === 'trigger' ? 'trigger' : 'node'} ${node.id}`
    checker.fieldReferences(node, index, label)
    checker.config(node, index, def, label)
    checker.environment(node, index, def, label)
  })
  checker.branches()
  issues.push(...watchedFolderIssues(wf, env.registry))
  return issues
}

export function validateWorkflow(input: unknown, env: ValidateEnv): PlanIssue[] {
  const stages = new Set<IssueStage>(env.stages ?? [1, 2, 3])
  const shape = shapeIssues(input)
  if (shape.length > 0) return stages.has(1) ? sortIssues(shape) : []
  const wf = input as Workflow
  const issues = [
    ...typeIssues(wf, env.registry),
    ...(stages.has(2) ? graphIssues(wf) : []),
    ...(stages.has(3) ? semanticIssues(wf, env) : []),
  ]
  return sortIssues(issues.filter((issue) => stages.has(issue.stage)))
}
