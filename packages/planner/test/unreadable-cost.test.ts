import type { Workflow } from '@rill/dsl'
import { LlmError, costUsd, type LlmUsage } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { PlanError, createPlanner } from '../src/index'
import { FakeProvider, SONNET, usage } from './fake-provider'
import { receipts, registry, request, workflowData } from './fixtures'

const HAIKU = 'claude-haiku-5-5'
const OPUS = 'claude-opus-5-5'

const lost: LlmUsage = { inputTokens: 400, outputTokens: 60, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 }

const unreadable = (options: ConstructorParameters<typeof LlmError>[2] = {}) => ({ error: new LlmError('invalid_output', 'not JSON', options) })

function withDelay(ms: unknown): Workflow {
  const workflow = receipts()
  workflow.nodes.push({ id: 'n3', type: 'delay@1', config: { ms } })
  workflow.edges.push({ from: 'n2', to: 'n3' })
  return workflow
}

const plan = (provider: FakeProvider) => createPlanner({ provider, registry }).plan(request())

describe('the cost of an unreadable answer', () => {
  it('counts the usage of an unreadable answer in the totals, the round and the cost', async () => {
    const provider = new FakeProvider([unreadable({ usage: lost, model: SONNET }), { data: workflowData(receipts()) }])
    const result = await plan(provider)
    expect(result.usage).toEqual({ inputTokens: 1400, outputTokens: 560, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 })
    expect(result.rounds.map((round) => round.usage)).toEqual([lost, usage()])
    expect(result.costUsd).toBeCloseTo(costUsd(SONNET, lost)! + costUsd(SONNET, usage())!, 12)
  })

  it('prices the unreadable call at the dearest of the models that served it', async () => {
    const provider = new FakeProvider([unreadable({ usage: lost, model: HAIKU, servedModels: [HAIKU, OPUS] }), { data: workflowData(receipts()) }])
    const result = await plan(provider)
    expect(costUsd(OPUS, lost)!).toBeGreaterThan(costUsd(HAIKU, lost)!)
    expect(result.costUsd).toBeCloseTo(costUsd(OPUS, lost)! + costUsd(SONNET, usage())!, 12)
    expect(result.model).toBe(SONNET)
  })

  it('counts every unreadable answer of a run that never becomes readable', async () => {
    const provider = new FakeProvider(Array.from({ length: 4 }, () => unreadable({ usage: lost, model: SONNET })))
    const error = await createPlanner({ provider, registry }).plan(request()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlanError)
    expect((error as PlanError).rounds.map((round) => round.usage)).toEqual([lost, lost, lost, lost])
  })

  it('reports a null cost when an unreadable answer carries no usage, and keeps it null', async () => {
    const provider = new FakeProvider([unreadable(), { data: workflowData(receipts()) }])
    const result = await plan(provider)
    expect(result.costUsd).toBeNull()
    expect(result.usage).toEqual(usage())
    expect(result.rounds[0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  it('keeps the cost null when a later unreadable answer can be priced', async () => {
    const provider = new FakeProvider([unreadable(), unreadable({ usage: lost, model: SONNET }), { data: workflowData(receipts()) }])
    const result = await plan(provider)
    expect(result.costUsd).toBeNull()
    expect(result.usage.inputTokens).toBe(1000 + 400 + 0)
  })

  it('reports a null cost when the usage of an unreadable answer has no model to price it', async () => {
    const result = await plan(new FakeProvider([unreadable({ usage: lost }), { data: workflowData(receipts()) }]))
    expect(result.costUsd).toBeNull()
    expect(result.usage.inputTokens).toBe(1400)
  })

  it('reports a null cost when the unreadable answer came from a model with no price', async () => {
    const result = await plan(new FakeProvider([unreadable({ usage: lost, model: 'mystery-model' }), { data: workflowData(receipts()) }]))
    expect(result.costUsd).toBeNull()
  })

  it('counts an unreadable answer to a targeted repair', async () => {
    const provider = new FakeProvider([
      { data: workflowData(withDelay('soon')) },
      unreadable({ usage: lost, model: SONNET }),
      { data: workflowData(withDelay(3)) },
    ])
    const result = await plan(provider)
    expect(result.rounds.map((round) => round.targeted)).toEqual([[], ['n3'], []])
    expect(result.rounds[1]!.usage).toEqual(lost)
    expect(result.costUsd).toBeCloseTo(costUsd(SONNET, usage())! * 2 + costUsd(SONNET, lost)!, 12)
  })

  it('reports a null cost for an unreadable targeted answer without usage', async () => {
    const provider = new FakeProvider([{ data: workflowData(withDelay('soon')) }, unreadable(), { data: workflowData(withDelay(3)) }])
    expect((await plan(provider)).costUsd).toBeNull()
  })

  it('leaves the cost alone for answers that were readable', async () => {
    const result = await plan(new FakeProvider([{ data: workflowData(receipts()) }]))
    expect(result.costUsd).toBeCloseTo(costUsd(SONNET, usage())!, 12)
  })
})
