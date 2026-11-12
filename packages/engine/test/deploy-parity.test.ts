import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWarningIssue, resolveTemplates, type PlanIssue, type Workflow } from '@rill/dsl'
import { NodeRegistry, defineAction, validateWorkflow, type NodeDefinition } from '@rill/nodes-core'
import Type from 'typebox'
import Value from 'typebox/value'
import { afterAll, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, WorkflowValidationError } from '../src/engine'
import { createTestRegistry } from './helpers'

type Config = Record<string, unknown>
interface Node {
  id: string
  type: string
  config: Config
  retry?: { maxAttempts: number; baseDelayMs?: number }
  onError?: 'fail' | 'continue'
}
interface Edge {
  from: string
  to: string
  when?: string
}

const dir = mkdtempSync(join(tmpdir(), 'rill-parity-'))
const root = join(dir, 'allowed')
mkdirSync(root)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const n = (id: string, type: string, config: Config = {}, extra: Partial<Node> = {}): Node => ({ id, type, config, ...extra })
const wf = (nodes: Node[], edges?: Edge[]) => ({
  schemaVersion: 1,
  name: 'corpus',
  nodes,
  edges: edges ?? nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })),
})
const manual = n('t1', 'trigger.manual@1')
const fields = [
  { name: 'amount', type: 'number' },
  { name: 'count', type: 'integer' },
  { name: 'date', type: 'date' },
]
const csv = join(root, 'out.csv')
const branching = (when: [string, string], left: unknown = '{{t1.output.amount}}') =>
  wf(
    [
      manual,
      n('c1', 'condition@1', { left, operator: 'gt', right: 100 }),
      n('big', 'csv.append@1', { file: csv, row: ['{{t1.output.amount}}'] }),
      n('small', 'transform@1', { values: { note: 'small' } }),
    ],
    [
      { from: 't1', to: 'c1' },
      { from: 'c1', to: 'big', when: when[0] },
      { from: 'c1', to: 'small', when: when[1] },
    ],
  )
const receipt = (out: Config = {}) =>
  wf([
    manual,
    n('read', 'file.read@1', { path: '{{t1.output.path}}' }),
    n('ex', 'llm.extract@1', { file: '{{read.output.path}}', fields: fields.slice(0, 1).concat(fields[2]!) }, { retry: { maxAttempts: 3 } }),
    n('out', 'csv.append@1', { file: csv, row: ['{{ex.output.date}}', '{{ex.output.amount}}'], ...out }),
  ])

