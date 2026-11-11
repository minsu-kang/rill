import { extractRefs, stringLeaves, type WorkflowNode } from '@rill/dsl'
import { fieldRoles, isEgressField, valueAtPointer } from '@rill/nodes-core'
import type { ProvenanceInput } from '../ports'
import type { Flag } from '../types'
import { fold, literalOf, occursInAny } from './normalize'

/**
 * Node types whose output carries content from outside the workflow: file text, extracted values,
 * HTTP responses and incoming requests or file names. A url, path, recipient or connection that is
 * built from the output of one of these, directly or through nodes that reference it, is flagged
 * untrusted_flow. Versions are ignored: llm.extract@1 and llm.extract@2 are the same entry.
 */
export const UNTRUSTED_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'llm.extract',
  'file.read',
  'http.request',
  'trigger.webhook',
  'trigger.folderWatch',
])

export interface ProvenanceOptions {
  untrustedSourceTypes?: ReadonlySet<string>
}

const CHECKED_ROLES = new Set(['path', 'url', 'connection', 'recipient'])

const MESSAGES: Record<Flag['code'], string> = {
  attachment_origin: 'holds a value that appears in an attached file but not in your messages or the current workflow',
  new_egress_target: 'sends data or writes to a target that is not in your messages or the current workflow',
  untrusted_flow: 'is built from content read from a file, a web response or a request',
}

const CODE_ORDER: Flag['code'][] = ['attachment_origin', 'new_egress_target', 'untrusted_flow']

function baseType(type: string): string {
  return type.replace(/@\d+$/, '')
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function taintIndex(nodes: readonly WorkflowNode[], sources: ReadonlySet<string>): (id: string) => boolean {
  const byId = new Map<string, WorkflowNode>()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)
  const known = new Map<string, boolean>()
  const visiting = new Set<string>()
  const tainted = (id: string): boolean => {
    const cached = known.get(id)
    if (cached !== undefined) return cached
    const node = byId.get(id)
    if (node === undefined || visiting.has(id)) return false
    visiting.add(id)
    const result =
      sources.has(baseType(node.type)) || extractRefs(node.config).some((ref) => ref.nodeId !== id && tainted(ref.nodeId))
    visiting.delete(id)
    known.set(id, result)
    return result
  }
  return tainted
}

export function computeProvenance(input: ProvenanceInput, options: ProvenanceOptions = {}): Flag[] {
  const { workflow, registry, userTexts, existingWorkflow, attachmentTexts } = input
  const userHaystacks = [...userTexts, ...(existingWorkflow === undefined ? [] : stringLeaves(existingWorkflow).map((leaf) => leaf.value))].map(fold)
  const attachmentHaystacks = attachmentTexts.map(fold)
  const tainted = taintIndex(workflow.nodes, options.untrustedSourceTypes ?? UNTRUSTED_SOURCE_TYPES)
  const found: { index: number; flag: Flag }[] = []
  const seen = new Set<string>()
  workflow.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    if (def === undefined) return
    const add = (pointer: string, code: Flag['code']) => {
      const key = `${index}\u0000${pointer}\u0000${code}`
      if (seen.has(key)) return
      seen.add(key)
      found.push({ index, flag: { nodeId: node.id, pointer, code, message: `node ${node.id}: ${pointer} ${MESSAGES[code]}` } })
    }
    for (const { pointer, role } of fieldRoles(def)) {
      if (!CHECKED_ROLES.has(role)) continue
      const value = valueAtPointer(node.config, pointer)
      if (typeof value !== 'string') continue
      const at = `/nodes/${index}/config${pointer}`
      if (extractRefs(value).some((ref) => tainted(ref.nodeId))) add(at, 'untrusted_flow')
      const literal = literalOf(role as 'path' | 'url' | 'connection' | 'recipient', value)
      if (literal === undefined || occursInAny(userHaystacks, literal)) continue
      if (isEgressField(def, pointer)) add(at, 'new_egress_target')
      if (occursInAny(attachmentHaystacks, literal)) add(at, 'attachment_origin')
    }
  })
  return found
    .sort(
      (a, b) =>
        a.index - b.index ||
        compare(a.flag.pointer, b.flag.pointer) ||
        CODE_ORDER.indexOf(a.flag.code) - CODE_ORDER.indexOf(b.flag.code),
    )
    .map((entry) => entry.flag)
}
