import { encodeGeneration } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { createSpecProvider } from '../src/providers'
import { runEval, type RunResult } from '../src/runner'
import { aggregate, allNullOutput, isPassingOutcome, oracleOutput, type ScoredRow } from '../src/score'
import { baselineEvalProviders, buildAnswerTable } from '../src/suites/extract/baselines'
import { createExtractSuite } from '../src/suites/extract/suite'
import { goldBody, nullPlanner, oraclePlanner, perturb, perturbedPlanner } from '../src/suites/planner/fakes'
import { workflowBody, unsupportedBody } from '../src/suites/planner/fake-results'
import { plannerMetrics } from '../src/suites/planner/metrics'
import { ASSERTION_NAMES } from '../src/suites/planner/assertions'
import type { PlannerOutput } from '../src/suites/planner/scoring'
import { createPlannerSuite, type PlannerFactory } from '../src/suites/planner/suite'
import { caseOfRequest, goldData } from './planner-integration-helpers'
import { runFake } from './planner-helpers'
import { VENDORS, documentKeys, vendorFetch, type VendorFake } from './provider-fakes'

const sleep = () => Promise.resolve()

function scoredRows(run: RunResult<unknown>): ScoredRow[] {
  return run.tasks.flatMap((task) =>
    task.score === undefined ? [] : [{ caseId: task.caseId, group: task.group, category: task.category, model: task.model, rep: task.rep, status: task.score.status, outcomes: task.score.outcomes }],
  )
}

describe.each(VENDORS)('the extract suite through the $id adapter and a fake transport', (vendor: VendorFake) => {
  const suite = createExtractSuite({ only: ['easy-ko-cafe-yeonnam', 'adv-en-ignore-instructions'] })
  const cases = suite.cases()
  const table = buildAnswerTable(cases)
  const supported = cases.filter((testCase) => suite.unsupportedReason?.(testCase, vendor.spec) === undefined)

  const run = (answerOf: (expected: { amount: number | null; date: string | null; vendor: string | null }) => unknown) => {
    const oracle = vendorFetch(vendor, (body) => {
      const entry = documentKeys(body).map((key) => table.get(key)).find((candidate) => candidate !== undefined)
      if (entry === undefined) throw new Error('the request carries no known document')
      return answerOf(entry.expected)
    })
    return runEval({
      suite,
      models: [vendor.spec],
      reps: 1,
      concurrency: 3,
      maxAttempts: 1,
      seed: 1,
      sleep,
      createProvider: (model, signal, settings) => createSpecProvider({ model, signal, apiKey: `key-${vendor.id}`, maxTokens: settings.maxOutputTokens, fetch: oracle.fetch }),
    })
  }

  const baseline = async (name: 'oracle' | 'all-null') => {
    const only = { ...suite, cases: () => supported }
    return runEval({ suite: only, models: [name], reps: 1, concurrency: 3, maxAttempts: 1, seed: 1, sleep, createProvider: (model) => baselineEvalProviders(supported)(model) })
  }

  it('runs the cases the model can take, and only those', async () => {
    const result = await run((expected) => oracleOutput(expected))
    expect(result.tasks.map((task) => task.caseId).sort()).toEqual(supported.map((testCase) => testCase.id).sort())
    expect(result.tasks.every((task) => task.status === 'ok')).toBe(true)
    if (vendor.id === 'grok') expect(result.notRun?.map((entry) => entry.caseId)).toEqual(cases.filter((testCase) => testCase.kind === 'pdf').map((testCase) => testCase.id))
    else expect(result.notRun).toBeUndefined()
  })

  it('scores the oracle as the oracle baseline does, and every task has a cost and a recorded exchange', async () => {
    const result = await run((expected) => oracleOutput(expected))
    const expected = aggregate(scoredRows(await baseline('oracle')))
    const got = aggregate(scoredRows(result))
    expect(got.casePassRate).toBe(1)
    expect(got.casePassCount).toBe(expected.casePassCount)
    for (const task of result.tasks) {
      expect(task.exchanges.length).toBeGreaterThanOrEqual(1)
      expect(task.costUsd).toBeGreaterThan(0)
      expect(task.failedAttempts).toEqual([])
    }
  })

  it('scores an all-null answer as the all-null baseline does', async () => {
    const got = aggregate(scoredRows(await run(() => allNullOutput())))
    const expected = aggregate(scoredRows(await baseline('all-null')))
    expect(got.casePassCount).toBe(expected.casePassCount)
    expect(got.pooled.fieldAccuracy).toBe(expected.pooled.fieldAccuracy)
  })

  it('fails the amount field of every case when the amount is perturbed', async () => {
    const result = await run((expected) => ({ ...oracleOutput(expected), amount: (expected.amount ?? 0) + 1 }))
    expect(result.tasks.length).toBe(supported.length)
    for (const task of result.tasks) expect(isPassingOutcome(task.score!.outcomes['amount']!), task.caseId).toBe(false)
  })
})