const VALID: [string, unknown][] = [
  ['echo', wf([manual, n('a', 'test.echo@1', { value: 1 })])],
  ['flaky with retry', wf([manual, n('a', 'test.flaky@1', { failTimes: 1 }, { retry: { maxAttempts: 2 } })])],
  ['fail', wf([manual, n('a', 'test.fail@1')])],
  ['echo chain', wf([manual, n('a', 'test.echo@1', { value: '{{t1.output.x}}' }), n('b', 'test.echo@1', { value: '{{a.output.value}}' })])],
  ['branching', branching(['true', 'false'])],
  ['one labelled branch', branching(['true', 'true'])],
  ['receipt', receipt()],
  [
    'folder receipts',
    wf([
      n('t1', 'trigger.folderWatch@1', { folder: join(root, 'in'), glob: '*.pdf' }),
      n('ex', 'llm.extract@1', { file: '{{t1.output.file}}', fields }),
      n('out', 'csv.append@1', { file: csv, row: ['{{t1.output.name}}', '{{ex.output.date}}', '{{ex.output.count}}'] }),
    ]),
  ],
  ['cron echo', wf([n('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' }), n('a', 'test.echo@1', { value: 1 })])],
  ['cron catch up', wf([n('t1', 'trigger.cron@1', { expression: '0 9 * * 1-5', catchUp: 'once', overlap: 'skip' }), n('d', 'delay@1', { ms: 10 })])],
  [
    'webhook to http',
    wf([
      n('t1', 'trigger.webhook@1', { path: '/hooks/a', method: 'POST', secretConnection: 'hook' }),
      n('h', 'http.request@1', { url: 'https://api.example.test/items', method: 'POST', body: '{{t1.output.body}}', headers: { 'x-id': '{{t1.output.headers.x-id}}' } }),
      n('s', 'notify.slack@1', { connection: 'slack', text: 'status {{h.output.status}}' }),
    ]),
  ],
  ['http with auth', wf([manual, n('h', 'http.request@1', { url: 'https://x.test/{{t1.output.id}}', auth: { connection: 'api', scheme: 'Basic' }, timeoutMs: 1000 })])],
  ['delay from integer field', wf([manual, n('ex', 'llm.extract@1', { text: '{{t1.output.text}}', fields }), n('d', 'delay@1', { ms: 5 }), n('e', 'test.echo@1', { value: '{{ex.output.count}}' })])],
  ['transform values', wf([manual, n('a', 'transform@1', { values: { a: 1, b: '{{t1.output.v}}', c: { d: ['x'] } } })])],
  ['file read', wf([manual, n('r', 'file.read@1', { path: join(root, 'a.txt'), maxBytes: 100 }), n('e', 'test.echo@1', { value: '{{r.output.text}}' })])],
  [
    'continue on error',
    wf(
      [
        manual,
        n('c1', 'condition@1', { left: 5, operator: 'gt', right: '3' }, { onError: 'continue' }),
        n('a', 'test.echo@1', { value: 'a' }),
        n('b', 'test.echo@1', { value: 'b' }),
      ],
      [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'a' },
        { from: 'c1', to: 'b', when: 'true' },
      ],
    ),
  ],
  ['diamond', wf([manual, n('a', 'test.echo@1', { value: 1 }), n('b', 'test.echo@1', { value: 2 }), n('c', 'test.echo@1', { value: '{{a.output.value}}{{b.output.value}}' })], [{ from: 't1', to: 'a' }, { from: 't1', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }])],
  ['webhook get', wf([n('t1', 'trigger.webhook@1', { path: '/hooks/b', method: 'GET' }), n('a', 'transform@1', { values: { q: '{{t1.output.query.q}}' } })])],
  ['condition exists', wf([manual, n('c', 'condition@1', { left: '{{t1.output.v}}', operator: 'exists' }), n('a', 'test.echo@1', { value: 1 })], [{ from: 't1', to: 'c' }, { from: 'c', to: 'a', when: 'false' }])],
  ['warning only: nullable number into delay', wf([manual, n('ex', 'llm.extract@1', { text: 't', fields }), n('d', 'delay@1', { ms: '{{ex.output.amount}}' })])],
  ['warning only: unused branch', wf([manual, n('c', 'condition@1', { left: 1, operator: 'eq', right: 1 }), n('a', 'test.echo@1', { value: 1 })])],
  ['manual only', wf([manual])],
  ['ledger beside a pdf watch', wf([n('t1', 'trigger.folderWatch@1', { folder: join(root, 'in'), glob: '*.pdf' }), n('c', 'csv.append@1', { file: join(root, 'in', 'ledger.csv'), row: [1] })])],
]

