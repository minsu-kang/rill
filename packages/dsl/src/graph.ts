import type { Workflow } from './schema'

export function isTrigger(type: string): boolean {
  return type.startsWith('trigger.')
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

export function validateGraph(wf: Workflow): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`)
    ids.add(n.id)
  }
  const triggers = wf.nodes.filter((n) => isTrigger(n.type))
  if (triggers.length !== 1) errors.push(`expected exactly 1 trigger node, found ${triggers.length}`)
  for (const e of wf.edges) {
    for (const id of [e.from, e.to]) {
      if (!ids.has(id)) errors.push(`edge references unknown node: ${id}`)
    }
  }
  const trigger = triggers[0]
  if (errors.length > 0 || !trigger) return errors
  if (wf.edges.some((e) => e.to === trigger.id)) errors.push(`trigger must not have incoming edges: ${trigger.id}`)
  if (topologicalOrder(wf) === null) errors.push('graph contains a cycle')
  const reachable = reachableFrom(wf, trigger.id)
  for (const n of wf.nodes) {
    if (!reachable.has(n.id)) errors.push(`node not reachable from trigger: ${n.id}`)
  }
  return errors
}
