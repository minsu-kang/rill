import { SCHEMA_VERSION, joinPointer, schemaIssues, type PlanIssue, type Workflow, type WorkflowNode } from '@rill/dsl'
import type { JsonSchema } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import type Type from 'typebox'
import Value from 'typebox/value'
import type { GenerationCodec } from './ports'
import type { PatchOp, PlanQuestion, PlanResultBody } from './types'

export type GenerationMode = 'create' | 'patch'

export interface GenerationOptions {
  mode?: GenerationMode
  allowQuestions?: boolean
}

export interface EnvelopeRetry {
  maxAttempts: number
  baseDelayMs?: number
}

export interface EnvelopeNode {
  id: string
  type: string
  config: string
  retry?: EnvelopeRetry
  onError?: 'fail' | 'continue'
}

export interface EnvelopeEdge {
  from: string
  to: string
  when?: string
}

export interface EnvelopeWorkflow {
  name: string
  nodes: EnvelopeNode[]
  edges: EnvelopeEdge[]
}

export interface EnvelopePatchOp {
  op: PatchOp['op']
  nodeId?: string
  type?: string
  config?: string
  from?: string
  to?: string
  when?: string
  retry?: EnvelopeRetry
  onError?: 'fail' | 'continue'
}

export interface Envelope {
  kind: PlanResultBody['kind']
  summary: string
  workflow?: EnvelopeWorkflow
  patch?: EnvelopePatchOp[]
  questions?: PlanQuestion[]
  unsupported?: { reason: string; nearest: string }
}

type Json = Record<string, unknown>

const PATCH_OPS: readonly PatchOp['op'][] = ['add_node', 'set_config', 'remove_node', 'connect', 'disconnect']

function object(properties: Record<string, Json>, required: string[], description?: string): Json {
  return {
    type: 'object',
    ...(description === undefined ? {} : { description }),
    properties,
    required,
    additionalProperties: false,
  }
}

const str = (description?: string): Json => ({ type: 'string', ...(description === undefined ? {} : { description }) })

function retrySchema(description = 'Retry policy; only for nodes that call the network.'): Json {
  return object(
    {
      maxAttempts: { type: 'integer', description: 'Attempts in total, 1 to 10.' },
      baseDelayMs: { type: 'integer', description: 'First backoff delay in ms, 0 to 60000.' },
    },
    ['maxAttempts'],
    description,
  )
}

const onErrorSchema = (description?: string): Json => ({ type: 'string', enum: ['fail', 'continue'], ...(description === undefined ? {} : { description }) })

const CONFIG_TEXT = 'The node config as JSON text of one object, matching the config schema of this type in the catalog.'

function workflowSchema(types: string[]): Json {
  const node = object(
    {
      id: str('Lowercase id, ^[a-z][a-z0-9_]{0,31}$, unique in the workflow.'),
      type: { type: 'string', enum: types },
      config: str(CONFIG_TEXT),
      retry: retrySchema(),
      onError: onErrorSchema(),
    },
    ['id', 'type', 'config'],
  )
  const edge = object(
    { from: str(), to: str(), when: str('Branch label; only on edges leaving a branching node.') },
    ['from', 'to'],
  )
  return object(
    { name: str('Short name of the workflow.'), nodes: { type: 'array', items: node }, edges: { type: 'array', items: edge } },
    ['name', 'nodes', 'edges'],
  )
}

function patchSchema(types: string[]): Json {
  const op = object(
    {
      op: { type: 'string', enum: [...PATCH_OPS] },
      nodeId: str('add_node, set_config, remove_node: the node id.'),
      type: { type: 'string', enum: types, description: 'add_node only.' },
      config: str(`add_node, set_config: ${CONFIG_TEXT} set_config replaces the whole config.`),
      from: str('connect, disconnect.'),
      to: str('connect, disconnect.'),
      when: str('connect only: branch label.'),
      retry: retrySchema('add_node, set_config: retry policy; only for nodes that call the network. set_config without retry keeps the current one.'),
      onError: onErrorSchema('add_node, set_config: what a failure does. set_config without onError keeps the current one.'),
    },
    ['op'],
  )
  return { type: 'array', description: 'Changes to the existing workflow, applied in order.', items: op }
}

function questionsSchema(): Json {
  const question = object(
    {
      id: str('Stable id, e.g. target_folder.'),
      text: str('The question, in the language of the user message.'),
      options: { type: 'array', items: str(), description: '2 to 4 options.' },
      default: str('One of the options: the safe default.'),
    },
    ['id', 'text', 'options', 'default'],
  )
  return { type: 'array', items: question, description: 'At most 3 questions.' }
}

function unsupportedSchema(): Json {
  return object(
    {
      reason: str('Why the catalog cannot do this, in the language of the user message.'),
      nearest: str('The nearest thing the catalog can do.'),
    },
    ['reason', 'nearest'],
  )
}

const schemaCache = new WeakMap<NodeRegistry, Map<string, Json>>()