const INVALID: [string, unknown][] = [
  ['shape_type', { ...wf([manual]), nodes: 'x' }],
  ['shape_required', { nope: true }],
  ['shape_required', { schemaVersion: 1, nodes: [manual], edges: [] }],
  ['shape_additionalProperties', { ...wf([manual]), extra: 1 }],
  ['shape_pattern', wf([n('T1', 'trigger.manual@1')])],
  ['shape_minLength', { ...wf([manual]), name: '' }],
  ['shape_maxLength', wf([manual, n('a', 'test.echo@1', { value: 1 })], [{ from: 't1', to: 'a', when: 'w'.repeat(65) }])],
  ['shape_minimum', wf([manual, n('a', 'test.echo@1', { value: 1 }, { retry: { maxAttempts: 0 } })])],
  ['shape_maximum', wf([manual, n('a', 'test.echo@1', { value: 1 }, { retry: { maxAttempts: 11 } })])],
  ['shape_minItems', { ...wf([manual]), nodes: [] }],
  ['shape_const', { ...wf([manual]), schemaVersion: 2 }],
  ['shape_anyOf', wf([manual, n('a', 'test.echo@1', { value: 1 }, { onError: 'skip' as 'fail' })])],
  ['unknown_node_type', wf([manual, n('a', 'nope.nothing@1')])],
  ['duplicate_id', wf([manual, n('a', 'test.echo@1', { value: 1 }), n('a', 'test.echo@1', { value: 2 })])],
  ['trigger_count', wf([manual, n('t2', 'trigger.manual@1')])],
  ['edge_unknown_node', wf([manual], [{ from: 't1', to: 'ghost' }])],
  ['trigger_incoming', wf([manual, n('a', 'test.echo@1', { value: 1 })], [{ from: 't1', to: 'a' }, { from: 'a', to: 't1' }])],
  ['trigger_edge_when', wf([manual, n('a', 'test.echo@1', { value: 1 })], [{ from: 't1', to: 'a', when: 'true' }])],
  ['cycle', wf([manual, n('a', 'test.echo@1', { value: 1 }), n('b', 'test.echo@1', { value: 1 })], [{ from: 't1', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }])],
  ['unreachable', wf([manual, n('a', 'test.echo@1', { value: 1 })], [])],
  ['trigger_count', wf([manual, n('a', 'trigger.manual@1')], [{ from: 't1', to: 'a' }])],
  ['unknown_ref_node', wf([manual, n('a', 'test.echo@1', { value: '{{ghost.output.v}}' })])],
  ['ref_not_upstream', branching(['true', 'false'], '{{big.output.file}}')],
  ['malformed_template', wf([manual, n('a', 'test.echo@1', { value: '{{t1.outputs.amount}}' })])],
  ['unknown_output_field', receipt({ row: ['{{ex.output.total}}'] })],
  ['when_not_branching', wf([manual, n('e1', 'test.echo@1', { value: 1 }), n('e2', 'test.echo@1', { value: 2 })], [{ from: 't1', to: 'e1' }, { from: 'e1', to: 'e2', when: 'true' }])],
  ['when_unknown_label', branching(['True', 'false'])],
  ['config_type', wf([manual, n('d', 'delay@1', { ms: 'soon' })])],
  ['config_type', wf([manual, n('ex', 'llm.extract@1', { text: 't', fields }), n('d', 'delay@1', { ms: '{{ex.output.date}}' })])],
  ['config_required', wf([manual, n('a', 'test.echo@1')])],
  ['config_additionalProperties', wf([manual, n('a', 'test.echo@1', { value: 1, other: 2 })])],
  ['config_pattern', wf([manual, n('h', 'http.request@1', { url: 'ftp://x' })])],
  ['config_pattern', wf([n('t1', 'trigger.webhook@1', { path: 'nope' })])],
  ['config_minLength', wf([manual, n('r', 'file.read@1', { path: '' })])],
  ['config_maxLength', wf([manual, n('s', 'notify.slack@1', { connection: 'c', text: 'x'.repeat(3001) })])],
  ['config_minimum', wf([manual, n('d', 'delay@1', { ms: -1 })])],
  ['config_maximum', wf([manual, n('h', 'http.request@1', { url: 'https://x.test', timeoutMs: 60_001 })])],
  ['config_minItems', wf([manual, n('c', 'csv.append@1', { file: csv, row: [] })])],
  ['config_maxItems', wf([manual, n('ex', 'llm.extract@1', { text: 't', fields: Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, type: 'string' })) })])],
  ['config_anyOf', wf([manual, n('h', 'http.request@1', { url: 'https://x.test', method: 'FETCH' })])],
  ['config_anyOf', wf([n('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'mars' })])],
  ['config_rule', wf([manual, n('ex', 'llm.extract@1', { fields: [{ name: 'a', type: 'string' }] })])],
  ['config_rule', wf([manual, n('ex', 'llm.extract@1', { text: 't', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] })])],
  ['config_rule', wf([n('t1', 'trigger.folderWatch@1', { folder: root, glob: 'a/b' })])],
  ['cron_expression', wf([n('t1', 'trigger.cron@1', { expression: '61 * * * *' })])],
  ['cron_expression', wf([n('t1', 'trigger.cron@1', { expression: '0 0 31 2 *' })])],
  ['path_outside_roots', wf([manual, n('c', 'csv.append@1', { file: join(dir, 'other', 'x.csv'), row: [1] })])],
  ['path_outside_roots', wf([n('t1', 'trigger.folderWatch@1', { folder: dir })])],
  ['path_outside_roots', wf([manual, n('c', 'csv.append@1', { file: 'out.csv', row: [1] })])],
  ['path_outside_roots', wf([manual, n('c', 'csv.append@1', { file: './allowed/out.csv', row: [1] })])],
  ['path_outside_roots', wf([manual, n('r', 'file.read@1', { path: 'a.txt' })])],
  ['path_outside_roots', wf([n('t1', 'trigger.folderWatch@1', { folder: 'in' })])],
  ['inside_watched_folder', wf([n('t1', 'trigger.folderWatch@1', { folder: join(root, 'in'), glob: '*' }), n('c', 'csv.append@1', { file: join(root, 'in', 'ledger.csv'), row: [1] })])],
  ['inside_watched_folder', wf([n('t1', 'trigger.folderWatch@1', { folder: join(root, 'in') }), n('c', 'csv.append@1', { file: join(root, 'in', 'ledger.csv'), row: [1] })])],
]

const registry = createTestRegistry()
const engine = new Engine({ db: Db.open(':memory:'), registry, allowedRoots: [root] })

function deployOutcome(input: unknown): WorkflowValidationError | 'deployed' {
  try {
    engine.deploy(input)
    return 'deployed'
  } catch (error) {
    if (error instanceof WorkflowValidationError) return error
    throw error
  }
}

describe('deploy and plan-time validation agree', () => {
  it('has a corpus of at least 40 workflows and an invalid case for every deploy-reachable code', () => {
    expect(VALID.length + INVALID.length).toBeGreaterThanOrEqual(40)
    expect(VALID.length).toBeGreaterThanOrEqual(20)
  })

  for (const [name, input] of [...VALID, ...INVALID]) {
    it(`agrees on ${name}`, () => {
      const errors = validateWorkflow(input, { registry, allowedRoots: [root] }).filter((i) => !isWarningIssue(i))
      const outcome = deployOutcome(input)
      expect(outcome === 'deployed', JSON.stringify(errors)).toBe(errors.length === 0)
      if (outcome !== 'deployed') {
        expect(outcome.problemIssues).toEqual(errors)
        expect(outcome.problems).toEqual(errors.map((i) => i.message))
      }
    })
  }

  for (const [name, input] of VALID) {
    it(`deploys the valid workflow ${name}`, () => {
      expect(deployOutcome(input)).toBe('deployed')
    })
  }

  for (const [code, input] of INVALID) {
    it(`rejects ${code} at deploy with that code`, () => {
      const outcome = deployOutcome(input)
      expect(outcome).not.toBe('deployed')
      expect((outcome as WorkflowValidationError).problemIssues.map((i) => i.code)).toContain(code)
    })
  }
})

describe('deploy kind checks', () => {
  it('rejects an action registered under a trigger name with kind_mismatch', () => {
    const custom = createTestRegistry().register(
      defineAction({
        type: 'trigger.fake@1',
        title: 'Fake',
        description: 'An action with a trigger name.',
        sideEffect: 'none',
        configSchema: Type.Object({}),
        outputSchema: Type.Object({}),
        execute: async () => ({}),
      }),
    )
    const local = new Engine({ db: Db.open(':memory:'), registry: custom })
    const input = wf([manual, n('a', 'trigger.fake@1')])
    expect(() => local.deploy(input)).toThrow('node type kind mismatch: trigger.fake@1')
    expect(validateWorkflow(input, { registry: custom }).map((i) => i.code)).toContain('kind_mismatch')
  })

  it('does not check connection names at deploy, because connections can be added later', () => {
    const input = wf([manual, n('s', 'notify.slack@1', { connection: 'later', text: 'hi' })])
    expect(deployOutcome(input)).toBe('deployed')
  })
})

type Json = Record<string, unknown>
type Mode = 'typical' | 'nulls'

const PAYLOADS: Record<string, Json> = {
  'echo chain': { x: 'hello' },
  branching: { amount: 150 },
  'one labelled branch': { amount: 150 },
  receipt: { path: join(root, 'a.pdf') },
  'webhook to http': { headers: { 'x-id': 'abc' }, body: { a: 1 } },
  'http with auth': { id: '42' },
  'delay from integer field': { text: 'receipt text' },
  'transform values': { v: 'value' },
  'webhook get': { query: { q: 'abc' } },
  'condition exists': { v: 'value' },
}

function sampleOf(schema: Json, mode: Mode): unknown {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Json[]
    const nullable = branches.some((branch) => branch.type === 'null')
    if (mode === 'nulls' && nullable) return null
    return sampleOf(branches.find((branch) => branch.type !== 'null') ?? {}, mode)
  }
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  switch (schema.type) {
    case 'string':
      return schema.format === 'date' || String(schema.pattern ?? '').includes('\\d{4}') ? '2026-01-02' : 'sample'
    case 'integer':
      return 7
    case 'number':
      return 1.5
    case 'boolean':
      return true
    case 'array':
      return [sampleOf((schema.items ?? {}) as Json, mode)]
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Json>
      const patterns = Object.values((schema.patternProperties ?? {}) as Record<string, Json>)
      return {
        ...Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, sampleOf(value, mode)])),
        ...(patterns.length > 0 ? { sample: sampleOf(patterns[0]!, mode) } : {}),
      }
    }
    default:
      return 'sample'
  }
}

