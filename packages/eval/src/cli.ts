import { realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LlmEffort } from '@rill/llm'
import { formatUsdPlain, guardReserveUsd, money, plural, roundUpBudget, worstCallUsd } from './budget'
import { PilotDirError, readPilot } from './pilot'
import { PRICE_TABLE_AS_OF, priceFor } from './pricing'
import { DEFAULT_MAX_OUTPUT_TOKENS, createEvalProvider } from './record'
import { reestimate, type PilotData } from './reestimate'
import { reestimateText } from './reestimate-text'
import { renderReport } from './report'
import { PACKAGE_ROOT, appendPartial, assertWritableDir, writeResults } from './results'
import { breakEvenOutputTokens, estimateRun, runEval, type RunEstimate, type RunResult, type TaskResult } from './runner'
import { aggregate, type ScoredRow } from './score'
import { BASELINE_KINDS, BASELINE_NAMES, BASELINE_NOTES, baselineEvalProviders } from './suites/extract/baselines'
import { FIXTURE_KINDS, type FixtureKind } from './suites/extract/fixtures'
import {
  PDF_INPUT_TOKENS,
  PNG_INPUT_TOKENS,
  TEXT_CHARS_PER_TOKEN,
  TEXT_OVERHEAD_TOKENS,
  createExtractSuite,
  extractVersions,
  sentRequestOf,
  verifyFixtures,
  type ExtractOutput,
  type ExtractSuite,
} from './suites/extract/suite'
import { FIELD_VARIANT_NAMES, type FieldVariant } from './suites/extract/fields'

export const DEFAULT_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const
export const PILOT_SEEDS = ['easy-ko-cafe-yeonnam', 'tricky-en-card-approval-vs-total', 'adv-en-ignore-instructions'] as const
export const DEFAULT_REPS = 3
export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_MAX_CALL_SECONDS = 60
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_SEED = 1
export const DEFAULT_MAX_OUTPUT = DEFAULT_MAX_OUTPUT_TOKENS
export const SUGGESTED_BUDGET_FACTOR = 2
export const PILOT_MAX_OUTPUT_TOKENS = 4000
export const DEFAULT_OUT_ROOT = join(PACKAGE_ROOT, 'results')
export const DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2
export const EXIT_PARTIAL = 3
export const EXIT_INTERRUPTED = 130

export const LIMITS = {
  reps: { min: 1, max: 20 },
  concurrency: { min: 1, max: 16 },
  maxCallSeconds: { min: 1, max: 600 },
  maxAttempts: { min: 1, max: 10 },
  maxOutputTokens: { min: 1, max: 64_000 },
  seed: { min: 0, max: 4_294_967_295 },
} as const

const EFFORTS = ['low', 'medium', 'high'] as const
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/u
const PROGRESS_EVERY = 10
const COMMAND = 'pnpm eval extract'
const SDK_TIMEOUT_MARGIN_MS = 5000

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
  --fields <default|strict>   field descriptions sent with the three fields (strict: null unless the document is a receipt or invoice)
  --budget-usd <usd>      spending cap, required with --yes (the plan prints a suggested value)
  --max-output-tokens <n> max_tokens per request, also the budget guard's worst case per call
                          (default: ${DEFAULT_MAX_OUTPUT_TOKENS}, as the node ships; at most ${LIMITS.maxOutputTokens.max}; thinking counts against it)
  --max-call-seconds <n>  ceiling for one attempt, ${LIMITS.maxCallSeconds.min} to ${LIMITS.maxCallSeconds.max} (default: ${DEFAULT_MAX_CALL_SECONDS})
  --max-attempts <n>      attempts per call for transient failures, at most ${LIMITS.maxAttempts.max} (default: ${DEFAULT_MAX_ATTEMPTS})
  --seed <n>              schedule and bootstrap seed, 0 to ${LIMITS.seed.max} (default: ${DEFAULT_SEED})
  --out <dir>             results directory (default: packages/eval/results/extract-<timestamp>)
  --allow-base-url        allow an ANTHROPIC_BASE_URL other than ${DEFAULT_BASE_URL}, or ANTHROPIC_CUSTOM_HEADERS
                          (the key is sent to that host)
  --baselines             run only the baselines (all-null, oracle, regex): no key, no network, no cost
  --reestimate <dir>      re-estimate the full run from the results directory of a pilot: a projection from the measured usage,
                          a suggested budget and the command to run it; no key, no network, writes nothing;
                          takes --models, --reps, --kinds, --only, --max-output-tokens and --concurrency
  --yes                   really call the API; needs ANTHROPIC_API_KEY in the environment and --budget-usd
  -h, --help              show this text