describe.each(VENDORS)('the planner suite through the $id adapter and a fake transport', (vendor: VendorFake) => {
  const suite = createPlannerSuite()
  const cases = suite.cases()
  const supported = cases.filter((testCase) => suite.unsupportedReason?.(testCase, vendor.spec) === undefined)
  const plannerCase = (text: string) => caseOfRequest({ messages: [{ role: 'user', content: text }] } as never, cases)

  const run = (answerOf: (testCase: ReturnType<typeof plannerCase>) => unknown, factory?: PlannerFactory) => {
    const oracle = vendorFetch(vendor, (_body, text) => answerOf(plannerCase(text)))
    return runEval({
      suite: factory === undefined ? suite : createPlannerSuite({ makePlanner: factory }),
      models: [vendor.spec],
      reps: 1,
      concurrency: 4,
      maxAttempts: 1,
      seed: 1,
      sleep,
      createProvider: (model, signal, settings) => createSpecProvider({ model, signal, apiKey: `key-${vendor.id}`, maxTokens: settings.maxOutputTokens, fetch: oracle.fetch }),
    })
  }

  const passOf = (tasks: RunResult<PlannerOutput>['tasks']) => plannerMetrics(tasks).casePass

  it('plans the gold answer of every case the model can take, through the real planner', async () => {
    const result = await run((testCase) => goldData(testCase))
    expect(result.tasks).toHaveLength(supported.length)
    expect(passOf(result.tasks)).toEqual({ num: supported.length, den: supported.length })
    expect(passOf((await runFake(oraclePlanner, {}, [vendor.spec])).tasks)).toEqual({ num: supported.length, den: supported.length })
  })

  it('scores a refusal-to-plan answer as the null planner does', async () => {
    const result = await run(() => encodeGeneration(unsupportedBody('nothing is supported')))
    const fake = await runFake(nullPlanner, {}, [vendor.spec])
    expect(passOf(result.tasks)).toEqual(passOf(fake.tasks))
  })

  it('scores a perturbed workflow as the perturbed planner does', async () => {
    const check = ASSERTION_NAMES.find((name) => cases.some((testCase) => testCase.expected.outcome === 'workflow' && testCase.expected.assertions.some((assertion) => assertion.check === name)))!
    const result = await run((testCase) => {
      const body = goldBody(testCase)
      const block = testCase.expected
      if (body.kind !== 'workflow' || block.outcome !== 'workflow') return goldData(testCase)
      const target = block.assertions.find((assertion) => assertion.check === check)
      return encodeGeneration(target === undefined ? body : workflowBody(perturb(body.workflow, target)))
    })
    const fake = await runFake(perturbedPlanner(check), {}, [vendor.spec])
    expect(passOf(result.tasks)).toEqual(passOf(fake.tasks))
    expect(passOf(result.tasks).num).toBeLessThan(supported.length)
  })
})
