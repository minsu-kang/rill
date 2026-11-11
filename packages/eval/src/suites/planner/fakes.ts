import type { Workflow, WorkflowNode } from '@rill/dsl'
import { PlanError, type Flag, type PlanResult, type PlanResultBody, type PlanRound } from '@rill/planner'
import { evaluateAssertions, expandHome, literalPaths } from './assertions'
import { ERROR_ISSUE, fakeResult, fakeRound, questionsBody, unsupportedBody, workflowBody } from './fake-results'
import type { PlannerCase } from './cases'
import { injectionNeedles } from './injection'
import type { PlannerFactory } from './suite'
import type { Assertion, AssertionName, ExpectationBlock } from './schema'

const first = (entry: string | readonly string[]): string => (typeof entry === 'string' ? entry : (entry[0] ?? ''))

export function goldQuestionTexts(block: Extract<ExpectationBlock, { outcome: 'questions' }>): string[] {
  const slots = Math.max(1, Math.min(block.maxQuestions, block.mustAskAbout.length))
  const texts: string[][] = Array.from({ length: slots }, () => [])
  block.mustAskAbout.forEach((entry, index) => texts[index % slots]?.push(first(entry)))
  return texts.map((parts) => `${parts.join(' / ')}?`)
}

export function goldBody(testCase: PlannerCase): PlanResultBody {
  const block = testCase.expected
  if (block.outcome === 'workflow') {
    const workflow = testCase.references[0]
    if (workflow === undefined) throw new Error(`${testCase.id} has no gold workflow`)
    return workflowBody(structuredClone(workflow))
  }
  if (block.outcome === 'questions') return questionsBody(goldQuestionTexts(block))
  return unsupportedBody(block.mustMention.map(first).join(' / '))
}

const fixed =
  (build: (testCase: PlannerCase) => PlanResult): PlannerFactory =>
  ({ testCase }) => ({ plan: () => Promise.resolve(build(testCase)) })

export const oraclePlanner: PlannerFactory = fixed((testCase) => fakeResult(goldBody(testCase)))

export const nullPlanner: PlannerFactory = fixed(() => fakeResult(unsupportedBody('nothing is supported')))

export const alwaysAsksPlanner: PlannerFactory = fixed(() => fakeResult(questionsBody(['Could you tell me a little more about what you want?'])))

const GUESS: Workflow = {
  schemaVersion: 1,
  name: 'guess',
  nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
  edges: [],
}

export const neverAsksPlanner: PlannerFactory = fixed((testCase) =>
  fakeResult(testCase.expected.outcome === 'workflow' ? goldBody(testCase) : workflowBody(structuredClone(GUESS))),
)

export function withRounds(rounds: PlanRound[], base: PlannerFactory = oraclePlanner): PlannerFactory {
  return (input) => ({ plan: async (request) => ({ ...(await base(input).plan(request)), rounds }) })
}

export function throwingPlanner(error: (testCase: PlannerCase) => Error): PlannerFactory {
  return ({ testCase }) => ({ plan: () => Promise.reject(error(testCase)) })
}

export const invalidAfterRepairPlanner = throwingPlanner(
  () => new PlanError('invalid_after_repair', 'no valid workflow after 3 repairs', [fakeRound(0, [ERROR_ISSUE]), fakeRound(1, [ERROR_ISSUE]), fakeRound(2, [ERROR_ISSUE]), fakeRound(3, [ERROR_ISSUE])], [ERROR_ISSUE]),
)

let extraId = 0
const nextId = (): string => `zz${(extraId += 1)}`

function clone(workflow: Workflow): Workflow {
  return structuredClone(workflow)
}

function withNode(workflow: Workflow, node: WorkflowNode): Workflow {
  const copy = clone(workflow)
  copy.nodes.push(node)
  return copy
}

function typeOf(workflow: Workflow, id: string): string | undefined {
  return workflow.nodes.find((node) => node.id === id)?.type
}

function hasNodeBreak(workflow: Workflow, target: Extract<Assertion, { check: 'hasNode' }>): Workflow {
  const copy = clone(workflow)
  const key = Object.keys(target.config ?? {})[0]
  if (key === undefined && target.onError === undefined) {
    const gone = new Set(copy.nodes.filter((node) => node.type === target.type).map((node) => node.id))
    copy.nodes = copy.nodes.filter((node) => !gone.has(node.id))
    copy.edges = copy.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to))
    return copy
  }
  for (const node of copy.nodes.filter((candidate) => candidate.type === target.type)) {
    if (key !== undefined) node.config[key] = '__perturbed__'
    else node.onError = target.onError === 'fail' ? 'continue' : 'fail'
  }
  return copy
}

function templateStripper(fromIds: ReadonlySet<string>): (value: unknown) => unknown {
  const strip = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{\{\s*([a-z][a-z0-9_]*)\.output[A-Za-z0-9_.-]*\s*\}\}/g, (whole, id: string) => (fromIds.has(id) ? 'x' : whole))
    }
    if (Array.isArray(value)) return value.map(strip)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]))
    return value
  }
  return strip
}

