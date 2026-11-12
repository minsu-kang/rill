import { isWarningIssue } from '@rill/dsl'
import { validateWorkflow, type NodeRegistry } from '@rill/nodes-core'
import { MAX_DIGEST_CHARS, failureSignals } from '@rill/planner'
import { digestOf, explainInputOf } from './cases'
import { EXPLAIN_DRAFT_SIZE, parseExplainDraft, type ExplainCaseSpec } from './schema'

const ALLOWED_ROOTS = ['/Users/demo']
const MIN_SECRET = 4

export interface ExplainConsistencyInput {
  draft: unknown
  registry: NodeRegistry
  approvedCaseIds: readonly string[]
}

export interface ExplainConsistency {
  problems: string[]
  summary?: { cases: number; injection: number; signals: Record<string, number> }
}

function lastFailure(spec: ExplainCaseSpec): { nodeId: string; error: string } | undefined {
  const last = new Map<string, ExplainCaseSpec['steps'][number]>()
  for (const step of spec.steps) last.set(step.nodeId, step)
  const failed = [...last.values()].filter((step) => step.status === 'failed')
  const step = failed[failed.length - 1]
  return step === undefined ? undefined : { nodeId: step.nodeId, error: step.error ?? '' }
}

function checkCase(spec: ExplainCaseSpec, index: number, input: ExplainConsistencyInput, add: (text: string) => void): void {
  const { registry } = input
  const prefix = `explain-${String(index + 1).padStart(2, '0')}-`
  if (!spec.id.startsWith(prefix)) add(`${spec.id}: id must start with ${prefix}`)
  if (input.approvedCaseIds.includes(spec.id)) add(`${spec.id}: is an id of the approved suite`)

  const issues = validateWorkflow(spec.workflow, { registry, allowedRoots: ALLOWED_ROOTS }).filter((issue) => !isWarningIssue(issue))
  if (issues.length > 0) add(`${spec.id}: workflow is not valid: ${issues.map((issue) => `${issue.code} at ${issue.pointer}`).join(', ')}`)

  const nodeIds = new Set(spec.workflow.nodes.map((node) => node.id))
  for (const step of spec.steps) if (!nodeIds.has(step.nodeId)) add(`${spec.id}: step of a node that is not in the workflow: ${step.nodeId}`)

  const failure = lastFailure(spec)
  if (spec.run.status === 'failed') {
    if (failure === undefined) add(`${spec.id}: a failed run needs a step that failed`)
    else if (spec.run.error !== `node ${failure.nodeId} failed: ${failure.error}`) add(`${spec.id}: run error must be "node ${failure.nodeId} failed: <the error of that step>"`)
  }

  const says = JSON.stringify(failureSignals(explainInputOf(spec, registry).steps, registry, spec.workflow))
  if (says !== JSON.stringify(spec.expect.signals)) add(`${spec.id}: failureSignals says ${says}, the case expects ${JSON.stringify(spec.expect.signals)}`)

  if (spec.expect.likelyCause.length === 0) add(`${spec.id}: likelyCause must list at least one word`)
  if (spec.expect.actions.length === 0) add(`${spec.id}: actions must list at least one word`)

  const title = failure === undefined ? undefined : registry.get(spec.workflow.nodes.find((node) => node.id === failure.nodeId)?.type ?? '')?.title
  if (spec.expect.mention.length === 0) add(`${spec.id}: mention must name the failed node`)
  for (const word of spec.expect.mention) {
    if (failure === undefined || (word !== failure.nodeId && word !== title)) add(`${spec.id}: mention must name the failed node by its id or its title, not "${word}"`)
  }

  const data = JSON.stringify({ run: spec.run, steps: spec.steps })
  const workflowText = JSON.stringify(spec.workflow)
  for (const secret of spec.secrets) {
    if (secret.length < MIN_SECRET) add(`${spec.id}: a secret is shorter than ${MIN_SECRET} characters and would not be hidden`)
    else if (!data.includes(secret)) add(`${spec.id}: a secret never occurs in the run data`)
  }

  const { injection } = spec.expect
  if ((injection !== undefined) !== (spec.tags ?? []).includes('injection')) add(`${spec.id}: only the injection case has an injection block and the injection tag`)
  if (injection !== undefined) {
    if (spec.expect.likelyCause.includes('unknown')) add(`${spec.id}: the injection case must not accept unknown as the cause`)
    for (const needle of injection.needles) {
      if (!data.includes(needle)) add(`${spec.id}: needle "${needle}" is not in the run data`)
      if (workflowText.includes(needle)) add(`${spec.id}: needle "${needle}" is in the workflow, so it is not new`)
    }
  }

  const digest = digestOf(spec, registry)
  if (digest.chars > MAX_DIGEST_CHARS || digest.truncated) add(`${spec.id}: the digest is cut`)
  for (const secret of spec.secrets) if (secret.length >= MIN_SECRET && digest.text.includes(secret)) add(`${spec.id}: the digest holds a secret`)
}

export function checkExplainDraft(input: ExplainConsistencyInput): ExplainConsistency {
  let draft
  try {
    draft = parseExplainDraft(input.draft)
  } catch (error) {
    return { problems: [`explain draft: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const problems: string[] = []
  const add = (text: string): void => void problems.push(text)
  if (draft.cases.length !== EXPLAIN_DRAFT_SIZE) add(`explain draft: expected exactly ${EXPLAIN_DRAFT_SIZE} cases, found ${draft.cases.length}`)
  const seen = new Set<string>()
  for (const spec of draft.cases) {
    if (seen.has(spec.id)) add(`${spec.id}: duplicate id`)
    seen.add(spec.id)
  }
  draft.cases.forEach((spec, index) => checkCase(spec, index, input, add))
  const injection = draft.cases.filter((spec) => spec.expect.injection !== undefined).length
  if (injection !== 1) add(`explain draft: expected exactly 1 injection case, found ${injection}`)
  const signals: Record<string, number> = {}
  for (const spec of draft.cases) for (const entry of spec.expect.signals) signals[entry.signal] = (signals[entry.signal] ?? 0) + 1
  return { problems, summary: { cases: draft.cases.length, injection, signals } }
}
