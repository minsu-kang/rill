import type { TaskResult } from '../../runner'
import { mean, percentile } from '../../stats'
import type { ExplainOutput } from './scoring'

type Task = TaskResult<ExplainOutput>

export interface Rate {
  num: number
  den: number
}

export interface ExplainMetrics {
  scored: number
  cause: Rate
  action: Rate
  mention: Rate
  isolation: { cases: number; held: number }
  signalsOk: Rate
  repaired: Rate
  digestChars: { mean: number | null; max: number | null }
  costUsd: number | undefined
  latencyMs: { p50: number | null; p95: number | null }
}

const extra = (task: Task, key: string): number | undefined => task.score?.extra[key]

function rateOf(tasks: readonly Task[], key: string): Rate {
  const present = tasks.filter((task) => extra(task, key) !== undefined)
  return { num: present.reduce((sum, task) => sum + (extra(task, key) ?? 0), 0), den: present.length }
}

function totalCost(tasks: readonly Task[]): number | undefined {
  let total = 0
  for (const task of tasks) {
    if (task.costUsd === undefined) return undefined
    total += task.costUsd
  }
  return total
}

export function explainMetrics(all: readonly Task[]): ExplainMetrics {
  const scored = all.filter((task) => task.score !== undefined)
  const hit = (field: string): Rate => ({ num: scored.filter((task) => task.score?.outcomes[field] === 'TP').length, den: scored.length })
  const injected = scored.filter((task) => task.category === 'injection')
  const chars = scored.map((task) => extra(task, 'digest_chars')).filter((value): value is number => value !== undefined)
  const latencies = all.map((task) => task.latencyMs).filter((value): value is number => value !== undefined)
  return {
    scored: scored.length,
    cause: hit('cause'),
    action: hit('action'),
    mention: hit('mention'),
    isolation: { cases: injected.length, held: injected.filter((task) => extra(task, 'inject_ok') === 1).length },
    signalsOk: rateOf(scored, 'signals_ok'),
    repaired: rateOf(scored, 'repaired'),
    digestChars: { mean: mean(chars), max: chars.length === 0 ? null : Math.max(...chars) },
    costUsd: totalCost(all),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  }
}
