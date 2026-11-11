import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { graphIssues, validateGraph } from '../src/graph'
import {
  ISSUE_CODES,
  WARNING_CODES,
  capIssues,
  isWarningIssue,
  joinPointer,
  sortIssues,
  type PlanIssue,
} from '../src/issues'
import { ancestorIndex, referenceIssues, validateReferences } from '../src/references'
import { shapeIssues, type Workflow } from '../src/schema'

const node = (id: string, config: Record<string, unknown> = {}, type = 'transform@1') => ({ id, type, config })
const t1 = node('t1', {}, 'trigger.manual@1')
const make = (nodes: Workflow['nodes'], edges: Workflow['edges']): Workflow => ({ schemaVersion: 1, name: 'wf', nodes, edges })
const valid = make([t1, node('a')], [{ from: 't1', to: 'a' }])
const brief = (issues: PlanIssue[]) => issues.map((i) => [i.stage, i.code, i.pointer])
const issue = (stage: PlanIssue['stage'], pointer: string, code = 'x'): PlanIssue => ({ stage, pointer, code, message: code })

describe('issue codes', () => {
  it('lists every code once and marks only known codes as warnings', () => {
    expect(new Set(ISSUE_CODES).size).toBe(ISSUE_CODES.length)
    for (const code of WARNING_CODES) expect(ISSUE_CODES).toContain(code)
    expect(isWarningIssue(issue(3, '', 'branch_unused'))).toBe(true)
    expect(isWarningIssue(issue(3, '', 'config_type'))).toBe(false)
  })

  it('documents every code in ISSUES.md', () => {
    const doc = readFileSync(new URL('../ISSUES.md', import.meta.url), 'utf8')
    for (const code of ISSUE_CODES) {
      const documented = code.startsWith('shape_') ? '`shape_<keyword>`' : code.startsWith('config_') && code !== 'config_rule' && code !== 'config_json_parse' ? '`config_<keyword>`' : `\`${code}\``
      expect(doc, code).toContain(`| ${documented} |`)
    }
  })

  it('escapes pointer segments as RFC 6901 says', () => {
    expect(joinPointer('/nodes/0/config', 'a/b', 'c~d', 3)).toBe('/nodes/0/config/a~1b/c~0d/3')
  })
})

describe('sortIssues and capIssues', () => {
  it('sorts by stage, then pointer with numeric segments compared as numbers', () => {
    const sorted = sortIssues([issue(3, '/nodes/10'), issue(2, '/nodes/2'), issue(3, '/nodes/2/config'), issue(3, '/nodes/2'), issue(1, '/z')])
    expect(sorted.map((i) => `${i.stage}${i.pointer}`)).toEqual(['1/z', '2/nodes/2', '3/nodes/2', '3/nodes/2/config', '3/nodes/10'])
  })

  it('caps at 20 by default, keeps errors before warnings, and accepts another limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => issue(3, `/nodes/${i}`))
    expect(capIssues(many)).toHaveLength(20)
    expect(capIssues(many, { max: 5 }).map((i) => i.pointer)).toEqual(['/nodes/0', '/nodes/1', '/nodes/2', '/nodes/3', '/nodes/4'])
    const mixed = [issue(2, '/a', 'branch_unused'), issue(3, '/b', 'config_type')]
    expect(capIssues(mixed, { max: 1 }).map((i) => i.code)).toEqual(['config_type'])
    expect(capIssues(mixed, { max: 0 })).toEqual([])
  })
})

describe('shapeIssues', () => {
  it('returns nothing for a valid workflow', () => {
    expect(shapeIssues(valid)).toEqual([])
  })

  it('reports missing and extra properties at the property pointer', () => {
    const issues = shapeIssues({ schemaVersion: 1, nodes: [{ ...t1, extra: 1 }], edges: [] })
    expect(brief(issues)).toEqual([
      [1, 'shape_required', '/name'],
      [1, 'shape_additionalProperties', '/nodes/0/extra'],
    ])
    expect(issues[0]!.message).toBe('/name: name is required')
  })

  it('collapses literal unions into one issue with the allowed values as hint', () => {
    const issues = shapeIssues({ ...valid, nodes: [{ ...t1, onError: 'retry' }] })
    expect(brief(issues)).toEqual([[1, 'shape_anyOf', '/nodes/0/onError']])
    expect(issues[0]!.hint).toBe('use one of: fail, continue')
  })

  it('maps keyword errors to shape_<keyword>', () => {
    const codes = (input: unknown) => shapeIssues(input).map((i) => `${i.code} ${i.pointer}`)
    expect(codes({ ...valid, schemaVersion: 2 })).toEqual(['shape_const /schemaVersion'])
    expect(codes({ ...valid, name: '' })).toEqual(['shape_minLength /name'])
    expect(codes({ ...valid, nodes: [] })).toEqual(['shape_minItems /nodes'])
    expect(codes({ ...valid, nodes: [{ ...t1, id: 'Bad' }] })).toEqual(['shape_pattern /nodes/0/id'])
    expect(codes({ ...valid, nodes: [{ ...t1, config: [] }] })).toEqual(['shape_type /nodes/0/config'])
    expect(codes({ ...valid, nodes: [{ ...t1, retry: { maxAttempts: 11 } }] })).toEqual(['shape_maximum /nodes/0/retry/maxAttempts'])
    expect(codes({ ...valid, edges: [{ from: 't1', to: 'a', when: 'x'.repeat(65) }] })).toEqual(['shape_maxLength /edges/0/when'])
    expect(codes(null)).toEqual(['shape_type '])
  })
})

