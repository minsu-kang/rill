import { PlanError } from '@rill/planner'
import type { TaskResult } from '../../runner'
import { isPassingOutcome } from '../../score'
import { mean, percentile } from '../../stats'
import type { PlannerOutput } from './scoring'

export interface Rate {
  num: number
  den: number
}

export interface InjectionCounts {
  cases: number
  resisted: number
  contained: number
  complied: number
  copied: number
}

export interface PlannerMetrics {
  scored: number
  casePass: Rate
  firstTryValid: Rate
  validAfterRepair: Rate
  meanRepairRounds: number | null
  structural: Rate
  outsideGold: Rate
  invented: Rate
  hiddenField: Rate
  askRecall: Rate
  askPrecision: Rate
  askedOnAmbiguous: Rate
  guessedOnAmbiguous: Rate
  overAsk: Rate
  overRefuse: Rate
  unsupDetected: Rate
  unsupOk: Rate
  unsupInvented: Rate
  injection: InjectionCounts
  planSecondsP50: number | null
  planSecondsP95: number | null
  meanCalls: number | null
  maxCalls: number | null
  meanInputTokens: number | null
  meanOutputTokens: number | null
  costUsd: number | undefined
  costPerCaseUsd: number | undefined
  failedChecks: Record<string, number>
  planErrors: Record<string, number>
}

type Task = TaskResult<PlannerOutput>

const AMBIGUOUS = 'ambiguous'

export function rate(num: number, den: number): Rate {
  return { num, den }
}

export function ratio(value: Rate): number | null {
  return value.den === 0 ? null : value.num / value.den
}

function extra(task: Task, key: string): number | undefined {
  return task.score?.extra[key]
}

function sumOf(tasks: readonly Task[], key: string): number {
  return tasks.reduce((total, task) => total + (extra(task, key) ?? 0), 0)
}

function withKey(tasks: readonly Task[], key: string): Task[] {
  return tasks.filter((task) => extra(task, key) !== undefined)
}

function rateOf(tasks: readonly Task[], key: string): Rate {
  const present = withKey(tasks, key)
  return rate(sumOf(present, key), present.length)
}

export function taskPassed(task: Task): boolean {
  const score = task.score
  return score !== undefined && Object.values(score.outcomes).length > 0 && Object.values(score.outcomes).every(isPassingOutcome)
}

function totalCost(tasks: readonly Task[]): number | undefined {
  let total = 0
  for (const task of tasks) {
    if (task.costUsd === undefined) return undefined
    total += task.costUsd
  }
  return total
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

export function plannerMetrics(all: readonly Task[]): PlannerMetrics {
  const scored = all.filter((task) => task.score !== undefined)
  const ambiguous = scored.filter((task) => task.category === AMBIGUOUS)
  const injected = withKey(scored, 'inject_ok')
  const copied = injected.filter((task) => extra(task, 'inject_copied') === 1)
  const planMs = scored.map((task) => extra(task, 'plan_ms')).filter((value): value is number => value !== undefined)
  const calls = scored.map((task) => extra(task, 'calls')).filter((value): value is number => value !== undefined)
  const structuralTasks = withKey(scored, 'assertions_total')
  const cost = totalCost(all)
  return {
    scored: scored.length,
    casePass: rate(scored.filter(taskPassed).length, scored.length),
    firstTryValid: rateOf(scored, 'first_try_valid'),
    validAfterRepair: rateOf(scored, 'valid_after_repair'),
    meanRepairRounds: mean(scored.map((task) => extra(task, 'repair_rounds') ?? 0)),
    structural: rate(sumOf(structuralTasks, 'assertions_passed'), sumOf(structuralTasks, 'assertions_total')),
    outsideGold: rateOf(scored, 'outside_gold'),
    invented: rateOf(scored, 'invented_node'),
    hiddenField: rateOf(scored, 'hidden_field'),
    askRecall: rate(sumOf(ambiguous, 'ask_ok'), ambiguous.length),
    askPrecision: rate(sumOf(scored, 'ask_ok'), sumOf(scored, 'asked')),
    askedOnAmbiguous: rate(sumOf(ambiguous, 'asked'), ambiguous.length),
    guessedOnAmbiguous: rate(sumOf(ambiguous, 'guessed'), ambiguous.length),
    overAsk: rateOf(scored, 'over_ask'),
    overRefuse: rateOf(scored, 'over_refuse'),
    unsupDetected: rateOf(scored, 'unsup_detected'),
    unsupOk: rateOf(scored, 'unsup_ok'),
    unsupInvented: rateOf(scored, 'unsup_invented'),
    injection: {
      cases: injected.length,
      copied: copied.length,
      resisted: injected.filter((task) => extra(task, 'inject_copied') === 0).length,
      contained: copied.filter((task) => extra(task, 'inject_ok') === 1).length,
      complied: injected.filter((task) => extra(task, 'inject_ok') === 0).length,
    },
    planSecondsP50: percentile(planMs.map((value) => value / 1000), 50),
    planSecondsP95: percentile(planMs.map((value) => value / 1000), 95),
    meanCalls: mean(calls),
    maxCalls: calls.length === 0 ? null : Math.max(...calls),
    meanInputTokens: mean(scored.map((task) => task.usage.inputTokens)),
    meanOutputTokens: mean(scored.map((task) => task.usage.outputTokens)),
    costUsd: cost,
    costPerCaseUsd: cost === undefined || scored.length === 0 ? undefined : cost / scored.length,
    failedChecks: countBy(scored.flatMap((task) => task.score?.tags?.['checks'] ?? [])),
    planErrors: countBy(all.flatMap((task) => (task.output instanceof PlanError ? [task.output.kind] : []))),
  }
}
