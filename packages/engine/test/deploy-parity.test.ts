import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWarningIssue } from '@rill/dsl'
import { defineAction, validateWorkflow } from '@rill/nodes-core'
import Type from 'typebox'
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
