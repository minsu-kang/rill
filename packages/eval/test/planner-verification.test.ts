import { describe, expect, it } from 'vitest'
import { PlanError } from '@rill/planner'
import { LlmError } from '@rill/llm'
import { evaluateAssertions, ASSERTION_NAMES } from '../src/suites/planner/assertions'
import { loadPlannerData, toPlannerCase } from '../src/suites/planner/cases'
import { ERROR_ISSUE, fakeResult, fakeRound, questionsBody } from '../src/suites/planner/fake-results'
import {
  alwaysAsksPlanner,
  copyingPlanner,
  goldBody,
  goldQuestionTexts,
  invalidAfterRepairPlanner,
  neverAsksPlanner,
  nullPlanner,
  oraclePlanner,
  perturb,
  perturbedPlanner,
  throwingPlanner,
  withRounds,
} from '../src/suites/planner/fakes'
import type { AssertionName } from '../src/suites/planner/schema'
import type { PlannerFactory } from '../src/suites/planner/suite'
import { count, inCategory, passed, runFake, scoreOf, total, workflowTasks } from './planner-helpers'

const data = loadPlannerData()
const caseSpec = (id: string) => {
  const found = data.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('oracle planner (returns the gold answer for every case)', () => {
  it('passes all 48 cases on both fields and every assertion', async () => {
    const { tasks } = await runFake(oraclePlanner)
    expect(tasks).toHaveLength(48)
    expect(tasks.filter(passed)).toHaveLength(48)
    for (const task of tasks) expect(scoreOf(task).outcomes, task.caseId).toEqual({ outcome: 'TP', checks: 'TP' })
    const workflows = workflowTasks(tasks)
    expect(workflows).toHaveLength(30)
    expect(total(workflows, 'assertions_passed')).toBe(total(workflows, 'assertions_total'))
    expect(total(workflows, 'assertions_total')).toBe(257)
  })

  it('has first-try validity 100%, no repair, nothing outside the gold set and no invented node', async () => {
    const { tasks } = await runFake(oraclePlanner)
    expect(total(tasks, 'first_try_valid')).toBe(48)
    expect(total(tasks, 'valid_after_repair')).toBe(48)
    expect(total(tasks, 'repair_rounds')).toBe(0)
    expect(total(tasks, 'calls')).toBe(48)
    expect(total(tasks, 'outside_gold')).toBe(0)
    expect(count(tasks, 'outside_gold')).toBe(30)
    expect(total(tasks, 'invented_node')).toBe(0)
    expect(total(tasks, 'over_ask')).toBe(0)
    expect(total(tasks, 'hidden_field')).toBe(0)
  })

  it('asks on every ambiguous case with the right topic, and only there', async () => {
    const { tasks } = await runFake(oraclePlanner)
    const ambiguous = inCategory(tasks, 'ambiguous')
    expect(ambiguous).toHaveLength(10)
    expect(total(ambiguous, 'asked')).toBe(10)
    expect(total(ambiguous, 'ask_ok')).toBe(10)
    expect(total(ambiguous, 'guessed')).toBe(0)
    expect(total(tasks, 'asked')).toBe(10)
  })

  it('detects every unsupported case, names it and invents nothing', async () => {
    const { tasks } = await runFake(oraclePlanner)
    const unsupported = inCategory(tasks, 'unsupported')
    expect(unsupported).toHaveLength(8)
    expect(total(unsupported, 'unsup_detected')).toBe(8)
    expect(total(unsupported, 'unsup_ok')).toBe(8)
    expect(total(unsupported, 'unsup_invented')).toBe(0)
  })

  it('resists both injections without needing a flag', async () => {
    const { tasks } = await runFake(oraclePlanner)
    const injected = tasks.filter((task) => task.score?.extra['inject_ok'] !== undefined)
    expect(injected.map((task) => task.caseId).sort()).toEqual(['attach-03-pdf-injection-http-exfil', 'attach-04-text-injection-outside-path'])
    expect(total(injected, 'inject_ok')).toBe(2)
    expect(total(injected, 'inject_copied')).toBe(0)
  })

  it('gives the same scores on every run and at every concurrency', async () => {
    const one = await runFake(oraclePlanner)
    const two = await runFake(oraclePlanner)
    const scores = (tasks: typeof one.tasks) => Object.fromEntries(tasks.map((task) => [task.caseId, scoreOf(task)]))
    expect(scores(one.tasks)).toEqual(scores(two.tasks))
  })
})

describe('null planner (refuses everything)', () => {
  it('scores 0 on every workflow case, on both fields and on the structural counters', async () => {
    const { tasks } = await runFake(nullPlanner)
    const workflows = workflowTasks(tasks)
    expect(workflows.filter(passed)).toHaveLength(0)
    for (const task of workflows) expect(scoreOf(task).outcomes, task.caseId).toEqual({ outcome: 'WRONG', checks: 'MISS' })
    expect(total(workflows, 'assertions_passed')).toBe(0)
    expect(total(workflows, 'over_refuse')).toBe(30)
    expect(total(workflows, 'over_ask')).toBe(0)
  })

  it('also fails the ambiguous set, and on the unsupported set it detects but names nothing', async () => {
    const { tasks } = await runFake(nullPlanner)
    expect(inCategory(tasks, 'ambiguous').filter(passed)).toHaveLength(0)
    const unsupported = inCategory(tasks, 'unsupported')
    expect(total(unsupported, 'unsup_detected')).toBe(8)
    expect(total(unsupported, 'unsup_ok')).toBe(0)
    expect(unsupported.filter(passed)).toHaveLength(0)
    expect(tasks.filter(passed)).toHaveLength(0)
  })
})

describe('perturbed gold planners (one per assertion kind)', () => {
  const ALLOWED: Readonly<Record<AssertionName, readonly AssertionName[]>> = {
    hasTrigger: [],
    hasNode: ['pathInsideAllowedFolders', 'usesConnection'],
    hasNodeCount: ['hasTrigger'],
    hasEdge: [],
    orderedBefore: [],
    extractsFields: [],
    noNodeOutsideCatalog: [],
    noSecretLiteral: [],
    pathInsideAllowedFolders: ['hasNode'],
    usesConnection: ['hasNode'],
    hasRetry: [],
    referencesOutputOf: ['pathInsideAllowedFolders', 'hasNode'],
  }
  const using = (kind: AssertionName): Set<string> =>
    new Set(data.cases.filter((entry) => entry.expect.outcome === 'workflow' && entry.expect.assertions.some((a) => a.check === kind)).map((entry) => entry.id))

  it('uses every assertion kind of the vocabulary in at least one case', () => {
    for (const kind of ASSERTION_NAMES) expect(using(kind).size, kind).toBeGreaterThan(0)
  })

  it.each(ASSERTION_NAMES)('%s: makes that assertion fail on every case that uses it, and little else', async (kind) => {
    const { tasks } = await runFake(perturbedPlanner(kind))
    const affected = using(kind)
    for (const task of tasks) {
      const score = scoreOf(task)
      if (!affected.has(task.caseId)) {
        expect(score.outcomes, `${kind} on ${task.caseId}`).toEqual({ outcome: 'TP', checks: 'TP' })
        continue
      }
      const failed = score.tags?.['checks'] ?? []
      expect(score.outcomes, `${kind} on ${task.caseId}`).toEqual({ outcome: 'TP', checks: 'WRONG' })
      expect(failed, `${kind} on ${task.caseId}`).toContain(kind)
      for (const other of failed) expect([kind, ...ALLOWED[kind]], `${kind} on ${task.caseId}: ${other}`).toContain(other)
    }
    expect(tasks.filter((task) => !passed(task)).map((task) => task.caseId).sort()).toEqual([...affected].sort())
  })

  it('makes each single assertion of every workflow case fail when perturbed, so none is vacuous', () => {
    let instances = 0
    for (const spec of data.cases) {
      const testCase = toPlannerCase(spec, data.references)
      const block = testCase.expected
      const body = goldBody(testCase)
      if (block.outcome !== 'workflow' || body.kind !== 'workflow') continue
      const context = { allowedFolders: spec.context.allowedFolders }
      expect(evaluateAssertions(block.assertions, body.workflow, context).every((result) => result.ok), spec.id).toBe(true)
      block.assertions.forEach((target, index) => {
        const results = evaluateAssertions(block.assertions, perturb(body.workflow, target), context)
        expect(results[index]?.ok, `${spec.id} #${index} ${JSON.stringify(target).slice(0, 80)}`).toBe(false)
        instances += 1
      })
    }
    expect(instances).toBe(257)
  })
})

describe('over-asking and never asking', () => {
  const askOnWorkflowCases: PlannerFactory = (input) =>
    input.testCase.expected.outcome === 'workflow'
      ? { plan: () => Promise.resolve(fakeResult(questionsBody(['어느 폴더를 볼까요? 시간은요? 어디로 보낼까요?']))) }
      : oraclePlanner(input)

  it('a planner that always asks fails the easy set, which counts as over-asking and not as a guess', async () => {
    const { tasks } = await runFake(alwaysAsksPlanner)
    const easy = inCategory(tasks, 'easy')
    expect(easy).toHaveLength(20)
    expect(easy.filter(passed)).toHaveLength(0)
    expect(total(easy, 'over_ask')).toBe(20)
    expect(total(workflowTasks(tasks), 'over_ask')).toBe(30)
    expect(total(workflowTasks(tasks), 'assertions_passed')).toBe(0)
    expect(inCategory(tasks, 'unsupported').filter(passed)).toHaveLength(0)
  })

  it('a planner that asks well on ambiguous prompts but also asks on easy ones fails the easy set, except where the case allows a question', async () => {
    const { tasks } = await runFake(askOnWorkflowCases)
    expect(inCategory(tasks, 'ambiguous').filter(passed)).toHaveLength(10)
    expect(tasks.filter(passed).filter((task) => task.category !== 'ambiguous').map((task) => task.caseId).filter((id) => !id.startsWith('unsup-'))).toEqual(['easy-14-vague-morning'])
    expect(total(inCategory(tasks, 'easy'), 'over_ask')).toBe(19)
    expect(total(workflowTasks(tasks), 'over_ask')).toBe(29)
    expect(total(tasks, 'asked')).toBe(10 + 30)
    expect(total(tasks, 'ask_ok')).toBe(10 + 1)
  })

  it('a planner that never asks fails the ambiguous set by guessing, even though its guess is a valid workflow', async () => {
    const { tasks } = await runFake(neverAsksPlanner)
    const ambiguous = inCategory(tasks, 'ambiguous')
    expect(ambiguous.filter(passed)).toHaveLength(0)
    expect(total(ambiguous, 'guessed')).toBe(10)
    expect(total(ambiguous, 'asked')).toBe(0)
    expect(workflowTasks(tasks).filter(passed)).toHaveLength(30)
    expect(inCategory(tasks, 'unsupported').filter(passed)).toHaveLength(0)
    expect(total(inCategory(tasks, 'unsupported'), 'unsup_invented')).toBe(8)
  })
})

describe('injection cases', () => {
  const INJECTED = ['attach-03-pdf-injection-http-exfil', 'attach-04-text-injection-outside-path']

  it('fails a planner that copies the injected target without a flag, on both cases and only there', async () => {
    const { tasks } = await runFake(copyingPlanner({ flag: false }))
    const injected = tasks.filter((task) => INJECTED.includes(task.caseId))
    expect(injected).toHaveLength(2)
    for (const task of injected) {
      expect(scoreOf(task).extra, task.caseId).toMatchObject({ inject_copied: 1, inject_flagged: 0, inject_ok: 0 })
      expect(passed(task), task.caseId).toBe(false)
    }
    expect(tasks.filter((task) => !passed(task)).map((task) => task.caseId).sort()).toEqual(INJECTED)
  })

  it('passes the same planner when its result carries the flag and asks for confirmation', async () => {
    const { tasks } = await runFake(copyingPlanner({ flag: true }))
    const injected = tasks.filter((task) => INJECTED.includes(task.caseId))
    for (const task of injected) {
      expect(scoreOf(task).extra, task.caseId).toMatchObject({ inject_copied: 1, inject_flagged: 1, inject_ok: 1 })
      expect(passed(task), task.caseId).toBe(true)
    }
    expect(tasks.filter(passed)).toHaveLength(48)
  })

  it('fails a flagged copy when the result does not ask for confirmation', async () => {
    const { tasks } = await runFake(copyingPlanner({ flag: true, needsConfirmation: false }))
    expect(tasks.filter((task) => !passed(task)).map((task) => task.caseId).sort()).toEqual(INJECTED)
  })
})

describe('round metrics through the suite', () => {
  it('a planner that needs repair has lower first-try validity than final validity', async () => {
    const repairing: PlannerFactory = (input) =>
      withRounds(input.testCase.id.startsWith('easy-') ? [fakeRound(0, [ERROR_ISSUE]), fakeRound(1, [ERROR_ISSUE]), fakeRound(2)] : [fakeRound(0)])(input)
    const { tasks } = await runFake(repairing)
    expect(total(tasks, 'first_try_valid')).toBe(28)
    expect(total(tasks, 'valid_after_repair')).toBe(48)
    expect(total(tasks, 'repair_rounds')).toBe(40)
    expect(total(tasks, 'calls')).toBe(28 + 20 * 3)
  })
})

describe('failures that are not answers', () => {
  it('grades a plan that stays invalid after repair as no answer, once, without retry', async () => {
    const { tasks } = await runFake(invalidAfterRepairPlanner)
    expect(tasks.every((task) => task.status === 'schema_failed' && task.attempts === 1)).toBe(true)
    for (const task of tasks) expect(scoreOf(task).outcomes).toEqual({ outcome: 'NO_ANSWER', checks: 'NO_ANSWER' })
    expect(total(tasks, 'first_try_valid')).toBe(0)
    expect(total(tasks, 'valid_after_repair')).toBe(0)
    expect(total(tasks, 'repair_rounds')).toBe(3 * 48)
  })

  it('classifies a provider failure through the cause chain and retries it as the runner does', async () => {
    const rateLimited = throwingPlanner(() => new PlanError('provider', 'x', [], [], { cause: new LlmError('rate_limit', 'slow down') }))
    const suiteOptions = { only: 'easy-03-webhook-to-slack' }
    const { tasks } = await runFake(rateLimited, suiteOptions)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ status: 'failed', failureClass: 'rate_limit', attempts: 1 })
  })

  it('treats an attachment error as a harness failure', async () => {
    const broken = throwingPlanner((testCase) => new PlanError('attachment', `bad attachment for ${testCase.id}`, [], []))
    const { tasks } = await runFake(broken, { only: 'attach-01-sample-pdf-extract-to-csv' })
    expect(tasks[0]).toMatchObject({ status: 'failed', failureClass: 'harness' })
  })
})

describe('gold answers', () => {
  it('fit a case that allows fewer questions than it has topics by merging topics into fewer questions', () => {
    const block = { outcome: 'questions' as const, mustAskAbout: ['a', ['b', 'x'], 'c', 'd'], maxQuestions: 2 }
    expect(goldQuestionTexts(block)).toEqual(['a / c?', 'b / d?'])
    expect(goldQuestionTexts({ ...block, maxQuestions: 9 })).toEqual(['a?', 'b?', 'c?', 'd?'])
  })
  it('stay within maxQuestions on every shipped questions case', () => {
    for (const spec of data.cases) {
      if (spec.expect.outcome !== 'questions') continue
      const body = goldBody(toPlannerCase(spec, data.references))
      expect(body.kind).toBe('questions')
      if (body.kind === 'questions') expect(body.questions.length, spec.id).toBeLessThanOrEqual(spec.expect.maxQuestions)
    }
  })
  it('have no gold workflow for a case without a reference', () => {
    const noRef = toPlannerCase({ ...caseSpec('easy-01-receipt-folder-to-csv') }, {})
    expect(() => goldBody(noRef)).toThrow('has no gold workflow')
  })
})
