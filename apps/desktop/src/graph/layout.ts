import { Graph, layout, type OrderConstraint } from '@dagrejs/dagre'
import type { Workflow } from '@rill/dsl'

export interface Placed {
  id: string
  x: number
  y: number
}

export interface LayoutResult {
  nodes: Placed[]
  width: number
  height: number
}

const RANK_SEPARATION = 88
const NODE_SEPARATION = 36
const MARGIN = 24

function place(order: readonly string[], links: ReadonlyArray<readonly [number, number]>, size: { width: number; height: number }, constraints: OrderConstraint[]): LayoutResult {
  const graph = new Graph()
  graph.setGraph({ rankdir: 'LR', ranksep: RANK_SEPARATION, nodesep: NODE_SEPARATION, marginx: MARGIN, marginy: MARGIN })
  graph.setDefaultEdgeLabel(() => ({}))
  order.forEach((_, index) => graph.setNode(`n${index}`, { width: size.width, height: size.height }))
  for (const [from, to] of links) graph.setEdge(`n${from}`, `n${to}`)
  layout(graph, constraints.length > 0 ? { constraints } : undefined)

  const nodes = order.map((id, index): Placed => {
    const placed = graph.node(`n${index}`)
    return { id, x: Math.round(placed.x - size.width / 2), y: Math.round(placed.y - size.height / 2) }
  })
  const label = graph.graph()
  return { nodes, width: Math.ceil(label.width ?? 0), height: Math.ceil(label.height ?? 0) }
}

export function layoutWorkflow(workflow: Workflow, size: { width: number; height: number }): LayoutResult {
  const index = new Map<string, number>()
  const order: string[] = []
  for (const item of workflow.nodes) {
    if (index.has(item.id)) continue
    index.set(item.id, order.length)
    order.push(item.id)
  }

  const links: Array<[number, number]> = []
  const children = new Map<number, number[]>()
  const seen = new Set<string>()
  for (const link of workflow.edges) {
    const from = index.get(link.from)
    const to = index.get(link.to)
    if (from === undefined || to === undefined || from === to || seen.has(`${from}>${to}`)) continue
    seen.add(`${from}>${to}`)
    links.push([from, to])
    children.set(from, [...(children.get(from) ?? []), to])
  }

  const constraints: OrderConstraint[] = []
  for (const targets of children.values()) {
    for (let at = 1; at < targets.length; at += 1) constraints.push({ left: `n${targets[at - 1]}`, right: `n${targets[at]}` })
  }

  try {
    return place(order, links, size, constraints)
  } catch {
    return place(order, links, size, [])
  }
}
