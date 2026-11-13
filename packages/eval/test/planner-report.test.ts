import { LlmError } from '@rill/llm'
import { PlanError } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { runEval } from '../src/runner'
import { plannerMetrics, rate, ratio } from '../src/suites/planner/metrics'
import { renderPlannerReport, type PlannerReportMeta } from '../src/suites/planner/report'
import { ERROR_ISSUE, fakeResult, fakeRound, questionsBody, workflowBody } from '../src/suites/planner/fake-results'
import {
  alwaysAsksPlanner,
  copyingPlanner,
  goldBody,
  invalidAfterRepairPlanner,
  neverAsksPlanner,
  nullPlanner,
  oraclePlanner,
  throwingPlanner,
  withRounds,
} from '../src/suites/planner/fakes'
import { createPlannerSuite, type PlannerFactory } from '../src/suites/planner/suite'
import { FAKE_MODEL, offlineProvider, runFake, type FakeRun } from './planner-helpers'

const META: PlannerReportMeta = {
  suiteName: 'planner',
  suiteVersion: 'v-test',
  createdAt: '2026-11-12T09:30:00.000Z',
  models: [FAKE_MODEL],
  reps: 1,
  seed: 1,
  effort: undefined,
  priceTableAsOf: PRICE_TABLE_AS_OF,
  fallback: false,
  baselines: [],
  maxRepairRounds: 3,
  maxOutputTokens: 16_000,
}

const render = (fake: FakeRun, meta: Partial<PlannerReportMeta> = {}): string => renderPlannerReport({ run: fake.run, meta: { ...META, ...meta } })

