import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LlmEffort } from '@rill/llm'
import { PRICE_TABLE_AS_OF, priceFor } from './pricing'
import { createEvalProvider } from './record'
import { renderReport } from './report'
import { PACKAGE_ROOT, assertWritableDir, writeResults } from './results'
import { estimateRun, runEval, type RunEstimate, type RunResult, type TaskResult } from './runner'
import { aggregate, type ScoredRow } from './score'
import { BASELINE_NAMES, baselineEvalProviders } from './suites/extract/baselines'
import { FIXTURE_KINDS, type FixtureKind } from './suites/extract/fixtures'
import {
  PDF_INPUT_TOKENS,
  PNG_INPUT_TOKENS,
  TEXT_CHARS_PER_TOKEN,
  TEXT_OVERHEAD_TOKENS,
  createExtractSuite,
  sentRequestOf,
  verifyFixtures,
  type ExtractOutput,
  type ExtractSuite,
} from './suites/extract/suite'

export const DEFAULT_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const
export const PILOT_SEEDS = ['easy-ko-cafe-yeonnam', 'tricky-en-card-approval-vs-total', 'adv-en-ignore-instructions'] as const
export const DEFAULT_REPS = 3
export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_MAX_CALL_SECONDS = 60
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_SEED = 1
export const BUDGET_FACTOR = 1.5
export const DEFAULT_OUT_ROOT = join(PACKAGE_ROOT, 'results')

const EFFORTS = ['low', 'medium', 'high'] as const
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/u
const PROGRESS_EVERY = 10
const COMMAND = 'pnpm eval extract'

export const USAGE = `usage: ${COMMAND} [options]

Measures how well models extract amount, date and vendor from receipts.
Without --yes nothing is sent: it prints the plan, a cost estimate and the command that would run it.

options:
  --models <a,b,c>        models to compare (default: ${DEFAULT_MODELS.join(',')})
  --reps <n>              repetitions per case and model (default: ${DEFAULT_REPS})
  --concurrency <n>       calls in flight at once (default: ${DEFAULT_CONCURRENCY})
  --kinds <text,pdf,png>  fixture kinds to include (default: all)
  --only <ids>            a seed id substring, or a comma list of exact seed ids
  --pilot                 three fixed seeds, all kinds, one rep
  --effort <low|medium|high>  override the effort of the node (default: the node's own, low)
  --budget-usd <usd>      spending cap (default: ${BUDGET_FACTOR} x the estimate, rounded up to a cent)
  --max-call-seconds <n>  ceiling for one call, retries included per attempt (default: ${DEFAULT_MAX_CALL_SECONDS})
  --max-attempts <n>      attempts per call for transient failures (default: ${DEFAULT_MAX_ATTEMPTS})
  --seed <n>              schedule and bootstrap seed (default: ${DEFAULT_SEED})
  --out <dir>             results directory (default: packages/eval/results/extract-<timestamp>)
  --baselines             run only the baselines (all-null, oracle, regex): no key, no network, no cost
  --yes                   really call the API; needs ANTHROPIC_API_KEY in the environment
  -h, --help              show this text

exit codes: 0 done, 1 runtime error, 2 usage error
`

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface CliConfig {
  models: string[]
  reps: number
  concurrency: number
  kinds: FixtureKind[]
  only: string | string[] | undefined
  pilot: boolean
  effort: LlmEffort | undefined
  budgetUsd: number | undefined
  maxCallSeconds: number
  maxAttempts: number
  seed: number
  out: string | undefined
  baselines: boolean
  yes: boolean
  help: boolean
}

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  now: () => number
  fixturesDir?: string
  outRoot?: string
}

function integerOption(name: string, raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/u.test(raw) || Number(raw) < minimum) throw new UsageError(`${name} must be an integer of at least ${minimum}`)
  return Number(raw)
}

function listOption(name: string, raw: string): string[] {
  const items = raw.split(',').map((item) => item.trim())
  if (items.some((item) => item === '')) throw new UsageError(`${name} must be a comma separated list without empty entries`)
  if (new Set(items).size !== items.length) throw new UsageError(`${name} lists an entry twice`)
  return items
}

