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

  it('finishes a 300 node graph with one node fanning out to all others plus a chain through them within half a second', () => {
    const names = ids(300)
    const nodes = names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {}))
    const edges = [...names.slice(1).map((id) => edge('n0', id)), ...names.slice(1, -1).map((id, index) => edge(id, names[index + 2]!))]
    const started = performance.now()
    const result = layoutWorkflow(workflowOf('fan', nodes, edges), SIZE)
    expect(performance.now() - started).toBeLessThan(500)
    expect(result.nodes).toHaveLength(300)
    expectNoOverlap(result.nodes)
  })

  it('finishes a 500 node graph with 1,500 edges within half a second', () => {
    const names = ids(500)
    const nodes = names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {}))
    const edges = names.flatMap((id, index) => [1, 2, 3].filter((step) => index + step < 500).map((step) => edge(id, names[index + step]!)))
    const started = performance.now()
    const result = layoutWorkflow(workflowOf('dense', nodes, edges), SIZE)
    expect(performance.now() - started).toBeLessThan(500)
    expect(result.nodes).toHaveLength(500)
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

  describe('for a graph too big for the careful layout', () => {
    function fan(count: number, extra: Array<[number, number]> = []): Workflow {
      const names = ids(count)
      const nodes = names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {}))
      const edges = [...names.slice(1).map((id) => edge('n0', id)), ...extra.map(([from, to]) => edge(names[from]!, names[to]!))]
      return workflowOf('fan', nodes, edges)
    }

    it('uses the careful layout for 80 nodes and the plain one for 81', () => {
      const careful = byId(layoutWorkflow(fan(80), SIZE).nodes)
      expect(careful.get('n0')!.y).toBeGreaterThan(24)
      const plain = byId(layoutWorkflow(fan(81), SIZE).nodes)
      expect(plain.get('n0')!.y).toBe(24)
    })

    function crowded(edgeCount: number): Workflow {
      const names = ids(60)
      const pairs: Array<[number, number]> = []
      for (let from = 1; from < 60 && pairs.length < edgeCount - 59; from += 1) {
        for (let step = 1; step <= 5 && from + step < 60 && pairs.length < edgeCount - 59; step += 1) pairs.push([from, from + step])
      }
      const base = fan(60, pairs)
      expect(base.edges).toHaveLength(edgeCount)
      expect(base.nodes).toHaveLength(names.length)
      return base
    }

    it('uses the careful layout for 240 edges and the plain one for 241', () => {
      expect(byId(layoutWorkflow(crowded(240), SIZE).nodes).get('n0')!.y).toBeGreaterThan(24)
      expect(byId(layoutWorkflow(crowded(241), SIZE).nodes).get('n0')!.y).toBe(24)
    })

    it('ranks by the longest path and stacks each rank in node order on a grid', () => {
      const names = ids(90)
      const nodes = names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {}))
      const edges = [edge('n0', 'n1'), edge('n0', 'n2'), edge('n1', 'n3'), edge('n2', 'n3'), edge('n0', 'n3'), edge('n3', 'n4'), edge('n3', 'n5')]
      const result = layoutWorkflow(workflowOf('grid', nodes, edges), SIZE)
      const placed = byId(result.nodes)
      const x = (rank: number) => 24 + rank * (SIZE.width + 88)
      const y = (row: number) => 24 + row * (SIZE.height + 36)
      expect([placed.get('n0')!.x, placed.get('n0')!.y]).toEqual([x(0), y(0)])
      expect([placed.get('n1')!.x, placed.get('n1')!.y]).toEqual([x(1), y(0)])
      expect([placed.get('n2')!.x, placed.get('n2')!.y]).toEqual([x(1), y(1)])
      expect([placed.get('n3')!.x, placed.get('n3')!.y]).toEqual([x(2), y(0)])
      expect([placed.get('n4')!.x, placed.get('n4')!.y]).toEqual([x(3), y(0)])
      expect([placed.get('n5')!.x, placed.get('n5')!.y]).toEqual([x(3), y(1)])
      for (const id of names.slice(6)) expect([placed.get(id)!.x, placed.get(id)!.y], id).toEqual([x(0), y(Number(id.slice(1)) - 5)])
      expect(result.nodes.map((p) => p.id)).toEqual(names)
      expect(result.width).toBe(24 * 2 + 4 * SIZE.width + 3 * 88)
      expect(result.height).toBe(24 * 2 + 85 * SIZE.height + 84 * 36)
    })

    it('reports the size of a single column', () => {
      const names = ids(81)
      const nodes = names.map((id) => node(id, 'transform@1', {}))
      const result = layoutWorkflow(workflowOf('column', nodes, []), SIZE)
      expect(result.width).toBe(24 * 2 + SIZE.width)
      expect(result.height).toBe(24 * 2 + 81 * SIZE.height + 80 * 36)
    })

    it('ignores unknown, self and repeated edges and a repeated node id', () => {
      const names = ids(85)
      const nodes = [...names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {})), node('n3', 'transform@1', {})]
      const edges = [edge('n0', 'n1'), edge('n0', 'n1'), edge('n0', 'ghost'), edge('ghost', 'n1'), edge('n1', 'n1'), edge('n1', 'n2')]
      const result = layoutWorkflow(workflowOf('odd', nodes, edges), SIZE)
      expect(result.nodes.map((p) => p.id)).toEqual(names)
      const placed = byId(result.nodes)
      expect(placed.get('n2')!.x).toBe(24 + 2 * (SIZE.width + 88))
    })

    it('places a cycle without throwing, once, and without overlap', () => {
      const names = ids(90)
      const nodes = names.map((id, index) => node(id, index === 0 ? 'trigger.manual@1' : 'transform@1', {}))
      const edges = [edge('n0', 'n1'), edge('n1', 'n2'), edge('n2', 'n1'), edge('n2', 'n3'), edge('n10', 'n11'), edge('n11', 'n10')]
      const result = layoutWorkflow(workflowOf('cycle', nodes, edges), SIZE)
      expect(result.nodes.map((p) => p.id)).toEqual(names)
      expectNoOverlap(result.nodes)
      const placed = byId(result.nodes)
      expect(placed.get('n1')!.x).toBeLessThan(placed.get('n2')!.x)
      expect(placed.get('n2')!.x).toBeLessThan(placed.get('n3')!.x)
      expect(placed.get('n10')!.x).toBeLessThan(placed.get('n11')!.x)
    })

    it('gives the same output for the same input', () => {
      const workflow = large(150)
      expect(layoutWorkflow(structuredClone(workflow), SIZE)).toEqual(layoutWorkflow(workflow, SIZE))
    })
  })
})
