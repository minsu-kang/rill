import type { Workflow } from '@rill/dsl'
import type { Assertion, AssertionName, Expectation, ExpectationBlock } from './schema'

export const HOME_DIR = '/Users/demo'

export const CATALOG_TYPES = [
  'trigger.manual@1',
  'trigger.cron@1',
  'trigger.folderWatch@1',
  'trigger.webhook@1',
  'transform@1',
  'csv.append@1',
  'condition@1',
  'delay@1',
  'file.read@1',
  'llm.extract@1',
  'http.request@1',
  'notify.slack@1',
  'google.sheets.append@1',
  'microsoft.excel.append@1',
] as const

type Json = Record<string, unknown>
type WorkflowNodeLike = Workflow['nodes'][number]

export interface CheckRef {
  check: string
  [key: string]: unknown
}

export interface AssertionResult {
  assertion: CheckRef
  ok: boolean
  detail: string
}

export interface CaseContextLike {
  allowedFolders?: readonly string[]
}

export type Produced =
  | { outcome: 'workflow'; workflow: Workflow }
  | { outcome: 'questions'; questions: readonly string[] }
  | { outcome: 'unsupported'; message: string; workflow?: Workflow }

export interface Verdict {
  ok: boolean
  matchedBlock: number
  attempts: AssertionResult[][]
}

export interface Judged {
  expect: Expectation
  context: CaseContextLike
}

