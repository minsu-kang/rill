import type { Workflow } from './schema'
import { extractRefs, findMalformedTemplates } from './template'

export function validateReferences(wf: Workflow): string[] {
  const ids = new Set(wf.nodes.map((n) => n.id))
  const parents = new Map<string, string[]>()
  for (const n of wf.nodes) parents.set(n.id, [])
  for (const e of wf.edges) parents.get(e.to)?.push(e.from)

  const ancestorsOf = (id: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [...(parents.get(id) ?? [])]
    while (stack.length > 0) {
      const parent = stack.pop()!
      if (seen.has(parent)) continue
      seen.add(parent)
      stack.push(...(parents.get(parent) ?? []))
    }
    return seen
  }

  const errors: string[] = []
  for (const node of wf.nodes) {
    const ancestors = ancestorsOf(node.id)
    for (const ref of extractRefs(node.config)) {
      if (!ids.has(ref.nodeId)) errors.push(`${node.id}: reference to unknown node ${ref.nodeId}`)
      else if (!ancestors.has(ref.nodeId)) errors.push(`${node.id}: reference to ${ref.nodeId} which does not run before it`)
    }
    for (const span of findMalformedTemplates(node.config)) errors.push(`${node.id}: malformed template ${span}`)
  }
  return errors
}
