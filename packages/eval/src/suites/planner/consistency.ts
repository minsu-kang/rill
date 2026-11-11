import { extractRefs as dslExtractRefs, isWarningIssue, parseWorkflowShape, type Workflow } from '@rill/dsl'
import { assertPathAllowed, declaredBranches, validateWorkflow, type NodeRegistry } from '@rill/nodes-core'
import Type from 'typebox'
import Value from 'typebox/value'
import {
  ASSERTION_NAMES,
  CATALOG_TYPES,
  HOME_DIR,
  blocksOf,
  evaluateAssertions,
  evaluateExpectation,
  expandHome,
  extractRefs,
  literalPaths,
  type Produced,
} from './assertions'
import {
  CATEGORIES,
  TAGS,
  casesSchema,
  referencesSchema,
  schemaProblems,
  type Assertion,
  type CaseSpec,
  type Category,
  type ExpectationBlock,
} from './schema'

type Json = Record<string, unknown>

export interface ConsistencyInput {
  cases: unknown
  references: unknown
  vocabulary: unknown
  registry: NodeRegistry
  seeds: readonly { id: string }[]
  manifest: readonly { seedId: string; kind: string; path: string }[]
  fixtureExists?: (path: string) => boolean
}

export interface ConsistencySummary {
  cases: number
  category: Record<string, number>
  language: Record<string, number>
  effort: Record<string, number>
  outcome: Record<string, number>
  hard: number
  references: number
  coveredTypes: string[]
  unusedTypes: string[]
}

export interface ConsistencyResult {
  problems: string[]
  summary: ConsistencySummary | undefined
}

export const EXPECTED_COUNTS: Readonly<Record<Category, number>> = { easy: 20, ambiguous: 10, unsupported: 8, attachment: 6, patch: 4 }
export const ID_PREFIX: Readonly<Record<Category, string>> = { easy: 'easy', ambiguous: 'ambig', unsupported: 'unsup', attachment: 'attach', patch: 'patch' }
export const OUTCOME_FOR: Readonly<Record<Category, string>> = {
  easy: 'workflow',
  ambiguous: 'questions',
  unsupported: 'unsupported',
  attachment: 'workflow',
  patch: 'workflow',
}

const NODE_TYPE_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*@[0-9]+$/
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/
const ID_RE = /^(easy|ambig|unsup|attach|patch)-\d{2}-[a-z0-9-]+$/
const MAX_PROMPT = 600
const MAX_WHY = 420
const MIN_WORKFLOW_ASSERTIONS = 5

const DEGENERATE: Workflow = { schemaVersion: 1, name: 'x', nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }], edges: [] }

const isObj = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const isStr = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const first = (entry: string | readonly string[]): string => (typeof entry === 'string' ? entry : (entry[0] ?? ''))

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function homeExpanded(value: unknown): unknown {
  if (typeof value === 'string') return value === '~' || value.startsWith('~/') ? HOME_DIR + value.slice(1) : value
  if (Array.isArray(value)) return value.map(homeExpanded)
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, homeExpanded(item)]))
  return value
}

interface Context {
  connections: readonly string[]
  allowedFolders: readonly string[]
}