describe('plannerMetrics', () => {
  it('computes rate and ratio, with none for an empty denominator', () => {
    expect(rate(1, 4)).toEqual({ num: 1, den: 4 })
    expect(ratio(rate(1, 4))).toBe(0.25)
    expect(ratio(rate(0, 0))).toBeNull()
  })

  it('reads the oracle as perfect on everything it can', async () => {
    const { tasks } = await runFake(oraclePlanner)
    const m = plannerMetrics(tasks)
    expect(m.scored).toBe(61)
    expect(m.casePass).toEqual({ num: 61, den: 61 })
    expect(m.firstTryValid).toEqual({ num: 61, den: 61 })
    expect(m.validAfterRepair).toEqual({ num: 61, den: 61 })
    expect(m.meanRepairRounds).toBe(0)
    expect(m.structural).toEqual({ num: 358, den: 358 })
    expect(m.outsideGold).toEqual({ num: 0, den: 43 })
    expect(m.invented).toEqual({ num: 0, den: 43 })
    expect(m.askRecall).toEqual({ num: 10, den: 10 })
    expect(m.askPrecision).toEqual({ num: 11, den: 11 })
    expect(m.guessedOnAmbiguous).toEqual({ num: 0, den: 10 })
    expect(m.overAsk).toEqual({ num: 0, den: 43 })
    expect(m.overRefuse).toEqual({ num: 0, den: 43 })
    expect(m.unsupDetected).toEqual({ num: 7, den: 7 })
    expect(m.unsupOk).toEqual({ num: 7, den: 7 })
    expect(m.unsupInvented).toEqual({ num: 0, den: 7 })
    expect(m.injection).toEqual({ cases: 3, copied: 0, resisted: 3, contained: 0, complied: 0 })
    expect(m.meanCalls).toBe(1)
    expect(m.maxCalls).toBe(1)
    expect(m.planSecondsP50).toBeCloseTo(0.1)
    expect(m.costUsd).toBe(0)
    expect(m.costPerCaseUsd).toBe(0)
    expect(m.failedChecks).toEqual({})
    expect(m.planErrors).toEqual({})
  })

  it('measures ask precision against all questions asked, and recall against the ambiguous cases', async () => {
    const overAsking: PlannerFactory = (input) =>
      input.testCase.expected.outcome === 'workflow' ? { plan: () => Promise.resolve(fakeResult(questionsBody(['시간은요?']))) } : oraclePlanner(input)
    const m = plannerMetrics((await runFake(overAsking)).tasks)
    expect(m.askRecall).toEqual({ num: 10, den: 10 })
    expect(m.askPrecision).toEqual({ num: 10 + 1 + 1, den: 10 + 1 + 43 })
    expect(m.overAsk).toEqual({ num: 42, den: 43 })
  })

  it('reads the always-asking planner as high recall of asking but none of it right', async () => {
    const m = plannerMetrics((await runFake(alwaysAsksPlanner)).tasks)
    expect(m.askedOnAmbiguous).toEqual({ num: 10, den: 10 })
    expect(m.askRecall).toEqual({ num: 0, den: 10 })
    expect(m.askPrecision).toEqual({ num: 0, den: 61 })
    expect(m.casePass.num).toBe(0)
  })

  it('reads the never-asking planner as guessing on every ambiguous prompt', async () => {
    const m = plannerMetrics((await runFake(neverAsksPlanner)).tasks)
    expect(m.guessedOnAmbiguous).toEqual({ num: 10, den: 10 })
    expect(m.askRecall).toEqual({ num: 0, den: 10 })
    expect(m.unsupInvented).toEqual({ num: 7, den: 7 })
    expect(m.casePass).toEqual({ num: 43, den: 61 })
  })

  it('counts resisted, contained and complied injections and the flag rate when copied', async () => {
    const complied = plannerMetrics((await runFake(copyingPlanner({ flag: false }))).tasks).injection
    expect(complied).toEqual({ cases: 3, copied: 3, resisted: 0, contained: 0, complied: 3 })
    const contained = plannerMetrics((await runFake(copyingPlanner({ flag: true }))).tasks).injection
    expect(contained).toEqual({ cases: 3, copied: 3, resisted: 0, contained: 3, complied: 0 })
  })

  it('takes latency percentiles, mean and max calls and the failed checks from the rounds and scores', async () => {
    const slow: PlannerFactory = (input) => {
      const index = input.testCase.id.startsWith('patch-01') ? 3 : 1
      const rounds = Array.from({ length: index }, (_, round) => fakeRound(round, round < index - 1 ? [ERROR_ISSUE] : [], [], 1000 * (round + 1)))
      return withRounds(rounds)(input)
    }
    const m = plannerMetrics((await runFake(slow, { group: 'patch' })).tasks)
    expect(m.scored).toBe(4)
    expect(m.maxCalls).toBe(3)
    expect(m.meanCalls).toBeCloseTo((3 + 1 + 1 + 1) / 4)
    expect(m.planSecondsP95).toBeGreaterThan(m.planSecondsP50 ?? 0)
    expect(m.firstTryValid).toEqual({ num: 3, den: 4 })
    expect(m.meanRepairRounds).toBeCloseTo((2 + 0 + 0 + 0) / 4)
  })

  it('leaves tasks that failed without an answer out of every rate, and gives no cost for an unpriced model', async () => {
    const broken = throwingPlanner(() => new PlanError('provider', 'x', [], [], { cause: new LlmError('invalid_request', 'bad request') }))
    const mixed: PlannerFactory = (input) => (input.testCase.id.startsWith('patch-01') ? broken(input) : oraclePlanner(input))
    const fake = await runFake(mixed, { group: 'patch' }, ['some-other-model'])
    expect(fake.tasks.filter((task) => task.status === 'failed')).toHaveLength(1)
    const m = plannerMetrics(fake.tasks)
    expect(m.scored).toBe(3)
    expect(m.casePass).toEqual({ num: 3, den: 3 })
    expect(m.firstTryValid).toEqual({ num: 3, den: 3 })
    expect(m.costUsd).toBeUndefined()
    expect(m.costPerCaseUsd).toBeUndefined()
    const text = render(fake, { models: ['some-other-model'] })
    expect(text).toContain('| some-other-model | 0.10 | 0.10 | 1.00 | 1 | 0 | 0 | n/a | n/a |')
    expect(text).toContain('Calls that failed after all attempts: 1')
  })

  it('counts plan errors by kind and leaves failed and skipped tasks out of the scored cases', async () => {
    const fake = await runFake(invalidAfterRepairPlanner, { group: 'patch' })
    const m = plannerMetrics(fake.tasks)
    expect(m.scored).toBe(4)
    expect(m.planErrors).toEqual({ invalid_after_repair: 4 })
    expect(m.casePass).toEqual({ num: 0, den: 4 })
    expect(m.validAfterRepair).toEqual({ num: 0, den: 4 })
    const none = plannerMetrics([])
    expect(none.scored).toBe(0)
    expect(none.meanCalls).toBeNull()
    expect(none.maxCalls).toBeNull()
    expect(none.planSecondsP50).toBeNull()
    expect(none.costUsd).toBe(0)
    expect(none.costPerCaseUsd).toBeUndefined()
  })
})

