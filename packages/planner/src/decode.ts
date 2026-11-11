import { joinPointer, sortIssues, type PlanIssue, type Workflow } from '@rill/dsl'
import { validateWorkflow, type NodeRegistry } from '@rill/nodes-core'
import { connectionKindIssues } from './connections'
import { checkEnvelope, memberIssues, workflowFromEnvelope, type Envelope, type GenerationMode } from './generation'
import { hiddenFieldIssues, type ConfigSite } from './hidden'
import { applyPatch, decodePatchOps, labelIssuesForPatch, touchedOutsideSelection } from './patch'
import { MAX_QUESTION_TURNS, normalizeQuestions } from './questions'
import type { PatchOp, PlanContext, PlanResultBody } from './types'

export interface DecodeContext {
  registry: NodeRegistry
  context: PlanContext
  mode?: GenerationMode
  allowQuestions?: boolean
  selection?: string
}

export interface Decoded {
  envelope?: Envelope
  workflow?: Workflow
  patch?: PatchOp[]
  body?: PlanResultBody
  issues: PlanIssue[]
}

export function hasExternalNode(workflow: Workflow, registry: NodeRegistry): boolean {
  return workflow.nodes.some((node) => {
    const def = registry.get(node.type)
    return def?.kind === 'action' && def.sideEffect === 'external'
  })
}

export function checkWorkflow(workflow: Workflow, ctx: DecodeContext, sites: readonly ConfigSite[]): PlanIssue[] {
  const issues = [
    ...hiddenFieldIssues(sites, ctx.registry),
    ...validateWorkflow(workflow, {
      registry: ctx.registry,
      allowedRoots: ctx.context.allowedRoots,
      connections: ctx.context.connections.map((connection) => connection.name),
    }),
    ...connectionKindIssues(workflow, ctx.registry, ctx.context.connections),
  ]
  return sortIssues(issues)
}

export function nodeSites(workflow: Workflow): ConfigSite[] {
  return workflow.nodes.map((node, index) => ({ type: node.type, config: node.config, pointer: joinPointer('/nodes', index, 'config'), nodeId: node.id }))
}

function patchSites(ops: readonly PatchOp[], existing: Workflow): ConfigSite[] {
  const sites: ConfigSite[] = []
  ops.forEach((op, index) => {
    const pointer = joinPointer('/patch', index, 'config')
    if (op.op === 'add_node') sites.push({ type: op.node.type, config: op.node.config, pointer, nodeId: op.node.id })
    if (op.op === 'set_config') {
      const type = existing.nodes.find((node) => node.id === op.nodeId)?.type
      if (type !== undefined) sites.push({ type, config: op.config, pointer, nodeId: op.nodeId })
    }
  })
  return sites
}

export function alsoChangedSummary(summary: string, ids: readonly string[]): string {
  if (ids.length === 0) return summary
  const line = `Also changed: ${ids.join(', ')}.`
  return summary.endsWith(line) ? summary : summary === '' ? line : `${summary}\n${line}`
}

export function workflowBody(workflow: Workflow, summary: string, registry: NodeRegistry, patch?: PatchOp[]): PlanResultBody {
  return {
    kind: 'workflow',
    workflow,
    summary,
    ...(patch === undefined ? {} : { patch }),
    flags: [],
    needsConfirmation: hasExternalNode(workflow, registry),
  }
}

export function decodePatched(ops: PatchOp[], summary: string, ctx: DecodeContext): Omit<Decoded, 'envelope'> {
  const existing = ctx.context.existingWorkflow
  if (existing === undefined) {
    return { issues: [{ stage: 1, pointer: '/patch', code: 'patch_without_workflow', message: 'there is no existing workflow to patch' }] }
  }
  const applied = applyPatch(existing, ops, ctx.registry)
  const validated = labelIssuesForPatch(checkWorkflow(applied.workflow, ctx, []), applied.workflow)
  const issues = sortIssues([...hiddenFieldIssues(patchSites(ops, existing), ctx.registry), ...applied.issues, ...validated])
  const touched = ctx.selection === undefined ? [] : touchedOutsideSelection(ops, existing, ctx.selection)
  const body = workflowBody(applied.workflow, alsoChangedSummary(summary, touched), ctx.registry, ops)
  return { workflow: applied.workflow, patch: ops, body, issues }
}

export function decodeGeneration(data: unknown, ctx: DecodeContext): Decoded {
  const mode = ctx.mode ?? 'create'
  const allowQuestions = ctx.allowQuestions ?? true
  if (!allowQuestions && (data as { kind?: unknown } | null)?.kind === 'questions') {
    return {
      issues: [
        {
          stage: 4,
          pointer: '/kind',
          code: 'questions_not_allowed',
          message: `the user already answered ${MAX_QUESTION_TURNS} rounds of questions; plan now`,
          hint: 'return kind workflow with safe defaults and name the defaults in the summary',
        },
      ],
    }
  }
  const checked = checkEnvelope(data, ctx.registry, { mode, allowQuestions })
  const envelope = checked.envelope
  if (envelope === undefined) return { issues: checked.issues }
  const missing = memberIssues(envelope, mode)
  if (missing.length > 0) return { envelope, issues: missing }
  if (envelope.kind === 'questions') {
    const { questions, issues } = normalizeQuestions(envelope.questions ?? [])
    return { envelope, body: { kind: 'questions', questions, summary: envelope.summary }, issues: sortIssues(issues) }
  }
  if (envelope.kind === 'unsupported') {
    const { reason, nearest } = envelope.unsupported!
    return { envelope, body: { kind: 'unsupported', reason, nearest, summary: envelope.summary }, issues: [] }
  }
  if (mode === 'patch') {
    const decoded = decodePatchOps(envelope.patch ?? [])
    if (decoded.issues.length > 0) return { envelope, issues: sortIssues(decoded.issues) }
    return { envelope, ...decodePatched(decoded.ops, envelope.summary, ctx) }
  }
  const parsed = workflowFromEnvelope(envelope.workflow!)
  if (parsed.workflow === undefined) return { envelope, issues: sortIssues(parsed.issues) }
  const workflow = parsed.workflow
  return {
    envelope,
    workflow,
    body: workflowBody(workflow, envelope.summary, ctx.registry),
    issues: checkWorkflow(workflow, ctx, nodeSites(workflow)),
  }
}