export function workflowProblems(registry: NodeRegistry, workflow: unknown, context: Context): string[] {
  const issues = validateWorkflow(homeExpanded(workflow), { registry, allowedRoots: [...context.allowedFolders], connections: [...context.connections] })
  const problems = issues.filter((issue) => !isWarningIssue(issue)).map((issue) => `${issue.code} at ${issue.pointer || '/'}: ${issue.message}`)
  const parsed = parseWorkflowShape(workflow)
  if (!parsed.ok) return problems
  for (const node of parsed.workflow.nodes) {
    const def = registry.get(node.type)
    if (def?.kind === 'trigger' && (node.retry !== undefined || node.onError !== undefined)) problems.push(`${node.id}: retry/onError on a trigger`)
  }
  for (const path of literalPaths(parsed.workflow)) {
    if (path.value.includes('{{')) continue
    try {
      assertPathAllowed(expandHome(path.value), context.allowedFolders.map(expandHome))
    } catch (error) {
      problems.push(`${path.id}.${path.key}: real path guard rejects ${path.value}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const mine = evaluateAssertions([{ check: 'pathInsideAllowedFolders' }], parsed.workflow, { allowedFolders: context.allowedFolders })[0]
  if (mine !== undefined && !mine.ok) problems.push(`path check: ${mine.detail}`)
  return problems
}

function stepSchema(schema: unknown, segment: string): unknown {
  if (!isObj(schema) || Object.keys(schema).length === 0) return 'any'
  const union = schema['anyOf']
  if (Array.isArray(union)) {
    for (const part of union) {
      const next = stepSchema(part, segment)
      if (next !== null) return next
    }
    return null
  }
  const properties = schema['properties']
  if (isObj(properties) && Object.hasOwn(properties, segment)) return properties[segment]
  const patterns = schema['patternProperties']
  if (isObj(patterns)) return Object.values(patterns)[0] ?? 'any'
  if (schema['type'] === 'object' && !isObj(properties)) return 'any'
  return null
}

function pathExists(schema: unknown, path: readonly string[]): boolean {
  let current: unknown = schema
  for (const segment of path) {
    current = stepSchema(current, segment)
    if (current === 'any') return true
    if (current === null) return false
  }
  return true
}

function operatorKey(value: unknown): string | null {
  if (!isObj(value)) return null
  const keys = Object.keys(value)
  const only = keys[0]
  return keys.length === 1 && only !== undefined && only.startsWith('$') ? only : null
}

function checkConfigPattern(fail: (message: string) => void, schema: Json, expected: unknown, path: string): void {
  const op = operatorKey(expected)
  if (op !== null && isObj(expected)) {
    if (op === '$contains') {
      if (!isStr(expected['$contains'])) fail(`${path}: $contains needs a non-empty string`)
    } else if (op === '$regex') {
      try {
        new RegExp(String(expected['$regex']), 'i')
      } catch {
        fail(`${path}: invalid regular expression`)
      }
      if (!isStr(expected['$regex'])) fail(`${path}: $regex needs a non-empty string`)
    } else if (op === '$oneOf') {
      const candidates = expected['$oneOf']
      if (!Array.isArray(candidates) || candidates.length < 2) fail(`${path}: $oneOf needs at least two candidates`)
      else candidates.forEach((candidate, index) => checkConfigPattern(fail, schema, candidate, `${path}.$oneOf[${index}]`))
    } else fail(`${path}: unknown operator ${op}`)
    return
  }
  if (Array.isArray(expected)) {
    if (schema['type'] !== 'array') return fail(`${path}: expected an array in the schema`)
    const items = isObj(schema['items']) ? schema['items'] : {}
    expected.forEach((item, index) => checkConfigPattern(fail, items, item, `${path}[${index}]`))
    return
  }
  if (isObj(expected)) {
    const properties = schema['properties']
    if (!isObj(properties)) return
    for (const [key, value] of Object.entries(expected)) {
      const sub = properties[key]
      if (!Object.hasOwn(properties, key) || !isObj(sub)) fail(`${path}.${key} is not a config property`)
      else checkConfigPattern(fail, sub, value, `${path}.${key}`)
    }
    return
  }
  if (Object.keys(schema).length > 0 && !Value.Check(schema as unknown as Type.TSchema, expected)) {
    fail(`${path}: ${JSON.stringify(expected)} is not valid for the config schema`)
  }
}

function checkAlternatives(fail: (message: string) => void, list: readonly (string | readonly string[])[], label: string): void {
  if (list.length === 0) return fail(`${label} must be a non-empty array`)
  list.forEach((entry, index) => {
    const alts = typeof entry === 'string' ? [entry] : entry
    if (alts.length === 0 || !alts.every(isStr)) fail(`${label}[${index}] must be a non-empty string or array of non-empty strings`)
    if (typeof entry !== 'string' && new Set(entry.map((alt) => alt.toLowerCase())).size !== entry.length) fail(`${label}[${index}] has duplicate alternatives`)
  })
}

export function checkAssertion(registry: NodeRegistry, fail: (message: string) => void, assertion: Assertion, context: CaseSpec['context']): void {
  const defOf = (type: string) => registry.get(type)
  const catalog = registry.list().map((def) => def.type)
  const checkType = (type: string, trigger?: boolean): boolean => {
    if (!isStr(type) || !NODE_TYPE_RE.test(type)) return fail(`bad node type ${JSON.stringify(type)}`), false
    if (!catalog.includes(type)) return fail(`node type not in the real catalog: ${type}`), false
    const kind = defOf(type)?.kind
    if (trigger === true && kind !== 'trigger') fail(`${type} is not a trigger`)
    if (trigger === false && kind === 'trigger') fail(`${type} must not be a trigger here`)
    return true
  }
  switch (assertion.check) {
    case 'hasTrigger':
      checkType(assertion.type, true)
      break
    case 'hasNode': {
      if (!checkType(assertion.type)) break
      if (assertion.config !== undefined) {
        if (Object.keys(assertion.config).length === 0) fail('config must be a non-empty object')
        else {
          const def = defOf(assertion.type)
          if (def !== undefined) checkConfigPattern(fail, clone(def.configSchema) as unknown as Json, assertion.config, 'config')
        }
      }
      if (assertion.onError !== undefined && defOf(assertion.type)?.kind === 'trigger') fail('onError does not apply to a trigger')
      break
    }
    case 'hasNodeCount':
      checkType(assertion.type)
      if (assertion.min < 0 || assertion.max < assertion.min) fail('min/max must be integers with 0 <= min <= max')
      break
    case 'hasEdge': {
      const okFrom = checkType(assertion.fromType)
      checkType(assertion.toType, false)
      const def = defOf(assertion.fromType)
      if (okFrom && assertion.when !== undefined && def !== undefined) {
        const labels = declaredBranches(def)
        if (labels === null) fail(`${assertion.fromType} never produces a branch, so an edge from it cannot carry when`)
        else if (labels !== 'any' && !labels.includes(assertion.when)) fail(`when ${assertion.when} is not one of ${labels.join(', ')}`)
      }
      break
    }
    case 'orderedBefore':
      checkType(assertion.typeA)
      checkType(assertion.typeB, false)
      break
    case 'extractsFields':
      checkAlternatives(fail, assertion.names, 'names')
      for (const entry of assertion.names) {
        for (const alt of typeof entry === 'string' ? [entry] : entry) {
          if (!FIELD_NAME_RE.test(alt)) fail(`field name ${alt} does not match the llm.extract name pattern`)
        }
      }
      break
    case 'noNodeOutsideCatalog':
    case 'noSecretLiteral':
      break
    case 'pathInsideAllowedFolders':
      if (context.allowedFolders.length === 0) fail('pathInsideAllowedFolders needs at least one allowed folder in the context')
      break
    case 'usesConnection':
      if (!context.connections.includes(assertion.name)) fail(`connection ${assertion.name} is not in context.connections`)
      break
    case 'hasRetry':
      if (checkType(assertion.nodeType, false)) {
        const lo = assertion.minAttempts ?? 2
        const hi = assertion.maxAttempts ?? 10
        for (const [label, value] of [['minAttempts', lo], ['maxAttempts', hi]] as const) {
          if (value < 1 || value > 10) fail(`${label} must be an integer 1-10`)
        }
        if (lo > hi) fail('minAttempts > maxAttempts')
      }
      break
    case 'referencesOutputOf': {
      const okFrom = checkType(assertion.fromType)
      checkType(assertion.toType, false)
      if (assertion.field !== undefined) {
        const alts = Array.isArray(assertion.field) ? assertion.field : [assertion.field]
        if (!alts.every(isStr)) fail('field must be a string or array of strings')
        else if (okFrom && assertion.fromType !== 'llm.extract@1') {
          const def = defOf(assertion.fromType)
          const schema = def === undefined ? {} : clone(def.outputSchema)
          for (const alt of alts) if (!pathExists(schema, [alt])) fail(`${assertion.fromType} has no output field ${alt}`)
        }
      }
      break
    }
  }
}

function checkBlock(
  registry: NodeRegistry,
  fail: (message: string) => void,
  block: ExpectationBlock & { why?: string; alsoAccept?: readonly ExpectationBlock[] },
  context: CaseSpec['context'],
  main: boolean,
): void {
  const catalog = registry.list().map((def) => def.type)
  if (main) {
    const why = block.why
    if (!isStr(why)) fail('why must be a non-empty string')
    else {
      if (why.length > MAX_WHY) fail(`why is longer than ${MAX_WHY} characters`)
      if (/[.!?]\s+[A-Z]/.test(why)) fail('why must be one sentence')
      if (!/[.]$/.test(why)) fail('why must end with a period')
    }
  }
  if (block.outcome === 'workflow') {
    if (block.assertions.length < MIN_WORKFLOW_ASSERTIONS) return fail(`a workflow expectation needs at least ${MIN_WORKFLOW_ASSERTIONS} assertions`)
    block.assertions.forEach((assertion, index) => checkAssertion(registry, (message) => fail(`assertions[${index}]: ${message}`), assertion, context))
    if (!block.assertions.some((assertion) => assertion.check === 'noNodeOutsideCatalog')) fail('workflow expectations must include noNodeOutsideCatalog')
    const pinsTrigger = block.assertions.some(
      (assertion) => assertion.check === 'hasTrigger' || (assertion.check === 'hasNode' && assertion.type.startsWith('trigger.')),
    )
    if (!pinsTrigger) fail('workflow expectations must pin the trigger')
    const seen = new Set<string>()
    for (const assertion of block.assertions) {
      const key = JSON.stringify(assertion)
      if (seen.has(key)) fail(`duplicate assertion ${key.slice(0, 60)}`)
      seen.add(key)
    }
  } else if (block.outcome === 'questions') {
    checkAlternatives(fail, block.mustAskAbout, 'mustAskAbout')
    if (block.maxQuestions < 1 || block.maxQuestions > 5) fail('maxQuestions must be an integer 1-5')
  } else {
    checkAlternatives(fail, block.mustMention, 'mustMention')
    if (block.mustNotInvent.length < 2) fail('mustNotInvent needs at least two invented node types')
    for (const type of block.mustNotInvent) {
      if (!isStr(type) || !NODE_TYPE_RE.test(type)) fail(`mustNotInvent entry is not a well-formed node type: ${type}`)
      else if (catalog.includes(type)) fail(`mustNotInvent entry ${type} is a real catalog type; it must be an invented name`)
    }
  }
  if (main && block.alsoAccept !== undefined) {
    if (block.alsoAccept.length === 0) fail('alsoAccept must be a non-empty array')
    else block.alsoAccept.forEach((alt, index) => checkBlock(registry, (message) => fail(`alsoAccept[${index}]: ${message}`), alt, context, false))
  }
}

function checkLanguage(fail: (message: string) => void, testCase: CaseSpec): void {
  const hangul = /[가-힣]/.test(testCase.prompt)
  const latin = (testCase.prompt.replace(/https?:\/\/\S+/g, ' ').match(/[A-Za-z]{3,}/g) ?? []).length
  if (testCase.language === 'en' && (hangul || latin < 4)) fail('language en but the prompt is not English')
  if (testCase.language === 'ko' && !hangul) fail('language ko but the prompt has no Hangul')
  if (testCase.language === 'mixed' && (!hangul || latin < 3)) fail('language mixed but the prompt does not mix Hangul and English words')
}

function tally(cases: readonly CaseSpec[]): { summary: Omit<ConsistencySummary, 'references' | 'coveredTypes' | 'unusedTypes'>; hard: number } {
  const bump = (bucket: Record<string, number>, key: string): void => {
    bucket[key] = (bucket[key] ?? 0) + 1
  }
  const category: Record<string, number> = {}
  const language: Record<string, number> = {}
  const effort: Record<string, number> = {}
  const outcome: Record<string, number> = {}
  let hard = 0
  for (const testCase of cases) {
    bump(category, testCase.category)
    bump(language, testCase.language)
    bump(effort, testCase.effort)
    bump(outcome, testCase.expect.outcome)
    if (testCase.tags?.includes('hard') === true) hard += 1
  }
  return { summary: { cases: cases.length, category, language, effort, outcome, hard }, hard }
}

function checkCase(input: ConsistencyInput, testCase: CaseSpec, report: (where: string, message: string) => void): void {
  const where = testCase.id
  const fail = (message: string): void => report(where, message)
  const { registry } = input
  if (!ID_RE.test(testCase.id)) fail('id must look like easy-01-some-slug')
  if (!testCase.id.startsWith(`${ID_PREFIX[testCase.category]}-`)) fail(`id prefix does not match category ${testCase.category}`)
  const unknownTags = (testCase.tags ?? []).filter((tag) => !(TAGS as readonly string[]).includes(tag))
  if (unknownTags.length > 0) fail(`tags must be a subset of ${TAGS.join(', ')}`)
  if (testCase.prompt.length > MAX_PROMPT) fail(`prompt must be a non-empty string up to ${MAX_PROMPT} characters`)
  else checkLanguage(fail, testCase)

  const { context } = testCase
  if (!context.connections.every(isStr) || new Set(context.connections).size !== context.connections.length) fail('connections must be unique strings')
  const badFolder = context.allowedFolders.some(
    (folder) => !isStr(folder) || !folder.startsWith(`${HOME_DIR}/`) || folder.endsWith('/') || folder.includes('..'),
  )
  if (badFolder) fail(`allowedFolders must be absolute ${HOME_DIR}/... paths without a trailing slash`)
  if (testCase.category === 'patch') {
    if (context.existingWorkflow === undefined || context.selectedNodeId === undefined) fail('patch cases need existingWorkflow and selectedNodeId')
    else {
      for (const problem of workflowProblems(registry, context.existingWorkflow, context)) report(`${where}.existingWorkflow`, problem)
      if (!context.existingWorkflow.nodes.some((node) => node.id === context.selectedNodeId)) {
        fail(`selectedNodeId ${context.selectedNodeId} is not a node of existingWorkflow`)
      }
    }
  } else if (context.existingWorkflow !== undefined || context.selectedNodeId !== undefined) fail('existingWorkflow/selectedNodeId only belong to patch cases')
  if (testCase.category === 'attachment') {
    if (context.attachments === undefined || context.attachments.length === 0) fail('attachment cases need attachments')
    else {
      context.attachments.forEach((attachment, index) => {
        const at = `${where}.attachments[${index}]`
        if (!input.seeds.some((seed) => seed.id === attachment.fixture)) report(at, `fixture ${attachment.fixture} is not a seed id in seeds.json`)
        const entry = input.manifest.find((file) => file.seedId === attachment.fixture && file.kind === attachment.kind)
        if (entry === undefined) report(at, `no ${attachment.kind} fixture for ${attachment.fixture} in manifest.json`)
        else if (input.fixtureExists !== undefined && !input.fixtureExists(entry.path)) report(at, `fixture file missing on disk: ${entry.path}`)
        if (!isStr(attachment.note)) report(at, 'note must be a non-empty string')
        if (attachment.inject !== undefined && !isStr(attachment.inject)) report(at, 'inject must be a non-empty string')
      })
    }
  } else if (context.attachments !== undefined) fail('attachments only belong to attachment cases')

  if (testCase.expect.outcome !== OUTCOME_FOR[testCase.category]) {
    fail(`category ${testCase.category} expects outcome ${OUTCOME_FOR[testCase.category]}, found ${testCase.expect.outcome}`)
  }
  checkBlock(registry, (message) => report(`${where}.expect`, message), testCase.expect, context, true)
}

function checkCounts(cases: readonly CaseSpec[], report: (where: string, message: string) => void): void {
  const { summary, hard } = tally(cases)
  if (cases.length !== 48) report('cases.json', `expected exactly 48 cases, found ${cases.length}`)
  for (const category of CATEGORIES) {
    const found = summary.category[category] ?? 0
    if (found !== EXPECTED_COUNTS[category]) report('counts', `${category}: expected ${EXPECTED_COUNTS[category]}, found ${found}`)
  }
  if (hard < 6) report('counts', `need at least 6 hard prompts, found ${hard}`)
  if ((summary.language['ko'] ?? 0) < 24) report('counts', `most prompts should be Korean (found ${summary.language['ko'] ?? 0} of ${cases.length})`)
  if ((summary.language['en'] ?? 0) < 4 || (summary.language['mixed'] ?? 0) < 4) report('counts', 'need at least 4 English and 4 mixed prompts')
  for (const effort of ['low', 'medium', 'high']) {
    if ((summary.effort[effort] ?? 0) < 8) report('counts', `effort ${effort} is used only ${summary.effort[effort] ?? 0} times`)
  }
  if (cases.filter((testCase) => testCase.category === 'easy' && testCase.tags?.includes('over-ask') === true).length < 3) {
    report('counts', 'need at least 3 easy over-ask cases')
  }
}

function checkVocabulary(input: ConsistencyInput, cases: readonly CaseSpec[], report: (where: string, message: string) => void): void {
  const documented = isObj(input.vocabulary) && isObj(input.vocabulary['assertions']) ? input.vocabulary['assertions'] : {}
  for (const name of ASSERTION_NAMES) if (!Object.hasOwn(documented, name)) report('vocabulary.json', `missing ${name}`)
  for (const name of Object.keys(documented)) if (!(ASSERTION_NAMES as readonly string[]).includes(name)) report('vocabulary.json', `documents unknown assertion ${name}`)
  const catalog = input.registry.list().map((def) => def.type)
  if (JSON.stringify([...CATALOG_TYPES].sort()) !== JSON.stringify([...catalog].sort())) report('assertions', 'CATALOG_TYPES differs from the real registry')
  if (catalog.length !== 12) report('catalog', `expected 12 catalog nodes, the real registry has ${catalog.length}`)
  const used = new Set(
    cases.flatMap((testCase) =>
      blocksOf(testCase.expect).flatMap((block) => (block.outcome === 'workflow' ? block.assertions.map((assertion) => assertion.check) : [])),
    ),
  )
  for (const name of ASSERTION_NAMES) if (!used.has(name)) report('coverage', `no case uses the ${name} assertion`)
}

function guarded(report: (where: string, message: string) => void, where: string, step: () => void): void {
  try {
    step()
  } catch (error) {
    report(where, `the evaluator threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function referenceKey(testCase: CaseSpec, index: number): string {
  return index === 0 ? testCase.id : `${testCase.id}#alsoAccept${index - 1}`
}

type Report = (where: string, message: string) => void

function checkReference(
  input: ConsistencyInput,
  testCase: CaseSpec,
  block: ExpectationBlock,
  index: number,
  reference: unknown,
  covered: Set<string>,
  report: Report,
): void {
  const { context } = testCase
  const key = referenceKey(testCase, index)
  for (const problem of workflowProblems(input.registry, reference, context)) report(`${key}.reference`, problem)
  const parsed = parseWorkflowShape(reference)
  if (!parsed.ok) return
  const workflow = parsed.workflow
  if (index === 0 && testCase.category === 'patch' && JSON.stringify(reference) === JSON.stringify(context.existingWorkflow)) {
    report(key, 'the patch reference equals the existing workflow')
  }
  for (const node of workflow.nodes) covered.add(node.type)
  const single = { context, expect: { ...block, why: 'alt', alsoAccept: undefined } as CaseSpec['expect'] }
  const verdict = evaluateExpectation(single, { outcome: 'workflow', workflow })
  for (const result of verdict.attempts[0] ?? []) {
    if (!result.ok) report(`${key}.reference`, `assertion ${JSON.stringify(result.assertion).slice(0, 110)} fails on the reference: ${result.detail}`)
  }
  if (evaluateExpectation(single, { outcome: 'workflow', workflow: DEGENERATE }).ok) {
    report(key, 'a bare manual-trigger workflow passes the expectation, so the assertions are too weak')
  }
  const assertions = block.outcome === 'workflow' ? block.assertions : []
  const failing = assertions.filter((assertion) => evaluateAssertions([assertion], DEGENERATE, context)[0]?.ok !== true).length
  if (failing < 3) report(key, `only ${failing} assertions fail on a bare workflow`)
}

function checkReferences(input: ConsistencyInput, cases: readonly CaseSpec[], references: Record<string, unknown>, report: Report): Set<string> {
  const covered = new Set<string>()
  const expectedKeys = new Set<string>()
  for (const testCase of cases) {
    blocksOf(testCase.expect).forEach((block, index) => {
      if (block.outcome !== 'workflow') return
      const key = referenceKey(testCase, index)
      expectedKeys.add(key)
      const reference = references[key]
      if (reference === undefined) return report(key, 'no reference solution in references.json')
      guarded(report, key, () => checkReference(input, testCase, block, index, reference, covered, report))
    })
  }
  for (const key of Object.keys(references)) if (!expectedKeys.has(key)) report(key, 'reference without a workflow expectation')
  return covered
}

const NAMED_TYPE_KEYS = ['type', 'fromType', 'toType', 'typeA', 'typeB', 'nodeType'] as const

function namesType(assertion: Assertion, type: string): boolean {
  const record = assertion as Record<string, unknown>
  return NAMED_TYPE_KEYS.some((key) => record[key] === type) && !(assertion.check === 'hasNodeCount' && assertion.min === 0)
}

function checkMutation(testCase: CaseSpec, references: Record<string, unknown>, report: Report): void {
  const main = testCase.expect
  if (main.outcome !== 'workflow') return
  const parsed = parseWorkflowShape(references[testCase.id])
  if (!parsed.ok) return
  const workflow = parsed.workflow
  for (const victim of workflow.nodes.filter((node) => !node.type.startsWith('trigger.'))) {
    const mutated: Workflow = {
      ...workflow,
      nodes: workflow.nodes.filter((node) => node.id !== victim.id),
      edges: workflow.edges.filter((edge) => edge.from !== victim.id && edge.to !== victim.id),
    }
    if (!main.assertions.some((assertion) => namesType(assertion, victim.type))) continue
    const verdict = evaluateExpectation({ context: testCase.context, expect: { ...main, alsoAccept: undefined } }, { outcome: 'workflow', workflow: mutated })
    if (verdict.ok) report(testCase.id, `removing ${victim.id} (${victim.type}) from the reference still passes`)
  }
}

function checkMachinery(testCase: CaseSpec, report: Report): void {
  const main = testCase.expect
  const single = { context: testCase.context, expect: { ...main, alsoAccept: undefined } }
  const judge = (produced: Produced): boolean => evaluateExpectation(single, produced).ok
  if (main.outcome === 'questions') {
    const good = main.mustAskAbout.map((entry) => `${first(entry)}?`)
    if (!judge({ outcome: 'questions', questions: good.slice(0, main.maxQuestions) }) && good.length <= main.maxQuestions) {
      report(testCase.id, 'a synthetic good question list does not pass')
    }
    if (judge({ outcome: 'questions', questions: [] })) report(testCase.id, 'an empty question list passes')
    if (judge({ outcome: 'workflow', workflow: DEGENERATE })) report(testCase.id, 'a workflow passes a questions expectation')
  }
  if (main.outcome === 'unsupported') {
    const message = main.mustMention.map(first).join(' / ')
    if (!judge({ outcome: 'unsupported', message })) report(testCase.id, 'a synthetic refusal does not pass')
    const invented: Workflow = { schemaVersion: 1, name: 'x', nodes: [{ id: 't1', type: main.mustNotInvent[0] ?? 'x@1', config: {} }], edges: [] }
    if (judge({ outcome: 'unsupported', message, workflow: invented })) report(testCase.id, 'a refusal carrying an invented node passes')
    if (judge({ outcome: 'workflow', workflow: DEGENERATE })) report(testCase.id, 'a workflow passes an unsupported expectation')
  }
}

function checkParity(references: Record<string, unknown>, report: (where: string, message: string) => void): void {
  for (const [key, reference] of Object.entries(references)) {
    const parsed = parseWorkflowShape(reference)
    if (!parsed.ok) continue
    for (const node of parsed.workflow.nodes) {
      if (JSON.stringify(extractRefs(node.config)) !== JSON.stringify(dslExtractRefs(node.config))) {
        report(key, `extractRefs differs from the real one on node ${node.id}`)
      }
    }
  }
  const allowed = [`${HOME_DIR}/Receipts`]
  const probes = [
    `${HOME_DIR}/Receipts/a.csv`,
    `${HOME_DIR}/Receipts`,
    `${HOME_DIR}/Receipts2/a.csv`,
    `${HOME_DIR}/Receipts/../x.csv`,
    '/etc/passwd',
    'relative/x.csv',
    `${HOME_DIR}/Documents/x.csv`,
  ]
  for (const path of probes) {
    let real = true
    try {
      assertPathAllowed(path, allowed)
    } catch {
      real = false
    }
    const workflow: Workflow = { schemaVersion: 1, name: 'x', nodes: [{ id: 'n1', type: 'csv.append@1', config: { file: path, row: ['x'] } }], edges: [] }
    const mine = evaluateAssertions([{ check: 'pathInsideAllowedFolders' }], workflow, { allowedFolders: allowed })[0]?.ok === true
    if (real !== mine) report('assertions', `pathInsideAllowedFolders disagrees with the real path guard on ${path} (real ${real}, mine ${mine})`)
  }
}

export function checkConsistency(input: ConsistencyInput): ConsistencyResult {
  const problems: string[] = []
  const report = (where: string, message: string): void => {
    problems.push(`${where}: ${message}`)
  }
  const shape = schemaProblems(casesSchema, input.cases)
  if (shape.length > 0) return { problems: shape.map((problem) => `cases.json: ${problem}`), summary: undefined }
  const cases = input.cases as CaseSpec[]
  const referenceShape = isObj(input.references) ? [] : ['references.json: must be an object']
  if (referenceShape.length > 0) return { problems: referenceShape, summary: undefined }
  const references = input.references as Record<string, unknown>
  if (!Value.Check(referencesSchema, references)) {
    for (const [key, reference] of Object.entries(references)) {
      const parsed = parseWorkflowShape(reference)
      if (!parsed.ok) for (const message of parsed.errors) report(`${key}.reference`, `shape: ${message}`)
    }
  }

  const ids = new Set<string>()
  for (const testCase of cases) {
    if (ids.has(testCase.id)) report(testCase.id, 'duplicate id')
    ids.add(testCase.id)
    checkCase(input, testCase, report)
  }
  checkCounts(cases, report)
  checkVocabulary(input, cases, report)
  const covered = checkReferences(input, cases, references, report)
  for (const testCase of cases) {
    guarded(report, testCase.id, () => checkMutation(testCase, references, report))
    guarded(report, testCase.id, () => checkMachinery(testCase, report))
  }
  checkParity(references, report)

  const catalog = input.registry.list().map((def) => def.type)
  const { summary } = tally(cases)
  return {
    problems,
    summary: {
      ...summary,
      references: Object.keys(references).length,
      coveredTypes: [...covered].sort(),
      unusedTypes: catalog.filter((type) => !covered.has(type)),
    },
  }
}
