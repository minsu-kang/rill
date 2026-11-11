import { SCHEMA_VERSION, type Workflow } from '@rill/dsl'
import { fieldRoles } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_KINDS,
  CONNECTION_KIND_CODE,
  attachmentModule,
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

  it('checks the kind of a connection name that a reference resolves to', () => {
    const connections: PlanConnection[] = [{ name: 'team', kind: 'slack' }, { name: 'api', kind: 'http' }]
    const carrier = { id: 'n0', type: 'transform@1', config: { values: { c: 'team', a: 'api', pre: 'te', several: ['api', 'team'] } } }
    const auth = (connection: string) => ({ ...httpNode(connection), id: 'n1' })
    const codes = (connection: string) => connectionKindIssues(wf([manual, carrier, auth(connection)]), registry, connections).map((issue) => [issue.pointer, issue.message])
    expect(codes('{{n0.output.c}}')).toEqual([['/nodes/2/config/auth/connection', 'node n1: connection team is a slack connection, but this field needs a http connection']])
    expect(codes('{{n0.output.pre}}am')).toEqual([['/nodes/2/config/auth/connection', 'node n1: connection team is a slack connection, but this field needs a http connection']])
    expect(codes('{{n0.output.several}}')).toHaveLength(1)
    expect(codes('{{n0.output.a}}')).toEqual([])
    const extracted = wf([manual, { id: 'n0', type: 'llm.extract@1', config: { text: 'team', fields: [{ name: 'c', type: 'string' }] } }, auth('{{n0.output.c}}')])
    expect(connectionKindIssues(extracted, registry, connections)).toEqual([])
    expect(attachmentModule.provenance({ workflow: extracted, registry, userTexts: ['https://api.example.test'], attachmentTexts: [], trustedConnections: ['team', 'api'] }).map((flag) => flag.code)).toEqual(['untrusted_flow'])
  })

  it('leaves the right kind, unknown names and templated names to other checks', () => {
    const connections: PlanConnection[] = [{ name: 'team', kind: 'slack' }]
    expect(connectionKindIssues(wf([manual, slackNode('team')]), registry, connections)).toEqual([])
    expect(connectionKindIssues(wf([manual, slackNode('other')]), registry, connections)).toEqual([])
    expect(connectionKindIssues(wf([manual, slackNode('{{t1.output.c}}')]), registry, connections)).toEqual([])
    expect(connectionKindIssues(wf([manual, { id: 'n0', type: 'transform@1', config: { values: { c: 'team' } } }, { ...slackNode('{{n0.output.c}}'), id: 'n2' }]), registry, connections)).toEqual([])
  })

  it('keeps the right-kind hint after redaction even when the pointer is flagged', () => {
    const workflow = wf([manual, slackNode('api')])
    const issues = connectionKindIssues(workflow, registry, [{ name: 'api', kind: 'http' }, { name: 'team', kind: 'slack' }])
    const flags = [{ nodeId: 'n1', pointer: '/nodes/1/config/connection', code: 'new_egress_target' as const, message: 'm' }]
    expect(attachmentModule.redactIssues(issues, { workflow, registry, attachmentTexts: ['api'], flags })).toEqual([
      { stage: 3, pointer: '/nodes/1/config/connection', code: CONNECTION_KIND_CODE, message: `${CONNECTION_KIND_CODE} at /nodes/1/config/connection`, hint: 'configured slack connections: team' },
    ])
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

  it('repairs an http auth connection that a transform points at a Slack connection', async () => {
    const bad = wf([manual, { id: 'n0', type: 'transform@1', config: { values: { c: 'team' } } }, { ...httpNode('{{n0.output.c}}'), id: 'n1' }])
    const good = wf([manual, { id: 'n0', type: 'transform@1', config: { values: { c: 'api' } } }, { ...httpNode('{{n0.output.c}}'), id: 'n1' }])
    const provider = new FakeProvider([{ data: workflowData(bad) }, { data: workflowData(good) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: 'call https://api.example.test/x', context: context([{ name: 'api', kind: 'http' }, { name: 'team', kind: 'slack' }]) }))
    expect(result.rounds[0]!.issues.map((issue) => [issue.code, issue.hint])).toEqual([[CONNECTION_KIND_CODE, 'configured http connections: api']])
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.flags).toEqual([])
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
