import { extractRefs, stringLeaves, type Workflow, type WorkflowNode } from '@rill/dsl'
import { assertPathAllowed, fieldRoles, isEgressField, isWriteField, valueAtPointer } from '@rill/nodes-core'
import type { ProvenanceInput } from '../ports'
import type { Flag } from '../types'
import { fold, literalOf, occursIn, occursInAny } from './normalize'

/**
 * Node types whose output carries content from outside the workflow: file text, extracted values,
 * HTTP responses and incoming requests or file names. A url, path, recipient or connection that is
 * built from the output of one of these, directly or through nodes that reference it, is flagged
 * untrusted_flow. Versions are ignored: llm.extract@1 and llm.extract@2 are the same entry.
 * One designed flow is exempt: a path that is only read (never written) may come from the file
 * event of trigger.folderWatch, which is the file the user chose to watch.
 */
export const UNTRUSTED_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'llm.extract',
  'file.read',
  'http.request',
  'trigger.webhook',
  'trigger.folderWatch',
])

const FILE_EVENT_SOURCE = 'trigger.folderWatch'

export interface ProvenanceOptions {
  untrustedSourceTypes?: ReadonlySet<string>
}

export const CHECKED_ROLES: ReadonlySet<string> = new Set(['path', 'url', 'connection', 'recipient'])

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
  const byId = indexNodes(nodes)
  const known = new Map<string, boolean>()
  const visiting = new Set<string>()
  const tainted = (id: string): boolean => {
    const cached = known.get(id)
    if (cached !== undefined) return cached
    const node = byId.get(id)
    if (node === undefined || visiting.has(id)) return false
    visiting.add(id)
    const result =
      sources.has(baseType(node.type)) || extractRefs(node.config).some((ref) => tainted(ref.nodeId))
    visiting.delete(id)
    known.set(id, result)
    return result
  }
  return tainted
}

export type CheckedRole = 'path' | 'url' | 'connection' | 'recipient'

export const MAX_RESOLVED_LITERALS = 1000

export interface ResolvedLiterals {
  literals: string[]
  truncated: boolean
}

function indexNodes(nodes: readonly WorkflowNode[]): Map<string, WorkflowNode> {
  const byId = new Map<string, WorkflowNode>()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)
  return byId
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function referencedValue(config: Record<string, unknown>, path: readonly string[]): unknown {
  const values = config.values
  const first = path[0]
  let current: unknown = first !== undefined && isObject(values) && Object.hasOwn(values, first) ? values : config
  for (const segment of path) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) break
    current = current[segment]
  }
  return current
}

/**
 * The string literals a templated value can take from the configs of the nodes it references,
 * followed transitively. A transform output field resolves to its own entry in values; any other
 * reference resolves to the referenced config field of the same name when there is one, else to
 * every string in that node's config. Nodes of the skipped types (the untrusted sources, whose
 * output is outside content and flagged untrusted_flow instead) are not followed.
 */
export function resolveLiterals(value: string, byId: ReadonlyMap<string, WorkflowNode>, skip: ReadonlySet<string> = UNTRUSTED_SOURCE_TYPES): ResolvedLiterals {
  const literals: string[] = []
  const stack = new Set<string>()
  let truncated = false
  const visit = (text: string): void => {
    for (const ref of extractRefs(text)) {
      const key = JSON.stringify([ref.nodeId, ...ref.path])
      const node = byId.get(ref.nodeId)
      if (node === undefined || skip.has(baseType(node.type)) || stack.has(key)) continue
      stack.add(key)
      for (const leaf of stringLeaves(referencedValue(node.config, ref.path))) {
        if (literals.length >= MAX_RESOLVED_LITERALS) {
          truncated = true
          break
        }
        literals.push(leaf.value)
        visit(leaf.value)
      }
      stack.delete(key)
      if (truncated) return
    }
  }
  visit(value)
  return { literals, truncated }
}

