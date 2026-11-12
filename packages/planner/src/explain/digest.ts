import type { Workflow, WorkflowNode } from '@rill/dsl'
import type { NodeRegistry } from '@rill/nodes-core'
import { createRedactor, excerpt, oneLine, type Redactor } from './excerpt'
import { MAX_DIGEST_CHARS, isFailedLike, type ExplainRun, type ExplainRunInput, type ExplainStep, type RunDigest } from './types'

const MAX_ERROR = 500
const MAX_NAME = 200
const MAX_NODE_CONFIG = 400
const MAX_STEP_EXCERPT = 1500
const NODE_LINES_BUDGET = 3800
const EDGES_BUDGET = 700
const FOOTER_ROOM = 80

interface Grouped {
  order: string[]
  attempts: Map<string, ExplainStep[]>
}

function groupSteps(steps: readonly ExplainStep[]): Grouped {
  const attempts = new Map<string, ExplainStep[]>()
  for (const step of steps) {
    const list = attempts.get(step.nodeId)
    if (list === undefined) attempts.set(step.nodeId, [step])
    else list.push(step)
  }
  return { order: [...attempts.keys()], attempts }
}

function lastOf(grouped: Grouped, nodeId: string): ExplainStep {
  const list = grouped.attempts.get(nodeId)!
  return list[list.length - 1]!
}

function priority(workflow: Workflow, failed: readonly string[], ids: readonly string[]): string[] {
  const failedSet = new Set(failed)
  const parents = new Map<string, string[]>()
  for (const edge of workflow.edges) {
    const list = parents.get(edge.to)
    if (list === undefined) parents.set(edge.to, [edge.from])
    else list.push(edge.from)
  }
  const upstream = new Set<string>()
  for (const id of failed) for (const parent of parents.get(id) ?? []) if (!failedSet.has(parent)) upstream.add(parent)
  const inScope = ids.filter((id) => failedSet.has(id))
  const near = ids.filter((id) => upstream.has(id))
  const rest = ids.filter((id) => !failedSet.has(id) && !upstream.has(id))
  return [...inScope, ...near, ...rest]
}

function duration(from: number | null, to: number | null): string | undefined {
  return from === null || to === null ? undefined : `${Math.max(0, to - from)} ms`
}

function textOf(value: string | null, redactor: Redactor, limit: number): string {
  return redactor.cut(oneLine(redactor.string(value ?? '')), limit)
}

function runLines(run: ExplainRun, redactor: Redactor): string[] {
  const lines = ['RUN', `status: ${oneLine(run.status).slice(0, 40)}`, `dry run: ${run.dryRun ? 'yes' : 'no'}`]
  const waited = duration(run.createdAt, run.startedAt)
  if (waited !== undefined) lines.push(`waited: ${waited}`)
  const ran = duration(run.startedAt, run.finishedAt)
  if (ran !== undefined) lines.push(`ran: ${ran}`)
  lines.push(run.error === null ? 'error: none' : `error: ${textOf(run.error, redactor, MAX_ERROR)}`)
  return lines
}

function titleOf(registry: NodeRegistry, type: string): string {
  return registry.get(type)?.title ?? 'unknown node type'
}

function nodeLine(node: WorkflowNode, registry: NodeRegistry, redactor: Redactor): string {
  const config = redactor.within(excerpt(node.config, redactor), MAX_NODE_CONFIG)
  const retry = node.retry === undefined ? '' : ` retry: ${node.retry.maxAttempts} attempts`
  const onError = node.onError === undefined ? '' : ` onError: ${node.onError}`
  return `- ${oneLine(node.id)} ${oneLine(node.type)} (${titleOf(registry, node.type)}) config: ${config}${retry}${onError}`
}

interface Outline {
  lines: string[]
  omitted: boolean
}

