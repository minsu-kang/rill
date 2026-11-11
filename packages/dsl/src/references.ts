import { joinPointer, type IssueCode, type PlanIssue } from './issues'
import type { Workflow } from './schema'
import { extractRefs, findMalformedTemplates } from './template'

export function ancestorIndex(wf: Workflow): (id: string) => ReadonlySet<string> {
  const parents = new Map<string, string[]>()
  for (const n of wf.nodes) parents.set(n.id, [])
  for (const e of wf.edges) parents.get(e.to)?.push(e.from)
  const cache = new Map<string, Set<string>>()
  return (id) => {
    const cached = cache.get(id)
    if (cached) return cached
    const seen = new Set<string>()
    const stack = [...(parents.get(id) ?? [])]
    while (stack.length > 0) {
      const parent = stack.pop()!
      if (seen.has(parent)) continue
      seen.add(parent)
      const known = cache.get(parent)
      if (known) {
        for (const ancestor of known) seen.add(ancestor)
        continue
      }
      for (const next of parents.get(parent) ?? []) if (!seen.has(next)) stack.push(next)
    }
    cache.set(id, seen)
    return seen
  }
}

export interface StringLeaf {
  pointer: string
  value: string
}

export function stringLeaves(value: unknown, pointer = ''): StringLeaf[] {
  if (typeof value === 'string') return [{ pointer, value }]
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, joinPointer(pointer, i)))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, joinPointer(pointer, k)))
  }
  return []
}

export function referenceIssues(wf: Workflow): PlanIssue[] {
  const ids = new Set(wf.nodes.map((n) => n.id))
  const ancestorsOf = ancestorIndex(wf)
  const issues: PlanIssue[] = []
  const add = (pointer: string, code: IssueCode, message: string, hint?: string) =>
    issues.push({ stage: 3, pointer, code, message, ...(hint === undefined ? {} : { hint }) })
  wf.nodes.forEach((node, index) => {
    const leaves = stringLeaves(node.config, `/nodes/${index}/config`)
    for (const leaf of leaves) {
      for (const ref of extractRefs(leaf.value)) {
        if (!ids.has(ref.nodeId)) {
          add(leaf.pointer, 'unknown_ref_node', `${node.id}: reference to unknown node ${ref.nodeId}`)
        } else if (!ancestorsOf(node.id).has(ref.nodeId)) {
          add(
            leaf.pointer,
            'ref_not_upstream',
            `${node.id}: reference to ${ref.nodeId} which does not run before it`,
            'reference only nodes connected before this one',
          )
        }
      }
    }
    for (const leaf of leaves) {
      for (const span of findMalformedTemplates(leaf.value)) {
        add(leaf.pointer, 'malformed_template', `${node.id}: malformed template ${span}`, 'use {{nodeId.output.field}}')
      }
    }
  })
  return issues
}

export function validateReferences(wf: Workflow): string[] {
  return referenceIssues(wf).map((issue) => issue.message)
}