function outputSchemaOf(def: NodeDefinition, resolved: unknown): Json {
  const dynamic = def.kind === 'action' && def.outputSchemaFor !== undefined && Value.Check(def.configSchema, resolved)
  return (dynamic ? def.outputSchemaFor!(resolved) : def.outputSchema) as unknown as Json
}

function triggerOutput(def: NodeDefinition, mode: Mode, payload: Json): Json {
  return { ...(sampleOf(def.outputSchema as unknown as Json, mode) as Json), ...payload }
}

function topological(workflow: Workflow): string[] {
  const order: string[] = []
  const placed = new Set<string>()
  while (order.length < workflow.nodes.length) {
    const next = workflow.nodes.find((node) => !placed.has(node.id) && workflow.edges.filter((edge) => edge.to === node.id).every((edge) => placed.has(edge.from)))
    if (!next) throw new Error('the corpus workflow has a cycle')
    placed.add(next.id)
    order.push(next.id)
  }
  return order
}

interface Verdict {
  nodeId: string
  index: number
  ok: boolean
  detail: string
}

function runtimeVerdicts(input: unknown, mode: Mode, payload: Json = {}): Verdict[] {
  const workflow = input as Workflow
  const outputs: Record<string, unknown> = {}
  const verdicts: Verdict[] = []
  for (const id of topological(workflow)) {
    const index = workflow.nodes.findIndex((node) => node.id === id)
    const node = workflow.nodes[index]!
    const def = registry.get(node.type)!
    if (def.kind === 'trigger') {
      outputs[id] = triggerOutput(def, mode, payload)
      continue
    }
    const resolved = resolveTemplates(node.config, outputs, { lenient: def.lenientRefs === true })
    const errors = [...Value.Errors(def.configSchema, resolved)].map((error) => `${error.instancePath || '/'}: ${error.message}`)
    verdicts.push({ nodeId: id, index, ok: Value.Check(def.configSchema, resolved), detail: errors.join('; ') })
    outputs[id] = sampleOf(outputSchemaOf(def, resolved), mode)
  }
  return verdicts
}

