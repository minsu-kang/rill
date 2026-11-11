import { extractRefs, matchWholeRef, replaceRefs, stringLeaves, type TemplateRef, type Workflow, type WorkflowNode } from '@rill/dsl'
import { assertPathAllowed, fieldRoles, isEgressField, isWriteField, valueAtPointer } from '@rill/nodes-core'
import type { ProvenanceInput } from '../ports'
import type { Flag } from '../types'
import { fold, literalOf, occursIn, occursInAny } from './normalize'

/**
 * Node types whose output carries content from outside the workflow: file text, extracted values,
 * HTTP responses and incoming requests or file names. A url, path, recipient or connection that is
 * built from the output of one of these, directly or through nodes that reference it, is flagged
 * untrusted_flow. Versions are ignored: llm.extract@1 and llm.extract@2 are the same entry.
 * One designed flow is exempt: a path that is only read (never written) and is exactly the file
 * of a trigger.folderWatch event ({{t1.output.file}}), which is the file the user chose to watch.
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
  resolutionBudget?: number
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

/** Steps of literal resolution allowed in one provenance call; past it every role field of the node is flagged. */
export const DEFAULT_RESOLUTION_BUDGET = 50_000

const MAX_EXACT_LENGTH = 8192
const MIN_FILE_NAME = 3
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi

export interface ProvenanceStats {
  work: number
  rootChecks: number
  decisions: number
}

/** Memo shared by the provenance calls and the masking of one planner run (same user texts and settings). */
export interface ProvenanceCache {
  userSourced: Map<string, boolean>
  insideRoots: Map<string, boolean>
  stats: ProvenanceStats
}

export function createProvenanceCache(): ProvenanceCache {
  return { userSourced: new Map(), insideRoots: new Map(), stats: { work: 0, rootChecks: 0, decisions: 0 } }
}

export interface Resolution {
  /** The single full string the value takes, when every reference resolves to exactly one string. */
  exact?: string
  /** Every string literal reachable through the references, for fragment checks. */
  literals: string[]
  /** The work budget ran out, so the literals may be incomplete. */
  exhausted: boolean
}

export interface Resolver {
  resolve(value: string): Resolution
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

export interface ResolverOptions {
  skip?: ReadonlySet<string>
  budget?: number
  stats?: ProvenanceStats
}

/**
 * Resolves the literals a templated value can take from the configs of the nodes it references,
 * followed transitively and memoised per (node, path). A transform output field resolves to its own
 * entry in values; any other reference resolves to the referenced config field of the same name when
 * there is one, else to every string in that node's config. Nodes of the skipped types (the
 * untrusted sources, whose output is outside content and flagged untrusted_flow instead) are not
 * followed. The total work is bounded by the budget.
 */
export function createResolver(workflow: Workflow, options: ResolverOptions = {}): Resolver {
  const skip = options.skip ?? UNTRUSTED_SOURCE_TYPES
  const budget = options.budget ?? DEFAULT_RESOLUTION_BUDGET
  const stats = options.stats
  const byId = indexNodes(workflow.nodes)
  const memo = new Map<string, Resolution>()
  const active = new Set<string>()
  let work = 0
  let cut = false
  const spend = (): boolean => {
    work += 1
    if (stats !== undefined) stats.work += 1
    return work <= budget
  }
  const resolveRef = (ref: TemplateRef): Resolution => {
    const key = JSON.stringify([ref.nodeId, ...ref.path])
    const known = memo.get(key)
    if (known !== undefined) return known
    const node = byId.get(ref.nodeId)
    if (node === undefined || skip.has(baseType(node.type)) || !isObject(node.config)) return { literals: [], exhausted: false }
    if (active.has(key)) {
      cut = true
      return { literals: [], exhausted: false }
    }
    const outerCut = cut
    cut = false
    active.add(key)
    const target = referencedValue(node.config, ref.path)
    const literals = new Set<string>()
    let exhausted = false
    for (const leaf of stringLeaves(target)) {
      if (!spend()) {
        exhausted = true
        break
      }
      literals.add(leaf.value)
      const inner = resolveText(leaf.value)
      for (const literal of inner.literals) literals.add(literal)
      if (inner.exhausted) {
        exhausted = true
        break
      }
    }
    const exact = typeof target === 'string' && !exhausted ? resolveText(target).exact : undefined
    active.delete(key)
    const result: Resolution = { ...(exact === undefined ? {} : { exact }), literals: [...literals], exhausted }
    if (!cut) memo.set(key, result)
    cut ||= outerCut
    return result
  }
  const resolveText = (text: string): Resolution => {
    const refs = extractRefs(text)
    if (refs.length === 0) return { exact: text, literals: [], exhausted: false }
    const literals = new Set<string>()
    const exacts = new Map<string, string | undefined>()
    let exhausted = false
    for (const ref of refs) {
      if (!spend()) {
        exhausted = true
        break
      }
      const resolved = resolveRef(ref)
      for (const literal of resolved.literals) literals.add(literal)
      exacts.set(JSON.stringify([ref.nodeId, ...ref.path]), resolved.exact)
      if (resolved.exhausted) {
        exhausted = true
        break
      }
    }
    let exact: string | undefined
    if (!exhausted && [...exacts.values()].every((value) => value !== undefined)) {
      const whole = matchWholeRef(text)
      exact = whole !== null ? exacts.get(JSON.stringify([whole.nodeId, ...whole.path])) : replaceRefs(text, (ref) => exacts.get(JSON.stringify([ref.nodeId, ...ref.path])) as string)
      if (exact !== undefined && exact.length > MAX_EXACT_LENGTH) exact = undefined
    }
    return { ...(exact === undefined ? {} : { exact }), literals: [...literals], exhausted }
  }
  return { resolve: resolveText }
}

function roleValues(workflow: Workflow, registry: ProvenanceInput['registry']): { node: WorkflowNode; index: number; pointer: string; role: CheckedRole; value: string }[] {
  const found: { node: WorkflowNode; index: number; pointer: string; role: CheckedRole; value: string }[] = []
  workflow.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    if (def === undefined) return
    for (const { pointer, role } of fieldRoles(def)) {
      if (!CHECKED_ROLES.has(role)) continue
      const value = valueAtPointer(node.config, pointer)
      if (typeof value === 'string') found.push({ node, index, pointer, role: role as CheckedRole, value })
    }
  })
  return found
}

