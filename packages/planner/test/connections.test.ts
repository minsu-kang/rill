import { SCHEMA_VERSION, type Workflow } from '@rill/dsl'
import { fieldRoles } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_KINDS,
  CONNECTION_KIND_CODE,
  connectionKindIssues,
  createPlanner,
  isGapIssue,
  neededConnectionKind,
  type PlanConnection,
} from '../src/index'
import { FakeProvider } from './fake-provider'
import { registry, request, workflowData } from './fixtures'

const manual = { id: 't1', type: 'trigger.manual@1', config: {} }

function wf(nodes: Workflow['nodes']): Workflow {
  return { schemaVersion: SCHEMA_VERSION, name: 'x', nodes, edges: nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })) }
}

const slackNode = (connection: string) => ({ id: 'n1', type: 'notify.slack@1', config: { connection, text: 'hi' } })
const httpNode = (connection: string) => ({ id: 'n1', type: 'http.request@1', config: { url: 'https://api.example.test/x', method: 'POST', auth: { connection } } })
const webhook = (secretConnection: string) => ({ id: 't1', type: 'trigger.webhook@1', config: { path: '/in', secretConnection } })
const context = (connections: PlanConnection[]) => ({ ...request().context, connections })

describe('connection kinds', () => {
  it('has a kind for every connection-role pointer of the core registry', () => {
    const pointers = registry
      .list()
      .flatMap((def) => fieldRoles(def).filter((field) => field.role === 'connection').map((field) => `${def.type} ${field.pointer}`))
    expect(pointers.length).toBeGreaterThan(0)
    for (const entry of pointers) {
      const [type, pointer] = entry.split(' ') as [string, string]
      expect(neededConnectionKind(type, pointer), entry).toBeDefined()
    }
    const listed = Object.entries(CONNECTION_KINDS).flatMap(([type, table]) => Object.keys(table).map((pointer) => `${type} ${pointer}`))
    expect(listed.sort()).toEqual(pointers.map((entry) => entry.replace(/@\d+ /, ' ')).sort())
  })

  it('maps each node to the kind its connection needs', () => {
    expect(neededConnectionKind('notify.slack@1', '/connection')).toBe('slack')
    expect(neededConnectionKind('http.request@2', '/auth/connection')).toBe('http')
    expect(neededConnectionKind('trigger.webhook@1', '/secretConnection')).toBe('webhookSecret')
    expect(neededConnectionKind('notify.slack@1', '/text')).toBeUndefined()
    expect(neededConnectionKind('made.up@1', '/connection')).toBeUndefined()
  })

  it('reports a configured connection of the wrong kind with the right-kind names as hint', () => {
    const connections: PlanConnection[] = [{ name: 'api', kind: 'http' }, { name: 'team', kind: 'slack' }, { name: 'ops', kind: 'slack' }]
    expect(connectionKindIssues(wf([manual, slackNode('api')]), registry, connections)).toEqual([
      {
        stage: 3,
        pointer: '/nodes/1/config/connection',
        code: CONNECTION_KIND_CODE,
        message: 'node n1: connection api is a http connection, but this field needs a slack connection',
        hint: 'configured slack connections: team, ops',
      },
    ])
    expect(connectionKindIssues(wf([manual, httpNode('team')]), registry, connections).map((issue) => [issue.pointer, issue.hint])).toEqual([
      ['/nodes/1/config/auth/connection', 'configured http connections: api'],
    ])
    expect(connectionKindIssues(wf([webhook('team')]), registry, connections).map((issue) => issue.hint)).toEqual(['no webhookSecret connections are configured'])
  })

  it('leaves the right kind, unknown names and templated names to other checks', () => {
    const connections: PlanConnection[] = [{ name: 'team', kind: 'slack' }]
    expect(connectionKindIssues(wf([manual, slackNode('team')]), registry, connections)).toEqual([])
    expect(connectionKindIssues(wf([manual, slackNode('other')]), registry, connections)).toEqual([])
    expect(connectionKindIssues(wf([manual, slackNode('{{t1.output.c}}')]), registry, connections)).toEqual([])
  })

  it('treats a connection issue as a gap only when no connection of the needed kind is configured', () => {
    const workflow = wf([manual, slackNode('api')])
    const issue = { stage: 3 as const, pointer: '/nodes/1/config/connection', code: 'unknown_connection', message: 'm' }
    expect(isGapIssue(issue, context([{ name: 'api', kind: 'http' }]), workflow)).toBe(true)
    expect(isGapIssue(issue, context([{ name: 'team', kind: 'slack' }]), workflow)).toBe(false)
    expect(isGapIssue({ ...issue, code: CONNECTION_KIND_CODE }, context([{ name: 'api', kind: 'http' }]), workflow)).toBe(true)
    expect(isGapIssue({ ...issue, code: CONNECTION_KIND_CODE }, context([{ name: 'team', kind: 'slack' }, { name: 'api', kind: 'http' }]), workflow)).toBe(false)
    expect(isGapIssue(issue, context([]))).toBe(true)
    expect(isGapIssue(issue, context([{ name: 'api', kind: 'http' }]))).toBe(false)
  })
})

