import type { Workflow } from '@rill/dsl'
import { LlmError, type LlmCallOptions, type LlmProvider, type LlmRequest, type LlmResult, type LlmUsage } from '@rill/llm'
import { encodeGeneration, encodePatchOp, type Envelope, type PatchOp } from '@rill/planner'
import { createRecorder, type EvalProvider } from '../src/record'
import type { PlannerCase } from '../src/suites/planner/cases'
import { goldBody } from '../src/suites/planner/fakes'

export const SONNET = 'claude-sonnet-5-5'

export function usage(partial: Partial<LlmUsage> = {}): LlmUsage {
  return { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...partial }
}

export function resultOf(data: unknown, model = SONNET): LlmResult {
  return { data, usage: usage(), model, requestedModel: SONNET, stopReason: 'end_turn', durationMs: 5, fallbackUsed: false, servedModels: [model] }
}

export function requestText(request: LlmRequest): string {
  return request.messages
    .map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n')))
    .join('\n')
}

export function systemTextOf(system: LlmRequest['system'] | { text: string }[] | undefined): string {
  if (system === undefined) return ''
  return typeof system === 'string' ? system : system.map((block) => block.text).join('\n')
}

export function pickCase(cases: readonly PlannerCase[], userText: string, systemText: string): PlannerCase | undefined {
  const notesOf = (testCase: PlannerCase): readonly string[] => testCase.spec.context.memory ?? []
  return cases
    .filter((testCase) => userText.includes(`Request:\n${testCase.prompt}`) && notesOf(testCase).every((note) => systemText.includes(note)))
    .sort((a, b) => b.prompt.length - a.prompt.length || notesOf(b).length - notesOf(a).length)[0]
}

export function caseOfRequest(request: LlmRequest, cases: readonly PlannerCase[]): PlannerCase {
  const hit = pickCase(cases, requestText(request), systemTextOf(request.system))
  if (hit === undefined) throw new Error('no planner case matches this request')
  return hit
}

function typeChanged(before: Workflow['nodes'][number], after: Workflow['nodes'][number]): boolean {
  return JSON.stringify([before.retry, before.onError]) !== JSON.stringify([after.retry, after.onError])
}

export function goldPatch(existing: Workflow, gold: Workflow): PatchOp[] {
  const ops: PatchOp[] = []
  const goldIds = new Set(gold.nodes.map((node) => node.id))
  const redone = new Set<string>()
  for (const before of existing.nodes) {
    const after = gold.nodes.find((node) => node.id === before.id)
    if (after !== undefined && typeChanged(before, after)) redone.add(before.id)
  }
  const edgeKey = (edge: { from: string; to: string }): string => `${edge.from}>${edge.to}`
  const removed = new Set([...existing.nodes.filter((node) => !goldIds.has(node.id)).map((node) => node.id), ...redone])
  for (const id of removed) ops.push({ op: 'remove_node', nodeId: id })
  const survivingEdges = existing.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to))
  for (const node of gold.nodes) {
    const before = existing.nodes.find((candidate) => candidate.id === node.id)
    if (before === undefined || redone.has(node.id)) ops.push({ op: 'add_node', node: structuredClone(node) })
    else if (JSON.stringify(before.config) !== JSON.stringify(node.config)) ops.push({ op: 'set_config', nodeId: node.id, config: structuredClone(node.config) })
  }
  const keep = new Set(survivingEdges.map(edgeKey))
  for (const edge of survivingEdges) if (!gold.edges.some((candidate) => edgeKey(candidate) === edgeKey(edge))) ops.push({ op: 'disconnect', from: edge.from, to: edge.to })
  for (const edge of gold.edges) if (!keep.has(edgeKey(edge))) ops.push({ op: 'connect', edge: { ...edge } })
  return ops
}

export function goldData(testCase: PlannerCase): Envelope {
  const body = goldBody(testCase)
  const existing = testCase.spec.context.existingWorkflow
  if (body.kind === 'workflow' && testCase.spec.context.selectedNodeId !== undefined && existing !== undefined) {
    return { kind: 'workflow', summary: body.summary, patch: goldPatch(existing, body.workflow).map(encodePatchOp) }
  }
  return encodeGeneration(body)
}

export interface Seen {
  request: LlmRequest
  options: LlmCallOptions | undefined
}

export interface Scripted extends LlmProvider {
  seen: Seen[]
}

export function scripted(respond: (request: LlmRequest, nth: number) => unknown): Scripted {
  const seen: Seen[] = []
  return {
    name: 'scripted',
    seen,
    generate: async (request, options) => {
      seen.push({ request: structuredClone(request), options: options === undefined ? undefined : { ...options } })
      const out = await respond(request, seen.length)
      if (out instanceof Error) throw out
      return resultOf(out)
    },
  }
}

export function oracleProvider(cases: readonly PlannerCase[]): Scripted {
  return scripted((request) => goldData(caseOfRequest(request, cases)))
}

export function refusalProvider(): Scripted {
  return scripted(() => new LlmError('refusal', 'the model declined to answer'))
}

export function evalProviderOf(provider: LlmProvider): EvalProvider {
  const refuse = (): Promise<never> => Promise.reject(new Error('no network in this test'))
  return { provider, recorder: createRecorder(refuse) }
}

export interface HttpBody {
  model: string
  max_tokens: number
  system?: { type: string; text: string; cache_control?: unknown }[] | string
  messages: { role: string; content: string | { type: string; text?: string; source?: { media_type: string; data: string }; cache_control?: unknown }[] }[]
  output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } }
  cache_control?: unknown
}

export interface HttpOracle {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  bodies: HttpBody[]
}

export function httpOracle(cases: readonly PlannerCase[], reply: { inputTokens?: number; outputTokens?: number } = {}): HttpOracle {
  const bodies: HttpBody[] = []
  return {
    bodies,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as HttpBody
      bodies.push(body)
      const text = body.messages
        .map((message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => block.text ?? '').join('\n')))
        .join('\n')
      const testCase = pickCase(cases, text, systemTextOf(body.system))
      if (testCase === undefined) throw new Error('no planner case matches this http request')
      const payload = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(goldData(testCase)) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: reply.inputTokens ?? 5000, output_tokens: reply.outputTokens ?? 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `req_${bodies.length}` } })
    },
  }
}