describe('renderPlannerReport', () => {
  it('reports the oracle run in every section', async () => {
    const text = render(await runFake(oraclePlanner))
    expect(text).toContain('# Eval report: planner')
    expect(text).toContain('- Suite version: v-test')
    expect(text).toContain('- Effort: as each case sets it (low, medium or high)')
    expect(text).toContain('- Repair rounds allowed: 3; max output tokens per request: 16000')
    expect(text).toContain('- Cases: 61 ')
    expect(text).toContain('- Case pass is clustered by case')
    expect(text).toContain('| claude-sonnet-5-5 | 100.0% (100.0% to 100.0%), 61/61 | 100.0% (61/61) | 100.0% (61/61) | 0.00 | 100.0% (358/358) | 0.0% (0/43) | 0.0% (0/43) |')
    expect(text).toContain('| claude-sonnet-5-5 | 100.0% (10/10) | 100.0% (11/11) | 0.0% (0/10) | 0.0% (0/43) | 0.0% (0/43) |')
    expect(text).toContain('| claude-sonnet-5-5 | 100.0% (7/7) | 100.0% (7/7) | 0.0% (0/7) | 0.0% (0/61) |')
    expect(text).toContain('| claude-sonnet-5-5 | 3 | 3 | 0 | 0 | n/a (never copied) |')
    expect(text).toContain('| claude-sonnet-5-5 | 0.10 | 0.10 | 1.00 | 1 | 0 | 0 | $0.0000 | $0.0000 |')
    for (const category of ['ambiguous', 'attachment', 'easy', 'memory', 'patch', 'unsupported']) expect(text).toMatch(new RegExp(`\\| claude-sonnet-5-5 \\| ${category} \\| \\d+ \\| 100\\.0% `))
    expect(text).toContain('No check failed.')
    expect(text).toContain('No failed attempts and no refusals.')
    expect(text).toContain('No case was failed by every model on every rep.')
    expect(text).not.toContain('PARTIAL')
  })

  it('shows an effort override and the indicative note for a small subset', async () => {
    const text = render(await runFake(oraclePlanner, { group: 'patch' }), { effort: 'high' })
    expect(text).toContain('- Effort: high (override of the case effort)')
    expect(text).toContain('- Only 4 cases ran: every number below is indicative')
    expect(text).not.toContain('- Case pass is clustered by case')
  })

  it('lists the failed checks, the plan errors and the gold suspects of a bad planner', async () => {
    const text = render(await runFake(nullPlanner))
    expect(text).toContain('| claude-sonnet-5-5 | 0.0% (0.0% to 0.0%), 0/61 |')
    expect(text).toContain('| claude-sonnet-5-5 | 100.0% (7/7) | 0.0% (0/7) | 0.0% (0/7) | 0.0% (0/61) |')
    expect(text).toContain('| claude-sonnet-5-5 | mustMention | 7 |')
    expect(text).toContain('Cases that every real model failed on every rep.')
    expect(text).toMatch(/\| easy-01-receipt-folder-to-csv \| 1 \| got:unsupported \| \(outcome\) \|/u)
    const errors = render(await runFake(invalidAfterRepairPlanner, { group: 'patch' }))
    expect(errors).toContain('Plans that ended in an error (graded as a failed case):')
    expect(errors).toContain('| claude-sonnet-5-5 | invalid_after_repair | 4 |')
  })

  it('lists copied injections in the checks and counts them as complied', async () => {
    const text = render(await runFake(copyingPlanner({ flag: false })))
    expect(text).toContain('| claude-sonnet-5-5 | 3 | 0 | 0 | 3 | 0.0% (0/3) |')
    expect(text).toContain('| claude-sonnet-5-5 | injection | 3 |')
  })

  it('compares two models side by side and keeps their rows apart', async () => {
    const fake = await runFake(oraclePlanner, {}, ['m-one', 'm-two'])
    const text = render(fake, { models: ['m-one', 'm-two'] })
    expect(text).toContain('- Models: m-one, m-two')
    expect(text.match(/\| m-one \| 100\.0% \(100\.0% to 100\.0%\), 61\/61 \|/gu)).toHaveLength(1)
    expect(text.match(/\| m-two \| 100\.0% \(100\.0% to 100\.0%\), 61\/61 \|/gu)).toHaveLength(1)
  })

  it('lists a gold suspect only when every model failed it on every rep', async () => {
    const good = await runFake(oraclePlanner, {}, ['m-one'])
    const bad = await runFake(nullPlanner, {}, ['m-two'])
    const both = { ...good.run, tasks: [...good.run.tasks, ...bad.run.tasks] }
    const text = renderPlannerReport({ run: both, meta: { ...META, models: ['m-one', 'm-two'] } })
    expect(text).toContain('No case was failed by every model on every rep.')
    expect(text).toContain('| m-one | 100.0% (100.0% to 100.0%), 61/61 |')
    expect(text).toContain('| m-two | 0.0% (0.0% to 0.0%), 0/61 |')
    const alsoBad = await runFake(nullPlanner, {}, ['m-one'])
    const same = renderPlannerReport({ run: { ...alsoBad.run, tasks: [...alsoBad.run.tasks, ...bad.run.tasks] }, meta: { ...META, models: ['m-one', 'm-two'] } })
    expect(same).toContain('Cases that every real model failed on every rep.')
    expect(same).toContain('| easy-01-receipt-folder-to-csv | 2 | got:unsupported | (outcome) |')
  })

  it('divides the flag rate by the plans that copied the target, not by all injection plans', async () => {
    const onlyOne: PlannerFactory = (input) => (input.testCase.id.startsWith('attach-03') ? copyingPlanner({ flag: false })(input) : oraclePlanner(input))
    const text = render(await runFake(onlyOne))
    expect(text).toContain('| claude-sonnet-5-5 | 3 | 2 | 0 | 1 | 0.0% (0/1) |')
  })

  it('draws the case-pass interval from the schedule seed, the same one every time', async () => {
    const fake = await runFake(neverAsksPlanner)
    const interval = (seed: number): string => /\| claude-sonnet-5-5 \| ([^|]+) \|/u.exec(render(fake, { seed }))?.[1] ?? ''
    expect(interval(1)).toBe('70.5% (59.0% to 82.0%), 43/61')
    expect(interval(1)).toBe(interval(1))
    expect(interval(8)).toBe('70.5% (59.0% to 80.3%), 43/61')
    expect(interval(84)).toBe('70.5% (57.4% to 82.0%), 43/61')
  })

  it('opens with a PARTIAL RUN notice when the budget ran out', async () => {
    const suite = createPlannerSuite({ makePlanner: oraclePlanner, group: 'patch' })
    const run = await runEval({
      suite,
      models: ['claude-sonnet-5-5'],
      reps: 1,
      concurrency: 1,
      seed: 1,
      budgetUsd: 0.001,
      createProvider: () => offlineProvider(),
    })
    const text = renderPlannerReport({ run, meta: { ...META, models: ['claude-sonnet-5-5'] } })
    expect(text).toContain('> **PARTIAL RUN**: the budget ran out')
    expect(text).toContain('claude-sonnet-5-5 0 completed, 4 skipped')
    expect(text).toContain('Budget: $0.0010, spent $0.0000.')
    expect(text).toContain('Tasks skipped because of the budget: 4.')
  })

  it('says so when there is no model under test', async () => {
    const fake = await runFake(oraclePlanner, { group: 'patch' })
    expect(render(fake, { models: [] })).toContain('No model under test in this run.')
  })

  it('cuts the gold suspect list at thirty and says how many are not listed', async () => {
    const text = render(await runFake(nullPlanner))
    expect(text).toContain('31 more not listed.')
  })

  it('has the check each model fails most often first, by count then name', async () => {
    const text = render(await runFake(nullPlanner))
    const rows = [...text.matchAll(/\| claude-sonnet-5-5 \| (\w+) \| (\d+) \|\n/gu)].map((match) => [match[1], Number(match[2])] as const)
    const counts = rows.map(([, count]) => count)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })
})

describe('gold answers used by the fake planners', () => {
  it('always give a workflow body for the workflow cases', async () => {
    const { suite } = await runFake(oraclePlanner, { group: 'patch' })
    for (const testCase of suite.cases()) expect(goldBody(testCase).kind).toBe('workflow')
    expect(workflowBody(structuredClone(suite.cases()[0]!.references[0]!)).kind).toBe('workflow')
  })
})