export function roleLiterals(workflow: Workflow, registry: ProvenanceInput['registry'], skip: ReadonlySet<string> = UNTRUSTED_SOURCE_TYPES): string[] {
  const resolver = createResolver(workflow, { skip })
  return roleValues(workflow, registry).flatMap(({ value }) => {
    if (extractRefs(value).length === 0) return [value]
    const resolved = resolver.resolve(value)
    return [value, ...(resolved.exact === undefined ? [] : [resolved.exact]), ...resolved.literals]
  })
}

function fileNameOf(path: string): string {
  return fold(path.trim()).split(/[/\\]/).at(-1) ?? ''
}

export type UserSourcedTest = (role: CheckedRole, text: string, write: boolean) => boolean

/**
 * Whether a literal at a role field counts as written by the user: it occurs in the user texts or
 * in a role field of the existing workflow, or it is a configured connection name, or it is a
 * write path inside the allowed folders whose file name (3 characters or more) the user wrote
 * outside a URL. A text without a literal part has nothing to check and counts as user-sourced.
 */
export function userSourcedTest(input: Omit<ProvenanceInput, 'workflow' | 'attachmentTexts'>, sources: ReadonlySet<string> = UNTRUSTED_SOURCE_TYPES): UserSourcedTest {
  const cache = input.cache ?? createProvenanceCache()
  const ownHaystacks = input.userTexts.map(fold)
  const plainHaystacks = ownHaystacks.map((text) => text.replace(URL_IN_TEXT, ' '))
  const existing = input.existingWorkflow
  const userHaystacks = [...ownHaystacks, ...(existing === undefined ? [] : roleLiterals(existing, input.registry, sources).map(fold))]
  const trustedConnections = new Set(input.trustedConnections ?? [])
  const roots = [...(input.allowedRoots ?? [])]
  const rootsKey = JSON.stringify(roots)
  const scope = JSON.stringify([[...sources].sort(), rootsKey])
  const insideRoots = (path: string): boolean => {
    const key = `${rootsKey}\u0000${path}`
    const known = cache.insideRoots.get(key)
    if (known !== undefined) return known
    cache.stats.rootChecks += 1
    let inside: boolean
    try {
      assertPathAllowed(path, roots)
      inside = true
    } catch {
      inside = false
    }
    cache.insideRoots.set(key, inside)
    return inside
  }
  const decide = (role: CheckedRole, text: string, write: boolean): boolean => {
    const literal = literalOf(role, text)
    if (literal === undefined) return true
    if (literal.opaque === true) return false
    if (occursInAny(userHaystacks, literal)) return true
    if (role === 'connection') return trustedConnections.has(text)
    if (!write || extractRefs(text).length > 0) return false
    const name = fileNameOf(text)
    if (name.length < MIN_FILE_NAME || !plainHaystacks.some((haystack) => occursIn(haystack, name, 'name'))) return false
    return insideRoots(text)
  }
  return (role, text, write) => {
    const key = `${scope}\u0000${role}\u0000${write ? 1 : 0}\u0000${text}`
    const known = cache.userSourced.get(key)
    if (known !== undefined) return known
    cache.stats.decisions += 1
    const result = decide(role, text, write)
    cache.userSourced.set(key, result)
    return result
  }
}

