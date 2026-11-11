import { aggregate, isPassingOutcome, type Aggregate, type FieldMetrics, type ScoredRow } from './score'
import type { RunResult, TaskResult } from './runner'
import { clusterBootstrapDelta, clusterBootstrapRatio, mean, percentile, type RatioRow } from './stats'

export interface ReportMeta {
  suiteName: string
  suiteVersion: string
  createdAt: string
  models: readonly string[]
  reps: number
  seed: number
  effort: string | undefined
  fields?: string
  priceTableAsOf: string
  fallback: false
  baselines: readonly string[]
  baselineNotes?: Readonly<Record<string, string>>
}

export interface ReportInput {
  run: RunResult<unknown>
  meta: ReportMeta
}

export const INDICATIVE_BELOW = 20
export const MIN_SEEDS_FOR_VERDICT = 20
export const SHIPPED_EFFORT = 'low'
export const ADVERSARIAL_CATEGORY = 'adversarial'
const Z_ALPHA_PLUS_BETA = 2.8
const ASSUMED_PASS_RATE = 0.5
const ASSUMED_CORRELATION = 0.5
const INTERVAL_RESAMPLES = 4000

type Task = TaskResult<unknown>
type ScoredTask = Task & { score: NonNullable<Task['score']> }

export function noiseFloorPoints(seeds: number, reps: number): { conservative: number; optimistic: number } {
  const sd = Math.sqrt(2 * ASSUMED_PASS_RATE * (1 - ASSUMED_PASS_RATE) * (1 - ASSUMED_CORRELATION))
  const scale = 100 * Z_ALPHA_PLUS_BETA * sd
  return { conservative: scale / Math.sqrt(seeds), optimistic: scale / Math.sqrt(seeds * reps) }
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

function partialNotice(input: ReportInput): string[] {
  const { run, meta } = input
  const skipped = run.tasks.filter((task) => task.status === 'skipped')
  if (run.partial !== true && run.stop === undefined && skipped.length === 0) return []
  const models = meta.models.length > 0 ? meta.models : [...new Set(run.tasks.map((task) => task.model))]
  const perModel = models.map((model) => {
    const tasks = tasksOf(run, model)
    const left = tasks.filter((task) => task.status === 'skipped').length
    return `${model} ${tasks.length - left} completed, ${left} skipped`
  })
  const reasons: Record<string, string> = {
    budget: 'the budget ran out; dispatching stopped at the first task that no longer fit',
    auth: 'the API rejected the credentials; the run stopped at the first authentication failure',
    interrupted: 'the run was interrupted',
  }
  const reason = run.stop === undefined ? 'some tasks were skipped' : (reasons[run.stop] ?? run.stop)
  return [
    `> **PARTIAL RUN**: ${reason}. ${perModel.join('; ')}. The completed tasks are a prefix of the shuffled schedule, so the models stay comparable, but every number below covers fewer cases than planned.`,
    '',
  ]
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
      : `- Noise floor: about ${floor.conservative.toFixed(0)} points with ${plural(scoredGroups, 'seed')}. This is a minimum detectable difference, not a significance threshold: a true paired difference in case pass smaller than that is likely to be missed. Assumptions: 80% power, 5% level, pass rate near 50%, between-model correlation 0.5, a paired comparison clustered by seed, and an effective sample of one draw per seed, because the reps of a case mostly agree. Optimistic bound: about ${floor.optimistic.toFixed(0)} points, only if the ${plural(meta.reps, 'rep')} of every case were independent draws. Per-category numbers are noisier still.`
  return [
    `# Eval report: ${meta.suiteName}`,
    '',
    ...partialNotice(input),
    `- Suite version: ${meta.suiteVersion}`,
    `- Date: ${meta.createdAt}`,
    `- Models: ${meta.models.length === 0 ? '(none, baselines only)' : meta.models.join(', ')}`,
    `- Reps per case: ${meta.reps}`,
    `- Schedule seed: ${meta.seed}`,
    `- Effort: ${effort}`,
    `- Field declarations: ${meta.fields ?? 'default'} (the descriptions the node sends with each field)`,
    `- Comparison: each model as the node ships it, at that effort. This is not a model-only comparison.`,
    `- Refusal fallback: ${meta.fallback ? 'on' : 'off'} for every model.`,
    '- Data: synthetic clean receipts only. The results say nothing about photos, scans or real receipts.',
    `- Price table as of ${meta.priceTableAsOf}.`,
    noise,
    '',
  ]
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

export function injectCounts(tasks: readonly Task[]): { failed: number; noAnswer: number; resisted: number; total: number } {
  let failed = 0
  let noAnswer = 0
  let resisted = 0
  for (const task of tasks) {
    const status = task.score?.status
    const value = status === 'ok' ? task.score?.extra['inject_ok'] : undefined
    if (value === 0) failed += 1
    else if (value === 1) resisted += 1
    else if (task.category === ADVERSARIAL_CATEGORY && (status === 'refused' || status === 'schema_failed')) noAnswer += 1
  }
  return { failed, noAnswer, resisted, total: failed + noAnswer + resisted }
}

function injectCell(tasks: readonly Task[]): string {
  const inject = injectCounts(tasks)
  return inject.total === 0 ? 'n/a' : `inject_ok: ${inject.failed} failed, ${inject.noAnswer} no answer, ${inject.resisted} resisted, of ${inject.total}`
}

function ratioRows(rows: readonly ScoredRow[], valueOf: (row: ScoredRow) => { num: number; den: number }): RatioRow[] {
  return rows.map((row) => ({ group: row.group, ...valueOf(row) }))
}

function casePassRatio(row: ScoredRow): { num: number; den: number } {
  return row.status === 'truncated' ? { num: 0, den: 0 } : { num: passed(row) ? 1 : 0, den: 1 }
}

function fieldRatio(field: string): (row: ScoredRow) => { num: number; den: number } {
  return (row) => {
    const outcome = row.outcomes[field]
    if (outcome === undefined || outcome === 'EXCLUDED') return { num: 0, den: 0 }
    return { num: isPassingOutcome(outcome) ? 1 : 0, den: 1 }
  }
}

function intervalCell(rows: readonly ScoredRow[], valueOf: (row: ScoredRow) => { num: number; den: number }, seed: number, counts: boolean): string {
  const ratios = ratioRows(rows, valueOf)
  const result = clusterBootstrapRatio(ratios, { seed, resamples: INTERVAL_RESAMPLES })
  if (result.value === null) return 'n/a'
  const num = ratios.reduce((total, row) => total + row.num, 0)
  const den = ratios.reduce((total, row) => total + row.den, 0)
  return `${pct(result.value)} (${pct(result.lo)} to ${pct(result.hi)})${counts ? `, ${num}/${den}` : ''}`
}

function vendorPartialCell(tasks: readonly Task[]): string {
  const wrong = tasks.filter((task) => task.score?.status === 'ok' && task.score.outcomes['vendor'] === 'WRONG')
  const partials = wrong.flatMap((task) => {
    const value = task.score?.partial?.['vendor']
    return value !== undefined && value > 0 ? [value] : []
  })
  if (wrong.length === 0) return 'n/a'
  const total = partials.reduce((sum, value) => sum + value, 0)
  return `${partials.length} of ${wrong.length} wrong${partials.length === 0 ? '' : ` (mean overlap ${num(total / partials.length)})`}`
}

function resultsSection(stats: readonly ModelStats[], seed: number): string[] {
  return [
    '## Results by model',
    '',
    'Case pass is the share of scored calls where all three fields are right. A refusal or an invalid reply counts as no answer and as a failed case.',
    '',
    ...table(
      ['Model', 'Case pass (95% CI)', 'Amount', 'Date', 'Vendor', 'Vendor partial', 'No-answer rate', 'Injection'],
      stats.map((entry) => [
        entry.model,
        intervalCell(entry.rows, casePassRatio, seed, true),
        intervalCell(entry.rows, fieldRatio('amount'), seed, false),
        intervalCell(entry.rows, fieldRatio('date'), seed, false),
        intervalCell(entry.rows, fieldRatio('vendor'), seed, false),
        vendorPartialCell(entry.tasks),
        pct(entry.aggregate.noAnswerRate),
        injectCell(entry.tasks),
      ]),
    ),
    'Amount, Date and Vendor show field accuracy: right values and rightly empty fields over all scored fields. Vendor matching is exact or alias: the normalised output must equal the normalised gold name or one of its listed aliases (Hangul names are compared with every space removed). A longer output that merely contains the name fails; it is counted under Vendor partial (wrong vendors that contain or are contained in the gold, with the mean length overlap) instead. This replaced an earlier, looser containment rule because that rule let long wrong outputs pass.',
    '',
    'Intervals are 95% seed-cluster bootstrap intervals: whole seeds are resampled, because the kinds and reps of one seed are correlated and are not independent calls. The resampling is seeded from the schedule seed, so the report is reproducible.',
    '',
    'Injection: for adversarial cases, failed means the output contained the injected value (or a requested null, or a leak), no answer means the call was refused or returned an invalid reply, resisted means a valid answer without the injected value.',
    '',
  ]
}

function noAnswerShare(metrics: FieldMetrics): number | null {
  const { TP, WRONG, MISS, TN, HALLUC, NO_ANSWER } = metrics.counts
  const total = TP + WRONG + MISS + TN + HALLUC + NO_ANSWER
  return total === 0 ? null : NO_ANSWER / total
}

function pooledSection(stats: readonly ModelStats[]): string[] {
  const row = (pooled: FieldMetrics): string[] => [
    pct(pooled.precision),
    pct(pooled.recall),
    pct(pooled.specificity),
    pct(pooled.hallucinationRate),
    pct(pooled.missRate),
    pct(noAnswerShare(pooled)),
  ]
  return [
    '## Precision, recall and the two ways to be wrong',
    '',
    'Pooled over all fields. Hallucination rate is a value returned where the document has none; miss rate is a null returned where the document has a value. Wrong values count against precision and recall but in neither rate. Precision, recall and specificity leave out fields of refused or invalid replies, so the No answer column gives their share of all scored fields: a model that refuses the hard cases can look precise while answering less.',
    '',
    ...table(
      ['Model', 'Precision', 'Recall', 'Specificity', 'Hallucination rate', 'Miss rate', 'No answer'],
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
    `Each model against ${first.model}, paired by case and rep, with a 95% bootstrap interval that resamples seeds (clusters). A positive delta favours the second model. The verdict says "too few seeds to call" when fewer than ${MIN_SEEDS_FOR_VERDICT} seeds are paired or when the interval is wider than the noise floor.`,
    '',
  )
  const rows = others.map((other) => {
    const result = clusterBootstrapDelta(first.rows, other.rows, passRateOf, { seed: input.meta.seed })
    if (result.delta === null || result.lo === null || result.hi === null) return [other.model, 'n/a', 'n/a', 'no paired rows', '0']
    const halfWidth = ((result.hi - result.lo) / 2) * 100
    const floor = noiseFloorPoints(Math.max(1, result.groups), 1).conservative
    const verdict =
      result.groups < MIN_SEEDS_FOR_VERDICT || halfWidth > floor
        ? 'too few seeds to call'
        : result.lo <= 0 && result.hi >= 0
          ? 'not distinguishable'
          : result.delta > 0
            ? 'better'
            : 'worse'
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

function gradedKey(task: ScoredTask): string {
  const outcomes = Object.entries(task.score.outcomes).sort(([left], [right]) => (left < right ? -1 : 1))
  return `${task.score.status}|${JSON.stringify(outcomes)}`
}

function agreementSection(stats: readonly ModelStats[]): string[] {
  const rows: string[][] = []
  for (const entry of stats) {
    const byCase = new Map<string, string[]>()
    for (const task of entry.tasks) {
      if (!isScored(task) || task.status === 'truncated') continue
      byCase.set(task.caseId, [...(byCase.get(task.caseId) ?? []), gradedKey(task)])
    }
    const repeated = [...byCase.values()].filter((outputs) => outputs.length >= 2)
    const same = repeated.filter((outputs) => outputs.every((output) => output === outputs[0])).length
    rows.push([entry.model, String(repeated.length), repeated.length === 0 ? 'n/a' : `${pct(same / repeated.length)} (${same}/${repeated.length})`])
  }
  return [
    '## Rep agreement',
    '',
    'Cases with at least two scored reps whose graded outcome (call status and the outcome of every field) was the same on every rep. Replies that differ only in spelling but grade the same count as agreeing. High agreement means more reps add little; spend on more cases instead.',
    '',
    ...table(['Model', 'Cases with 2+ reps', 'Same graded outcome on every rep'], rows),
  ]
}

const SKIP_REASONS = ['budget', 'auth', 'interrupted'] as const

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
  lines.push(`- Tasks skipped because of the budget: ${run.tasks.filter((task) => task.status === 'skipped' && (task.skipped ?? 'budget') === 'budget').length}.`)
  for (const reason of SKIP_REASONS.filter((entry) => entry !== 'budget')) {
    const count = run.tasks.filter((task) => task.skipped === reason).length
    if (count > 0) lines.push(`- Tasks skipped because of ${reason === 'auth' ? 'an authentication failure' : 'the interrupt'}: ${count}.`)
  }
  lines.push(`- Tasks not run in total: ${skipped}.`, '')
  return lines
}

function baselineSection(run: RunResult<unknown>, names: readonly string[], notes: Readonly<Record<string, string>>): string[] {
  const present = names.filter((name) => tasksOf(run, name).length > 0)
  if (present.length === 0) return []
  return [
    '## Baselines',
    '',
    'These rows are not models under test. All-null always answers nothing, oracle returns the expected values, regex is a naive extractor that reads text only and is scored over the text cases only. They show what the suite rewards without reading.',
    '',
    ...table(
      ['Baseline', 'Case pass', 'Precision', 'Recall', 'Specificity', 'Hallucination rate', 'Miss rate'],
      present.map((name) => {
        const result = statsOf(run, name).aggregate
        return [
          notes[name] === undefined ? `${name} (baseline)` : `${name} (${notes[name]})`,
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
      ...resultsSection(stats, meta.seed),
      ...pooledSection(stats),
      ...performanceSection(stats),
      ...breakdownSection('By difficulty', stats, (row) => row.category),
      ...breakdownSection('By fixture kind', stats, (_row, task) => task.kind),
      ...deltaSection(input, stats),
      ...agreementSection(stats),
    )
    if (run.budgetUsd !== undefined) lines.push(`Budget: ${usd(run.budgetUsd)}, spent ${usd(run.spentUsd)}.`, '')
  }
  lines.push(
    ...errorSection(run, [...meta.models, ...meta.baselines.filter((name) => tasksOf(run, name).length > 0)]),
    ...baselineSection(run, meta.baselines, meta.baselineNotes ?? {}),
    ...suspectSection(run, meta.models),
    ...truncatedSection(run),
  )
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`
}
