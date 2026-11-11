import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ISSUE_CODES, isWarningIssue, type PlanIssue, type Workflow } from '@rill/dsl'
import Type from 'typebox'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createCoreRegistry,
  defineAction,
  defineTrigger,
  placeholderFor,
  subschemaAt,
  validateWorkflow,
  walkOutput,
  type ValidateEnv,
} from '../src/index'

type Node = Workflow['nodes'][number]

const dir = mkdtempSync(join(tmpdir(), 'rill-validate-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const registry = createCoreRegistry()
const env: ValidateEnv = { registry }

const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({ id, type, config })
const manual = n('t1', 'trigger.manual@1')
const chain = (...nodes: Node[]): Workflow => ({
  schemaVersion: 1,
  name: 'wf',
  nodes,
  edges: nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })),
})
const extract = (id: string, config: Record<string, unknown> = {}) =>
  n(id, 'llm.extract@1', {
    text: 'receipt',
    fields: [
      { name: 'amount', type: 'number' },
      { name: 'count', type: 'integer' },
      { name: 'date', type: 'date' },
    ],
    ...config,
  })
const brief = (issues: PlanIssue[]) => issues.map((i) => `${i.code} ${i.pointer}`)
const errorsOf = (input: unknown, e: ValidateEnv = env) => validateWorkflow(input, e).filter((i) => !isWarningIssue(i))

