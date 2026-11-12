// @vitest-environment node
import type { Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import { fakeData } from '../src/fixtures'
import { branchingWorkflow, edge, node, receiptWorkflow, webhookWorkflow, workflowOf } from '../src/fixtures/workflows'
import { layoutWorkflow, type Placed } from '../src/graph/layout'

const SIZE = { width: 240, height: 120 }

function byId(placed: Placed[]): Map<string, Placed> {
  return new Map(placed.map((p) => [p.id, p]))
}

function overlaps(a: Placed, b: Placed): boolean {
  return a.x < b.x + SIZE.width && b.x < a.x + SIZE.width && a.y < b.y + SIZE.height && b.y < a.y + SIZE.height
}

function expectNoOverlap(placed: Placed[]): void {
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      expect(overlaps(placed[i]!, placed[j]!), `${placed[i]!.id} and ${placed[j]!.id}`).toBe(false)
    }
  }
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `n${index}`)
}

function large(count: number): Workflow {
  const names = ids(count)
  const nodes = names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {}))
  const edges = names.slice(1).map((id, index) => edge(names[Math.floor(index / 2)]!, id))
  return workflowOf('large', nodes, edges)
}

describe('layoutWorkflow', () => {
  it('puts a chain left to right in edge order', () => {
    const placed = byId(layoutWorkflow(receiptWorkflow, SIZE).nodes)
    expect(placed.get('watch')!.x).toBeLessThan(placed.get('extract')!.x)
    expect(placed.get('extract')!.x).toBeLessThan(placed.get('append')!.x)
  })

  it('puts the join of a diamond after both branches', () => {
    const diamond = workflowOf(
      'diamond',
      [node('a', 'trigger.manual@1', {}), node('b', 'transform@1', {}), node('c', 'transform@1', {}), node('d', 'transform@1', {})],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    )
    const placed = byId(layoutWorkflow(diamond, SIZE).nodes)
    expect(placed.get('d')!.x).toBeGreaterThan(placed.get('b')!.x)
    expect(placed.get('d')!.x).toBeGreaterThan(placed.get('c')!.x)
    expect(placed.get('b')!.y).not.toBe(placed.get('c')!.y)
  })

  it('puts the two labelled branches of a condition on different rows, true above false', () => {
    const placed = byId(layoutWorkflow(branchingWorkflow, SIZE).nodes)
    expect(placed.get('log')!.x).toBe(placed.get('alert')!.x)
    expect(placed.get('log')!.y).toBeLessThan(placed.get('alert')!.y)
  })

  it('never overlaps two cards, in the fixtures and in a wide generated graph', () => {
    for (const entry of fakeData.workflows) expectNoOverlap(layoutWorkflow(entry.workflow, SIZE).nodes)
    expectNoOverlap(layoutWorkflow(large(60), SIZE).nodes)
  })

  it('returns one place per node, in node order, with non-negative integer coordinates inside the reported size', () => {
    const result = layoutWorkflow(webhookWorkflow, SIZE)
    expect(result.nodes.map((p) => p.id)).toEqual(webhookWorkflow.nodes.map((n) => n.id))
    for (const p of result.nodes) {
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + SIZE.width).toBeLessThanOrEqual(result.width)
      expect(p.y + SIZE.height).toBeLessThanOrEqual(result.height)
    }
  })

  it('gives the same output for the same input', () => {
    const first = layoutWorkflow(branchingWorkflow, SIZE)
    const second = layoutWorkflow(structuredClone(branchingWorkflow), SIZE)
    expect(second).toEqual(first)
  })

  it('finishes a graph of 200 nodes in a second', () => {
    const workflow = large(200)
    const started = performance.now()
    const result = layoutWorkflow(workflow, SIZE)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.nodes).toHaveLength(200)
    expectNoOverlap(result.nodes)
  })

  it('ignores an edge to an unknown node, a self edge and a duplicate edge without throwing', () => {
    const odd = workflowOf(
      'odd',
      [node('a', 'trigger.manual@1', {}), node('b', 'transform@1', {})],
      [edge('a', 'b'), edge('a', 'b'), edge('a', 'ghost'), edge('ghost', 'b'), edge('b', 'b')],
    )
    const result = layoutWorkflow(odd, SIZE)
    expect(result.nodes.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('places a cycle and a repeated node id without throwing', () => {
    const cyclic = workflowOf(
      'cyclic',
      [node('a', 'trigger.manual@1', {}), node('b', 'transform@1', {}), node('b', 'transform@1', {})],
      [edge('a', 'b'), edge('b', 'a')],
    )
    expect(layoutWorkflow(cyclic, SIZE).nodes.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('places a graph whose branch orders contradict each other without throwing or overlapping', () => {
    const tangled = workflowOf(
      'tangled',
      [
        node('s', 'trigger.manual@1', {}),
        node('p', 'transform@1', {}),
        node('q', 'transform@1', {}),
        node('b', 'transform@1', {}),
        node('c', 'transform@1', {}),
      ],
      [edge('s', 'p'), edge('s', 'q'), edge('p', 'b'), edge('p', 'c'), edge('q', 'c'), edge('q', 'b')],
    )
    const result = layoutWorkflow(tangled, SIZE)
    expect(result.nodes).toHaveLength(5)
    expectNoOverlap(result.nodes)
  })

  it('handles ids that are Object.prototype names', () => {
    const names = workflowOf(
      'names',
      [node('constructor', 'trigger.manual@1', {}), node('toString', 'transform@1', {}), node('__proto__', 'transform@1', {})],
      [edge('constructor', 'toString'), edge('toString', '__proto__')],
    )
    const placed = byId(layoutWorkflow(names, SIZE).nodes)
    expect([...placed.keys()]).toEqual(['constructor', 'toString', '__proto__'])
    expect(placed.get('constructor')!.x).toBeLessThan(placed.get('__proto__')!.x)
  })
})