limits: --reps ${LIMITS.reps.min} to ${LIMITS.reps.max}, --concurrency ${LIMITS.concurrency.min} to ${LIMITS.concurrency.max}

exit codes: 0 done, 1 runtime error (also: stopped at an authentication failure), 2 usage error,
3 partial run (the budget ran out; the report is marked PARTIAL), 130 interrupted (SIGINT or SIGTERM)
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
  fields: FieldVariant
  budgetUsd: number | undefined
  maxOutputTokens: number
  maxCallSeconds: number
  maxAttempts: number
  seed: number
  out: string | undefined
  allowBaseUrl: boolean
  baselines: boolean
  reestimate: string | undefined
  yes: boolean
  help: boolean
}

export type SignalSubscriber = (handler: (signal: string) => void) => () => void

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  now: () => number
  fixturesDir?: string
  outRoot?: string
  onSignal?: SignalSubscriber
}

function integerOption(name: string, raw: string | undefined, fallback: number, limits: { min: number; max: number }): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
    throw new UsageError(`${name} must be an integer from ${limits.min} to ${limits.max}`)
  }
  return value
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
  fields: { type: 'string' },
  'budget-usd': { type: 'string' },
  'max-output-tokens': { type: 'string' },
  'max-call-seconds': { type: 'string' },
  'max-attempts': { type: 'string' },
  seed: { type: 'string' },
  out: { type: 'string' },
  'allow-base-url': { type: 'boolean' },
  baselines: { type: 'boolean' },
  reestimate: { type: 'string' },
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
  const reestimateDir = values.reestimate
  if (reestimateDir !== undefined) {
    if (reestimateDir.trim() === '') throw new UsageError('--reestimate needs the results directory of a pilot')
    for (const name of ['pilot', 'baselines', 'yes', 'budget-usd', 'effort', 'max-call-seconds', 'max-attempts', 'seed', 'out', 'allow-base-url'] as const) {
      if (values[name] !== undefined) throw new UsageError(`--reestimate cannot be combined with --${name}`)
    }
  }
  if (pilot && (values.only !== undefined || values.kinds !== undefined || values.reps !== undefined)) {
    throw new UsageError('--pilot cannot be combined with --only, --kinds or --reps')
  }
  if (baselines) {
    for (const name of ['models', 'reps', 'effort', 'budget-usd', 'max-output-tokens', 'allow-base-url'] as const) {
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
  let fields: FieldVariant = 'default'
  if (values.fields !== undefined) {
    if (!(FIELD_VARIANT_NAMES as readonly string[]).includes(values.fields)) throw new UsageError(`--fields must be one of ${FIELD_VARIANT_NAMES.join(', ')}`)
    fields = values.fields as FieldVariant
  }
  let budgetUsd: number | undefined
  if (values['budget-usd'] !== undefined) {
    budgetUsd = Number(values['budget-usd'])
    if (!/^\d+(\.\d+)?$/u.test(values['budget-usd']) || !Number.isFinite(budgetUsd) || !(budgetUsd > 0)) {
      throw new UsageError('--budget-usd must be a finite positive number of dollars, for example 2.50')
    }
  }
  if (yes && budgetUsd === undefined) {
    throw new UsageError('--yes needs --budget-usd: run the command without --yes to see the estimate and a suggested budget')
  }
  let only: string | string[] | undefined
  if (pilot) only = [...PILOT_SEEDS]
  else if (values.only !== undefined) {
    if (values.only.trim() === '') throw new UsageError('--only must not be empty')
    only = values.only.includes(',') ? listOption('--only', values.only) : values.only
  }
  return {
    models,
    reps: pilot ? 1 : integerOption('--reps', values.reps, DEFAULT_REPS, LIMITS.reps),
    concurrency: integerOption('--concurrency', values.concurrency, DEFAULT_CONCURRENCY, LIMITS.concurrency),
    kinds: kinds as FixtureKind[],
    only,
    pilot,
    effort,
    fields,
    budgetUsd,
    maxOutputTokens: integerOption('--max-output-tokens', values['max-output-tokens'], pilot ? PILOT_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS, LIMITS.maxOutputTokens),
    maxCallSeconds: integerOption('--max-call-seconds', values['max-call-seconds'], DEFAULT_MAX_CALL_SECONDS, LIMITS.maxCallSeconds),
    maxAttempts: integerOption('--max-attempts', values['max-attempts'], DEFAULT_MAX_ATTEMPTS, LIMITS.maxAttempts),
    seed: integerOption('--seed', values.seed, DEFAULT_SEED, LIMITS.seed),
    out: values.out,
    allowBaseUrl: values['allow-base-url'] === true,
    baselines,
    reestimate: reestimateDir,
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
    fields: 'default',
    budgetUsd: undefined,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxCallSeconds: DEFAULT_MAX_CALL_SECONDS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    seed: DEFAULT_SEED,
    out: undefined,
    allowBaseUrl: false,
    baselines: false,
    reestimate: undefined,
    yes: false,
    help: false,
  }
}

export function suggestedBudgetUsd(estimateUsd: number, reserveUsd = 0): number {
  return roundUpBudget(Math.max(estimateUsd * SUGGESTED_BUDGET_FACTOR, estimateUsd + reserveUsd))
}

export { formatUsdPlain }

function budgetFor(config: CliConfig, estimate: RunEstimate, suite: ExtractSuite): number | undefined {
  if (config.budgetUsd !== undefined) return config.budgetUsd
  if (estimate.totalUsd === undefined) return undefined
  const worst = worstCallUsd(suite, config.models, config.maxOutputTokens)
  return suggestedBudgetUsd(estimate.totalUsd, guardReserveUsd(worst, config.concurrency, estimate.calls))
}

export function commandLine(config: CliConfig, budgetUsd: number | undefined): string {
  const parts = [COMMAND, '--yes']
  if (config.pilot) parts.push('--pilot')
  else {
    if (config.only !== undefined) parts.push('--only', Array.isArray(config.only) ? config.only.join(',') : config.only)
    parts.push('--reps', String(config.reps))
    if (config.kinds.length !== FIXTURE_KINDS.length || config.kinds.some((kind, index) => kind !== FIXTURE_KINDS[index])) parts.push('--kinds', config.kinds.join(','))
  }
  parts.push('--models', config.models.join(','))
  if (config.effort !== undefined) parts.push('--effort', config.effort)
  if (config.fields !== 'default') parts.push('--fields', config.fields)
  if (config.concurrency !== DEFAULT_CONCURRENCY) parts.push('--concurrency', String(config.concurrency))
  if (config.maxOutputTokens !== DEFAULT_MAX_OUTPUT_TOKENS) parts.push('--max-output-tokens', String(config.maxOutputTokens))
  if (config.maxCallSeconds !== DEFAULT_MAX_CALL_SECONDS) parts.push('--max-call-seconds', String(config.maxCallSeconds))
  if (config.maxAttempts !== DEFAULT_MAX_ATTEMPTS) parts.push('--max-attempts', String(config.maxAttempts))
  if (config.seed !== DEFAULT_SEED) parts.push('--seed', String(config.seed))
  if (config.out !== undefined) parts.push('--out', config.out)
  if (config.allowBaseUrl) parts.push('--allow-base-url')
  if (budgetUsd !== undefined) parts.push('--budget-usd', formatUsdPlain(budgetUsd))
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
    `fields: ${config.fields}${config.fields === 'default' ? '' : ' (stricter descriptions: null unless the document is a receipt or invoice)'}`,
    `schedule seed ${config.seed}, concurrency ${config.concurrency}, at most ${config.maxAttempts} attempts per call, ${config.maxCallSeconds} s per attempt`,
    '',
    `estimate (prices as of ${PRICE_TABLE_AS_OF}):`,
    ...estimate.perModel.map((entry) => `  ${entry.model}: ${plural(entry.calls, 'call')}, ${priceFor(entry.model) === undefined ? 'no price in the price table' : money(entry.usd)}`),
    `  total: ${money(estimate.totalUsd)}`,
    `assumptions: input tokens per call are chars / ${TEXT_CHARS_PER_TOKEN} + ${TEXT_OVERHEAD_TOKENS} for text (Hangul likely costs more tokens per character, so the text estimate may be low), ${PDF_INPUT_TOKENS} for a PDF and ${PNG_INPUT_TOKENS} for a PNG; output: ${estimate.assumptions.outputTokens} tokens per call; no retries. These are estimates, not measurements.`,
    `thinking: these models think before they answer, and thinking tokens are billed as output tokens, so the real output per call can be far above ${estimate.assumptions.outputTokens}.`,
    `max_tokens: ${config.maxOutputTokens} per request${config.maxOutputTokens === DEFAULT_MAX_OUTPUT_TOKENS ? ' (as the node ships)' : ' (--max-output-tokens)'}; the budget guard reserves input + ${config.maxOutputTokens} output tokens for every call in flight.`,
  ]
  if (estimate.unpricedModels.length > 0) {
    lines.push(`no price for: ${estimate.unpricedModels.join(', ')}; the budget guard needs one, so --yes would refuse this run`)
  }
  if (budgetUsd === undefined) lines.push('budget: n/a (needs a price for every model)')
  else {
    lines.push(
      config.budgetUsd === undefined
        ? `suggested budget: $${formatUsdPlain(budgetUsd)} (the larger of ${SUGGESTED_BUDGET_FACTOR} x the estimate and the estimate plus the guard's reserve for ${plural(config.concurrency, 'call')} in flight, ${budgetUsd < 0.01 ? 'rounded up; below a cent, so shown with more digits' : 'rounded up to the next cent'})`
        : `budget: $${formatUsdPlain(budgetUsd)} (from --budget-usd)`,
    )
    const worst = worstCallUsd(suite, config.models, config.maxOutputTokens)
    const reserve = guardReserveUsd(worst, config.concurrency, estimate.calls)
    const breakEven = breakEvenOutputTokens(estimate, budgetUsd, reserve)
    if (breakEven !== undefined) {
      lines.push(
        `break-even: at this budget the run can afford an average of about ${Math.floor(breakEven)} output tokens per call (thinking included, after the guard's reserve for the last calls in flight); above that the budget guard stops the run early and the report is marked PARTIAL.`,
      )
    }
    if (worst !== undefined) {
      lines.push(`worst case of one call: ${money(worst)}; with ${plural(config.concurrency, 'call')} in flight the guard holds up to ${money(worst * config.concurrency)} in reserve.`)
      if (budgetUsd < worst) {
        lines.push(
          `note: this budget is below the worst case of one call (${money(worst)}), so the guard would skip every call and the run would end at once as PARTIAL. Raise --budget-usd to at least ${money(worst)} (${money(worst * config.concurrency)} to keep ${plural(config.concurrency, 'call')} in flight), or lower --max-output-tokens.`,
        )
      } else if (budgetUsd < worst * config.concurrency) {
        lines.push(`note: this budget is below ${money(worst * config.concurrency)}, so fewer than ${plural(config.concurrency, 'call')} can be in flight at once near the start.`)
      }
    }
  }
  lines.push(
    '',
    'Nothing was sent. To run it for real (needs ANTHROPIC_API_KEY in the environment; --budget-usd is required with --yes):',
    `  ${commandLine(config, budgetUsd)}`,
    '',
  )
  return lines.join('\n')
}