function isWatchedFile(value: string, byId: ReadonlyMap<string, WorkflowNode>): boolean {
  const whole = matchWholeRef(value)
  if (whole === null || whole.path.length !== 1 || whole.path[0] !== 'file') return false
  const node = byId.get(whole.nodeId)
  return node !== undefined && baseType(node.type) === FILE_EVENT_SOURCE
}

export function computeProvenance(input: ProvenanceInput, options: ProvenanceOptions = {}): Flag[] {
  const { workflow, registry, attachmentTexts } = input
  const sources = options.untrustedSourceTypes ?? UNTRUSTED_SOURCE_TYPES
  const cache = input.cache ?? createProvenanceCache()
  const attachmentHaystacks = attachmentTexts.map(fold)
  const userSourced = userSourcedTest({ ...input, cache }, sources)
  const tainted = taintIndex(workflow.nodes, sources)
  const byId = indexNodes(workflow.nodes)
  const resolver = createResolver(workflow, { skip: sources, budget: options.resolutionBudget ?? DEFAULT_RESOLUTION_BUDGET, stats: cache.stats })
  const attachmentHits = new Map<string, boolean>()
  const fromAttachment = (role: CheckedRole, text: string): boolean => {
    const key = `${role}\u0000${text}`
    const known = attachmentHits.get(key)
    if (known !== undefined) return known
    const literal = literalOf(role, text)
    const hit = literal !== undefined && occursInAny(attachmentHaystacks, literal)
    attachmentHits.set(key, hit)
    return hit
  }
  const found: { index: number; flag: Flag }[] = []
  const fields = roleValues(workflow, registry)
  const exhaustedNodes = new Set<number>()
  const codesAt = new Map<string, { index: number; nodeId: string; codes: Set<Flag['code']> }>()
  for (const { node, index, pointer, role, value } of fields) {
    const def = registry.get(node.type)!
    const at = `/nodes/${index}/config${pointer}`
    const write = isWriteField(def, pointer)
    const egress = isEgressField(def, pointer)
    const codes = new Set<Flag['code']>()
    codesAt.set(at, { index, nodeId: node.id, codes })
    const refs = extractRefs(value)
    const exempt = role === 'path' && !write && isWatchedFile(value, byId)
    if (!exempt && refs.some((ref) => tainted(ref.nodeId))) codes.add('untrusted_flow')
    let candidates = [value]
    if (refs.length > 0) {
      const resolved = resolver.resolve(value)
      if (resolved.exhausted) exhaustedNodes.add(index)
      candidates = resolved.exact !== undefined && !resolved.exhausted ? [resolved.exact] : [value, ...resolved.literals]
    }
    for (const text of candidates) {
      if (userSourced(role, text, write)) continue
      if (egress) codes.add('new_egress_target')
      if (fromAttachment(role, text)) codes.add('attachment_origin')
    }
  }
  for (const { node, index, pointer } of fields) {
    if (!exhaustedNodes.has(index)) continue
    const def = registry.get(node.type)!
    codesAt.get(`/nodes/${index}/config${pointer}`)!.codes.add(isEgressField(def, pointer) ? 'new_egress_target' : 'untrusted_flow')
  }
  for (const [pointer, { index, nodeId, codes }] of codesAt) {
    for (const code of codes) found.push({ index, flag: { nodeId, pointer, code, message: `node ${nodeId}: ${pointer} ${MESSAGES[code]}` } })
  }
  return found
    .sort(
      (a, b) =>
        a.index - b.index ||
        compare(a.flag.pointer, b.flag.pointer) ||
        CODE_ORDER.indexOf(a.flag.code) - CODE_ORDER.indexOf(b.flag.code),
    )
    .map((entry) => entry.flag)
}
