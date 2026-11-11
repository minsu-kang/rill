import { writeResults, type ResultsMeta } from '../src/results'
import type { RunResult, TaskResult, TaskStatus } from '../src/runner'
import type { ExtractOutput } from '../src/suites/extract/suite'
import { fakeTask } from './fake-run'

export const PILOT_SUITE_VERSION = '1.1.2.2-p20261103-aaaaaaaaaaaa-bbbbbbbbbbbb'

export interface PilotRow {
  model: string
  kind: string
  group: string
  input: number
  output: number
  status?: TaskStatus
  rep?: number
  cache?: { read: number; write: number }
}

export interface PilotDirOptions {
  suiteVersion?: string
  effort?: string
  maxOutputTokens?: number
  extraTasks?: TaskResult<unknown>[]
  stop?: 'budget'
}

export function pilotTasks(rows: readonly PilotRow[]): TaskResult<unknown>[] {
  return rows.map((row) =>
    fakeTask({
      caseId: `${row.group}:${row.kind}`,
      group: row.group,
      kind: row.kind,
      model: row.model,
      rep: row.rep ?? 0,
      status: row.status ?? 'ok',
      usage: { inputTokens: row.input, outputTokens: row.output, cacheReadInputTokens: row.cache?.read ?? 0, cacheCreationInputTokens: row.cache?.write ?? 0 },
    }),
  )
}

export function writePilotDir(dir: string, rows: readonly PilotRow[], options: PilotDirOptions = {}): void {
  const tasks = [...pilotTasks(rows), ...(options.extraTasks ?? [])]
  const models = [...new Set(tasks.map((task) => task.model))]
  const run: RunResult<ExtractOutput> = {
    tasks: tasks as TaskResult<ExtractOutput>[],
    spentUsd: 0.5,
    budgetUsd: 1,
    maxOutputTokens: options.maxOutputTokens ?? 4000,
    ...(options.stop === undefined ? {} : { stop: options.stop, partial: true }),
  }
  const meta: ResultsMeta<ExtractOutput> = {
    suiteName: 'extract',
    suiteVersion: options.suiteVersion ?? PILOT_SUITE_VERSION,
    createdAt: '2026-11-11T09:00:00.000Z',
    seed: 1,
    reps: 1,
    effort: options.effort ?? 'low',
    fields: ['amount', 'date', 'vendor'],
    models,
    cases: [],
    maxOutputTokens: options.maxOutputTokens ?? 4000,
  }
  writeResults(dir, run, meta)
}