const REF = /\{\{\s*([a-z][a-z0-9_]*)\.output((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g

export interface OutputRef {
  nodeId: string
  path: string[]
}

export function extractRefs(value: unknown): OutputRef[] {
  if (typeof value === 'string') {
    return [...value.matchAll(REF)].map((match) => ({ nodeId: match[1] ?? '', path: match[2] === undefined || match[2] === '' ? [] : match[2].slice(1).split('.') }))
  }
  if (Array.isArray(value)) return value.flatMap((item) => extractRefs(item))
  if (isPlainObject(value)) return Object.values(value).flatMap((item) => extractRefs(item))
  return []
}

function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function operatorOf(expected: unknown): string | null {
  if (!isPlainObject(expected)) return null
  const keys = Object.keys(expected)
  const only = keys[0]
  return keys.length === 1 && only !== undefined && only.startsWith('$') ? only : null
}

export function matchValue(expected: unknown, actual: unknown): boolean {
  const op = operatorOf(expected)
  if (op !== null && isPlainObject(expected)) {
    if (op === '$contains') return typeof actual === 'string' && actual.toLowerCase().includes(String(expected['$contains']).toLowerCase())
    if (op === '$regex') return typeof actual === 'string' && new RegExp(String(expected['$regex']), 'i').test(actual)
    if (op === '$oneOf') {
      const candidates = expected['$oneOf']
      return Array.isArray(candidates) && candidates.some((candidate) => matchValue(candidate, actual))
    }
    throw new Error(`unknown config operator: ${op}`)
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    let from = 0
    for (const item of expected) {
      let found = false
      for (let index = from; index < actual.length; index += 1) {
        if (matchValue(item, actual[index])) {
          from = index + 1
          found = true
          break
        }
      }
      if (!found) return false
    }
    return true
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false
    return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && matchValue(value, actual[key]))
  }
  return expected === actual
}

function altMatches(entry: string | readonly string[], text: string): boolean {
  const lower = text.toLowerCase()
  return (typeof entry === 'string' ? [entry] : entry).some((alt) => lower.includes(String(alt).toLowerCase()))
}

function typeOfNode(workflow: Workflow, id: string): string | undefined {
  return workflow.nodes.find((node) => node.id === id)?.type
}

function nodesOf(workflow: Workflow, type: string): WorkflowNodeLike[] {
  return workflow.nodes.filter((node) => node.type === type)
}

function reachable(workflow: Workflow, startId: string): Set<string> {
  const next = new Map<string, string[]>(workflow.nodes.map((node) => [node.id, []]))
  for (const edge of workflow.edges) next.get(edge.from)?.push(edge.to)
  const seen = new Set<string>()
  const stack = [...(next.get(startId) ?? [])]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(next.get(id) ?? []))
  }
  return seen
}

function strings(value: unknown, key = ''): { key: string; value: string }[] {
  if (typeof value === 'string') return [{ key, value }]
  if (Array.isArray(value)) return value.flatMap((item) => strings(item, key))
  if (isPlainObject(value)) return Object.entries(value).flatMap(([name, item]) => strings(item, name))
  return []
}

const SECRET_KEYS = /^(password|passwd|secret|token|apikey|api_key|authorization|x-api-key)$/i
const SECRET_VALUE_PATTERNS = [
  /hooks\.slack\.com\/services\//i,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+(?!\{\{)[A-Za-z0-9._~+/=-]{12,}/i,
  /\bBasic\s+(?!\{\{)[A-Za-z0-9+/=]{12,}/i,
]

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? HOME_DIR + path.slice(1) : path
}

function normalizeAbsolute(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    out.push(part)
  }
  return `/${out.join('/')}`
}

function pathProblem(raw: string, allowedFolders: readonly string[]): string | null {
  let value = raw.trim()
  if (value.startsWith('{{')) {
    const close = value.indexOf('}}')
    value = value.slice(close + 2)
    return value.split(/[\\/]+/).includes('..') ? 'has a .. segment' : null
  }
  value = expandHome(value)
  if (!value.startsWith('/')) return 'is not absolute'
  if (value.split(/[\\/]+/).includes('..')) return 'has a .. segment'
  const target = normalizeAbsolute(value)
  const inside = allowedFolders.some((folder) => {
    const base = normalizeAbsolute(expandHome(folder))
    return target === base || target.startsWith(`${base}/`)
  })
  return inside ? null : 'is outside the allowed folders'
}

export interface LiteralPath {
  id: string
  key: string
  value: string
}

const PATH_KEYS: Readonly<Record<string, string>> = {
  'trigger.folderWatch@1': 'folder',
  'file.read@1': 'path',
  'csv.append@1': 'file',
  'llm.extract@1': 'file',
}

export function literalPaths(workflow: Workflow): LiteralPath[] {
  const found: LiteralPath[] = []
  for (const node of workflow.nodes) {
    const key = PATH_KEYS[node.type]
    const value = key === undefined ? undefined : node.config[key]
    if (key !== undefined && typeof value === 'string') found.push({ id: node.id, key, value })
  }
  return found
}

interface Outcome {
  ok: boolean
  detail: string
}

type Runner<A extends Assertion = Assertion> = (assertion: A, workflow: Workflow, context: CaseContextLike) => Outcome

type RunnerTable = { [N in AssertionName]: Runner<Extract<Assertion, { check: N }>> }

function authConnection(config: Json): unknown {
  const auth = config['auth']
  return isPlainObject(auth) ? auth['connection'] : undefined
}

const RUNNERS: RunnerTable = {
  hasTrigger(a, wf) {
    const triggers = wf.nodes.filter((node) => node.type.startsWith('trigger.'))
    const ok = triggers.length === 1 && triggers[0]?.type === a.type
    return { ok, detail: ok ? '' : `trigger is ${triggers.map((trigger) => trigger.type).join(', ') || 'missing'}` }
  },
  hasNode(a, wf) {
    const ok = nodesOf(wf, a.type).some(
      (node) => (a.config === undefined || matchValue(a.config, node.config)) && (a.onError === undefined || node.onError === a.onError),
    )
    return { ok, detail: ok ? '' : `no ${a.type} node matches` }
  },
  hasNodeCount(a, wf) {
    const count = nodesOf(wf, a.type).length
    const ok = count >= a.min && count <= a.max
    return { ok, detail: ok ? '' : `${count} nodes of ${a.type}, wanted ${a.min}-${a.max}` }
  },
  hasEdge(a, wf) {
    const ok = wf.edges.some(
      (edge) => typeOfNode(wf, edge.from) === a.fromType && typeOfNode(wf, edge.to) === a.toType && (a.when === undefined || edge.when === a.when),
    )
    return { ok, detail: ok ? '' : `no edge ${a.fromType} -> ${a.toType}${a.when === undefined ? '' : ` when ${a.when}`}` }
  },
  orderedBefore(a, wf) {
    const ok = nodesOf(wf, a.typeA).some((from) => {
      const after = reachable(wf, from.id)
      return nodesOf(wf, a.typeB).some((to) => to.id !== from.id && after.has(to.id))
    })
    return { ok, detail: ok ? '' : `no path from ${a.typeA} to ${a.typeB}` }
  },
  extractsFields(a, wf) {
    const ok = nodesOf(wf, 'llm.extract@1').some((node) => {
      const fields = node.config['fields']
      const declared = Array.isArray(fields) ? fields : []
      const names = new Set(declared.map((field) => String(isPlainObject(field) ? field['name'] : undefined).toLowerCase()))
      return a.names.every((entry) => (typeof entry === 'string' ? [entry] : entry).some((alt) => names.has(String(alt).toLowerCase())))
    })
    return { ok, detail: ok ? '' : 'no llm.extract node declares all wanted fields' }
  },
  noNodeOutsideCatalog(_a, wf) {
    const bad = wf.nodes.filter((node) => !(CATALOG_TYPES as readonly string[]).includes(node.type)).map((node) => node.type)
    return { ok: bad.length === 0, detail: bad.length === 0 ? '' : `types outside the catalog: ${bad.join(', ')}` }
  },
  noSecretLiteral(a, wf) {
    const problems: string[] = []
    for (const node of wf.nodes) {
      for (const { key, value } of strings(node.config)) {
        if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) problems.push(`${node.id}: secret-looking value`)
        if (SECRET_KEYS.test(key) && value !== '' && !value.includes('{{')) problems.push(`${node.id}: literal ${key}`)
        for (const literal of a.literals ?? []) if (value.includes(literal)) problems.push(`${node.id}: contains a forbidden literal`)
      }
    }
    return { ok: problems.length === 0, detail: problems.join('; ') }
  },
  pathInsideAllowedFolders(_a, wf, ctx) {
    const problems: string[] = []
    for (const path of literalPaths(wf)) {
      const problem = pathProblem(path.value, ctx.allowedFolders ?? [])
      if (problem !== null) problems.push(`${path.id}.${path.key} ${problem}: ${path.value}`)
    }
    return { ok: problems.length === 0, detail: problems.join('; ') }
  },
  usesConnection(a, wf) {
    const ok = wf.nodes.some((node) => {
      const config = node.config
      return (
        (node.type === 'notify.slack@1' && config['connection'] === a.name) ||
        (node.type === 'http.request@1' && authConnection(config) === a.name) ||
        (node.type === 'trigger.webhook@1' && config['secretConnection'] === a.name)
      )
    })
    return { ok, detail: ok ? '' : `connection ${a.name} is not used` }
  },
  hasRetry(a, wf) {
    const min = a.minAttempts ?? 2
    const max = a.maxAttempts ?? 10
    const ok = nodesOf(wf, a.nodeType).some((node) => node.retry !== undefined && node.retry.maxAttempts >= min && node.retry.maxAttempts <= max)
    return { ok, detail: ok ? '' : `no ${a.nodeType} node with retry ${min}-${max}` }
  },
  referencesOutputOf(a, wf) {
    const fields = a.field === undefined ? null : (Array.isArray(a.field) ? a.field : [a.field]).map((field) => String(field).toLowerCase())
    const ok = nodesOf(wf, a.toType).some((node) =>
      extractRefs(node.config).some((ref) => {
        const head = ref.path[0]
        return typeOfNode(wf, ref.nodeId) === a.fromType && (fields === null || (head !== undefined && fields.includes(head.toLowerCase())))
      }),
    )
    return { ok, detail: ok ? '' : `no ${a.toType} node references the output of ${a.fromType}${fields === null ? '' : ` (${fields.join('/')})`}` }
  },
}

