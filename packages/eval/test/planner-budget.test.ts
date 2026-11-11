import { LlmError } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { estimateCallUsd } from '../src/pricing'
import { createRecorder } from '../src/record'
import { runEval, worstCaseCallUsd } from '../src/runner'
import {
  BASE_INPUT_TOKENS,
  HISTORY_TOKENS_PER_REPAIR_ROUND,
  TARGETED_EXTRA_CALLS,
  firstCallInputTokens,
  plannerWorstCaseUsd,
  worstCallInputTokens,
  worstCaseCalls,
} from '../src/suites/planner/budget'
import { loadPlannerData } from '../src/suites/planner/cases'
import { fakeResult, workflowBody } from '../src/suites/planner/fake-results'
import { createPlannerSuite } from '../src/suites/planner/suite'

const SONNET = 'claude-sonnet-5-5'
const data = loadPlannerData()
const spec = (id: string) => {
  const found = data.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('worst-case calls per case', () => {
  it('is the first call, every repair round and two extra targeted calls', () => {
    expect(TARGETED_EXTRA_CALLS).toBe(2)
    expect(worstCaseCalls(3)).toBe(1 + 3 + 2)
    expect(worstCaseCalls(0)).toBe(3)
    expect(worstCaseCalls(5)).toBe(8)
  })
})

describe('worst-case cost of one case', () => {
  const first = firstCallInputTokens(spec('easy-03-webhook-to-slack'), [])
  it('re-sends the repair history in the input of every call', () => {
    expect(worstCallInputTokens(first, 0)).toBe(first)
    expect(worstCallInputTokens(first, 3)).toBe(first + 3 * HISTORY_TOKENS_PER_REPAIR_ROUND)
    expect(first).toBeGreaterThan(BASE_INPUT_TOKENS)
  })
  it('is the number of calls times the cost of one call with the full output allowance', () => {
    const one = estimateCallUsd(SONNET, first + 3 * HISTORY_TOKENS_PER_REPAIR_ROUND, 16_000) ?? 0
    expect(one).toBeGreaterThan(0)
    expect(plannerWorstCaseUsd(SONNET, first, 3, 16_000)).toBeCloseTo(6 * one, 12)
    const lean = estimateCallUsd(SONNET, first, 16_000) ?? 0
    expect(plannerWorstCaseUsd(SONNET, first, 0, 16_000)).toBeCloseTo(3 * lean, 12)
  })
  it('grows with the output allowance and with the repair rounds, and is unknown for an unpriced model', () => {
    expect(plannerWorstCaseUsd(SONNET, first, 3, 16_000) ?? 0).toBeGreaterThan(plannerWorstCaseUsd(SONNET, first, 3, 8000) ?? 0)
    expect(plannerWorstCaseUsd(SONNET, first, 4, 16_000) ?? 0).toBeGreaterThan(plannerWorstCaseUsd(SONNET, first, 3, 16_000) ?? 0)
    expect(plannerWorstCaseUsd('some-other-model', first, 3, 16_000)).toBeUndefined()
  })
})

describe('the budget guard reserves the worst case of the whole case', () => {
  const suite = createPlannerSuite({ only: 'easy-03-webhook-to-slack' })
  const [testCase] = suite.cases()
  if (testCase === undefined) throw new Error('no case')
  const worst = worstCaseCallUsd(suite, testCase, SONNET, 16_000) ?? 0
  const singleCall = estimateCallUsd(SONNET, suite.estimateInputTokens?.(testCase) ?? 0, 16_000) ?? 0

  it('is wired into the runner through the suite', () => {
    expect(worst).toBe(suite.worstCaseUsd?.(testCase, SONNET, 16_000))
    expect(worst).toBeGreaterThan(6 * singleCall)
  })

  const run = (budgetUsd: number) =>
    runEval({
      suite: createPlannerSuite({ only: 'easy-03-webhook-to-slack', makePlanner: ({ testCase: c }) => ({ plan: () => Promise.resolve(fakeResult(workflowBody(structuredClone(c.references[0]!)))) }) }),
      models: [SONNET],
      reps: 1,
      concurrency: 1,
      seed: 1,
      budgetUsd,
      maxOutputTokens: 16_000,
      createProvider: () => ({ provider: { name: 'stub', generate: () => Promise.reject(new Error('no network')) }, recorder: createRecorder(() => Promise.reject(new Error('no network'))) }),
    })

  it('skips the case when the budget covers fewer calls than the worst case, even six single calls', async () => {
    const result = await run(6 * singleCall)
    expect(result.tasks[0]?.status).toBe('skipped')
    expect(result.stop).toBe('budget')
  })
  it('runs the case once the budget covers the worst case', async () => {
    const result = await run(worst * 1.001)
    expect(result.tasks[0]?.status).toBe('ok')
    expect(result.stop).toBeUndefined()
  })

  it('charges the worst case of the whole case when an attempt is cut off at the time ceiling', async () => {
    const recorder = createRecorder(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: SONNET, content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }),
      ),
    )
    const stuck = createPlannerSuite({
      only: 'easy-03-webhook-to-slack',
      makePlanner: () => ({
        plan: async (request) => {
          await recorder.fetch('https://api.invalid/v1/messages', { method: 'POST', body: JSON.stringify({ max_tokens: 100 }) })
          await new Promise<never>((_, reject) => request.signal?.addEventListener('abort', () => reject(new LlmError('aborted', 'cut off'))))
          throw new Error('unreachable')
        },
      }),
    })
    const result = await runEval({
      suite: stuck,
      models: [SONNET],
      reps: 1,
      concurrency: 1,
      maxAttempts: 1,
      maxCallMs: 30,
      budgetUsd: 50,
      maxOutputTokens: 16_000,
      seed: 1,
      createProvider: () => ({ provider: { name: 'stub', generate: () => Promise.reject(new Error('no network')) }, recorder }),
    })
    expect(result.tasks[0]).toMatchObject({ status: 'failed', failureClass: 'timeout_ceiling' })
    expect(result.spentUsd).toBeCloseTo(worst, 6)
    expect(result.spentUsd).toBeGreaterThan(6 * singleCall)
  })
})
