import { capIssues } from '@rill/dsl'
import { LlmError } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { EFFORT_BUDGETS, repairMessage } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { estimateCallUsd } from '../src/pricing'
import { createRecorder } from '../src/record'
import { runEval, worstCaseCallUsd } from '../src/runner'
import {
  REPAIR_MESSAGE_TOKENS,
  TARGETED_CALLS_PER_ROUND,
  slowestCallSeconds,
  worstCaseSeconds,
  effortMaxTokens,
  baseInputTokens,
  firstCallInputTokens,
  historyTokensPerRepairRound,
  plannerWorstCaseUsd,
  worstCallInputTokens,
  worstCaseCalls,
} from '../src/suites/planner/budget'
import { loadPlannerData } from '../src/suites/planner/cases'
import { fakeResult, workflowBody } from '../src/suites/planner/fake-results'
import { TEXT_CHARS_PER_TOKEN } from '../src/suites/extract/suite'
import { createPlannerSuite } from '../src/suites/planner/suite'

const SONNET = 'claude-sonnet-5-5'
const data = loadPlannerData()
const spec = (id: string) => {
  const found = data.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('worst-case calls per case', () => {
  it('is the first call plus up to two calls in every repair round', () => {
    expect(TARGETED_CALLS_PER_ROUND).toBe(2)
    expect(worstCaseCalls(0)).toBe(1)
    expect(worstCaseCalls(1)).toBe(3)
    expect(worstCaseCalls(3)).toBe(1 + 2 * 3)
    expect(worstCaseCalls(5)).toBe(11)
  })
})

describe('worst-case seconds of one case', () => {
  it('is the calls of the worst case times the longest call limit of a measurable effort', () => {
    expect(slowestCallSeconds()).toBe(EFFORT_BUDGETS.high.timeoutMs / 1000)
    expect(slowestCallSeconds()).toBeLessThan(EFFORT_BUDGETS.xhigh.timeoutMs / 1000)
    expect(worstCaseSeconds(3)).toBe(7 * 180)
    expect(worstCaseSeconds(0)).toBe(180)
    for (const rounds of [0, 1, 2, 3, 4, 5]) expect(worstCaseSeconds(rounds)).toBe(worstCaseCalls(rounds) * slowestCallSeconds())
  })
})

describe('the history a repair round re-sends', () => {
  it('covers the previous answer up to the max output tokens plus the issue list', () => {
    expect(historyTokensPerRepairRound(8000)).toBe(8000 + REPAIR_MESSAGE_TOKENS)
    expect(historyTokensPerRepairRound(16_000)).toBe(16_000 + REPAIR_MESSAGE_TOKENS)
  })

  it('has room for the largest issue list the planner sends', () => {
    const issues = Array.from({ length: 20 }, (_, index) => ({
      stage: 3 as const,
      pointer: `/nodes/${index}/config/${'p'.repeat(60)}`,
      code: 'config_additionalProperties',
      message: 'm'.repeat(200),
      hint: 'h'.repeat(120),
    }))
    expect(repairMessage(5, capIssues(issues)).length / TEXT_CHARS_PER_TOKEN).toBeLessThanOrEqual(REPAIR_MESSAGE_TOKENS)
  })
})

describe('worst-case cost of one case', () => {
  const first = firstCallInputTokens(spec('easy-03-webhook-to-slack'), [])
  it('re-sends the repair history in the input of every call', () => {
    expect(worstCallInputTokens(first, 0, 16_000)).toBe(first)
    expect(worstCallInputTokens(first, 3, 16_000)).toBe(first + 3 * historyTokensPerRepairRound(16_000))
    expect(worstCallInputTokens(first, 3, 8000)).toBe(first + 3 * (8000 + REPAIR_MESSAGE_TOKENS))
    expect(first).toBeGreaterThan(baseInputTokens(createCoreRegistry()))
  })
  it('is the number of calls times the cost of one call with the full output allowance', () => {
    const one = estimateCallUsd(SONNET, first + 3 * historyTokensPerRepairRound(16_000), 16_000) ?? 0
    expect(one).toBeGreaterThan(0)
    expect(plannerWorstCaseUsd(SONNET, first, 3, 16_000)).toBeCloseTo(7 * one, 12)
    const lean = estimateCallUsd(SONNET, first, 16_000) ?? 0
    expect(plannerWorstCaseUsd(SONNET, first, 0, 16_000)).toBeCloseTo(lean, 12)
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
  const caseTokens = effortMaxTokens(testCase.spec.effort)
  const singleCall = estimateCallUsd(SONNET, suite.estimateInputTokens?.(testCase) ?? 0, caseTokens) ?? 0

  it('is wired into the runner through the suite', () => {
    expect(worst).toBe(suite.worstCaseUsd?.(testCase, SONNET, 16_000))
    expect(worst).toBeGreaterThan(7 * singleCall)
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

  it('skips the case when the budget covers fewer calls than the worst case, even seven single calls', async () => {
    const result = await run(7 * singleCall)
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
    expect(result.spentUsd).toBeGreaterThan(7 * singleCall)
  })
})
