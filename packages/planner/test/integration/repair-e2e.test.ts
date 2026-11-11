import type { PlanIssue, Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import { convertSchema, createPlanner, encodeGeneration, repairMessage, withoutHiddenFields } from '../../src/index'
import { FakeProvider } from '../fake-provider'
import { ROOT, receipts, registry, request, workflowBody, workflowData } from '../fixtures'

function withTail(mutate: (workflow: Workflow) => void): Workflow {
  const workflow = receipts()
  workflow.nodes.push({ id: 'n3', type: 'delay@1', config: { ms: 1000 } })
  workflow.edges.push({ from: 'n2', to: 'n3' })
  mutate(workflow)
  return workflow
}

const codesOf = (issues: readonly PlanIssue[]): string[] => issues.map((issue) => issue.code).sort()

describe('repair end to end with the real planner, validator and attachment module', () => {
  it('rejects a config type error together with an unknown output field and repairs it in a second full call', async () => {
    const invalid = withTail((workflow) => {
      workflow.nodes[2]!.config = { file: `${ROOT}/ledger.csv`, row: ['{{n1.output.date}}', '{{n1.output.nope}}'] }
      workflow.nodes[3]!.config = { ms: 'soon' }
    })
    const provider = new FakeProvider([{ data: workflowData(invalid) }, { data: workflowData(withTail(() => undefined)) }])
    const result = await createPlanner({ provider, registry }).plan(request())

    expect(result.kind).toBe('workflow')
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds.map((round) => round.index)).toEqual([0, 1])
    expect(codesOf(result.rounds[0]!.issues)).toEqual(['config_type', 'unknown_output_field'])
    expect(result.rounds[0]!.issues.find((issue) => issue.code === 'unknown_output_field')).toMatchObject({ pointer: '/nodes/2/config/row/1', hint: 'available: amount, date' })
    expect(result.rounds[1]!.issues).toEqual([])
    expect(result.rounds.map((round) => round.targeted)).toEqual([[], []])

    const [first, second] = provider.calls.map((call) => call.request)
    expect(provider.calls).toHaveLength(2)
    expect(second!.messages).toHaveLength(3)
    expect(second!.messages[0]).toEqual(first!.messages[0])
    expect(second!.messages[1]).toEqual({ role: 'assistant', content: JSON.stringify(workflowData(invalid)) })
    expect(second!.messages[2]).toEqual({ role: 'user', content: repairMessage(1, result.rounds[0]!.issues) })
    expect(JSON.parse(second!.messages[2]!.content as string)).toMatchObject({ round: 1, issues: [{ code: 'unknown_output_field' }, { code: 'config_type' }] })
    expect(second!.schema).toEqual(first!.schema)
    expect(second!.system).toEqual(first!.system)
    expect(second!.effort).toBe('medium')
    expect(second!.maxTokens).toBe(12_000)
    expect(result.usage.inputTokens).toBe(2000)
  })

  it('sends a config-only issue on one node to a targeted call with the per-node schema and merges the answer', async () => {
    const invalid = withTail((workflow) => {
      workflow.nodes[3]!.config = { ms: 'soon' }
    })
    const provider = new FakeProvider([{ data: workflowData(invalid) }, { data: { ms: 2500 } }])
    const result = await createPlanner({ provider, registry }).plan(request())

    expect(result.rounds.map((round) => round.targeted)).toEqual([[], ['n3']])
    expect(codesOf(result.rounds[0]!.issues)).toEqual(['config_type'])
    expect(provider.calls).toHaveLength(2)
    const targeted = provider.calls[1]!.request
    expect(targeted.schema).toEqual(convertSchema(withoutHiddenFields(registry.get('delay@1')!)).schema)
    expect(targeted.messages).toHaveLength(1)
    expect(targeted.effort).toBe('medium')
    expect(provider.calls[1]!.options?.timeoutMs).toBe(90_000)
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.workflow.nodes[3]!.config).toEqual({ ms: 2500 })
    expect(result.workflow.nodes.slice(0, 3)).toEqual(withTail(() => undefined).nodes.slice(0, 3))
  })

  it('records every round, sums the usage and prices the run from the price table', async () => {
    const invalid = withTail((workflow) => {
      workflow.nodes[3]!.config = { ms: 'soon' }
    })
    const provider = new FakeProvider([
      { data: workflowData(invalid), usage: { inputTokens: 4000, outputTokens: 900 } },
      { data: { ms: 10 }, usage: { inputTokens: 700, outputTokens: 40 } },
    ])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.rounds.map((round) => round.usage.inputTokens)).toEqual([4000, 700])
    expect(result.usage).toMatchObject({ inputTokens: 4700, outputTokens: 940 })
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('does not repair a workflow whose only findings are warnings', async () => {
    const warned = withTail((workflow) => {
      workflow.nodes[3]!.config = { ms: '{{n1.output.amount}}' }
    })
    const provider = new FakeProvider([{ data: encodeGeneration(workflowBody(warned)) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(provider.calls).toHaveLength(1)
    expect(result.rounds).toHaveLength(1)
    expect(codesOf(result.rounds[0]!.issues)).toEqual(['nullable_into_required', 'number_into_integer'])
  })
})