export function generationSchema(registry: NodeRegistry, options: GenerationOptions = {}): JsonSchema {
  const mode = options.mode ?? 'create'
  const allowQuestions = options.allowQuestions ?? true
  const key = `${mode}:${allowQuestions}`
  const cached = schemaCache.get(registry)?.get(key)
  if (cached !== undefined) return structuredClone(cached)
  const types = registry
    .list()
    .map((def) => def.type)
    .sort()
  const kinds = allowQuestions ? ['workflow', 'questions', 'unsupported'] : ['workflow', 'unsupported']
  const properties: Record<string, Json> = {
    kind: { type: 'string', enum: kinds },
    summary: str('Plain-language summary for the user, in the language of the user message.'),
  }
  if (mode === 'create') properties.workflow = workflowSchema(types)
  else properties.patch = patchSchema(types)
  if (allowQuestions) properties.questions = questionsSchema()
  properties.unsupported = unsupportedSchema()
  const schema = object(properties, ['kind', 'summary'])
  const byKey = schemaCache.get(registry) ?? new Map<string, Json>()
  byKey.set(key, schema)
  schemaCache.set(registry, byKey)
  return structuredClone(schema)
}

function encodeRetry(node: { retry?: WorkflowNode['retry']; onError?: WorkflowNode['onError'] }): Pick<EnvelopeNode, 'retry' | 'onError'> {
  return {
    ...(node.retry === undefined ? {} : { retry: { ...node.retry } }),
    ...(node.onError === undefined ? {} : { onError: node.onError }),
  }
}

export function encodePatchOp(op: PatchOp): EnvelopePatchOp {
  switch (op.op) {
    case 'add_node':
      return { op: 'add_node', nodeId: op.node.id, type: op.node.type, config: JSON.stringify(op.node.config), ...encodeRetry(op.node) }
    case 'set_config':
      return { op: 'set_config', nodeId: op.nodeId, config: JSON.stringify(op.config), ...encodeRetry(op) }
    case 'remove_node':
      return { op: 'remove_node', nodeId: op.nodeId }
    case 'connect':
      return { op: 'connect', from: op.edge.from, to: op.edge.to, ...(op.edge.when === undefined ? {} : { when: op.edge.when }) }
    case 'disconnect':
      return { op: 'disconnect', from: op.from, to: op.to }
  }
}

export function encodeWorkflow(workflow: Workflow): EnvelopeWorkflow {
  return {
    name: workflow.name,
    nodes: workflow.nodes.map((node) => ({ id: node.id, type: node.type, config: JSON.stringify(node.config), ...encodeRetry(node) })),
    edges: workflow.edges.map((edge) => ({ ...edge })),
  }
}

export function encodeGeneration(body: PlanResultBody): Envelope {
  switch (body.kind) {
    case 'workflow':
      return body.patch === undefined
        ? { kind: 'workflow', summary: body.summary, workflow: encodeWorkflow(body.workflow) }
        : { kind: 'workflow', summary: body.summary, patch: body.patch.map(encodePatchOp) }
    case 'questions':
      return { kind: 'questions', summary: body.summary, questions: body.questions.map((q) => ({ ...q, options: [...q.options] })) }
    case 'unsupported':
      return { kind: 'unsupported', summary: body.summary, unsupported: { reason: body.reason, nearest: body.nearest } }
  }
}

export function checkEnvelope(
  data: unknown,
  registry: NodeRegistry,
  options: GenerationOptions = {},
): { envelope?: Envelope; issues: PlanIssue[] } {
  const schema = generationSchema(registry, options) as unknown as Type.TSchema
  if (Value.Check(schema, data)) return { envelope: data as Envelope, issues: [] }
  const issues = schemaIssues([...Value.Errors(schema, data)], {
    stage: 1,
    prefix: 'shape',
    base: '',
    describe: (pointer, message) => `output ${pointer || '/'}: ${message}`,
  })
  return { issues }
}

export function memberIssues(envelope: Envelope, mode: GenerationMode): PlanIssue[] {
  const member = envelope.kind === 'workflow' ? (mode === 'create' ? 'workflow' : 'patch') : envelope.kind
  if (envelope[member] !== undefined) return []
  return [
    {
      stage: 1,
      pointer: `/${member}`,
      code: 'missing_member',
      message: `kind is ${envelope.kind}, so the output needs ${member}`,
      hint: `add ${member} or change kind`,
    },
  ]
}

export function parseConfigText(text: string, pointer: string): { config?: Record<string, unknown>; issue?: PlanIssue } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { issue: { stage: 1, pointer, code: 'config_json_parse', message: `config is not valid JSON: ${detail}`, hint: 'send the config as JSON text of one object' } }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { issue: { stage: 1, pointer, code: 'config_json_parse', message: 'config must be the JSON text of an object', hint: 'for example {"ms": 1000}' } }
  }
  return { config: value as Record<string, unknown> }
}

export function workflowFromEnvelope(source: EnvelopeWorkflow): { workflow?: Workflow; issues: PlanIssue[] } {
  const issues: PlanIssue[] = []
  const nodes: WorkflowNode[] = source.nodes.map((node, index) => {
    const parsed = parseConfigText(node.config, joinPointer('/nodes', index, 'config'))
    if (parsed.issue) issues.push(parsed.issue)
    return { id: node.id, type: node.type, config: parsed.config ?? {}, ...encodeRetry(node) }
  })
  if (issues.length > 0) return { issues }
  return {
    workflow: { schemaVersion: SCHEMA_VERSION, name: source.name, nodes, edges: source.edges.map((edge) => ({ ...edge })) },
    issues,
  }
}

export const generationCodec: GenerationCodec = {
  schema: (registry) => generationSchema(registry),
  encode: encodeGeneration,
}
