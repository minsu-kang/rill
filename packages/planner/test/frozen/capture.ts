import { createHash } from 'node:crypto'
import { ANTHROPIC_CAPABILITIES, type LlmCapabilities, type LlmRequest } from '@rill/llm'
import { ROOT } from '../fixtures'
import { createAttachmentModule, createExplainer, createPlanner, catalogText, encodeGeneration, type PlanRequest, type PlanTurn } from '../../src/index'
import { countingStore, enc } from '../integration/helpers'
import { FakeProvider, type Step } from '../fake-provider'
import { inputOf, runOf, step } from '../explain/helpers'
import { receipts, ref, registry, request, workflowData } from '../fixtures'

const HEX = '0123456789ab'
const NOTES = ['My receipts live in /rill-planner-test-root/Receipts', 'Alerts go to the connection team']

const store = countingStore({ a1: enc('Receipt 1\nTotal 12.50') })
const history: PlanTurn[] = [
  { role: 'user', text: 'this is a sample', attachments: [{ id: 'a1', mediaType: 'text/plain', name: 'a1.txt', bytes: 20 }] },
  { role: 'assistant', text: 'ok' },
]

function caps(overrides: Partial<LlmCapabilities>, dropMax = false): LlmCapabilities {
  const result: LlmCapabilities = { ...ANTHROPIC_CAPABILITIES, ...overrides }
  if (dropMax) delete result.maxCacheBreakpoints
  return result
}

function withMemory(overrides: Partial<PlanRequest> = {}): PlanRequest {
  const base = request()
  return request({ context: { ...base.context, memory: NOTES }, ...overrides })
}

export type Scenario = { name: string; run(): Promise<unknown> }

export function normalise(call: { request: LlmRequest }): unknown {
  const catalog = catalogText(registry)
  const { system, ...withSchema } = call.request
  const rest: Partial<typeof withSchema> = { ...withSchema }
  delete rest.schema
  return {
    ...rest,
    system: typeof system === 'string' || system === undefined ? system : system.map((block) => (block.text === catalog ? { ...block, text: '<catalog>' } : block)),
  }
}

async function plan(steps: Step[], planRequest: PlanRequest, options: { capabilities?: LlmCapabilities; attachments?: boolean } = {}): Promise<unknown> {
  const provider = new FakeProvider(steps, options.capabilities === undefined ? {} : { capabilities: options.capabilities })
  const attachments = createAttachmentModule({ randomHex: () => HEX })
  await createPlanner({ provider, registry, attachments, attachmentStore: store }).plan(planRequest)
  return provider.calls.map(normalise)
}

const OK: Step = { data: workflowData(receipts()) }

function outside(): unknown {
  const bad = receipts()
  bad.nodes[2]!.config = { file: '/elsewhere/ledger.csv', row: ['{{n1.output.date}}'] }
  return workflowData(bad)
}

function withDelay(): unknown {
  const workflow = receipts()
  workflow.nodes.push({ id: 'n3', type: 'delay@1', config: { ms: 'soon' } })
  workflow.edges.push({ from: 'n2', to: 'n3' })
  return workflowData(workflow)
}

function patchData(): unknown {
  return encodeGeneration({
    kind: 'workflow',
    workflow: receipts(),
    summary: 'Changed',
    patch: [{ op: 'set_config', nodeId: 'n2', config: { file: `${ROOT}/b.csv`, row: ['{{n1.output.amount}}'] } }],
    flags: [],
    needsConfirmation: false,
  })
}

export const SCENARIOS: Scenario[] = [
  { name: 'plain', run: () => plan([OK], request()) },
  { name: 'attachment', run: () => plan([OK], request({ attachments: [ref('a1')] })) },
  { name: 'history with an attachment turn', run: () => plan([OK], request({ turns: history, attachments: [ref('a1')] })) },
  { name: 'memory', run: () => plan([OK], withMemory()) },
  { name: 'memory and attachment', run: () => plan([OK], withMemory({ attachments: [ref('a1')] })) },
  { name: 'memory, history with an attachment turn, two breakpoints at most', run: () => plan([OK], withMemory({ turns: history, attachments: [ref('a1')] }), { capabilities: caps({ maxCacheBreakpoints: 2 }) }) },
  { name: 'memory, three breakpoints at most, history with an attachment turn', run: () => plan([OK], withMemory({ turns: history }), { capabilities: caps({ maxCacheBreakpoints: 3 }) }) },
  { name: 'memory, automatic cache', run: () => plan([OK], withMemory(), { capabilities: caps({ cache: 'automatic' }, true) }) },
  { name: 'memory, no cache', run: () => plan([OK], withMemory(), { capabilities: caps({ cache: 'none' }, true) }) },
  { name: 'memory, explicit cache without a maximum', run: () => plan([OK], withMemory(), { capabilities: caps({}, true) }) },
  { name: 'repair round', run: () => plan([{ data: outside() }, OK], request()) },
  { name: 'repair round with memory and attachment', run: () => plan([{ data: outside() }, OK], withMemory({ attachments: [ref('a1')] })) },
  { name: 'targeted repair with memory', run: () => plan([{ data: withDelay() }, { data: { ms: 1000 } }], withMemory()) },
  {
    name: 'patch mode',
    run: () => plan([{ data: patchData() }], request({ text: 'change it', selection: { nodeId: 'n2' }, context: { ...request().context, existingWorkflow: receipts() } })),
  },
]

export async function captureExplain(): Promise<unknown> {
  const provider = new FakeProvider([
    { data: { explanation: 'bad' } },
    { data: { explanation: 'The service rejected the request of node n1.', likelyCause: 'external_service', suggestedActions: ['wait_and_retry'] } },
  ])
  await createExplainer({ provider, registry, randomHex: () => HEX }).explain(
    inputOf({ run: runOf({ error: 'node n1 failed: HTTP 500' }), steps: [step('n1', 'failed', { error: 'HTTP 500' })] }),
  )
  return provider.calls.map((call) => ({ system: call.request.system, messages: call.request.messages, maxTokens: call.request.maxTokens, effort: call.request.effort }))
}

export async function captureAll(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const scenario of SCENARIOS) {
    result[scenario.name] = await scenario.run()
  }
  result['explain with a repair call'] = await captureExplain()
  return result
}

export interface Frozen {
  texts: Record<string, string>
  scenarios: Record<string, unknown>
}

const LONG = 400

export function intern(value: unknown, texts: Record<string, string>): unknown {
  if (typeof value === 'string') {
    if (value.length <= LONG) return value
    const id = createHash('sha1').update(value).digest('hex').slice(0, 12)
    texts[id] = value
    return { $text: id }
  }
  if (Array.isArray(value)) return value.map((item) => intern(item, texts))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, intern(item, texts)]))
  return value
}

export async function captureFrozen(): Promise<Frozen> {
  const texts: Record<string, string> = {}
  const scenarios = intern(await captureAll(), texts) as Record<string, unknown>
  return { texts: Object.fromEntries(Object.entries(texts).sort(([a], [b]) => (a < b ? -1 : 1))), scenarios }
}