const warningsAt = (issues: PlanIssue[], index: number, code: string): boolean =>
  issues.some((issue) => issue.code === code && issue.pointer.startsWith(`/nodes/${index}/config`))

describe('the run-time config check agrees with the validator on the valid corpus', () => {
  for (const [name, input] of VALID) {
    it(`checks every action node of ${name} on sample outputs of the declared schemas`, () => {
      const issues = validateWorkflow(input, { registry, allowedRoots: [root] })
      for (const mode of ['typical', 'nulls'] as const) {
        for (const verdict of runtimeVerdicts(input, mode, PAYLOADS[name])) {
          const warned = warningsAt(issues, verdict.index, mode === 'typical' ? 'number_into_integer' : 'nullable_into_required')
          expect(verdict.ok, `${mode} ${verdict.nodeId}: ${verdict.detail}`).toBe(!warned)
        }
      }
    })
  }

  it('checks every action node of the corpus, and sees the failing node of the warning case in both modes', () => {
    const checked = VALID.reduce((sum, [name, input]) => sum + runtimeVerdicts(input, 'typical', PAYLOADS[name]).length, 0)
    expect(checked).toBeGreaterThanOrEqual(35)
    const warned = VALID.find(([name]) => name === 'warning only: nullable number into delay')![1]
    expect(runtimeVerdicts(warned, 'typical').filter((verdict) => !verdict.ok).map((verdict) => verdict.nodeId)).toEqual(['d'])
    expect(runtimeVerdicts(warned, 'nulls').filter((verdict) => !verdict.ok).map((verdict) => verdict.nodeId)).toEqual(['d'])
  })
})

