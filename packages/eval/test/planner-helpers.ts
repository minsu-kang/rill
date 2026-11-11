import { createRecorder, type EvalProvider } from '../src/record'
import { runEval, type RunResult, type TaskResult } from '../src/runner'
import { isPassingOutcome } from '../src/score'
import type { CaseScore } from '../src/suite'
import type { PlannerOutput } from '../src/suites/planner/scoring'
import { createPlannerSuite, type PlannerFactory, type PlannerSuite, type PlannerSuiteOptions } from '../src/suites/planner/suite'

export const FAKE_MODEL = 'fake-model'

export function offlineProvider(): EvalProvider {
  const refuse = (): Promise<never> => Promise.reject(new Error('no network in this test'))
  return { provider: { name: 'offline', generate: refuse }, recorder: createRecorder(refuse) }
}

export interface FakeRun {
  suite: PlannerSuite
  run: RunResult<PlannerOutput>
  tasks: TaskResult<PlannerOutput>[]
}

export async function runFake(factory: PlannerFactory, options: PlannerSuiteOptions = {}, models: readonly string[] = [FAKE_MODEL], reps = 1): Promise<FakeRun> {
  const suite = createPlannerSuite({ makePlanner: factory, ...options })
  const run = await runEval({
    suite,
    models,
    reps,
    concurrency: 4,
    maxAttempts: 1,
    seed: 1,
    sleep: () => Promise.resolve(),
    createProvider: () => offlineProvider(),
  })
  return { suite, run, tasks: run.tasks }
}

export function scoreOf(task: TaskResult<PlannerOutput>): CaseScore {
  if (task.score === undefined) throw new Error(`no score for ${task.caseId}`)
  return task.score
}

export function passed(task: TaskResult<PlannerOutput>): boolean {
  const score = task.score
  return score !== undefined && score.status === 'ok' && Object.values(score.outcomes).every(isPassingOutcome)
}

export function inCategory(tasks: readonly TaskResult<PlannerOutput>[], category: string): TaskResult<PlannerOutput>[] {
  return tasks.filter((task) => task.category === category)
}

export function total(tasks: readonly TaskResult<PlannerOutput>[], key: string): number {
  return tasks.reduce((sum, task) => sum + (task.score?.extra[key] ?? 0), 0)
}

export function count(tasks: readonly TaskResult<PlannerOutput>[], key: string): number {
  return tasks.filter((task) => task.score?.extra[key] !== undefined).length
}

export const WORKFLOW_CATEGORIES = ['easy', 'attachment', 'patch'] as const

export function workflowTasks(tasks: readonly TaskResult<PlannerOutput>[]): TaskResult<PlannerOutput>[] {
  return tasks.filter((task) => task.kind === 'workflow')
}
