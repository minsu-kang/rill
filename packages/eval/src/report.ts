import { aggregate, isPassingOutcome, type Aggregate, type FieldMetrics, type ScoredRow } from './score'
import type { RunResult, TaskResult } from './runner'
import { clusterBootstrapDelta, mean, percentile, wilson } from './stats'

export interface ReportMeta {
  suiteName: string
  suiteVersion: string
  createdAt: string
  models: readonly string[]
  reps: number
  seed: number
  effort: string | undefined
  priceTableAsOf: string
  fallback: false
  baselines: readonly string[]
}

export interface ReportInput {
  run: RunResult<unknown>
  meta: ReportMeta
}

export const INDICATIVE_BELOW = 20
export const SHIPPED_EFFORT = 'low'
const Z_ALPHA_PLUS_BETA = 2.8
const WORST_CASE_PROPORTION = 0.5

type Task = TaskResult<unknown>
type ScoredTask = Task & { score: NonNullable<Task['score']> }

export function noiseFloorPoints(seeds: number, reps: number): { typical: number; worst: number } {
  const scale = 100 * Z_ALPHA_PLUS_BETA * WORST_CASE_PROPORTION
  return { typical: scale / Math.sqrt(seeds * reps), worst: scale / Math.sqrt(seeds) }
}

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(digits)}%`
}

function num(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits)
}

function usd(value: number | undefined | null): string {
  return value === undefined || value === null ? 'n/a' : `$${value.toFixed(value < 0.1 ? 4 : 2)}`
}

function signed(points: number): string {
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}`
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [line(header), line(header.map(() => '---')), ...rows.map(line), '']
}

function isScored(task: Task): task is ScoredTask {
  return task.score !== undefined
}

function toRow(task: ScoredTask): ScoredRow {
  return {
    caseId: task.caseId,
    group: task.group,
    category: task.category,
    model: task.model,
    rep: task.rep,
    status: task.score.status,
    outcomes: task.score.outcomes,
  }
}

function tasksOf(run: RunResult<unknown>, model: string): Task[] {
  return run.tasks.filter((task) => task.model === model)
}

function rowsOf(tasks: readonly Task[]): ScoredRow[] {
  return tasks.filter(isScored).map(toRow)
}

function passed(row: ScoredRow): boolean {
  return row.status === 'ok' && Object.values(row.outcomes).length > 0 && Object.values(row.outcomes).every(isPassingOutcome)
}

