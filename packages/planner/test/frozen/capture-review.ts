import { createReviewer, type ReviewRequest } from '../../src/index'
import { FakeProvider, type Step } from '../fake-provider'
import { edge, node, registry, workflowOf } from '../explain/helpers'
import { intern, type Frozen } from './capture'

const HEX = '0123456789ab'
const GOOD = { summary: 'The workflow posts the orders to a channel and a web address.', findings: [{ severity: 'warning', text: 'Node n2 posts to an address the request does not name.', nodeId: 'n2' }] }

function posting() {
  return workflowOf(
    [
      node('t1', 'trigger.cron@1', { expression: '0 9 * * *' }),
      node('n1', 'http.request@1', { url: 'https://api.example.com/orders', method: 'GET' }),
      node('n2', 'http.request@1', { url: 'https://hooks.example.test/collect', method: 'POST', body: '{{n1.output.body}}' }),
      node('n3', 'notify.slack@1', { connection: 'team', text: 'Orders sent' }),
    ],
    [edge('t1', 'n1'), edge('n1', 'n2'), edge('n2', 'n3')],
    'Morning orders',
  )
}

async function capture(steps: Step[], request: ReviewRequest): Promise<unknown> {
  const provider = new FakeProvider(steps)
  await createReviewer({ provider, registry, randomHex: () => HEX }).review(request)
  return provider.calls.map((call) => ({ system: call.request.system, messages: call.request.messages, maxTokens: call.request.maxTokens, effort: call.request.effort, schema: call.request.schema }))
}

export const REVIEW_SCENARIOS: Array<{ name: string; run(): Promise<unknown> }> = [
  {
    name: 'review with flags, rules and a reviewer that has a persona, instructions and two skills',
    run: () =>
      capture([{ data: GOOD }], {
        workflow: posting(),
        requestText: 'Every morning fetch the orders from api.example.com and tell the team on Slack',
        flags: [
          { nodeId: 'n2', pointer: '/url', code: 'new_egress_target' },
          { nodeId: 'n2', pointer: '/body', code: 'untrusted_flow' },
        ],
        rules: { forbiddenNodes: ['csv.append'], allowedHosts: ['api.example.com'] },
        agent: {
          id: 'reviewer-1',
          name: 'Careful reviewer',
          persona: 'Blunt and short.',
          instructions: 'Look at where data leaves the computer first.',
          skills: [
            { name: 'Schedules', body: 'Read every cron expression twice.' },
            { name: 'Web requests', body: 'A POST sends data out.\nName the target.' },
          ],
        },
        effort: 'high',
      }),
  },
  {
    name: 'review of a plain workflow by a reviewer without text, with a repair call',
    run: () =>
      capture([{ data: { summary: '' } }, { data: GOOD }], {
        workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'delay@1', { ms: 5 })], [edge('t1', 'n1')], 'Wait'),
        requestText: 'Wait a little',
        flags: [],
        agent: { id: 'reviewer-2', name: 'Plain reviewer', persona: '', instructions: '' },
      }),
  },
]

export async function captureReviewFrozen(): Promise<Frozen> {
  const texts: Record<string, string> = {}
  const scenarios: Record<string, unknown> = {}
  for (const scenario of REVIEW_SCENARIOS) scenarios[scenario.name] = await scenario.run()
  const interned = intern(scenarios, texts) as Record<string, unknown>
  return { texts: Object.fromEntries(Object.entries(texts).sort(([a], [b]) => (a < b ? -1 : 1))), scenarios: interned }
}
