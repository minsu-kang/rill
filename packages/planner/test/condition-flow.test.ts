import type { Workflow } from '@rill/dsl'
import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { createPlanner } from '../src/index'
import { FakeProvider } from './fake-provider'
import { ROOT, receipts, registry, request, workflowData } from './fixtures'

const GATE_MESSAGE = 'decides whether data is sent or written, using content read from a file, a web response or a request'

function gated(left = '{{n1.output.amount}}'): Workflow {
  const workflow = receipts()
  workflow.nodes.splice(2, 0, { id: 'c1', type: 'condition@1', config: { left, operator: 'gt', right: 100 } })
  workflow.edges = [
    { from: 't1', to: 'n1' },
    { from: 'n1', to: 'c1' },
    { from: 'c1', to: 'n2', when: 'true' },
  ]
  return workflow
}

const ask = { text: `Put receipts over 100 into ${ROOT}/ledger.csv` }

describe('a condition on extracted content that decides a write', () => {
  it('is flagged and makes the plan need confirmation, although nothing in it is external', async () => {
    const provider = new FakeProvider([{ data: workflowData(gated()) }])
    const result = await createPlanner({ provider, registry }).plan(request(ask))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.flags).toEqual([
      { nodeId: 'c1', pointer: '/nodes/2/config/left', code: 'untrusted_flow', message: `node c1: /nodes/2/config/left ${GATE_MESSAGE}` },
    ])
    expect(result.needsConfirmation).toBe(true)
  })

  it('does not flag the same condition when it decides nothing that sends or writes', async () => {
    const workflow = gated()
    workflow.nodes[3] = { id: 'n2', type: 'transform@1', config: { values: { note: 'big' } } }
    const provider = new FakeProvider([{ data: workflowData(workflow) }])
    const result = await createPlanner({ provider, registry }).plan(request(ask))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.flags).toEqual([])
    expect(result.needsConfirmation).toBe(false)
  })

  it('is flagged when the write hangs on the later of two branches of the condition', async () => {
    const workflow = gated()
    workflow.nodes.push({ id: 'n3', type: 'transform@1', config: { values: { note: 'small' } } })
    workflow.edges = [...workflow.edges, { from: 'c1', to: 'n3', when: 'false' }]
    const provider = new FakeProvider([{ data: workflowData(workflow) }])
    const result = await createPlanner({ provider, registry }).plan(request(ask))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.flags.map((flag) => flag.nodeId)).toEqual(['c1'])
  })

  it('is flagged when the step it reaches is external but has no field with a role', async () => {
    const beep = defineAction({
      type: 'test.beep@1',
      title: 'Beep',
      description: 'Makes a sound somewhere else',
      sideEffect: 'external',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({}),
      execute: async () => ({}),
    })
    const withBeep = createCoreRegistry().register(beep)
    const workflow = gated()
    workflow.nodes[3] = { id: 'n2', type: 'test.beep@1', config: {} }
    const result = await createPlanner({ provider: new FakeProvider([{ data: workflowData(workflow) }]), registry: withBeep }).plan(request(ask))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.flags.map((flag) => flag.nodeId)).toEqual(['c1'])
  })

  it('does not flag a plain receipts workflow', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: `Put my receipts into ${ROOT}/ledger.csv` }))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.flags).toEqual([])
    expect(result.needsConfirmation).toBe(false)
  })

  it('keeps the repair hint for a wrong field in the flagged operand: the flag is about who decides, not about a value', async () => {
    const provider = new FakeProvider([{ data: workflowData(gated('{{n1.output.total}}')) }, { data: workflowData(gated()) }])
    const result = await createPlanner({ provider, registry }).plan(request(ask))
    expect(result.kind).toBe('workflow')
    const repair = JSON.parse(provider.calls[1]!.request.messages.at(-1)!.content as string) as { issues: Record<string, unknown>[] }
    expect(repair.issues).toEqual([
      expect.objectContaining({ pointer: '/nodes/2/config/left', code: 'unknown_output_field', message: 'node c1: n1.output has no field total', hint: 'available: amount, date' }),
    ])
  })

  it('shows the flagged operand to the model in a targeted repair of the condition', async () => {
    const workflow = gated()
    workflow.nodes[2]!.config = { left: '{{n1.output.amount}}', operator: 'bigger', right: 100 }
    const fixed = { left: '"{{n1.output.amount}}"', operator: 'gt', right: '100' }
    const provider = new FakeProvider([{ data: workflowData(workflow) }, { data: fixed }])
    const result = await createPlanner({ provider, registry }).plan(request(ask))
    expect(result.rounds.map((round) => round.targeted)).toEqual([[], ['c1']])
    const sent = provider.calls[1]!.request.messages[0]!.content as string
    expect(sent).toContain('"left":"{{n1.output.amount}}"')
    expect(sent).not.toContain('"left":"<hidden>"')
  })
})
