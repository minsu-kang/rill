import type { Workflow, WorkflowEdge, WorkflowNode } from '@rill/dsl'
import { withState, NO_STATES, type NodeRunState, type RunStates } from '../model/status'
import { edge, node, workflowOf } from './workflows'

const STAGES = 7

export function largeWorkflow(): Workflow {
  const nodes: WorkflowNode[] = [node('schedule', 'trigger.cron@1', { expression: '*/15 * * * *', timezone: 'utc' })]
  const edges: WorkflowEdge[] = []
  let previous = 'schedule'
  for (let stage = 1; stage <= STAGES; stage += 1) {
    const fetch = `s${stage}_fetch`
    const check = `s${stage}_check`
    const ok = `s${stage}_ok`
    const alert = `s${stage}_alert`
    nodes.push(
      node(fetch, 'http.request@1', { url: `https://api.example.com/service-${stage}/health`, method: 'GET' }, { retry: { maxAttempts: 2 } }),
      node(check, 'condition@1', { left: `{{${fetch}.output.status}}`, operator: 'eq', right: 200 }),
      node(ok, 'csv.append@1', { file: '/Users/demo/health.csv', row: [`service-${stage}`, `{{${fetch}.output.status}}`] }),
      node(alert, 'notify.slack@1', { connection: 'slack-ops', text: `service-${stage} is not healthy` }),
    )
    edges.push(edge(previous, fetch), edge(fetch, check), edge(check, ok, 'true'), edge(check, alert, 'false'))
    previous = ok
  }
  nodes.push(node('done', 'transform@1', { values: { finished: true } }))
  edges.push(edge(previous, 'done'))
  return workflowOf('서비스 7개 상태 점검', nodes, edges)
}

const state = (status: NodeRunState['status'], extra: Partial<NodeRunState> = {}): NodeRunState => ({
  status,
  attempt: 1,
  retrying: false,
  error: null,
  ...extra,
})

export function largeStates(workflow: Workflow): RunStates {
  const has = new Set(workflow.nodes.map((item) => item.id))
  const plan: Array<[string, NodeRunState]> = [
    ['schedule', state('succeeded')],
    ['s1_fetch', state('succeeded')],
    ['s1_check', state('succeeded')],
    ['s1_ok', state('succeeded')],
    ['s1_alert', state('skipped')],
    ['s2_fetch', state('continued', { attempt: 2, error: 'request timed out after 15000 ms' })],
    ['s2_check', state('succeeded')],
    ['s2_ok', state('skipped')],
    ['s2_alert', state('succeeded')],
    ['s3_fetch', state('failed', { attempt: 2, error: 'connect ECONNREFUSED' })],
    ['s4_fetch', state('running', { attempt: 2, retrying: true, error: 'HTTP 503' })],
    ['s5_fetch', state('abandoned')],
  ]
  let states: RunStates = NO_STATES
  for (const [id, value] of plan) if (has.has(id)) states = withState(states, id, value)
  return states
}