const custom = createCoreRegistry()
  .register(
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
  .register(
    defineTrigger({ type: 'test.trigger@1', title: 'T', description: 'A trigger without the prefix.', configSchema: Type.Object({}), outputSchema: Type.Object({}) }),
  )
  .register(
    defineAction({
      type: 'test.list@1',
      title: 'List',
      description: 'Returns a list of rows.',
      sideEffect: 'none',
      configSchema: Type.Object({}),
      outputSchema: Type.Object({
        rows: Type.Array(Type.Object({ name: Type.String(), size: Type.Integer() })),
        any: Type.Array(Type.Unknown()),
        either: Type.Union([Type.String(), Type.Number()]),
        maybe: Type.Union([Type.Object({ inner: Type.Boolean() }), Type.Null()]),
      }),
      execute: async () => ({ rows: [], any: [], either: 'a', maybe: null }),
    }),
  )
  .register(
    defineAction({
      type: 'test.sink@1',
      title: 'Sink',
      description: 'Accepts typed values.',
      sideEffect: 'none',
      configSchema: Type.Object(
        {
          text: Type.Optional(Type.String()),
          flag: Type.Optional(Type.Boolean()),
          count: Type.Optional(Type.Integer()),
          num: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          mode: Type.Optional(Type.Union([Type.Literal('a'), Type.Literal('b')])),
          list: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
          map: Type.Optional(Type.Record(Type.String(), Type.Integer())),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object({}),
      validate: (config) => {
        if ((config as { text?: string }).text === 'throw') throw new Error('hook exploded')
        return (config as { text?: string }).text === 'bad' ? ['text must not be bad'] : []
      },
      execute: async () => ({}),
    }),
  )
const customEnv: ValidateEnv = { registry: custom }

interface CodeCase {
  code: string
  input: unknown
  pointer: string
  env?: ValidateEnv
}

const valid = chain(manual, n('a', 'delay@1', { ms: 1 }))

const CASES: CodeCase[] = [
  { code: 'shape_type', input: { ...valid, nodes: [{ ...manual, config: 'x' }] }, pointer: '/nodes/0/config' },
  { code: 'shape_required', input: { schemaVersion: 1, nodes: valid.nodes, edges: [] }, pointer: '/name' },
  { code: 'shape_additionalProperties', input: { ...valid, extra: true }, pointer: '/extra' },
  { code: 'shape_pattern', input: { ...valid, nodes: [{ ...manual, id: 'T1' }] }, pointer: '/nodes/0/id' },
  { code: 'shape_minLength', input: { ...valid, name: '' }, pointer: '/name' },
  { code: 'shape_maxLength', input: { ...valid, edges: [{ from: 't1', to: 'a', when: 'w'.repeat(65) }] }, pointer: '/edges/0/when' },
  { code: 'shape_minimum', input: { ...valid, nodes: [{ ...manual, retry: { maxAttempts: 0 } }] }, pointer: '/nodes/0/retry/maxAttempts' },
  { code: 'shape_maximum', input: { ...valid, nodes: [{ ...manual, retry: { maxAttempts: 1, baseDelayMs: 60_001 } }] }, pointer: '/nodes/0/retry/baseDelayMs' },
  { code: 'shape_minItems', input: { ...valid, nodes: [] }, pointer: '/nodes' },
  { code: 'shape_const', input: { ...valid, schemaVersion: 9 }, pointer: '/schemaVersion' },
  { code: 'shape_anyOf', input: { ...valid, nodes: [{ ...manual, onError: 'skip' }] }, pointer: '/nodes/0/onError' },
  { code: 'unknown_node_type', input: chain(manual, n('a', 'nope@1')), pointer: '/nodes/1/type' },
  { code: 'duplicate_id', input: chain(manual, n('a', 'delay@1', { ms: 1 }), n('a', 'delay@1', { ms: 1 })), pointer: '/nodes/2/id' },
  { code: 'trigger_count', input: chain(n('a', 'delay@1', { ms: 1 })), pointer: '/nodes' },
  { code: 'edge_unknown_node', input: { ...valid, edges: [{ from: 't1', to: 'ghost' }] }, pointer: '/edges/0/to' },
  { code: 'trigger_incoming', input: { ...valid, edges: [...valid.edges, { from: 'a', to: 't1' }] }, pointer: '/edges/1' },
  { code: 'trigger_edge_when', input: { ...valid, edges: [{ from: 't1', to: 'a', when: 'true' }] }, pointer: '/edges/0/when' },
  { code: 'cycle', input: { ...chain(manual, n('a', 'delay@1', { ms: 1 }), n('b', 'delay@1', { ms: 1 })), edges: [{ from: 't1', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }, pointer: '/edges' },
  { code: 'unreachable', input: { ...chain(manual, n('a', 'delay@1', { ms: 1 })), edges: [] }, pointer: '/nodes/1' },
  { code: 'kind_mismatch', input: chain(manual, n('a', 'trigger.fake@1')), pointer: '/nodes/1/type', env: customEnv },
  { code: 'unknown_ref_node', input: chain(manual, n('a', 'transform@1', { values: { v: '{{ghost.output.x}}' } })), pointer: '/nodes/1/config/values/v' },
  { code: 'ref_not_upstream', input: chain(manual, n('a', 'transform@1', { values: { v: '{{b.output.x}}' } }), n('b', 'transform@1', { values: {} })), pointer: '/nodes/1/config/values/v' },
  { code: 'malformed_template', input: chain(manual, n('a', 'transform@1', { values: { v: '{{t1.outputs.x}}' } })), pointer: '/nodes/1/config/values/v' },
  { code: 'unknown_output_field', input: chain(manual, extract('x'), n('a', 'delay@1', { ms: '{{x.output.total}}' })), pointer: '/nodes/2/config/ms' },
  { code: 'when_not_branching', input: { ...chain(manual, n('a', 'delay@1', { ms: 1 }), n('b', 'delay@1', { ms: 1 })), edges: [{ from: 't1', to: 'a' }, { from: 'a', to: 'b', when: 'true' }] }, pointer: '/edges/1/when' },
  { code: 'when_unknown_label', input: { ...chain(manual, n('c', 'condition@1', { operator: 'exists' }), n('b', 'delay@1', { ms: 1 })), edges: [{ from: 't1', to: 'c' }, { from: 'c', to: 'b', when: 'yes' }] }, pointer: '/edges/1/when' },
  { code: 'branch_unused', input: chain(manual, n('c', 'condition@1', { operator: 'exists' }), n('b', 'delay@1', { ms: 1 })), pointer: '/nodes/1' },
  { code: 'config_type', input: chain(manual, n('a', 'delay@1', { ms: 'soon' })), pointer: '/nodes/1/config/ms' },
  { code: 'config_required', input: chain(manual, n('a', 'delay@1')), pointer: '/nodes/1/config/ms' },
  { code: 'config_additionalProperties', input: chain(manual, n('a', 'delay@1', { ms: 1, extra: 2 })), pointer: '/nodes/1/config/extra' },
  { code: 'config_pattern', input: chain(manual, n('a', 'http.request@1', { url: 'ftp://x' })), pointer: '/nodes/1/config/url' },
  { code: 'config_minLength', input: chain(manual, n('a', 'file.read@1', { path: '' })), pointer: '/nodes/1/config/path' },
  { code: 'config_maxLength', input: chain(manual, n('a', 'notify.slack@1', { connection: 'c', text: 'x'.repeat(3001) })), pointer: '/nodes/1/config/text' },
  { code: 'config_minimum', input: chain(manual, n('a', 'delay@1', { ms: -1 })), pointer: '/nodes/1/config/ms' },
  { code: 'config_maximum', input: chain(manual, n('a', 'delay@1', { ms: 86_400_001 })), pointer: '/nodes/1/config/ms' },
  { code: 'config_minItems', input: chain(manual, n('a', 'csv.append@1', { file: '/x.csv', row: [] })), pointer: '/nodes/1/config/row' },
  { code: 'config_maxItems', input: chain(manual, n('a', 'test.sink@1', { list: ['a', 'b', 'c'] })), pointer: '/nodes/1/config/list', env: customEnv },
  { code: 'config_anyOf', input: chain(manual, n('a', 'http.request@1', { url: 'https://x', method: 'FETCH' })), pointer: '/nodes/1/config/method' },
  { code: 'config_rule', input: chain(manual, n('a', 'llm.extract@1', { fields: [{ name: 'a', type: 'string' }] })), pointer: '/nodes/1/config' },
  { code: 'cron_expression', input: chain(n('t1', 'trigger.cron@1', { expression: '61 * * * *' })), pointer: '/nodes/0/config/expression' },
  { code: 'nullable_into_required', input: chain(manual, extract('x'), n('a', 'delay@1', { ms: '{{x.output.count}}' })), pointer: '/nodes/2/config/ms' },
  { code: 'number_into_integer', input: chain(manual, extract('x'), n('a', 'delay@1', { ms: '{{x.output.amount}}' })), pointer: '/nodes/2/config/ms' },
  { code: 'path_outside_roots', input: chain(manual, n('a', 'file.read@1', { path: '/etc/hosts' })), pointer: '/nodes/1/config/path', env: { registry, allowedRoots: [dir] } },
  { code: 'unknown_connection', input: chain(manual, n('a', 'notify.slack@1', { connection: 'team', text: 'hi' })), pointer: '/nodes/1/config/connection', env: { registry, connections: ['ops'] } },
]

const UNREACHABLE: Record<string, string> = {
  config_json_parse: 'produced by the planner when it decodes config text',
  shape_format: 'WorkflowSchema has no format',
  shape_exclusiveMinimum: 'WorkflowSchema has no exclusive bounds',
  shape_exclusiveMaximum: 'WorkflowSchema has no exclusive bounds',
  shape_multipleOf: 'WorkflowSchema has no multipleOf',
  shape_maxItems: 'WorkflowSchema has no maxItems',
  shape_uniqueItems: 'WorkflowSchema has no uniqueItems',
  shape_enum: 'WorkflowSchema has no enum',
  shape_invalid: 'fallback for keywords TypeBox may add later',
  config_format: 'no core config uses format',
  config_exclusiveMinimum: 'no core config uses exclusive bounds',
  config_exclusiveMaximum: 'no core config uses exclusive bounds',
  config_multipleOf: 'no core config uses multipleOf',
  config_uniqueItems: 'no core config uses uniqueItems',
  config_enum: 'TypeBox literal unions are anyOf of const',
  config_const: 'a const at the top of a config cannot be reached through a union',
  config_invalid: 'fallback for keywords TypeBox may add later',
}

describe('validateWorkflow issue codes', () => {
  for (const c of CASES) {
    it(`reports ${c.code} at ${c.pointer}`, () => {
      const issues = validateWorkflow(c.input, c.env ?? env)
      const hit = issues.find((i) => i.code === c.code)
      expect(hit, JSON.stringify(issues)).toBeDefined()
      expect(hit!.pointer).toBe(c.pointer)
      expect(hit!.message.length).toBeGreaterThan(0)
    })
  }

  it('has a case for every reachable code', () => {
    const covered = new Set(CASES.map((c) => c.code))
    const missing = ISSUE_CODES.filter((code) => !covered.has(code) && !(code in UNREACHABLE))
    expect(missing).toEqual([])
  })

  it('accepts the base workflow of the cases', () => {
    expect(validateWorkflow(valid, env)).toEqual([])
  })
})

describe('validateWorkflow semantics', () => {
  it('reproduces the prototype cases', () => {
    const wf = chain(
      n('t1', 'trigger.folderWatch@1', { folder: '~/Receipts', glob: '*.pdf' }),
      n('n1', 'llm.extract@1', { file: '{{t1.output.file}}', fields: [{ name: 'amount', type: 'number' }, { name: 'date', type: 'date' }] }),
      n('n2', 'condition@1', { left: '{{n1.output.amount}}', operator: 'gt', right: 100 }),
      n('n3', 'delay@1', { ms: '{{n1.output.amount}}' }),
      n('n4', 'delay@1', { ms: '{{n1.output.date}}' }),
      n('n5', 'csv.append@1', { file: '~/Receipts/ledger.csv', row: ['{{n1.output.date}}', '{{n1.output.total}}'] }),
      n('n6', 'http.request@1', { url: '{{t1.output.name}}', method: 'POST', body: { a: '{{n1.output.amount}}' } }),
      n('n7', 'notify.slack@1', { connection: 'team', text: 'Paid {{n1.output.amount}} on {{n1.output.date}}' }),
      n('n8', 'http.request@1', { url: 'ftp://x' }),
      n('n9', 'llm.extract@1', { input: '{{t1.output.file}}', fields: { amount: 'number', date: 'date' } }),
    )
    const issues = validateWorkflow(wf, env)
    expect(brief(issues)).toEqual([
      'branch_unused /nodes/2',
      'nullable_into_required /nodes/3/config/ms',
      'number_into_integer /nodes/3/config/ms',
      'config_type /nodes/4/config/ms',
      'unknown_output_field /nodes/5/config/row/1',
      'config_pattern /nodes/8/config/url',
      'config_type /nodes/9/config/fields',
      'config_additionalProperties /nodes/9/config/input',
    ])
    expect(issues.find((i) => i.code === 'unknown_output_field')!.hint).toBe('available: amount, date')
    expect(issues.find((i) => i.pointer === '/nodes/4/config/ms')!.message).toBe(
      'node n4: invalid config: /ms: must be integer, but the reference gives string',
    )
  })

  it('uses the dynamic output schema of llm.extract and falls back to the open record when its config is invalid', () => {
    const ok = chain(manual, extract('x'), n('a', 'csv.append@1', { file: '/o.csv', row: ['{{x.output.date}}', '{{x.output.amount}}'] }))
    expect(validateWorkflow(ok, env)).toEqual([])
    const broken = chain(manual, n('x', 'llm.extract@1', { text: 'r', fields: 'nope' }), n('a', 'delay@1', { ms: '{{x.output.anything}}' }))
    expect(brief(validateWorkflow(broken, env))).toEqual(['config_type /nodes/1/config/fields'])
  })

  it('stops the field walk at open schemas and reports scalars that are not objects', () => {
    const http = n('h', 'http.request@1', { url: 'https://x.test' })
    const wf = chain(
      n('t1', 'trigger.webhook@1', { path: '/in' }),
      http,
      n('a', 'transform@1', {
        values: {
          b: '{{t1.output.body.deep.x}}',
          q: '{{t1.output.query.anything}}',
          h: '{{h.output.headers.x-id}}',
          s: '{{h.output.status.code}}',
          m: '{{t1.output.nope}}',
        },
      }),
    )
    const issues = validateWorkflow(wf, env)
    expect(issues.map((i) => [i.code, i.pointer, i.hint])).toEqual([
      ['unknown_output_field', '/nodes/2/config/values/m', 'available: method, path, query, headers, body'],
      ['unknown_output_field', '/nodes/2/config/values/s', 'h.output.status is not an object'],
    ])
    expect(issues[1]!.message).toBe('node a: h.output.status has no field code')
  })

  it('walks arrays by index and nullable objects', () => {
    const wf = chain(
      manual,
      n('l', 'test.list@1'),
      n('a', 'test.sink@1', { text: '{{l.output.rows.0.name}}', count: '{{l.output.rows.1.size}}', flag: '{{l.output.maybe.inner}}' }),
      n('b', 'test.sink@1', { text: '{{l.output.rows.first}}', count: '{{l.output.rows.0.name}}' }),
    )
    expect(brief(validateWorkflow(wf, customEnv))).toEqual([
      'config_type /nodes/3/config/count',
      'unknown_output_field /nodes/3/config/text',
    ])
  })

  it('checks whole-value and embedded templates by type', () => {
    const wf = chain(
      manual,
      extract('x'),
      n('a', 'http.request@1', { url: 'https://api.test/{{x.output.date}}', body: '{{x.output.amount}}' }),
      n('b', 'test.sink@1', { text: 'n={{x.output.amount}}', flag: '{{x.output.date}}', mode: '{{x.output.date}}' }),
      n('c', 'test.sink@1', { count: 'n={{x.output.amount}}', num: '{{x.output.amount}}', map: { k: '{{x.output.count}}' } }),
    )
    expect(brief(validateWorkflow(wf, customEnv))).toEqual([
      'config_type /nodes/3/config/flag',
      'nullable_into_required /nodes/3/config/mode',
      'config_type /nodes/4/config/count',
      'nullable_into_required /nodes/4/config/map/k',
    ])
  })

  it('does not judge a pattern at a templated pointer and drops open values', () => {
    const wf = chain(
      n('t1', 'trigger.webhook@1', { path: '/in' }),
      n('a', 'http.request@1', { url: '{{t1.output.path}}' }),
      n('b', 'csv.append@1', { file: '{{t1.output.body}}', row: ['{{t1.output.body}}', 1] }),
      n('c', 'test.sink@1', { mode: '{{t1.output.method}}', list: '{{t1.output.body}}' }),
    )
    expect(validateWorkflow(wf, customEnv)).toEqual([])
  })

  it('treats a union of different upstream types as open', () => {
    const wf = chain(manual, n('l', 'test.list@1'), n('a', 'test.sink@1', { flag: '{{l.output.either}}', list: '{{l.output.any}}' }))
    expect(validateWorkflow(wf, customEnv)).toEqual([])
  })

  it('runs validate hooks on the filled config and reports hook failures', () => {
    const good = chain(n('t1', 'trigger.folderWatch@1', { folder: '/in' }), n('x', 'llm.extract@1', { file: '{{t1.output.file}}', fields: [{ name: 'a', type: 'string' }] }))
    expect(validateWorkflow(good, env)).toEqual([])
    const dup = chain(manual, n('x', 'llm.extract@1', { text: 't', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] }))
    expect(validateWorkflow(dup, env).map((i) => [i.code, i.pointer, i.message])).toEqual([
      ['config_rule', '/nodes/1/config', 'node x: duplicate field name: a'],
    ])
    const bad = chain(manual, n('a', 'test.sink@1', { text: 'bad' }), n('b', 'test.sink@1', { text: 'throw' }))
    expect(validateWorkflow(bad, customEnv).map((i) => i.message)).toEqual(['node a: text must not be bad', 'node b: hook exploded'])
    expect(brief(validateWorkflow(chain(n('t1', 'trigger.webhook@1', { path: '/a/../b' })), env))).toEqual(['config_rule /nodes/0/config'])
    expect(validateWorkflow(chain(n('t1', 'trigger.cron@1', { expression: '0 0 31 2 *' })), env)[0]!.message).toBe('trigger t1: expression never fires')
  })

  it('skips hooks when the schema check failed', () => {
    const wf = chain(n('t1', 'trigger.webhook@1', {}))
    expect(brief(validateWorkflow(wf, env))).toEqual(['config_required /nodes/0/config/path'])
  })

  it('checks literal paths against the allowed roots with the real path guard', () => {
    const roots = { registry, allowedRoots: [dir] }
    const inside = chain(n('t1', 'trigger.folderWatch@1', { folder: join(dir, 'in') }), n('a', 'csv.append@1', { file: join(dir, 'o.csv'), row: [1] }))
    expect(validateWorkflow(inside, roots)).toEqual([])
    const outside = chain(
      n('t1', 'trigger.folderWatch@1', { folder: tmpdir() }),
      n('a', 'csv.append@1', { file: `${dir}/../x.csv`, row: [1] }),
      n('b', 'llm.extract@1', { file: '/etc/passwd', fields: [{ name: 'a', type: 'string' }] }),
      n('c', 'file.read@1', { path: '{{t1.output.file}}' }),
    )
    const issues = validateWorkflow(outside, roots)
    expect(brief(issues)).toEqual([
      'path_outside_roots /nodes/0/config/folder',
      'path_outside_roots /nodes/1/config/file',
      'path_outside_roots /nodes/2/config/file',
    ])
    expect(issues[0]!.hint).toBe(`allowed folders: ${dir}`)
    expect(issues[1]!.message).toContain("must not contain '..'")
    expect(validateWorkflow(outside, env)).toEqual([])
    expect(validateWorkflow(outside, { registry, allowedRoots: [] })[0]!.hint).toBe('allowed folders: (none)')
  })

  it('checks literal connection names when connections are given', () => {
    const wf = chain(
      n('t1', 'trigger.webhook@1', { path: '/in', secretConnection: 'hook' }),
      n('a', 'http.request@1', { url: 'https://x.test', auth: { connection: 'api' } }),
      n('b', 'notify.slack@1', { connection: '{{t1.output.body}}', text: 'hi' }),
    )
    expect(brief(validateWorkflow(wf, { registry, connections: ['api'] }))).toEqual(['unknown_connection /nodes/0/config/secretConnection'])
    expect(validateWorkflow(wf, { registry, connections: [] })[1]!.hint).toBe('no connections are configured')
    expect(validateWorkflow(wf, { registry, connections: ['api', 'hook'] })).toEqual([])
    expect(validateWorkflow(wf, env)).toEqual([])
  })

  it('checks when labels and accepts labelled branches', () => {
    const wf: Workflow = {
      ...chain(manual, n('c', 'condition@1', { left: 1, operator: 'eq', right: 1 }), n('y', 'delay@1', { ms: 1 }), n('z', 'delay@1', { ms: 1 })),
      edges: [
        { from: 't1', to: 'c' },
        { from: 'c', to: 'y', when: 'true' },
        { from: 'c', to: 'z', when: 'False' },
      ],
    }
    const issues = validateWorkflow(wf, env)
    expect(issues.map((i) => [i.code, i.pointer, i.hint])).toEqual([['when_unknown_label', '/edges/2/when', 'use one of: true, false']])
    expect(issues[0]!.message).toBe('edge c -> z: "False" is not one of true, false')
  })

  it('reports an unknown type with the catalog and skips its semantics', () => {
    const issues = validateWorkflow(chain(manual, n('a', 'nope@1', { v: '{{t1.output.x}}' })), env)
    expect(brief(issues)).toEqual(['unknown_node_type /nodes/1/type'])
    expect(issues[0]!.hint).toContain('condition@1, csv.append@1, delay@1')
    const mismatch = validateWorkflow(chain(n('t1', 'test.trigger@1')), customEnv)
    expect(brief(mismatch)).toEqual(['trigger_count /nodes', 'kind_mismatch /nodes/0/type'])
  })

  it('returns issues sorted by stage then pointer', () => {
    const wf = chain(manual, n('a', 'delay@1', { ms: 'x' }), n('b', 'nope@1'), n('c', 'delay@1', { ms: 'y' }))
    const issues = validateWorkflow({ ...wf, edges: [...wf.edges, { from: 't1', to: 'ghost' }] }, env)
    expect(issues.map((i) => i.stage)).toEqual([...issues.map((i) => i.stage)].sort())
    expect(brief(issues)).toEqual([
      'unknown_node_type /nodes/2/type',
      'edge_unknown_node /edges/3/to',
      'config_type /nodes/1/config/ms',
      'config_type /nodes/3/config/ms',
    ])
  })

  it('stops after stage 1 when the shape is wrong and honours the stages option', () => {
    expect(brief(validateWorkflow({ ...valid, name: 3 }, env))).toEqual(['shape_type /name'])
    expect(validateWorkflow({ ...valid, name: 3 }, { registry, stages: [2, 3] })).toEqual([])
    const wf = chain(manual, n('a', 'delay@1', { ms: 'x' }), n('b', 'nope@1'))
    const unreachable = { ...wf, edges: [wf.edges[0]!] }
    expect(brief(validateWorkflow(unreachable, { registry, stages: [1] }))).toEqual(['unknown_node_type /nodes/2/type'])
    expect(brief(validateWorkflow(unreachable, { registry, stages: [2] }))).toEqual(['unreachable /nodes/2'])
    expect(brief(validateWorkflow(unreachable, { registry, stages: [3] }))).toEqual(['config_type /nodes/1/config/ms'])
  })

  it('never throws on arbitrary input', () => {
    const inputs: unknown[] = [null, undefined, 1, 'x', [], {}, { nodes: 'x' }, { ...valid, nodes: [null] }, { ...valid, edges: [1] }]
    for (const input of inputs) expect(validateWorkflow(input, env).length).toBeGreaterThan(0)
  })

  it('validates 200 nodes that reference each other quickly', () => {
    const nodes: Node[] = [n('t1', 'trigger.webhook@1', { path: '/in' }), extract('x0', { text: '{{t1.output.path}}' })]
    for (let i = 1; i < 200; i++) {
      nodes.push(n(`x${i}`, 'csv.append@1', { file: '/o.csv', row: ['{{x0.output.date}}', '{{x0.output.amount}}', `{{x${i - 1}.output.file}}`].slice(0, i === 1 ? 2 : 3) }))
    }
    const started = performance.now()
    expect(errorsOf(chain(...nodes))).toEqual([])
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('validator helpers', () => {
  it('walkOutput resolves, opens and misses', () => {
    const schema = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } }, r: { patternProperties: {} } } }
    expect(walkOutput(schema, ['a', 'b'])).toEqual({ kind: 'schema', schema: { type: 'string' } })
    expect(walkOutput(schema, ['r', 'x'])).toEqual({ kind: 'open' })
    expect(walkOutput(schema, ['a', 'c'])).toEqual({ kind: 'missing', segment: 'c', known: ['b'], depth: 1 })
    expect(walkOutput(schema, [])).toEqual({ kind: 'schema', schema })
    expect(walkOutput({}, [])).toEqual({ kind: 'open' })
  })

  it('placeholderFor picks a value of the upstream type', () => {
    expect(placeholderFor({ type: 'string' })).toEqual({ value: 'x', nullable: false, fractional: false })
    expect(placeholderFor({ type: 'string', const: 'true' })!.value).toBe('true')
    expect(placeholderFor({ type: 'string', enum: ['a'] })!.value).toBe('a')
    expect(placeholderFor({ anyOf: [{ type: 'number' }, { type: 'null' }] })).toEqual({ value: 0, nullable: true, fractional: true })
    expect(placeholderFor({ type: 'integer' })).toEqual({ value: 0, nullable: false, fractional: false })
    expect(placeholderFor({ type: 'boolean' })!.value).toBe(false)
    expect(placeholderFor({ type: 'array' })!.value).toEqual([])
    expect(placeholderFor({ type: 'object' })!.value).toEqual({})
    expect(placeholderFor({ type: 'null' })).toEqual({ value: null, nullable: true, fractional: false })
    expect(placeholderFor({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBeUndefined()
    expect(placeholderFor({ anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] })!.value).toBe('a')
    expect(placeholderFor({})).toBeUndefined()
  })

  it('subschemaAt follows properties, items, records and single container unions', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'integer' } },
        map: { type: 'object', patternProperties: { '^.*$': { type: 'boolean' } } },
        u: { anyOf: [{ type: 'object', properties: { k: { type: 'string' } } }, { type: 'null' }] },
        extra: { type: 'object', additionalProperties: { type: 'number' } },
        'a/b': { type: 'string' },
      },
    }
    expect(subschemaAt(schema, '/list/3')).toEqual({ type: 'integer' })
    expect(subschemaAt(schema, '/map/x')).toEqual({ type: 'boolean' })
    expect(subschemaAt(schema, '/u/k')).toEqual({ type: 'string' })
    expect(subschemaAt(schema, '/extra/q')).toEqual({ type: 'number' })
    expect(subschemaAt(schema, '/a~1b')).toEqual({ type: 'string' })
    expect(subschemaAt(schema, '/nope')).toBeUndefined()
    expect(subschemaAt(schema, '/nope/deeper')).toBeUndefined()
    expect(subschemaAt(schema, '')).toBe(schema)
  })
})