export const PERTURBATIONS: { [N in AssertionName]: (workflow: Workflow, target: Extract<Assertion, { check: N }>) => Workflow } = {
  hasTrigger: (workflow) => withNode(workflow, { id: nextId(), type: 'trigger.manual@1', config: {} }),
  hasNode: hasNodeBreak,
  hasNodeCount: (workflow, target) => {
    const count = workflow.nodes.filter((node) => node.type === target.type).length
    let copy = workflow
    for (let index = 0; index < Math.max(1, target.max - count + 1); index += 1) copy = withNode(copy, { id: nextId(), type: target.type, config: {} })
    return copy
  },
  hasEdge: (workflow, target) => {
    const copy = clone(workflow)
    copy.edges = copy.edges.filter(
      (edge) => !(typeOf(copy, edge.from) === target.fromType && typeOf(copy, edge.to) === target.toType && (target.when === undefined || edge.when === target.when)),
    )
    return copy
  },
  orderedBefore: (workflow, target) => {
    const copy = clone(workflow)
    const sources = new Set(copy.nodes.filter((node) => node.type === target.typeA).map((node) => node.id))
    copy.edges = copy.edges.filter((edge) => !sources.has(edge.from))
    return copy
  },
  extractsFields: (workflow) => {
    const copy = clone(workflow)
    for (const node of copy.nodes.filter((candidate) => candidate.type === 'llm.extract@1')) {
      const fields = node.config['fields']
      if (Array.isArray(fields)) node.config['fields'] = fields.map((field: { name?: string }, index) => ({ ...field, name: `zzfield${index}` }))
    }
    return copy
  },
  noNodeOutsideCatalog: (workflow) => withNode(workflow, { id: nextId(), type: 'notion.createPage@1', config: {} }),
  noSecretLiteral: (workflow, target) => {
    const copy = clone(workflow)
    const node = copy.nodes.find((candidate) => !candidate.type.startsWith('trigger.')) ?? copy.nodes[0]
    if (node !== undefined) node.config['password'] = target.literals?.[0] ?? 'hunter2hunter2'
    return copy
  },
  pathInsideAllowedFolders: (workflow) => {
    const copy = clone(workflow)
    const literal = literalPaths(copy).find((path) => !path.value.includes('{{'))
    const node = copy.nodes.find((candidate) => candidate.id === literal?.id)
    if (node !== undefined && literal !== undefined) node.config[literal.key] = '/etc/outside.csv'
    return copy
  },
  usesConnection: (workflow, target) => {
    const copy = clone(workflow)
    for (const node of copy.nodes) {
      if (node.config['connection'] === target.name) node.config['connection'] = 'other-connection'
      const auth = node.config['auth']
      if (auth !== null && typeof auth === 'object' && (auth as { connection?: unknown }).connection === target.name) (auth as { connection: string }).connection = 'other-connection'
      if (node.config['secretConnection'] === target.name) node.config['secretConnection'] = 'other-connection'
    }
    return copy
  },
  hasRetry: (workflow, target) => {
    const copy = clone(workflow)
    for (const node of copy.nodes.filter((candidate) => candidate.type === target.nodeType)) delete node.retry
    return copy
  },
  referencesOutputOf: (workflow, target) => {
    const copy = clone(workflow)
    const from = new Set(copy.nodes.filter((node) => node.type === target.fromType).map((node) => node.id))
    const strip = templateStripper(from)
    for (const node of copy.nodes.filter((candidate) => candidate.type === target.toType)) node.config = strip(node.config) as Record<string, unknown>
    return copy
  },
}

export function perturb(workflow: Workflow, target: Assertion): Workflow {
  const apply = PERTURBATIONS[target.check] as (workflow: Workflow, target: Assertion) => Workflow
  return apply(workflow, target)
}

export function perturbedPlanner(check: AssertionName): PlannerFactory {
  return ({ testCase }) => ({
    plan: () => {
      const body = goldBody(testCase)
      const block = testCase.expected
      if (body.kind !== 'workflow' || block.outcome !== 'workflow') return Promise.resolve(fakeResult(body))
      const target = block.assertions.find((assertion) => assertion.check === check)
      return Promise.resolve(fakeResult(target === undefined ? body : workflowBody(perturb(body.workflow, target))))
    },
  })
}

export function failingAssertions(testCase: PlannerCase, workflow: Workflow): Assertion[] {
  const block = testCase.expected
  if (block.outcome !== 'workflow') return []
  return evaluateAssertions(block.assertions, workflow, { allowedFolders: testCase.spec.context.allowedFolders })
    .filter((result) => !result.ok)
    .map((result) => result.assertion as Assertion)
}

export function injectedNodes(testCase: PlannerCase): WorkflowNode[] {
  const nodes: WorkflowNode[] = []
  for (const attachment of testCase.spec.context.attachments ?? []) {
    if (attachment.inject === undefined) continue
    for (const needle of injectionNeedles(attachment.inject)) {
      if (needle.startsWith('/')) nodes.push({ id: nextId(), type: 'file.read@1', config: { path: expandHome(needle) } })
      else nodes.push({ id: nextId(), type: 'http.request@1', config: { url: `https://${needle}/upload`, method: 'POST', body: '{{n1.output}}' } })
    }
  }
  return nodes
}

export function copyingPlanner(options: { flag: boolean; needsConfirmation?: boolean } = { flag: false }): PlannerFactory {
  return ({ testCase }) => ({
    plan: () => {
      const body = goldBody(testCase)
      const added = injectedNodes(testCase)
      if (body.kind !== 'workflow' || added.length === 0) return Promise.resolve(fakeResult(body))
      const workflow = clone(body.workflow)
      const last = workflow.nodes[workflow.nodes.length - 1]
      for (const node of added) {
        workflow.nodes.push(node)
        if (last !== undefined) workflow.edges.push({ from: last.id, to: node.id })
      }
      const flags: Flag[] = options.flag
        ? added.map((node) => ({ nodeId: node.id, pointer: `/nodes/${workflow.nodes.indexOf(node)}/config`, code: 'attachment_origin', message: 'taken from the attachment' }))
        : []
      return Promise.resolve(fakeResult(workflowBody(workflow, flags, options.needsConfirmation ?? options.flag)))
    },
  })
}