describe('the oracle is what the engine does when it runs a node', () => {
  const SPOT = ['echo chain', 'receipt', 'folder receipts', 'delay from integer field', 'warning only: nullable number into delay', 'transform values', 'http with auth', 'webhook to http', 'diamond']

  function stubbedRegistry(mode: Mode): NodeRegistry {
    const stubbed = new NodeRegistry()
    for (const def of registry.list()) {
      if (def.kind !== 'action' || def.type === 'condition@1') stubbed.register(def)
      else stubbed.register({ ...def, execute: async (config: unknown) => sampleOf(outputSchemaOf(def, config), mode) })
    }
    return stubbed
  }

  for (const name of SPOT) {
    for (const mode of ['typical', 'nulls'] as const) {
      it(`runs ${name} on ${mode} samples and fails on the node the oracle names`, async () => {
        const input = VALID.find(([entry]) => entry === name)![1]
        const workflow = input as Workflow
        const engine = new Engine({ db: Db.open(':memory:'), registry: stubbedRegistry(mode), allowedRoots: [root], sleep: async () => {} })
        const trigger = registry.get(workflow.nodes[0]!.type)!
        const result = await engine.startRun(engine.deploy(input), triggerOutput(trigger, mode, PAYLOADS[name] ?? {}))
        const first = runtimeVerdicts(input, mode, PAYLOADS[name]).find((verdict) => !verdict.ok)
        if (first === undefined) expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded' })
        else expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining(`node ${first.nodeId} failed: invalid config: ${first.detail}`) })
      })
    }
  }
})