function passRateOf(rows: readonly ScoredRow[]): number | null {
  return aggregate(rows).casePassRate
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function headerSection(input: ReportInput, scoredGroups: number): string[] {
  const { meta } = input
  const effort =
    meta.effort === undefined || meta.effort === SHIPPED_EFFORT
      ? `${SHIPPED_EFFORT} (as the node ships)`
      : `${meta.effort} (override; the node ships ${SHIPPED_EFFORT})`
  const floor = noiseFloorPoints(Math.max(1, scoredGroups), Math.max(1, meta.reps))
  const noise =
    scoredGroups === 0
      ? '- Noise floor: n/a, no call was scored.'
      : `- Noise floor: with ${plural(scoredGroups, 'seed')} and ${plural(meta.reps, 'rep')}, a paired pass-rate difference smaller than about ${floor.typical.toFixed(0)} points cannot be told from noise (80% power, 5% level, assuming independent reps); up to about ${floor.worst.toFixed(0)} points if the reps of a case agree. Per-category numbers are noisier still.`
  const lines = [
    `# Eval report: ${meta.suiteName}`,
    '',
    `- Suite version: ${meta.suiteVersion}`,
    `- Date: ${meta.createdAt}`,
    `- Models: ${meta.models.length === 0 ? '(none, baselines only)' : meta.models.join(', ')}`,
    `- Reps per case: ${meta.reps}`,
    `- Schedule seed: ${meta.seed}`,
    `- Effort: ${effort}`,
    `- Comparison: each model as the node ships it, at that effort. This is not a model-only comparison.`,
    `- Refusal fallback: ${meta.fallback ? 'on' : 'off'} for every model.`,
    '- Data: synthetic clean receipts only. The results say nothing about photos, scans or real receipts.',
    `- Price table as of ${meta.priceTableAsOf}.`,
    noise,
    '',
  ]
  return lines
}

interface ModelStats {
  model: string
  tasks: Task[]
  rows: ScoredRow[]
  aggregate: Aggregate
}

function statsOf(run: RunResult<unknown>, model: string): ModelStats {
  const tasks = tasksOf(run, model)
  const rows = rowsOf(tasks)
  return { model, tasks, rows, aggregate: aggregate(rows) }
}

function injectOf(tasks: readonly Task[]): { n: number; failed: number; mean: number | null } {
  const values = tasks.flatMap((task) => {
    const value = task.score?.status === 'ok' ? task.score.extra['inject_ok'] : undefined
    return value === undefined ? [] : [value]
  })
  return { n: values.length, failed: values.filter((value) => value === 0).length, mean: mean(values) }
}

function injectCell(tasks: readonly Task[]): string {
  const inject = injectOf(tasks)
  return inject.n === 0 ? 'n/a' : `${inject.failed} of ${inject.n} failed (mean ${num(inject.mean)})`
}

function wilsonCell(aggregateOf: Aggregate): string {
  const interval = wilson(aggregateOf.casePassCount, aggregateOf.scoredCalls)
  if (interval === null) return 'n/a'
  return `${pct(interval.p)} (${pct(interval.lo)} to ${pct(interval.hi)}), ${aggregateOf.casePassCount}/${aggregateOf.scoredCalls}`
}

function resultsSection(stats: readonly ModelStats[]): string[] {
  return [
    '## Results by model',
    '',
    'Case pass is the share of scored calls where all three fields are right. The interval is a Wilson 95% interval over calls; calls of the same seed are correlated, so the real interval is wider (clustered). A refusal or an invalid reply counts as no answer and as a failed case.',
    '',
    ...table(
      ['Model', 'Case pass (95% Wilson)', 'Amount', 'Date', 'Vendor', 'No-answer rate', 'Injection (fail on any)'],
      stats.map((entry) => [
        entry.model,
        wilsonCell(entry.aggregate),
        pct(entry.aggregate.fields['amount']?.fieldAccuracy),
        pct(entry.aggregate.fields['date']?.fieldAccuracy),
        pct(entry.aggregate.fields['vendor']?.fieldAccuracy),
        pct(entry.aggregate.noAnswerRate),
        injectCell(entry.tasks),
      ]),
    ),
    'Amount, Date and Vendor show field accuracy: right values and rightly empty fields over all scored fields.',
    '',
  ]
}

function pooledSection(stats: readonly ModelStats[]): string[] {
  const row = (pooled: FieldMetrics): string[] => [
    pct(pooled.precision),
    pct(pooled.recall),
    pct(pooled.specificity),
    pct(pooled.hallucinationRate),
    pct(pooled.missRate),
  ]
  return [
    '## Precision, recall and the two ways to be wrong',
    '',
    'Pooled over all fields. Hallucination rate is a value returned where the document has none; miss rate is a null returned where the document has a value. Wrong values count against precision and recall but in neither rate.',
    '',
    ...table(
      ['Model', 'Precision', 'Recall', 'Specificity', 'Hallucination rate', 'Miss rate'],
      stats.map((entry) => [entry.model, ...row(entry.aggregate.pooled)]),
    ),
  ]
}

function costOf(entry: ModelStats): number | undefined {
  let total = 0
  for (const task of entry.tasks) {
    if (task.costUsd === undefined) return undefined
    total += task.costUsd
  }
  return total
}

function performanceSection(stats: readonly ModelStats[]): string[] {
  return [
    '## Latency, tokens and cost',
    '',
    'Latency is the last successful request of a call, without retries or backoff. Tokens are billed tokens per scored call. Cost is the total spend of every attempt, per 100 scored receipts.',
    '',
    ...table(
      ['Model', 'Latency p50 (s)', 'Latency p95 (s)', 'Mean input tokens', 'Mean output tokens', 'Total cost', 'Cost per 100 receipts'],
      stats.map((entry) => {
        const scored = entry.tasks.filter((task) => isScored(task) && task.status !== 'truncated')
        const latencies = scored.flatMap((task) => (task.latencyMs === undefined ? [] : [task.latencyMs / 1000]))
        const total = costOf(entry)
        const receipts = entry.aggregate.scoredCalls
        return [
          entry.model,
          num(percentile(latencies, 50)),
          num(percentile(latencies, 95)),
          num(mean(scored.map((task) => task.usage.inputTokens)), 0),
          num(mean(scored.map((task) => task.usage.outputTokens)), 0),
          usd(total),
          total === undefined || receipts === 0 ? 'n/a' : usd((total / receipts) * 100),
        ]
      }),
    ),
  ]
}

function breakdownSection(title: string, stats: readonly ModelStats[], keyOf: (row: ScoredRow, task: Task) => string): string[] {
  const rows: string[][] = []
  for (const entry of stats) {
    const groups = new Map<string, ScoredRow[]>()
    for (const task of entry.tasks.filter(isScored)) {
      const row = toRow(task)
      const key = keyOf(row, task)
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    for (const [key, groupRows] of [...groups].sort(([left], [right]) => (left < right ? -1 : 1))) {
      const result = aggregate(groupRows)
      rows.push([
        entry.model,
        key,
        String(result.scoredCalls),
        result.casePassRate === null ? 'n/a' : `${pct(result.casePassRate)} (${result.casePassCount}/${result.scoredCalls})`,
        result.scoredCalls < INDICATIVE_BELOW ? 'indicative only' : '',
      ])
    }
  }
  return [`## ${title}`, '', ...table(['Model', 'Group', 'n', 'Case pass', 'Note'], rows)]
}

function deltaSection(input: ReportInput, stats: readonly ModelStats[]): string[] {
  const [first, ...others] = stats
  const lines = ['## Paired deltas on case pass', '']
  if (first === undefined || others.length === 0) return [...lines, 'Needs at least two models.', '']
  lines.push(
    `Each model against ${first.model}, paired by case and rep, with a 95% bootstrap interval that resamples seeds (clusters). A positive delta favours the second model.`,
    '',
  )
  const rows = others.map((other) => {
    const result = clusterBootstrapDelta(first.rows, other.rows, passRateOf, { seed: input.meta.seed })
    if (result.delta === null || result.lo === null || result.hi === null) return [other.model, 'n/a', 'n/a', 'no paired rows', '0']
    const verdict = result.lo <= 0 && result.hi >= 0 ? 'not distinguishable' : result.delta > 0 ? 'better' : 'worse'
    return [
      other.model,
      `${signed(result.delta * 100)} points`,
      `${signed(result.lo * 100)} to ${signed(result.hi * 100)}`,
      verdict,
      `${result.groups} seeds, ${result.pairs} pairs`,
    ]
  })
  return [...lines, ...table(['Model', 'Delta', '95% interval', 'Verdict', 'Based on'], rows)]
}

const GRADED_CLASSES = new Set(['refusal', 'truncated', 'invalid_output', 'unexpected_shape'])

function errorSection(run: RunResult<unknown>, models: readonly string[]): string[] {
  const counts = new Map<string, Map<string, number>>()
  const bump = (failureClass: string, model: string): void => {
    const perModel = counts.get(failureClass) ?? new Map<string, number>()
    perModel.set(model, (perModel.get(model) ?? 0) + 1)
    counts.set(failureClass, perModel)
  }
  for (const task of run.tasks) {
    for (const attempt of task.failedAttempts) bump(attempt.failureClass, task.model)
    if (task.status !== 'failed' && task.failureClass !== undefined) bump(task.failureClass, task.model)
  }
  const skipped = run.tasks.filter((task) => task.status === 'skipped').length
  const failed = run.tasks.filter((task) => task.status === 'failed').length
  const lines = ['## Errors', '']
  if (counts.size === 0) lines.push('No failed attempts and no refusals.', '')
  else {
    lines.push(
      'Infrastructure classes are failed attempts that produced no answer; they never count as a null answer. Refusal, truncated and invalid-output rows are graded outcomes and stay in or out of the scores as described above.',
      '',
      ...table(
        ['Failure class', ...models, 'Treated as'],
        [...counts.keys()].sort().map((failureClass) => [
          failureClass,
          ...models.map((model) => String(counts.get(failureClass)?.get(model) ?? 0)),
          GRADED_CLASSES.has(failureClass) ? 'graded outcome' : 'infrastructure, excluded',
        ]),
      ),
    )
  }
  lines.push(`- Calls that failed after all attempts: ${failed} (no score, left out of every number).`)
  lines.push(`- Tasks skipped because of the budget: ${skipped}.`, '')
  return lines
}

function baselineSection(run: RunResult<unknown>, names: readonly string[]): string[] {
  const present = names.filter((name) => tasksOf(run, name).length > 0)
  if (present.length === 0) return []
  return [
    '## Baselines',
    '',
    'These rows are not models under test. All-null always answers nothing, oracle returns the expected values, regex is a naive extractor that reads text only. They show what the suite rewards without reading.',
    '',
    ...table(
      ['Baseline', 'Case pass', 'Precision', 'Recall', 'Specificity', 'Hallucination rate', 'Miss rate'],
      present.map((name) => {
        const result = statsOf(run, name).aggregate
        return [
          `${name} (baseline)`,
          result.casePassRate === null ? 'n/a' : `${pct(result.casePassRate)} (${result.casePassCount}/${result.scoredCalls})`,
          pct(result.pooled.precision),
          pct(result.pooled.recall),
          pct(result.pooled.specificity),
          pct(result.pooled.hallucinationRate),
          pct(result.pooled.missRate),
        ]
      }),
    ),
  ]
}

function suspectSection(run: RunResult<unknown>, models: readonly string[]): string[] {
  const lines = ['## Gold suspects', '']
  const real = new Set(models)
  const byCase = new Map<string, ScoredTask[]>()
  for (const task of run.tasks) {
    if (!real.has(task.model) || !isScored(task) || task.status === 'truncated') continue
    byCase.set(task.caseId, [...(byCase.get(task.caseId) ?? []), task])
  }
  const suspects = [...byCase]
    .filter(([, tasks]) => tasks.every((task) => !passed(toRow(task))))
    .sort(([left], [right]) => (left < right ? -1 : 1))
  if (suspects.length === 0) return [...lines, 'No case was missed by every model on every rep.', '']
  lines.push(
    'Cases that every real model missed on every rep. Read these first: the gold label or the document is the more likely culprit than all models at once.',
    '',
    ...table(
      ['Case', 'Calls', 'Fields that failed', 'Models'],
      suspects.map(([caseId, tasks]) => {
        const failedFields = new Set(
          tasks.flatMap((task) => Object.entries(task.score?.outcomes ?? {}).filter(([, outcome]) => !isPassingOutcome(outcome)).map(([field]) => field)),
        )
        return [caseId, String(tasks.length), [...failedFields].sort().join(', '), [...new Set(tasks.map((task) => task.model))].join(', ')]
      }),
    ),
  )
  return lines
}

function truncatedSection(run: RunResult<unknown>): string[] {
  const truncated = run.tasks.filter((task) => task.status === 'truncated')
  const lines = ['## Truncated rows', '']
  if (truncated.length === 0) return [...lines, 'None.', '']
  lines.push(
    `${plural(truncated.length, 'row')} left out of every mean because the reply was cut off:`,
    '',
    ...truncated.map((task) => `- ${task.caseId} rep ${task.rep} (${task.model})`),
    '',
  )
  return lines
}

export function renderReport(input: ReportInput): string {
  const { run, meta } = input
  const stats = meta.models.map((model) => statsOf(run, model))
  const seeds = new Set(
    run.tasks.filter((task) => isScored(task) && (meta.models.includes(task.model) || meta.models.length === 0)).map((task) => task.group),
  ).size
  const lines: string[] = [...headerSection(input, seeds)]
  if (stats.length === 0) lines.push('No model under test in this run.', '')
  else {
    lines.push(
      ...resultsSection(stats),
      ...pooledSection(stats),
      ...performanceSection(stats),
      ...breakdownSection('By difficulty', stats, (row) => row.category),
      ...breakdownSection('By fixture kind', stats, (_row, task) => task.kind),
      ...deltaSection(input, stats),
    )
    if (run.budgetUsd !== undefined) lines.push(`Budget: ${usd(run.budgetUsd)}, spent ${usd(run.spentUsd)}.`, '')
  }
  lines.push(
    ...errorSection(run, [...meta.models, ...meta.baselines.filter((name) => tasksOf(run, name).length > 0)]),
    ...baselineSection(run, meta.baselines),
    ...suspectSection(run, meta.models),
    ...truncatedSection(run),
  )
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`
}
