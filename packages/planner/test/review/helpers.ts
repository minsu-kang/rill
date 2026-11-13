import type { Workflow } from '@rill/dsl'
import type { LlmProvider } from '@rill/llm'
import { createReviewer, type PlanAgent, type ReviewRequest, type ReviewResult } from '../../src/index'
import { chain, registry } from '../explain/helpers'
import { FakeProvider, type Step } from '../fake-provider'

export { chain, edge, node, registry, workflowOf } from '../explain/helpers'

export const MODEL_MARKER = 'MODEL-TEXT-MARKER-5a3e'
export const REQUEST_TEXT = 'Every morning fetch the orders and append their status to my ledger'
export const TAG = (block: string) => new RegExp(`<review-${block}-([0-9a-f]{12})>`)

export const GOOD = {
  summary: 'The workflow fetches the orders and appends their status to the ledger.',
  findings: [{ severity: 'info', text: 'Node n1 asks the orders service once per run.', nodeId: 'n1' }],
}

export function reviewerAgent(overrides: Partial<PlanAgent> = {}): PlanAgent {
  return { id: 'reviewer-1', name: 'Careful reviewer', persona: '', instructions: '', ...overrides }
}

export function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return { workflow: chain(), requestText: REQUEST_TEXT, flags: [], agent: reviewerAgent(), ...overrides }
}

export function reviewer(steps: Step[], options: { name?: string } = {}) {
  const provider = new FakeProvider(steps, options)
  return { provider, reviewer: createReviewer({ provider, registry }) }
}

export function reviewerOf(provider: LlmProvider, randomHex?: (bytes: number) => string) {
  return createReviewer({ provider, registry, ...(randomHex === undefined ? {} : { randomHex }) })
}

export function userText(provider: FakeProvider, call = 0): string {
  const content = provider.calls[call]!.request.messages[0]!.content
  return typeof content === 'string' ? content : content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
}

export function block(text: string, name: string): string {
  const tag = TAG(name).exec(text)?.[1]
  if (tag === undefined) throw new Error(`no block ${name}`)
  const open = `<review-${name}-${tag}>\n`
  const start = text.indexOf(open) + open.length
  return text.slice(start, text.indexOf(`\n</review-${name}-${tag}>`))
}

export async function reviewWith(data: unknown, overrides: Partial<ReviewRequest> = {}, workflow?: Workflow): Promise<ReviewResult> {
  const { reviewer: instance } = reviewer([{ data }])
  return instance.review(reviewRequest({ ...(workflow === undefined ? {} : { workflow }), ...overrides }))
}