const OPTIONS = {
  models: { type: 'string' },
  reps: { type: 'string' },
  concurrency: { type: 'string' },
  kinds: { type: 'string' },
  only: { type: 'string' },
  pilot: { type: 'boolean' },
  effort: { type: 'string' },
  'budget-usd': { type: 'string' },
  'max-call-seconds': { type: 'string' },
  'max-attempts': { type: 'string' },
  seed: { type: 'string' },
  out: { type: 'string' },
  baselines: { type: 'boolean' },
  yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export function parseCli(argv: readonly string[]): CliConfig {
  const { values, positionals } = parseOptions(argv)
  if (values.help === true) return { ...emptyConfig(), help: true }
  const [command, ...extra] = positionals
  if (command !== 'extract') throw new UsageError(command === undefined ? 'missing command: extract' : `unknown command: ${command}`)
  if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`)

  const pilot = values.pilot === true
  const baselines = values.baselines === true
  const yes = values.yes === true
  if (pilot && (values.only !== undefined || values.kinds !== undefined || values.reps !== undefined)) {
    throw new UsageError('--pilot cannot be combined with --only, --kinds or --reps')
  }
  if (baselines) {
    for (const name of ['models', 'reps', 'effort', 'budget-usd'] as const) {
      if (values[name] !== undefined) throw new UsageError(`--baselines cannot be combined with --${name}`)
    }
    if (yes) throw new UsageError('--baselines cannot be combined with --yes: baselines never call the API')
  }
  const models = values.models === undefined ? [...DEFAULT_MODELS] : listOption('--models', values.models)
  for (const model of models) if (!MODEL_ID.test(model)) throw new UsageError(`--models must list model ids, got: ${model}`)
  const kinds = values.kinds === undefined ? [...FIXTURE_KINDS] : listOption('--kinds', values.kinds)
  for (const kind of kinds) if (!(FIXTURE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kinds accepts ${FIXTURE_KINDS.join(', ')}, got: ${kind}`)
  let effort: LlmEffort | undefined
  if (values.effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(values.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`)
    effort = values.effort as LlmEffort
  }
  let budgetUsd: number | undefined
  if (values['budget-usd'] !== undefined) {
    budgetUsd = Number(values['budget-usd'])
    if (!/^\d+(\.\d+)?$/u.test(values['budget-usd']) || !(budgetUsd > 0)) throw new UsageError('--budget-usd must be a positive number')
  }
  let only: string | string[] | undefined
  if (pilot) only = [...PILOT_SEEDS]
  else if (values.only !== undefined) {
    if (values.only.trim() === '') throw new UsageError('--only must not be empty')
    only = values.only.includes(',') ? listOption('--only', values.only) : values.only
  }
  return {
    models,
    reps: pilot ? 1 : integerOption('--reps', values.reps, DEFAULT_REPS, 1),
    concurrency: integerOption('--concurrency', values.concurrency, DEFAULT_CONCURRENCY, 1),
    kinds: kinds as FixtureKind[],
    only,
    pilot,
    effort,
    budgetUsd,
    maxCallSeconds: integerOption('--max-call-seconds', values['max-call-seconds'], DEFAULT_MAX_CALL_SECONDS, 1),
    maxAttempts: integerOption('--max-attempts', values['max-attempts'], DEFAULT_MAX_ATTEMPTS, 1),
    seed: integerOption('--seed', values.seed, DEFAULT_SEED, 0),
    out: values.out,
    baselines,
    yes,
    help: false,
  }
}


function emptyConfig(): CliConfig {
  return {
    models: [...DEFAULT_MODELS],
    reps: DEFAULT_REPS,
    concurrency: DEFAULT_CONCURRENCY,
    kinds: [...FIXTURE_KINDS],
    only: undefined,
    pilot: false,
    effort: undefined,
    budgetUsd: undefined,
    maxCallSeconds: DEFAULT_MAX_CALL_SECONDS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    seed: DEFAULT_SEED,
    out: undefined,
    baselines: false,
    yes: false,
    help: false,
  }
}

export function defaultBudgetUsd(estimateUsd: number): number {
  return Math.ceil(estimateUsd * BUDGET_FACTOR * 100 - 1e-9) / 100
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function money(value: number | undefined): string {
  return value === undefined ? 'n/a' : `$${value.toFixed(value < 1 ? 4 : 2)}`
}

function budgetFor(config: CliConfig, estimate: RunEstimate): number | undefined {
  if (config.budgetUsd !== undefined) return config.budgetUsd
  return estimate.totalUsd === undefined ? undefined : defaultBudgetUsd(estimate.totalUsd)
}

export function commandLine(config: CliConfig, budgetUsd: number | undefined): string {
  const parts = [COMMAND, '--yes']
  if (config.pilot) parts.push('--pilot')
  else {
    if (config.only !== undefined) parts.push('--only', Array.isArray(config.only) ? config.only.join(',') : config.only)
    parts.push('--reps', String(config.reps))
    if (config.kinds.length !== FIXTURE_KINDS.length) parts.push('--kinds', config.kinds.join(','))
  }
  parts.push('--models', config.models.join(','))
  if (config.effort !== undefined) parts.push('--effort', config.effort)
  if (config.concurrency !== DEFAULT_CONCURRENCY) parts.push('--concurrency', String(config.concurrency))
  if (config.maxCallSeconds !== DEFAULT_MAX_CALL_SECONDS) parts.push('--max-call-seconds', String(config.maxCallSeconds))
  if (config.maxAttempts !== DEFAULT_MAX_ATTEMPTS) parts.push('--max-attempts', String(config.maxAttempts))
  if (config.seed !== DEFAULT_SEED) parts.push('--seed', String(config.seed))
  if (config.out !== undefined) parts.push('--out', config.out)
  if (budgetUsd !== undefined) parts.push('--budget-usd', budgetUsd.toFixed(2))
  return parts.join(' ')
}

function planText(config: CliConfig, suite: ExtractSuite, estimate: RunEstimate, budgetUsd: number | undefined): string {
  const cases = suite.cases()
  const seeds = new Set(cases.map((testCase) => testCase.group)).size
  const lines = [
    `rill eval: ${suite.name} (suite version ${suite.version})`,
    '',
    `cases: ${plural(seeds, 'seed')} x ${plural(config.kinds.length, 'kind')} (${config.kinds.join(', ')}) = ${plural(cases.length, 'case')}${config.pilot ? ' (pilot)' : ''}`,
    `models: ${config.models.join(', ')}`,
    `reps: ${config.reps}`,
    `calls: ${estimate.calls} (${plural(cases.length, 'case')} x ${plural(config.reps, 'rep')} x ${plural(config.models.length, 'model')})`,
    `effort: ${config.effort === undefined ? 'low (the node ships it)' : `${config.effort} (override)`}`,
    `schedule seed ${config.seed}, concurrency ${config.concurrency}, at most ${config.maxAttempts} attempts per call, ${config.maxCallSeconds} s per attempt`,
    '',
    `estimate (prices as of ${PRICE_TABLE_AS_OF}):`,
    ...estimate.perModel.map((entry) => `  ${entry.model}: ${plural(entry.calls, 'call')}, ${priceFor(entry.model) === undefined ? 'no price in the price table' : money(entry.usd)}`),
    `  total: ${money(estimate.totalUsd)}`,
    `assumptions: input tokens per call are chars / ${TEXT_CHARS_PER_TOKEN} + ${TEXT_OVERHEAD_TOKENS} for text, ${PDF_INPUT_TOKENS} for a PDF and ${PNG_INPUT_TOKENS} for a PNG; ${estimate.assumptions.outputTokens} output tokens per call; no retries. These are estimates, not measurements.`,
  ]
  if (estimate.unpricedModels.length > 0) {
    lines.push(`no price for: ${estimate.unpricedModels.join(', ')}; the budget guard needs one, so --yes would refuse this run`)
  }
  lines.push(
    budgetUsd === undefined
      ? 'budget: n/a (needs a price for every model)'
      : `budget: ${money(budgetUsd)} (${config.budgetUsd === undefined ? `${BUDGET_FACTOR} x the estimate, rounded up to a cent` : 'from --budget-usd'})`,
    '',
    'Nothing was sent. To run it for real (needs ANTHROPIC_API_KEY in the environment):',
    `  ${commandLine(config, budgetUsd)}`,
    '',
  )
  return lines.join('\n')
}

function summaryTable(tasksOf: (name: string) => TaskResult<ExtractOutput>[], names: readonly string[]): string {
  const rows = names.map((name) => {
    const tasks = tasksOf(name)
    const scored: ScoredRow[] = tasks.flatMap((task) =>
      task.score === undefined
        ? []
        : [{ caseId: task.caseId, group: task.group, category: task.category, model: task.model, rep: task.rep, status: task.score.status, outcomes: task.score.outcomes }],
    )
    const result = aggregate(scored)
    const cost = tasks.reduce<number | undefined>((total, task) => (total === undefined || task.costUsd === undefined ? undefined : total + task.costUsd), 0)
    const failed = tasks.filter((task) => task.status === 'failed').length
    return [
      name,
      result.casePassRate === null ? 'n/a' : `${(result.casePassRate * 100).toFixed(1)}% (${result.casePassCount}/${result.scoredCalls})`,
      result.pooled.fieldAccuracy === null ? 'n/a' : `${(result.pooled.fieldAccuracy * 100).toFixed(1)}%`,
      String(failed),
      money(cost),
    ]
  })
  const header = ['model', 'case pass', 'field accuracy', 'failed calls', 'cost']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

function timestamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
}

function outDirFor(config: CliConfig, io: CliIo): string {
  return config.out ?? join(io.outRoot ?? DEFAULT_OUT_ROOT, `extract-${timestamp(io.now())}`)
}

function progressPrinter(io: CliIo, total: number): (task: TaskResult<ExtractOutput>) => void {
  let done = 0
  return () => {
    done += 1
    if (done % PROGRESS_EVERY === 0 || done === total) io.stderr(`progress: ${done}/${total}\n`)
  }
}

function makeSuite(config: CliConfig, io: CliIo): ExtractSuite {
  try {
    return createExtractSuite({
      kinds: config.kinds,
      ...(config.only === undefined ? {} : { only: config.only }),
      ...(io.fixturesDir === undefined ? {} : { fixturesDir: io.fixturesDir }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no seed id contains|unknown seed id/u.test(message)) throw new UsageError(`--only: ${message}`)
    throw error
  }
}

async function runBaselines(config: CliConfig, suite: ExtractSuite): Promise<RunResult<ExtractOutput>> {
  const create = baselineEvalProviders(suite.cases())
  return runEval({
    suite,
    models: [...BASELINE_NAMES],
    reps: 1,
    concurrency: config.concurrency,
    maxAttempts: config.maxAttempts,
    maxCallMs: config.maxCallSeconds * 1000,
    seed: config.seed,
    createProvider: (model) => create(model),
  })
}

function reportMeta(config: CliConfig, suite: ExtractSuite, io: CliIo, models: readonly string[], reps: number) {
  return {
    suiteName: suite.name,
    suiteVersion: suite.version,
    createdAt: new Date(io.now()).toISOString(),
    models,
    reps,
    seed: config.seed,
    effort: config.effort,
    priceTableAsOf: PRICE_TABLE_AS_OF,
    fallback: false as const,
    baselines: [...BASELINE_NAMES],
  }
}

function resultsMeta(config: CliConfig, suite: ExtractSuite, io: CliIo, models: readonly string[], reps: number, secrets: readonly string[]) {
  return {
    suiteName: suite.name,
    suiteVersion: suite.version,
    createdAt: new Date(io.now()).toISOString(),
    seed: config.seed,
    reps,
    effort: config.effort ?? 'low',
    fields: suite.fields,
    models,
    cases: suite.cases(),
    sentRequestOf,
    secrets,
  }
}

function writeAll(
  out: string,
  results: RunResult<ExtractOutput>,
  reportRun: RunResult<ExtractOutput>,
  config: CliConfig,
  suite: ExtractSuite,
  io: CliIo,
  models: readonly string[],
  reps: number,
  secrets: readonly string[],
): string {
  writeResults(out, results, resultsMeta(config, suite, io, models, reps, secrets))
  const reportPath = join(out, 'report.md')
  const meta = reportMeta(config, suite, io, config.baselines ? [] : models, reps)
  writeFileSync(reportPath, renderReport({ run: reportRun, meta }))
  return reportPath
}

async function runBaselinesMode(config: CliConfig, suite: ExtractSuite, io: CliIo): Promise<number> {
  const out = outDirFor(config, io)
  assertWritableDir(out)
  const run = await runBaselines(config, suite)
  const reportPath = writeAll(out, run, run, config, suite, io, [...BASELINE_NAMES], 1, [])
  io.stdout(`baselines on ${suite.cases().length} cases (no API call, no cost)\n\n${summaryTable((name) => run.tasks.filter((task) => task.model === name), BASELINE_NAMES)}\n\n`)
  io.stdout(`results: ${out}\nreport: ${reportPath}\n`)
  return 0
}

async function runYesMode(config: CliConfig, suite: ExtractSuite, io: CliIo, estimate: RunEstimate, budgetUsd: number | undefined): Promise<number> {
  const key = io.env['ANTHROPIC_API_KEY']
  if (key === undefined || key === '') {
    io.stderr('error: ANTHROPIC_API_KEY is not set; --yes needs it in the environment\n')
    return 1
  }
  if (estimate.unpricedModels.length > 0) {
    io.stderr(`error: no price for model ${estimate.unpricedModels.join(', ')}; the budget guard needs one\n`)
    return 1
  }
  if (budgetUsd === undefined) throw new Error('no budget could be computed')
  const out = outDirFor(config, io)
  assertWritableDir(out)
  io.stdout(`notice: the synthetic fixture documents (receipts as text, PDF and PNG) are sent to the Anthropic API for ${config.models.join(', ')}\n`)
  io.stdout(`budget: ${money(budgetUsd)}, ${estimate.calls} calls planned, results go to ${out}\n`)
  const progress = progressPrinter(io, estimate.calls)
  const real = await runEval({
    suite,
    models: config.models,
    reps: config.reps,
    concurrency: config.concurrency,
    maxAttempts: config.maxAttempts,
    maxCallMs: config.maxCallSeconds * 1000,
    budgetUsd,
    seed: config.seed,
    now: io.now,
    createProvider: (model, signal) => createEvalProvider({ model, signal, clock: io.now, apiKey: key, ...(config.effort === undefined ? {} : { effort: config.effort }) }),
    onTask: progress,
  })
  const baselineRun = await runBaselines(config, suite)
  const combined: RunResult<ExtractOutput> = { tasks: [...real.tasks, ...baselineRun.tasks], spentUsd: real.spentUsd, budgetUsd: real.budgetUsd }
  const reportPath = writeAll(out, real, combined, config, suite, io, config.models, config.reps, [key])
  io.stdout(`\n${summaryTable((name) => real.tasks.filter((task) => task.model === name), config.models)}\n\n`)
  io.stdout(`total cost: ${money(real.spentUsd)} of a ${money(budgetUsd)} budget\n`)
  const skipped = real.tasks.filter((task) => task.status === 'skipped').length
  if (skipped > 0) {
    io.stdout(`notice: ${skipped} of ${real.tasks.length} tasks were skipped because of the budget; raise --budget-usd to run them\n`)
  }
  io.stdout(`results: ${out}\nreport: ${reportPath}\n`)
  return 0
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let secret: string | undefined
  try {
    const config = parseCli(argv)
    if (config.help) {
      io.stdout(USAGE)
      return 0
    }
    secret = io.env['ANTHROPIC_API_KEY']
    const suite = makeSuite(config, io)
    const problems = verifyFixtures(suite)
    if (problems.length > 0) {
      io.stderr(`error: the fixtures are not usable:\n${problems.slice(0, 10).map((problem) => `  ${problem}`).join('\n')}\n`)
      return 1
    }
    if (config.baselines) return await runBaselinesMode(config, suite, io)
    const estimate = estimateRun({ suite, models: config.models, reps: config.reps })
    const budgetUsd = budgetFor(config, estimate)
    if (!config.yes) {
      io.stdout(planText(config, suite, estimate, budgetUsd))
      return 0
    }
    return await runYesMode(config, suite, io, estimate, budgetUsd)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${USAGE}`)
      return 2
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`error: ${secret === undefined || secret === '' ? message : message.split(secret).join('[redacted]')}\n`)
    return 1
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return import.meta.url === pathToFileURL(entry).href
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    now: Date.now,
  })
}
