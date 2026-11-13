import { ANTHROPIC_CAPABILITIES, type LlmCapabilities } from '@rill/llm'
import { createAttachmentModule, createExplainer, createPlanner, type PlanAgent, type PlanRequest, type PlanTurn } from '../../src/index'
import { countingStore, enc } from '../integration/helpers'
import { FakeProvider, type Step } from '../fake-provider'
import { inputOf, runOf, step } from '../explain/helpers'
import { receipts, ref, registry, request, workflowData } from '../fixtures'
import { intern, normalise, type Frozen } from './capture'

const HEX = '0123456789ab'
const NOTES = ['My receipts live in /rill-planner-test-root/Receipts', 'Alerts go to the connection team']

const store = countingStore({ a1: enc('Receipt 1\nTotal 12.50') })
const history: PlanTurn[] = [
  { role: 'user', text: 'this is a sample', attachments: [{ id: 'a1', mediaType: 'text/plain', name: 'a1.txt', bytes: 20 }] },
  { role: 'assistant', text: 'ok' },
]

const SKILLS = [
  { name: 'Ledger example', body: 'Example: one row per receipt,\n\nnewest last.' },
  { name: 'Receipts checklist', body: 'Ask for the folder.\nName every default you pick.' },
]

const AGENT: PlanAgent = {
  id: 'agent-1',
  name: 'Receipts helper',
  persona: 'Calm and brief.',
  instructions: 'Name every default you pick.',
  skills: SKILLS,
}

function caps(overrides: Partial<LlmCapabilities>, dropMax = false): LlmCapabilities {
  const result: LlmCapabilities = { ...ANTHROPIC_CAPABILITIES, ...overrides }
  if (dropMax) delete result.maxCacheBreakpoints
  return result
}

function withAgent(agent: PlanAgent, overrides: Partial<PlanRequest> = {}, memory?: readonly string[]): PlanRequest {
  const base = request()
  return request({ context: { ...base.context, agent, ...(memory === undefined ? {} : { memory }) }, ...overrides })
}

async function plan(steps: Step[], planRequest: PlanRequest, options: { capabilities?: LlmCapabilities } = {}): Promise<unknown> {
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

export const SKILL_SCENARIOS: Array<{ name: string; run(): Promise<unknown> }> = [
  { name: 'agent with persona, instructions and two skills', run: () => plan([OK], withAgent(AGENT)) },
  { name: 'agent with only two skills', run: () => plan([OK], withAgent({ ...AGENT, persona: '', instructions: '' })) },
  { name: 'agent with skills, memory and attachment', run: () => plan([OK], withAgent(AGENT, { attachments: [ref('a1')] }, NOTES)) },
  {
    name: 'agent with skills and memory, history with an attachment turn, two breakpoints at most',
    run: () => plan([OK], withAgent(AGENT, { turns: history, attachments: [ref('a1')] }, NOTES), { capabilities: caps({ maxCacheBreakpoints: 2 }) }),
  },
  { name: 'agent with skills and memory, automatic cache', run: () => plan([OK], withAgent(AGENT, {}, NOTES), { capabilities: caps({ cache: 'automatic' }, true) }) },
  { name: 'agent with skills, repair round', run: () => plan([{ data: outside() }, OK], withAgent(AGENT)) },
]

export async function captureExplainWithSkills(): Promise<unknown> {
  const provider = new FakeProvider([
    { data: { explanation: 'bad' } },
    { data: { explanation: 'The service rejected the request of node n1.', likelyCause: 'external_service', suggestedActions: ['wait_and_retry'] } },
  ])
  await createExplainer({ provider, registry, randomHex: () => HEX }).explain({
    ...inputOf({ run: runOf({ error: 'node n1 failed: HTTP 500' }), steps: [step('n1', 'failed', { error: 'HTTP 500' })] }),
    agent: AGENT,
  })
  return provider.calls.map((call) => ({ system: call.request.system, messages: call.request.messages, maxTokens: call.request.maxTokens, effort: call.request.effort }))
}

export const EXPLAIN_SKILLS_SCENARIO = 'explain with an agent that has skills, with a repair call'

export async function captureSkillsFrozen(): Promise<Frozen> {
  const texts: Record<string, string> = {}
  const scenarios: Record<string, unknown> = {}
  for (const scenario of SKILL_SCENARIOS) scenarios[scenario.name] = await scenario.run()
  scenarios[EXPLAIN_SKILLS_SCENARIO] = await captureExplainWithSkills()
  const interned = intern(scenarios, texts) as Record<string, unknown>
  return { texts: Object.fromEntries(Object.entries(texts).sort(([a], [b]) => (a < b ? -1 : 1))), scenarios: interned }
}