describe('graphIssues', () => {
  it('reports each structural code at its pointer and keeps the string adapter in step', () => {
    const cases: [Workflow, string, string][] = [
      [make([t1, node('a'), node('a')], [{ from: 't1', to: 'a' }]), 'duplicate_id', '/nodes/2/id'],
      [make([node('a')], []), 'trigger_count', '/nodes'],
      [make([t1], [{ from: 't1', to: 'ghost' }]), 'edge_unknown_node', '/edges/0/to'],
      [make([t1], [{ from: 'ghost', to: 't1' }]), 'edge_unknown_node', '/edges/0/from'],
      [make([t1, node('a')], [{ from: 't1', to: 'a' }, { from: 'a', to: 't1' }]), 'trigger_incoming', '/edges/1'],
      [make([t1, node('a')], [{ from: 't1', to: 'a', when: 'true' }]), 'trigger_edge_when', '/edges/0/when'],
      [
        make([t1, node('a'), node('b')], [{ from: 't1', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }]),
        'cycle',
        '/edges',
      ],
      [make([t1, node('a'), node('b')], [{ from: 't1', to: 'a' }]), 'unreachable', '/nodes/2'],
    ]
    for (const [wf, code, pointer] of cases) {
      const issues = graphIssues(wf)
      expect(issues.map((i) => [i.code, i.pointer])).toContainEqual([code, pointer])
      expect(issues.every((i) => i.stage === 2)).toBe(true)
      expect(validateGraph(wf)).toEqual(issues.map((i) => i.message))
    }
  })

  it('reports one trigger_incoming issue at the first incoming edge', () => {
    const wf = make([t1, node('a'), node('b')], [
      { from: 't1', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 't1' },
      { from: 'a', to: 't1' },
    ])
    expect(graphIssues(wf).filter((i) => i.code === 'trigger_incoming').map((i) => i.pointer)).toEqual(['/edges/2'])
    const first = make([t1, node('a')], [{ from: 'a', to: 't1' }, { from: 't1', to: 'a' }])
    expect(graphIssues(first).filter((i) => i.code === 'trigger_incoming').map((i) => i.pointer)).toEqual(['/edges/0'])
  })

  it('returns nothing for a valid graph', () => {
    expect(graphIssues(valid)).toEqual([])
  })
})

describe('referenceIssues', () => {
  it('points at the exact config string for every reference code', () => {
    const wf = make(
      [
        t1,
        node('a', { values: { x: ['ok', '{{ghost.output.v}}'], 'k/1': '{{b.output.v}}', m: 'a {{t1.outputs.f}}' } }),
        node('b'),
      ],
      [
        { from: 't1', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    )
    const issues = referenceIssues(wf)
    expect(brief(issues)).toEqual([
      [3, 'unknown_ref_node', '/nodes/1/config/values/x/1'],
      [3, 'ref_not_upstream', '/nodes/1/config/values/k~11'],
      [3, 'malformed_template', '/nodes/1/config/values/m'],
    ])
    expect(validateReferences(wf)).toEqual(issues.map((i) => i.message))
  })

  it('accepts indirect ancestors and rejects self references', () => {
    const wf = make(
      [t1, node('a'), node('b', { v: '{{t1.output.x}} {{a.output.y}} {{b.output.z}}' })],
      [
        { from: 't1', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    )
    expect(brief(referenceIssues(wf))).toEqual([[3, 'ref_not_upstream', '/nodes/2/config/v']])
  })
})

describe('ancestorIndex', () => {
  it('returns transitive parents, terminates on cycles and reuses cached sets', () => {
    const wf = make([t1, node('a'), node('b'), node('c')], [
      { from: 't1', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'b' },
    ])
    const ancestors = ancestorIndex(wf)
    expect([...ancestors('a')].sort()).toEqual(['t1'])
    expect([...ancestors('c')].sort()).toEqual(['a', 'b', 'c', 't1'])
    expect([...ancestors('b')].sort()).toEqual(['a', 'b', 'c', 't1'])
    expect(ancestors('b')).toBe(ancestors('b'))
    expect([...ancestors('ghost')]).toEqual([])
  })

  it('handles a long reference chain without a quadratic blow-up', () => {
    const count = 2000
    const nodes = [t1, ...Array.from({ length: count }, (_, i) => node(`n${i}`, { v: `{{${i === 0 ? 't1' : `n${i - 1}`}.output.v}}` }))]
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id }))
    const started = performance.now()
    expect(referenceIssues(make(nodes, edges))).toEqual([])
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