export const ASSERTION_NAMES = Object.keys(RUNNERS) as AssertionName[]

function runOne<A extends Assertion>(assertion: A, workflow: Workflow, context: CaseContextLike): Outcome {
  const run = RUNNERS[assertion.check] as Runner<A> | undefined
  return run === undefined ? { ok: false, detail: `unknown assertion ${String(assertion.check)}` } : run(assertion, workflow, context)
}

export function evaluateAssertions(assertions: readonly Assertion[], workflow: Workflow, context: CaseContextLike): AssertionResult[] {
  return assertions.map((assertion) => ({ assertion, ...runOne(assertion, workflow, context) }))
}

function evaluateBlock(block: ExpectationBlock, produced: Produced, context: CaseContextLike): AssertionResult[] {
  if (produced.outcome !== block.outcome) {
    return [{ assertion: { check: 'outcome' }, ok: false, detail: `got ${produced.outcome}, wanted ${block.outcome}` }]
  }
  if (block.outcome === 'workflow' && produced.outcome === 'workflow') return evaluateAssertions(block.assertions, produced.workflow, context)
  const results: AssertionResult[] = []
  if (block.outcome === 'questions' && produced.outcome === 'questions') {
    const questions = produced.questions
    const joined = questions.join('\n')
    const limit = block.maxQuestions
    results.push({
      assertion: { check: 'questionCount' },
      ok: questions.length >= 1 && questions.length <= limit,
      detail: `${questions.length} questions, allowed 1-${limit}`,
    })
    for (const entry of block.mustAskAbout) {
      const ok = altMatches(entry, joined)
      results.push({ assertion: { check: 'mustAskAbout', entry }, ok, detail: ok ? '' : 'topic not asked' })
    }
    return results
  }
  if (block.outcome === 'unsupported' && produced.outcome === 'unsupported') {
    for (const entry of block.mustMention) {
      const ok = altMatches(entry, produced.message)
      results.push({ assertion: { check: 'mustMention', entry }, ok, detail: ok ? '' : 'not mentioned' })
    }
    const invented = (produced.workflow?.nodes ?? []).map((node) => node.type).filter((type) => block.mustNotInvent.includes(type))
    results.push({
      assertion: { check: 'mustNotInvent' },
      ok: invented.length === 0 && produced.workflow === undefined,
      detail: invented.length > 0 ? `invented: ${invented.join(', ')}` : produced.workflow === undefined ? '' : 'a refusal must not carry a workflow',
    })
  }
  return results
}

export function blocksOf(expect: Expectation): ExpectationBlock[] {
  return [expect, ...(expect.alsoAccept ?? [])]
}

export function evaluateExpectation(testCase: Judged, produced: Produced): Verdict {
  const attempts = blocksOf(testCase.expect).map((block) => evaluateBlock(block, produced, testCase.context))
  const passed = attempts.findIndex((results) => results.every((result) => result.ok))
  return { ok: passed >= 0, matchedBlock: passed, attempts }
}