describe('connection kinds in the planner', () => {
  it('repairs a Slack node on an http connection when a Slack connection exists', async () => {
    const provider = new FakeProvider([{ data: workflowData(wf([manual, slackNode('api')])) }, { data: workflowData(wf([manual, slackNode('team')])) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'tell me on slack', context: context([{ name: 'api', kind: 'http' }, { name: 'team', kind: 'slack' }]) }))
    expect(result.kind).toBe('workflow')
    expect(result.rounds[0]!.issues.map((issue) => [issue.code, issue.hint])).toEqual([[CONNECTION_KIND_CODE, 'configured slack connections: team']])
    expect(provider.calls[1]!.request.messages.at(-1)!.content).toContain('configured slack connections: team')
  })

  it('asks to set up a Slack connection when only connections of another kind exist', async () => {
    const provider = new FakeProvider([{ data: workflowData(wf([manual, slackNode('api')])) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'tell me on slack via api', context: context([{ name: 'api', kind: 'http' }]) }))
    expect(provider.calls).toHaveLength(1)
    if (result.kind !== 'questions') throw new Error('expected questions')
    expect(result.questions).toEqual([
      {
        id: 'setup_connection',
        text: 'This workflow needs a Slack connection (needed by n1), but no such connection is set up yet. Set one up in Settings first, or write the result to a CSV file instead?',
        options: ['Set up a connection first', 'Write to a CSV file instead'],
        default: 'Set up a connection first',
      },
    ])
  })

  it('asks the same for an unknown name when no connection of the needed kind exists', async () => {
    const provider = new FakeProvider([{ data: workflowData(wf([manual, slackNode('nope')])) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'ping slack', context: context([{ name: 'api', kind: 'http' }]) }))
    expect(result.kind === 'questions' && result.questions.map((question) => question.id)).toEqual(['setup_connection'])
  })

  it('does not offer a CSV file instead of a missing webhook secret', async () => {
    const workflow: Workflow = { ...wf([webhook('hooksecret'), { id: 'n1', type: 'delay@1', config: { ms: 1 } }]) }
    const provider = new FakeProvider([{ data: workflowData(workflow) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'run on a webhook', context: context([{ name: 'team', kind: 'slack' }]) }))
    if (result.kind !== 'questions') throw new Error('expected questions')
    expect(result.questions[0]!.options).toEqual(['Set up a connection first', 'Cancel'])
    expect(result.questions[0]!.text).toBe('This workflow needs a webhook secret connection (needed by t1), but no such connection is set up yet. Set one up in Settings first?')
    expect(result.questions[0]!.text).not.toContain('CSV')
  })
})
