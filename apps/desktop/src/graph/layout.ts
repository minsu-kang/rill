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
const MAX_CAREFUL_NODES = 80
const MAX_CAREFUL_EDGES = 240

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

function stack(order: readonly string[], links: ReadonlyArray<readonly [number, number]>, size: { width: number; height: number }): LayoutResult {
  const targets: number[][] = order.map(() => [])
  const waiting = order.map(() => 0)
  for (const [from, to] of links) {
    targets[from]!.push(to)
    waiting[to]! += 1
  }
  const rank = order.map(() => 0)
  const settled = order.map(() => false)
  const queue: number[] = []
  for (let at = 0; at < order.length; at += 1) if (waiting[at] === 0) queue.push(at)
  let head = 0
  let scan = 0
  for (let done = 0; done < order.length; done += 1) {
    if (head === queue.length) {
      while (settled[scan] === true) scan += 1
      queue.push(scan)
    }
    const current = queue[head]!
    head += 1
    settled[current] = true
    for (const to of targets[current]!) {
      if (settled[to] === true) continue
      rank[to] = Math.max(rank[to]!, rank[current]! + 1)
      waiting[to]! -= 1
      if (waiting[to] === 0) queue.push(to)
    }
  }

  const rows = new Map<number, number>()
  let columns = 0
  let tallest = 0
  const nodes = order.map((id, at): Placed => {
    const column = rank[at]!
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    columns = Math.max(columns, column + 1)
    tallest = Math.max(tallest, row + 1)
    return { id, x: MARGIN + column * (size.width + RANK_SEPARATION), y: MARGIN + row * (size.height + NODE_SEPARATION) }
  })
  return {
    nodes,
    width: 2 * MARGIN + columns * size.width + (columns - 1) * RANK_SEPARATION,
    height: 2 * MARGIN + tallest * size.height + (tallest - 1) * NODE_SEPARATION,
  }
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

  if (order.length > MAX_CAREFUL_NODES || links.length > MAX_CAREFUL_EDGES) return stack(order, links, size)

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