describe('the run-time config check fails where the validator reports a schema error', () => {
  const SCHEMA_CODES = /^config_(type|required|additionalProperties|pattern|minLength|maxLength|minimum|maximum|minItems|maxItems|anyOf)$/u
  for (const [code, input] of INVALID) {
    if (!SCHEMA_CODES.test(code)) continue
    const workflow = input as Workflow
    const errors = validateWorkflow(input, { registry, allowedRoots: [root] }).filter((issue) => !isWarningIssue(issue) && issue.code === code)
    const actionIndexes = errors.map((issue) => /^\/nodes\/(\d+)\//u.exec(issue.pointer)?.[1]).filter((value): value is string => value !== undefined).map(Number)
    const actions = actionIndexes.filter((index) => registry.get(workflow.nodes[index]!.type)?.kind === 'action')
    if (actions.length === 0) continue
    it(`fails the check of the node behind ${code} at ${errors.map((issue) => issue.pointer).join(', ')}`, () => {
      const failed = runtimeVerdicts(input, 'typical').filter((verdict) => !verdict.ok).map((verdict) => verdict.index)
      for (const index of actions) expect(failed).toContain(index)
    })
  }
})

const BASES: Record<string, Json> = {
  'delay@1': { ms: 1 },
  'csv.append@1': { file: csv, row: [1] },
  'http.request@1': { url: 'https://x.test' },
  'file.read@1': { path: join(root, 'a.txt') },
  'notify.slack@1': { connection: 'slack', text: 'hi' },
  'transform@1': { values: {} },
  'condition@1': { operator: 'exists' },
  'llm.extract@1': { text: 'doc', fields: [{ name: 'a', type: 'string' }] },
}

const SOURCES: [string, Node, Node?][] = [
  ['webhook', n('t1', 'trigger.webhook@1', { path: '/hooks/a' })],
  ['folder watch', n('t1', 'trigger.folderWatch@1', { folder: join(root, 'in') })],
  ['cron', n('t1', 'trigger.cron@1', { expression: '* * * * *' })],
  ['llm.extract', manual, n('u', 'llm.extract@1', { text: 'doc', fields })],
  ['http.request', manual, n('u', 'http.request@1', { url: 'https://x.test' })],
  ['file.read', manual, n('u', 'file.read@1', { path: join(root, 'a.txt') })],
  ['csv.append', manual, n('u', 'csv.append@1', { file: csv, row: [1] })],
  ['delay', manual, n('u', 'delay@1', { ms: 1 })],
  ['notify.slack', manual, n('u', 'notify.slack@1', { connection: 'slack', text: 'hi' })],
  ['transform', manual, n('u', 'transform@1', { values: { a: 1 } })],
  ['condition', manual, n('u', 'condition@1', { operator: 'exists' })],
]

interface Leaf {
  path: string[]
  schema: Json
}

function leavesOf(schema: Json, path: string[] = [], depth = 0): Leaf[] {
  const own: Leaf[] = [{ path, schema }]
  if (depth >= 3) return own
  const branches = Array.isArray(schema.anyOf) ? (schema.anyOf as Json[]).filter((branch) => branch.type !== 'null') : [schema]
  if (branches.length !== 1) return own
  const only = branches[0]!
  const children: Leaf[] = []
  for (const [key, value] of Object.entries((only.properties ?? {}) as Record<string, Json>)) children.push(...leavesOf(value, [...path, key], depth + 1))
  for (const value of Object.values((only.patternProperties ?? {}) as Record<string, Json>)) children.push(...leavesOf(value, [...path, 'sample'], depth + 1))
  if (only.type === 'array' && typeof only.items === 'object') children.push(...leavesOf(only.items as Json, [...path, '0'], depth + 1))
  return [...own, ...children]
}

function kindOf(schema: Json): string | undefined {
  if (Object.keys(schema).length === 0) return undefined
  const rest = Array.isArray(schema.anyOf) ? (schema.anyOf as Json[]).filter((branch) => branch.type !== 'null') : [schema]
  const kinds = new Set(rest.map((branch) => (Object.keys(branch).length === 0 ? undefined : branch.type === 'integer' ? 'number' : branch.type)))
  return kinds.size === 1 ? (kinds.values().next().value as string | undefined) : undefined
}

describe('the validator and the run-time check agree on every typed reference between two nodes', () => {
  type Target = { type: string; field: string; shape: 'scalar' | 'array' | 'record'; kind: string | undefined }
  const targets: Target[] = []
  for (const def of registry.list()) {
    if (def.kind !== 'action' || BASES[def.type] === undefined) continue
    for (const [field, schema] of Object.entries((def.configSchema as unknown as { properties: Record<string, Json> }).properties)) {
      const kind = kindOf(schema)
      targets.push({ type: def.type, field, shape: 'scalar', kind })
      if (kind === 'array') targets.push({ type: def.type, field, shape: 'array', kind: undefined })
      if (kind === 'object') targets.push({ type: def.type, field, shape: 'record', kind: undefined })
    }
  }

  function workflowFor(source: (typeof SOURCES)[number], target: Target, ref: string): Workflow {
    const base: Json = { ...BASES[target.type] }
    if (target.type === 'llm.extract@1' && target.field === 'file') delete base['text']
    const value: unknown = target.shape === 'scalar' ? ref : target.shape === 'array' ? [ref] : { k: ref }
    const nodes = [source[1], ...(source[2] === undefined ? [] : [source[2]]), n('a', target.type, { ...base, [target.field]: value })]
    return wf(nodes) as Workflow
  }

  it('compares the two on every reference to a field of a node output and finds no disagreement', () => {
    const disagreements: string[] = []
    const limits: string[] = []
    let compared = 0
    for (const source of SOURCES) {
      const holder = source[2] ?? source[1]
      const schema = outputSchemaOf(registry.get(holder.type)!, holder.config)
      for (const leaf of leavesOf(schema)) {
        const open = kindOf(leaf.schema) === undefined
        const ref = `{{${holder.id}.output${leaf.path.map((part) => `.${part}`).join('')}}}`
        for (const target of targets) {
          const workflow = workflowFor(source, target, ref)
          const index = workflow.nodes.length - 1
          const issues = validateWorkflow(workflow, { registry, allowedRoots: [root] }).filter((issue) => issue.code !== 'inside_watched_folder')
          const errors = issues.filter((issue) => !isWarningIssue(issue) && issue.pointer.startsWith(`/nodes/${index}/config`))
          const label = `${source[0]} ${ref} -> ${target.type} ${target.field} (${target.shape})`
          const elsewhere = issues.filter((issue) => !isWarningIssue(issue) && !issue.pointer.startsWith(`/nodes/${index}/config`))
          if (elsewhere.length > 0) {
            disagreements.push(`${label}: the combination is invalid before the check: ${elsewhere.map((issue) => issue.code).join(',')}`)
            continue
          }
          const verdict = runtimeVerdicts(workflow, 'typical', {}).at(-1)!
          const typeFailure = !verdict.ok && /must be (integer|number|string|boolean|object|array|null)/u.test(verdict.detail)
          if (kindOf(leaf.schema) === 'object' && target.shape === 'scalar' && target.kind === 'object') {
            limits.push(label)
            continue
          }
          compared += 1
          if (errors.length > 0 && verdict.ok) disagreements.push(`${label}: the validator reports ${errors.map((issue) => issue.code).join(',')} but the check passes`)
          if (errors.length === 0 && typeFailure && !warningsAt(issues, index, 'number_into_integer') && !open) {
            disagreements.push(`${label}: the check fails (${verdict.detail}) but the validator is silent`)
          }
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(1200)
    expect(disagreements).toEqual([])
    expect(limits.length).toBeGreaterThan(0)
    expect(limits.every((label) => label.endsWith('(scalar)'))).toBe(true)
  })
})