function outlineOf(input: ExplainRunInput, redactor: Redactor, failed: readonly string[]): Outline {
  const { workflow, registry } = input
  const ids = workflow.nodes.map((node) => node.id)
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  const ordered = priority(workflow, failed.filter((id) => byId.has(id)), ids)
  const shown = new Set<string>()
  const rendered = new Map<string, string>()
  let used = 0
  for (const id of ordered) {
    const line = nodeLine(byId.get(id)!, registry, redactor)
    if (used + line.length + 1 > NODE_LINES_BUDGET) break
    used += line.length + 1
    shown.add(id)
    rendered.set(id, line)
  }
  const edges: string[] = []
  let edgeChars = 0
  for (const edge of workflow.edges) {
    if (!shown.has(edge.from) || !shown.has(edge.to)) continue
    const text = `${oneLine(edge.from).slice(0, 64)}->${oneLine(edge.to).slice(0, 64)}${edge.when === undefined ? '' : ` [${oneLine(edge.when).slice(0, 64)}]`}`
    if (edgeChars + text.length + 2 > EDGES_BUDGET) break
    edges.push(text)
    edgeChars += text.length + 2
  }
  const lines = [`WORKFLOW ${textOf(workflow.name, redactor, MAX_NAME)}`]
  for (const node of workflow.nodes) {
    const line = rendered.get(node.id)
    if (line !== undefined) lines.push(line)
  }
  lines.push(`edges: ${edges.length === 0 ? 'none' : edges.join(', ')}`)
  const nodesOmitted = workflow.nodes.length - shown.size
  const edgesOmitted = workflow.edges.length - edges.length
  const omitted = nodesOmitted > 0 || edgesOmitted > 0
  if (omitted) lines.push(`outline omitted: ${nodesOmitted} nodes, ${edgesOmitted} edges`)
  return { lines, omitted }
}

function excerptPair(step: ExplainStep, responseHeaders: boolean, redactor: Redactor): { input: string; output: string } {
  const input = excerpt(step.input, redactor)
  const output = excerpt(step.output, redactor, { responseHeaders })
  if (input.length + output.length <= MAX_STEP_EXCERPT) return { input, output }
  const half = MAX_STEP_EXCERPT / 2
  if (input.length <= half) return { input, output: redactor.within(output, MAX_STEP_EXCERPT - input.length) }
  if (output.length <= half) return { input: redactor.within(input, MAX_STEP_EXCERPT - output.length), output }
  return { input: redactor.within(input, half), output: redactor.within(output, half) }
}

function stepBlock(id: string, grouped: Grouped, byId: Map<string, WorkflowNode>, registry: NodeRegistry, redactor: Redactor): string {
  const attempts = grouped.attempts.get(id)!
  const last = lastOf(grouped, id)
  const node = byId.get(id)
  const type = node?.type ?? 'unknown'
  const took = duration(last.startedAt, last.finishedAt)
  const noun = attempts.length === 1 ? 'attempt' : 'attempts'
  const head = `STEP ${oneLine(id).slice(0, 64)} (${oneLine(type)}, ${node === undefined ? 'unknown node type' : titleOf(registry, type)}): ${last.status} after ${attempts.length} ${noun}${took === undefined ? '' : `, ${took}`}`
  const lines = [head]
  if (last.error !== null) lines.push(`error: ${textOf(last.error, redactor, MAX_ERROR)}`)
  const { input, output } = excerptPair(last, type.replace(/@\d+$/, '') === 'http.request', redactor)
  lines.push(`input: ${input}`, `output: ${output}`)
  return lines.join('\n')
}

export function buildRunDigest(input: ExplainRunInput): RunDigest {
  const redactor = createRedactor(input.secrets)
  const grouped = groupSteps(input.steps)
  const failedNodeIds = grouped.order.filter((id) => isFailedLike(lastOf(grouped, id).status))
  const byId = new Map(input.workflow.nodes.map((node) => [node.id, node]))
  const outline = outlineOf(input, redactor, failedNodeIds)
  const head = redactor.seal([runLines(input.run, redactor).join('\n'), outline.lines.join('\n'), 'STEPS'].join('\n\n'))
  const order = priority(input.workflow, failedNodeIds, grouped.order)
  const blocks: string[] = []
  let used = head.length + 1
  for (const id of order) {
    const block = redactor.seal(stepBlock(id, grouped, byId, input.registry, redactor))
    if (used + block.length + 2 > MAX_DIGEST_CHARS - FOOTER_ROOM) break
    blocks.push(block)
    used += block.length + 2
  }
  const omittedSteps = order.length - blocks.length
  const body = order.length === 0 ? 'no steps were recorded' : blocks.join('\n\n')
  const footer = omittedSteps > 0 ? `\n\nomitted: ${omittedSteps} steps` : ''
  const text = redactor.seal(`${head}\n${body}${footer}`)
  return { text, chars: text.length, omittedSteps, truncated: omittedSteps > 0 || outline.omitted, failedNodeIds }
}