export function roleLiterals(workflow: Workflow, registry: ProvenanceInput['registry'], skip: ReadonlySet<string> = UNTRUSTED_SOURCE_TYPES): string[] {
  const byId = indexNodes(workflow.nodes)
  const found: string[] = []
  for (const node of workflow.nodes) {
    const def = registry.get(node.type)
    if (def === undefined) continue
    for (const { pointer, role } of fieldRoles(def)) {
      if (!CHECKED_ROLES.has(role)) continue
      const value = valueAtPointer(node.config, pointer)
      if (typeof value === 'string') found.push(value, ...resolveLiterals(value, byId, skip).literals)
    }
  }
  return found
}

function isInsideRoots(path: string, roots: readonly string[]): boolean {
  try {
    assertPathAllowed(path, [...roots])
    return true
  } catch {
    return false
  }
}

function fileNameOf(path: string): string {
  return fold(path.trim()).split(/[/\\]/).at(-1) ?? ''
}

export type UserSourcedTest = (role: CheckedRole, text: string, write: boolean) => boolean

/**
 * Whether a literal at a role field counts as written by the user: it occurs in the user texts or
 * in a role field of the existing workflow, or it is a configured connection name, or it is a
 * write path inside the allowed folders whose file name the user wrote. A text without a literal
 * part has nothing to check and counts as user-sourced.
 */
export function userSourcedTest(input: Omit<ProvenanceInput, 'workflow' | 'attachmentTexts'>, sources: ReadonlySet<string> = UNTRUSTED_SOURCE_TYPES): UserSourcedTest {
  const ownHaystacks = input.userTexts.map(fold)
  const existing = input.existingWorkflow
  const userHaystacks = [...ownHaystacks, ...(existing === undefined ? [] : roleLiterals(existing, input.registry, sources).map(fold))]
  const trustedConnections = new Set(input.trustedConnections ?? [])
  const roots = input.allowedRoots ?? []
  return (role, text, write) => {
    const literal = literalOf(role, text)
    if (literal === undefined) return true
    if (literal.opaque === true) return false
    if (occursInAny(userHaystacks, literal)) return true
    if (role === 'connection') return trustedConnections.has(text)
    if (!write || extractRefs(text).length > 0 || !isInsideRoots(text, roots)) return false
    const name = fileNameOf(text)
    return name !== '' && ownHaystacks.some((haystack) => occursIn(haystack, name, 'name'))
  }
}

export function computeProvenance(input: ProvenanceInput, options: ProvenanceOptions = {}): Flag[] {
  const { workflow, registry, attachmentTexts } = input
  const sources = options.untrustedSourceTypes ?? UNTRUSTED_SOURCE_TYPES
  const attachmentHaystacks = attachmentTexts.map(fold)
  const userSourced = userSourcedTest(input, sources)
  const tainted = taintIndex(workflow.nodes, sources)
  const taintedForReads = taintIndex(workflow.nodes, new Set([...sources].filter((type) => type !== FILE_EVENT_SOURCE)))
  const byId = indexNodes(workflow.nodes)
  const found: { index: number; flag: Flag }[] = []
  workflow.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    if (def === undefined) return
    const add = (pointer: string, code: Flag['code']) => {
      found.push({ index, flag: { nodeId: node.id, pointer, code, message: `node ${node.id}: ${pointer} ${MESSAGES[code]}` } })
    }
    for (const { pointer, role } of fieldRoles(def)) {
      if (!CHECKED_ROLES.has(role)) continue
      const value = valueAtPointer(node.config, pointer)
      if (typeof value !== 'string') continue
      const checked = role as CheckedRole
      const at = `/nodes/${index}/config${pointer}`
      const write = isWriteField(def, pointer)
      const egress = isEgressField(def, pointer)
      const codes = new Set<Flag['code']>()
      const isTainted = role === 'path' && !write ? taintedForReads : tainted
      if (extractRefs(value).some((ref) => isTainted(ref.nodeId))) codes.add('untrusted_flow')
      const resolved = resolveLiterals(value, byId, sources)
      if (resolved.truncated && egress) codes.add('new_egress_target')
      for (const text of [value, ...resolved.literals]) {
        const literal = literalOf(checked, text)
        if (literal === undefined || userSourced(checked, text, write)) continue
        if (egress) codes.add('new_egress_target')
        if (occursInAny(attachmentHaystacks, literal)) codes.add('attachment_origin')
      }
      for (const code of codes) add(at, code)
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
