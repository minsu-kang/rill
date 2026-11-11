import type { IssueCode, PlanIssue } from './issues'
import type { Workflow, WorkflowEdge } from './schema'

export function isTrigger(type: string): boolean {
  return type.startsWith('trigger.')
}

export function incomingEdges(wf: Workflow, id: string): WorkflowEdge[] {
  return wf.edges.filter((e) => e.to === id)
}

export function outgoingEdges(wf: Workflow, id: string): WorkflowEdge[] {
  return wf.edges.filter((e) => e.from === id)
}

function successors(wf: Workflow): Map<string, string[]> {
  const next = new Map<string, string[]>()
  for (const n of wf.nodes) next.set(n.id, [])
  for (const e of wf.edges) next.get(e.from)?.push(e.to)
  return next
}

export function topologicalOrder(wf: Workflow): string[] | null {
  const next = successors(wf)
  const indegree = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]))
  for (const e of wf.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  const queue = wf.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const to of next.get(id) ?? []) {
      const left = (indegree.get(to) ?? 0) - 1
      indegree.set(to, left)
      if (left === 0) queue.push(to)
    }
  }
  return order.length === wf.nodes.length ? order : null
}

function reachableFrom(wf: Workflow, start: string): Set<string> {
  const next = successors(wf)
  const seen = new Set<string>([start])
  const stack = [start]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const to of next.get(id) ?? []) {
      if (!seen.has(to)) {
        seen.add(to)
        stack.push(to)
      }
    }
  }
  return seen
}

export function graphIssues(wf: Workflow): PlanIssue[] {
  const issues: PlanIssue[] = []
  const add = (pointer: string, code: IssueCode, message: string, hint?: string) =>
    issues.push({ stage: 2, pointer, code, message, ...(hint === undefined ? {} : { hint }) })
  const ids = new Set<string>()
  wf.nodes.forEach((n, i) => {
    if (ids.has(n.id)) add(`/nodes/${i}/id`, 'duplicate_id', `duplicate node id: ${n.id}`, 'give every node a unique id')
    ids.add(n.id)
  })
  const triggers = wf.nodes.filter((n) => isTrigger(n.type))
  if (triggers.length !== 1) {
    add('/nodes', 'trigger_count', `expected exactly 1 trigger node, found ${triggers.length}`, 'use exactly one trigger.* node')
  }
  wf.edges.forEach((e, i) => {
    for (const side of ['from', 'to'] as const) {
      if (!ids.has(e[side])) add(`/edges/${i}/${side}`, 'edge_unknown_node', `edge references unknown node: ${e[side]}`)
    }
  })
  const trigger = triggers[0]
  if (issues.length > 0 || !trigger) return issues
  const incoming = wf.edges.findIndex((e) => e.to === trigger.id)
  if (incoming >= 0) add(`/edges/${incoming}`, 'trigger_incoming', `trigger must not have incoming edges: ${trigger.id}`)
  wf.edges.forEach((e, i) => {
    if (e.when !== undefined && e.from === trigger.id) {
      add(`/edges/${i}/when`, 'trigger_edge_when', `edge from the trigger cannot have a when condition: ${e.from} -> ${e.to}`)
    }
  })
  if (topologicalOrder(wf) === null) add('/edges', 'cycle', 'graph contains a cycle')
  const reachable = reachableFrom(wf, trigger.id)
  wf.nodes.forEach((n, i) => {
    if (!reachable.has(n.id)) add(`/nodes/${i}`, 'unreachable', `node not reachable from trigger: ${n.id}`)
  })
  return issues
}

export function validateGraph(wf: Workflow): string[] {
  return graphIssues(wf).map((issue) => issue.message)
}