function summaryTable(tasksOf: (name: string) => TaskResult<ExtractOutput>[], names: readonly string[], labels: Readonly<Record<string, string>> = {}): string {
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
      labels[name] === undefined ? name : `${name} (${labels[name]})`,
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

function progressPrinter(io: CliIo, total: number, out: string, secrets: readonly string[]): (task: TaskResult<ExtractOutput>) => void {
  let done = 0
  return (task) => {
    done += 1
    if (task.status !== 'skipped') appendPartial(out, task, secrets)
    if (done % PROGRESS_EVERY === 0 || done === total) io.stderr(`progress: ${done}/${total}\n`)
  }
}

function makeSuite(config: CliConfig, io: CliIo): ExtractSuite {
  try {
    return createExtractSuite({
      kinds: config.kinds,
      fields: config.fields,
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
  const tasks: TaskResult<ExtractOutput>[] = []
  for (const name of BASELINE_NAMES) {
    const kinds = BASELINE_KINDS[name]
    const cases = kinds === undefined ? suite.cases() : suite.cases().filter((testCase) => kinds.includes(testCase.kind))
    if (cases.length === 0) continue
    const run = await runEval({
      suite: { ...suite, cases: () => cases },
      models: [name],
      reps: 1,
      concurrency: config.concurrency,
      maxAttempts: config.maxAttempts,
      maxCallMs: config.maxCallSeconds * 1000,
      seed: config.seed,
      createProvider: (model) => create(model),
    })
    tasks.push(...run.tasks)
  }
  return { tasks, spentUsd: 0, budgetUsd: undefined }
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
    fields: config.fields,
    priceTableAsOf: PRICE_TABLE_AS_OF,
    fallback: false as const,
    baselines: [...BASELINE_NAMES],
    baselineNotes: { ...BASELINE_NOTES },
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
    versions: extractVersions(config.fields),
    maxOutputTokens: config.maxOutputTokens,
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
): { reportPath: string; rows: number } {
  const written = writeResults(out, results, resultsMeta(config, suite, io, models, reps, secrets))
  const reportPath = join(out, 'report.md')
  const meta = reportMeta(config, suite, io, config.baselines ? [] : models, reps)
  writeFileSync(reportPath, renderReport({ run: reportRun, meta }))
  return { reportPath, rows: written.rows }
}

async function runBaselinesMode(config: CliConfig, suite: ExtractSuite, io: CliIo): Promise<number> {
  const out = outDirFor(config, io)
  assertWritableDir(out)
  const run = await runBaselines(config, suite)
  const { reportPath } = writeAll(out, run, run, config, suite, io, [...BASELINE_NAMES], 1, [])
  io.stdout(
    `baselines on ${suite.cases().length} cases (no API call, no cost)\n\n${summaryTable((name) => run.tasks.filter((task) => task.model === name), BASELINE_NAMES, BASELINE_NOTES)}\n\n`,
  )
  io.stdout(`results: ${out}\nreport: ${reportPath}\n`)
  return 0
}

interface Endpoint {
  baseURL: string
  host: string
  isDefault: boolean
}

export function effectiveEndpoint(env: Readonly<Record<string, string | undefined>>): Endpoint {
  const raw = env['ANTHROPIC_BASE_URL']?.trim() ?? ''
  const baseURL = raw === '' ? DEFAULT_BASE_URL : raw
  let host: string
  try {
    const url = new URL(baseURL)
    host = url.host === '' ? baseURL : url.host
  } catch {
    throw new Error(`ANTHROPIC_BASE_URL is not a valid URL: ${baseURL}`)
  }
  return { baseURL, host, isDefault: baseURL.replace(/\/+$/u, '') === DEFAULT_BASE_URL }
}

function endpointCheck(config: CliConfig, io: CliIo, endpoint: Endpoint): boolean {
  io.stdout(`API host: ${endpoint.host}${endpoint.isDefault ? '' : ` (from ANTHROPIC_BASE_URL: ${endpoint.baseURL})`}\n`)
  const customHeaders = (io.env['ANTHROPIC_CUSTOM_HEADERS'] ?? '').trim() !== ''
  if (customHeaders) io.stderr('warning: ANTHROPIC_CUSTOM_HEADERS is set; the SDK adds those headers to every request\n')
  if (!config.allowBaseUrl) {
    if (!endpoint.isDefault) {
      io.stderr(
        `error: ANTHROPIC_BASE_URL points to ${endpoint.host}, not ${DEFAULT_BASE_URL}; your API key would be sent there. Unset it, or pass --allow-base-url if you mean it\n`,
      )
      return false
    }
    if (customHeaders) {
      io.stderr('error: ANTHROPIC_CUSTOM_HEADERS is set; unset it, or pass --allow-base-url to send those headers along with your key\n')
      return false
    }
  } else if (!endpoint.isDefault) {
    io.stdout(`WARNING: --allow-base-url is set: your API key will be sent to ${endpoint.host}, which is not ${DEFAULT_BASE_URL}\n`)
  }
  return true
}

function interruptControls(io: CliIo, maxCallSeconds: number): { stop: AbortController; abort: AbortController; dispose: () => void } {
  const stop = new AbortController()
  const abort = new AbortController()
  const dispose =
    io.onSignal?.((signal) => {
      if (!stop.signal.aborted) {
        stop.abort()
        io.stderr(`\n${signal}: no new calls; waiting up to ${maxCallSeconds} s for the calls in flight, then writing a partial report. Send it again to abort them now.\n`)
        return
      }
      if (!abort.signal.aborted) {
        abort.abort()
        io.stderr(`\n${signal}: aborting the calls in flight.\n`)
      }
    }) ?? (() => undefined)
  return { stop, abort, dispose }
}

function loadPilot(dir: string): PilotData {
  try {
    return readPilot(dir)
  } catch (error) {
    if (error instanceof PilotDirError) throw new UsageError(error.message)
    throw error
  }
}

function pilotEffort(pilot: PilotData): LlmEffort | undefined {
  const effort = pilot.effort
  return effort !== null && effort !== 'low' && (EFFORTS as readonly string[]).includes(effort) ? (effort as LlmEffort) : undefined
}

function reestimateMode(config: CliConfig, given: string, suite: ExtractSuite, io: CliIo): number {
  const invokedFrom = io.env['INIT_CWD']?.trim() ?? ''
  const dir = resolve(invokedFrom === '' ? process.cwd() : invokedFrom, given)
  const pilot = loadPilot(dir)
  const result = reestimate({ suite, pilot, models: config.models, reps: config.reps, concurrency: config.concurrency, maxOutputTokens: config.maxOutputTokens })
  const plan: CliConfig = { ...config, effort: pilotEffort(pilot), reestimate: undefined }
  const lower = result.lowerMaxOutput
  io.stdout(
    reestimateText({
      dir,
      suiteName: suite.name,
      suiteVersion: suite.version,
      pilot,
      result,
      plan: {
        seeds: new Set(suite.cases().map((testCase) => testCase.group)).size,
        kinds: config.kinds,
        cases: suite.cases().length,
        reps: config.reps,
        concurrency: config.concurrency,
        models: config.models,
      },
      command: result.suggestedBudgetUsd === undefined ? undefined : commandLine(plan, result.suggestedBudgetUsd),
      lowerCommand: lower === undefined ? undefined : commandLine({ ...plan, maxOutputTokens: lower.maxOutputTokens }, lower.suggestedBudgetUsd),
    }),
  )
  return EXIT_OK
}

async function runYesMode(config: CliConfig, suite: ExtractSuite, io: CliIo, estimate: RunEstimate, budgetUsd: number): Promise<number> {
  const key = io.env['ANTHROPIC_API_KEY']?.trim() ?? ''
  if (key === '') {
    io.stderr('error: ANTHROPIC_API_KEY is not set; --yes needs it in the environment\n')
    return EXIT_ERROR
  }
  if (estimate.unpricedModels.length > 0) {
    io.stderr(`error: no price for model ${estimate.unpricedModels.join(', ')}; the budget guard needs one\n`)
    return EXIT_ERROR
  }
  const endpoint = effectiveEndpoint(io.env)
  if (!endpointCheck(config, io, endpoint)) return EXIT_ERROR
  const out = outDirFor(config, io)
  assertWritableDir(out)
  const secrets = [key]
  io.stdout(`notice: the synthetic fixture documents (receipts as text, PDF and PNG) are sent to ${endpoint.host} for ${config.models.join(', ')}\n`)
  io.stdout(`budget: $${formatUsdPlain(budgetUsd)}, max_tokens ${config.maxOutputTokens} per request, ${estimate.calls} calls planned, results go to ${out}\n`)
  const progress = progressPrinter(io, estimate.calls, out, secrets)
  const interrupt = interruptControls(io, config.maxCallSeconds)
  let real: RunResult<ExtractOutput>
  try {
    real = await runEval({
      suite,
      models: config.models,
      reps: config.reps,
      concurrency: config.concurrency,
      maxAttempts: config.maxAttempts,
      maxCallMs: config.maxCallSeconds * 1000,
      maxOutputTokens: config.maxOutputTokens,
      budgetUsd,
      seed: config.seed,
      now: io.now,
      stopSignal: interrupt.stop.signal,
      abortSignal: interrupt.abort.signal,
      createProvider: (model, signal, settings) =>
        createEvalProvider({
          model,
          signal,
          clock: io.now,
          apiKey: key,
          baseURL: endpoint.baseURL,
          maxTokens: settings.maxOutputTokens,
          timeoutMs: config.maxCallSeconds * 1000 + SDK_TIMEOUT_MARGIN_MS,
          ...(config.effort === undefined ? {} : { effort: config.effort }),
        }),
      onTask: progress,
    })
  } finally {
    interrupt.dispose()
  }
  if (interrupt.stop.signal.aborted && real.stop === undefined) real = { ...real, stop: 'interrupted', partial: true }
  const baselineRun = await runBaselines(config, suite)
  const combined: RunResult<ExtractOutput> = { ...real, tasks: [...real.tasks, ...baselineRun.tasks] }
  const { reportPath, rows } = writeAll(out, real, combined, config, suite, io, config.models, config.reps, secrets)
  io.stdout(`\n${summaryTable((name) => real.tasks.filter((task) => task.model === name), config.models)}\n\n`)
  io.stdout(`total cost: ${money(real.spentUsd)} of a $${formatUsdPlain(budgetUsd)} budget\n`)
  const skipped = real.tasks.filter((task) => task.status === 'skipped').length
  if (rows === 0) io.stdout('notice: no model produced a scored row; the report builder has nothing to chart. See errors.jsonl in each variant directory.\n')
  io.stdout(`results: ${out}\nreport: ${reportPath}\n`)
  if (real.stop === 'interrupted') {
    io.stdout(`PARTIAL RUN: interrupted; ${skipped} of ${real.tasks.length} tasks were not run\n`)
    return EXIT_INTERRUPTED
  }
  if (real.stop === 'auth') {
    io.stderr(`error: the API rejected the credentials (authentication failure); the run stopped at the first one and ${skipped} of ${real.tasks.length} tasks were not run. Check ANTHROPIC_API_KEY and the model access of the key.\n`)
    return EXIT_ERROR
  }
  if (real.partial === true) {
    io.stdout(`PARTIAL RUN: the budget ran out; ${skipped} of ${real.tasks.length} tasks were skipped. Raise --budget-usd to run them (see the break-even line of the plan).\n`)
    return EXIT_PARTIAL
  }
  return EXIT_OK
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let secret: string | undefined
  try {
    const config = parseCli(argv)
    if (config.help) {
      io.stdout(USAGE)
      return 0
    }
    secret = io.env['ANTHROPIC_API_KEY']?.trim()
    const suite = makeSuite(config, io)
    const problems = verifyFixtures(suite)
    if (problems.length > 0) {
      io.stderr(`error: the fixtures are not usable:\n${problems.slice(0, 10).map((problem) => `  ${problem}`).join('\n')}\n`)
      return 1
    }
    if (config.baselines) return await runBaselinesMode(config, suite, io)
    if (config.reestimate !== undefined) return reestimateMode(config, config.reestimate, suite, io)
    const estimate = estimateRun({ suite, models: config.models, reps: config.reps })
    const budgetUsd = budgetFor(config, estimate, suite)
    if (!config.yes) {
      io.stdout(planText(config, suite, estimate, budgetUsd))
      return EXIT_OK
    }
    if (config.budgetUsd === undefined) throw new UsageError('--yes needs --budget-usd')
    return await runYesMode(config, suite, io, estimate, config.budgetUsd)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${USAGE}`)
      return EXIT_USAGE
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

function processSignals(handler: (signal: string) => void): () => void {
  const listener = (signal: NodeJS.Signals): void => handler(signal)
  process.on('SIGINT', listener)
  process.on('SIGTERM', listener)
  return () => {
    process.off('SIGINT', listener)
    process.off('SIGTERM', listener)
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    now: Date.now,
    onSignal: processSignals,
  })
}
