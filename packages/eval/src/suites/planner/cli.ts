import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { LlmEffort } from '@rill/llm'
import { formatUsdPlain, guardReserveUsd, money, plural, worstCallUsd } from '../../budget'
import {
  DEFAULT_BASE_URL,
  EXIT_ERROR,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_PARTIAL,
  EXIT_USAGE,
  SDK_TIMEOUT_MARGIN_MS,
  UsageError,
  effectiveEndpoint,
  endpointCheck,
  integerOption,
  interruptControls,
  listOption,
  suggestedBudgetUsd,
  timestamp,
  type CliIo,
} from '../../cli-shared'
import { PRICE_TABLE_AS_OF, priceFor } from '../../pricing'
import { createEvalProvider } from '../../record'
import { PACKAGE_ROOT, appendPartial, assertWritableDir, writeResults } from '../../results'
import { breakEvenOutputTokens, estimateRun, runEval, worstCaseCallUsd, type RunEstimate, type RunResult, type TaskResult } from '../../runner'
import {
  DEFAULT_MAX_REPAIR_ROUNDS,
  REPAIR_MESSAGE_TOKENS,
  BASE_INPUT_TOKENS,
  PLANNER_EFFORTS,
  PLANNER_MAX_OUTPUT_TOKENS,
  TARGETED_CALLS_PER_ROUND,
  TYPICAL_OUTPUT_TOKENS,
  effortTable,
  isMeasurableEffort,
  measurableEfforts,
  unmeasurableEffortMessage,
  worstCaseCalls,
} from './budget'
import { verifyAttachments } from './attachments'
import { plannerMetrics, ratio } from './metrics'
import { renderPlannerReport } from './report'
import { CATEGORIES } from './schema'
import type { PlannerCase } from './cases'
import type { PlannerOutput } from './scoring'
import { createPlannerSuite, plannerSentRequestOf, plannerVersions, type PlannerSuite } from './suite'

export const PLANNER_DEFAULT_MODELS = ['claude-sonnet-5-5'] as const
export const PLANNER_DEFAULT_REPS = 1
export const PLANNER_DEFAULT_CONCURRENCY = 2
export const PLANNER_DEFAULT_MAX_CALL_SECONDS = 300
export const PLANNER_DEFAULT_MAX_ATTEMPTS = 2
export const PLANNER_DEFAULT_SEED = 1
export const PLANNER_PROGRESS_EVERY = 5

export const PLANNER_LIMITS = {
  reps: { min: 1, max: 20 },
  concurrency: { min: 1, max: 16 },
  maxCallSeconds: { min: 1, max: 1800 },
  maxAttempts: { min: 1, max: 10 },
  maxRepairRounds: { min: 0, max: 5 },
  seed: { min: 0, max: 4_294_967_295 },
} as const

const COMMAND = 'pnpm eval planner'
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/u

export const PLANNER_USAGE = `usage: ${COMMAND} [options]

Measures how well models turn a plain-language request into a workflow, a list of questions or a refusal.
Without --yes nothing is sent: it prints the plan, the cost estimate and the command that would run it.

options:
  --model <a,b>           models to compare (default: ${PLANNER_DEFAULT_MODELS.join(',')}); --models is the same option
  --effort <e>            override the effort of every case: ${measurableEfforts().join(', ')} (default: the case's own); xhigh and max stream their reply and cannot be measured
  --group <g>             only this group of cases, or a comma list: ${CATEGORIES.join(', ')}
  --only <ids>            a case id substring, or a comma list of exact case ids
  --dry                   print the plan and exit (also what happens without --yes); cannot be combined with --yes
  --reps <n>              repetitions per case and model (default: ${PLANNER_DEFAULT_REPS})
  --concurrency <n>       cases in flight at once (default: ${PLANNER_DEFAULT_CONCURRENCY})
  --max-repair-rounds <n> repair rounds the planner may use, ${PLANNER_LIMITS.maxRepairRounds.min} to ${PLANNER_LIMITS.maxRepairRounds.max} (default: ${DEFAULT_MAX_REPAIR_ROUNDS}); sets the worst case of the budget guard
  --budget-usd <usd>      spending cap, required with --yes (the plan prints a suggested value)
  --max-call-seconds <n>  ceiling for one attempt of one case, repair rounds included, ${PLANNER_LIMITS.maxCallSeconds.min} to ${PLANNER_LIMITS.maxCallSeconds.max} (default: ${PLANNER_DEFAULT_MAX_CALL_SECONDS})
  --max-attempts <n>      attempts per case for transient provider failures, at most ${PLANNER_LIMITS.maxAttempts.max} (default: ${PLANNER_DEFAULT_MAX_ATTEMPTS})
  --seed <n>              schedule and bootstrap seed, 0 to ${PLANNER_LIMITS.seed.max} (default: ${PLANNER_DEFAULT_SEED})
  --out <dir>             results directory (default: packages/eval/results/planner-<timestamp>)
  --allow-base-url        allow an ANTHROPIC_BASE_URL other than ${DEFAULT_BASE_URL}, or ANTHROPIC_CUSTOM_HEADERS
                          (the key is sent to that host)
  --yes                   really call the API; needs ANTHROPIC_API_KEY in the environment and --budget-usd
  -h, --help              show this text

exit codes: 0 done, 1 runtime error (also: stopped at an authentication failure), 2 usage error,
3 partial run (the budget ran out; the report is marked PARTIAL), 130 interrupted (SIGINT or SIGTERM)
`

export interface PlannerCliConfig {
  models: string[]
  effort: LlmEffort | undefined
  group: string | string[] | undefined
  only: string | string[] | undefined
  dry: boolean
  reps: number
  concurrency: number
  maxRepairRounds: number
  budgetUsd: number | undefined
  maxCallSeconds: number
  maxAttempts: number
  seed: number
  out: string | undefined
  allowBaseUrl: boolean
  yes: boolean
  help: boolean
}

const OPTIONS = {
  model: { type: 'string' },
  models: { type: 'string' },
  effort: { type: 'string' },
  group: { type: 'string' },
  only: { type: 'string' },
  dry: { type: 'boolean' },
  reps: { type: 'string' },
  concurrency: { type: 'string' },
  'max-repair-rounds': { type: 'string' },
  'budget-usd': { type: 'string' },
  'max-output-tokens': { type: 'string' },
  'max-call-seconds': { type: 'string' },
  'max-attempts': { type: 'string' },
  seed: { type: 'string' },
  out: { type: 'string' },
  'allow-base-url': { type: 'boolean' },
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

function selection(name: string, raw: string): string | string[] {
  if (raw.trim() === '') throw new UsageError(`${name} must not be empty`)
  return raw.includes(',') ? listOption(name, raw) : raw
}

export function parsePlannerCli(argv: readonly string[]): PlannerCliConfig {
  const { values, positionals } = parseOptions(argv)
  const empty = emptyPlannerConfig()
  if (values.help === true) return { ...empty, help: true }
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`)
  if (values['max-output-tokens'] !== undefined) {
    throw new UsageError(`--max-output-tokens is not an option of the planner command: the planner sets max_tokens itself, by effort (${effortTable()}); choose the effort with --effort`)
  }
  const yes = values.yes === true
  const dry = values.dry === true
  if (yes && dry) throw new UsageError('--dry cannot be combined with --yes: a dry run never calls the API')
  if (values.model !== undefined && values.models !== undefined) throw new UsageError('--model and --models are the same option; pass one of them')
  const rawModels = values.model ?? values.models
  const models = rawModels === undefined ? [...PLANNER_DEFAULT_MODELS] : listOption(values.model === undefined ? '--models' : '--model', rawModels)
  for (const model of models) if (!MODEL_ID.test(model)) throw new UsageError(`--model must list model ids, got: ${model}`)
  let effort: LlmEffort | undefined
  if (values.effort !== undefined) {
    if (!(PLANNER_EFFORTS as readonly string[]).includes(values.effort)) throw new UsageError(`--effort must be one of ${measurableEfforts().join(', ')}`)
    effort = values.effort as LlmEffort
    if (!isMeasurableEffort(effort)) throw new UsageError(`--effort ${effort}: ${unmeasurableEffortMessage([effort])}`)
  }
  let budgetUsd: number | undefined
  const rawBudget = values['budget-usd']
  if (rawBudget !== undefined) {
    budgetUsd = Number(rawBudget)
    if (!/^\d+(\.\d+)?$/u.test(rawBudget) || !Number.isFinite(budgetUsd) || !(budgetUsd > 0)) {
      throw new UsageError('--budget-usd must be a finite positive number of dollars, for example 2.50')
    }
  }
  if (yes && budgetUsd === undefined) throw new UsageError('--yes needs --budget-usd: run the command without --yes to see the estimate and a suggested budget')
  return {
    models,
    effort,
    group: values.group === undefined ? undefined : selection('--group', values.group),
    only: values.only === undefined ? undefined : selection('--only', values.only),
    dry,
    reps: integerOption('--reps', values.reps, PLANNER_DEFAULT_REPS, PLANNER_LIMITS.reps),
    concurrency: integerOption('--concurrency', values.concurrency, PLANNER_DEFAULT_CONCURRENCY, PLANNER_LIMITS.concurrency),
    maxRepairRounds: integerOption('--max-repair-rounds', values['max-repair-rounds'], DEFAULT_MAX_REPAIR_ROUNDS, PLANNER_LIMITS.maxRepairRounds),
    budgetUsd,
    maxCallSeconds: integerOption('--max-call-seconds', values['max-call-seconds'], PLANNER_DEFAULT_MAX_CALL_SECONDS, PLANNER_LIMITS.maxCallSeconds),
    maxAttempts: integerOption('--max-attempts', values['max-attempts'], PLANNER_DEFAULT_MAX_ATTEMPTS, PLANNER_LIMITS.maxAttempts),
    seed: integerOption('--seed', values.seed, PLANNER_DEFAULT_SEED, PLANNER_LIMITS.seed),
    out: values.out,
    allowBaseUrl: values['allow-base-url'] === true,
    yes,
    help: false,
  }
}

function emptyPlannerConfig(): PlannerCliConfig {
  return {
    models: [...PLANNER_DEFAULT_MODELS],
    effort: undefined,
    group: undefined,
    only: undefined,
    dry: false,
    reps: PLANNER_DEFAULT_REPS,
    concurrency: PLANNER_DEFAULT_CONCURRENCY,
    maxRepairRounds: DEFAULT_MAX_REPAIR_ROUNDS,
    budgetUsd: undefined,
    maxCallSeconds: PLANNER_DEFAULT_MAX_CALL_SECONDS,
    maxAttempts: PLANNER_DEFAULT_MAX_ATTEMPTS,
    seed: PLANNER_DEFAULT_SEED,
    out: undefined,
    allowBaseUrl: false,
    yes: false,
    help: false,
  }
}

export function plannerCommandLine(config: PlannerCliConfig, budgetUsd: number | undefined): string {
  const parts = [COMMAND, '--yes', '--model', config.models.join(',')]
  if (config.effort !== undefined) parts.push('--effort', config.effort)
  if (config.group !== undefined) parts.push('--group', Array.isArray(config.group) ? config.group.join(',') : config.group)
  if (config.only !== undefined) parts.push('--only', Array.isArray(config.only) ? config.only.join(',') : config.only)
  if (config.reps !== PLANNER_DEFAULT_REPS) parts.push('--reps', String(config.reps))
  if (config.concurrency !== PLANNER_DEFAULT_CONCURRENCY) parts.push('--concurrency', String(config.concurrency))
  if (config.maxRepairRounds !== DEFAULT_MAX_REPAIR_ROUNDS) parts.push('--max-repair-rounds', String(config.maxRepairRounds))
  if (config.maxCallSeconds !== PLANNER_DEFAULT_MAX_CALL_SECONDS) parts.push('--max-call-seconds', String(config.maxCallSeconds))
  if (config.maxAttempts !== PLANNER_DEFAULT_MAX_ATTEMPTS) parts.push('--max-attempts', String(config.maxAttempts))
  if (config.seed !== PLANNER_DEFAULT_SEED) parts.push('--seed', String(config.seed))
  if (config.out !== undefined) parts.push('--out', config.out)
  if (config.allowBaseUrl) parts.push('--allow-base-url')
  if (budgetUsd !== undefined) parts.push('--budget-usd', formatUsdPlain(budgetUsd))
  return parts.join(' ')
}

function makeSuite(config: PlannerCliConfig, io: CliIo): PlannerSuite {
  try {
    return createPlannerSuite({
      ...(io.planner?.makePlanner === undefined ? {} : { makePlanner: io.planner.makePlanner }),
      ...(config.group === undefined ? {} : { group: config.group }),
      ...(config.only === undefined ? {} : { only: config.only }),
      ...(config.effort === undefined ? {} : { effort: config.effort }),
      maxRepairRounds: config.maxRepairRounds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown group/u.test(message)) throw new UsageError(`--group: ${message}`)
    if (/no case id contains|unknown case id/u.test(message)) throw new UsageError(`--only: ${message}`)
    throw error
  }
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): string {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1)
  return [...counts].map(([key, count]) => `${key} ${count}`).join(', ')
}

function caseTable(cases: readonly PlannerCase[], effortOverride: LlmEffort | undefined): string[] {
  const rows = cases.map((testCase) => [
    testCase.id,
    testCase.group,
    effortOverride ?? testCase.spec.effort,
    testCase.expected.outcome,
    String(testCase.spec.context.attachments?.length ?? 0),
    testCase.tags.filter((tag) => tag !== testCase.spec.language).join(','),
  ])
  const header = ['case', 'group', 'effort', 'expects', 'attachments', 'tags']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(header), ...rows.map(line)]
}

function worstTotalUsd(suite: PlannerSuite, model: string, maxOutputTokens: number, reps: number): number | undefined {
  let total = 0
  for (const testCase of suite.cases()) {
    const worst = worstCaseCallUsd(suite, testCase, model, maxOutputTokens)
    if (worst === undefined) return undefined
    total += worst * reps
  }
  return total
}

function budgetFor(config: PlannerCliConfig, suite: PlannerSuite, estimate: RunEstimate): number | undefined {
  if (config.budgetUsd !== undefined) return config.budgetUsd
  if (estimate.totalUsd === undefined) return undefined
  const worst = worstCallUsd(suite, config.models, PLANNER_MAX_OUTPUT_TOKENS)
  return suggestedBudgetUsd(estimate.totalUsd, guardReserveUsd(worst, config.concurrency, estimate.calls))
}

export function plannerPlanText(config: PlannerCliConfig, suite: PlannerSuite, estimate: RunEstimate, budgetUsd: number | undefined): string {
  const cases = suite.cases()
  const tasks = cases.length * config.reps * config.models.length
  const calls = worstCaseCalls(config.maxRepairRounds)
  const worstOne = worstCallUsd(suite, config.models, PLANNER_MAX_OUTPUT_TOKENS)
  const lines = [
    `rill eval: ${suite.name} (suite version ${suite.version})`,
    '',
    `cases: ${plural(cases.length, 'case')} (${countBy(cases, (testCase) => testCase.group)})`,
    `models: ${config.models.join(', ')}`,
    `reps: ${config.reps}`,
    `tasks: ${tasks} (${plural(cases.length, 'case')} x ${plural(config.reps, 'rep')} x ${plural(config.models.length, 'model')}), one planner call chain per task`,
    `provider calls: ${tasks} planned at one call per task if no plan needs repair; at most ${tasks * calls} (${calls} per task)`,
    `effort: ${config.effort === undefined ? `each case sets its own (${countBy(cases, (testCase) => testCase.spec.effort)})` : `${config.effort} (override)`}; the planner sets max_tokens from it: ${effortTable({ measurableOnly: true })}`,
    `planner: up to ${plural(config.maxRepairRounds, 'repair round')}; worst case ${plural(calls, 'call')} per case = 1 first call + ${config.maxRepairRounds} repair rounds x up to ${TARGETED_CALLS_PER_ROUND} calls (a repair round re-asks once, or repairs up to ${TARGETED_CALLS_PER_ROUND} nodes with one call each)`,
    `schedule seed ${config.seed}, concurrency ${config.concurrency}, at most ${config.maxAttempts} attempts per case, ${config.maxCallSeconds} s per attempt`,
    '',
    'cases:',
    ...caseTable(cases, config.effort).map((line) => `  ${line}`),
    '',
    `estimate (prices as of ${PRICE_TABLE_AS_OF}):`,
    ...estimate.perModel.map((entry) => {
      if (priceFor(entry.model) === undefined) return `  ${entry.model}: ${plural(entry.calls, 'case')}, no price in the price table`
      const worst = worstTotalUsd(suite, entry.model, PLANNER_MAX_OUTPUT_TOKENS, config.reps)
      return `  ${entry.model}: typical ${money(entry.usd)} (one call per case, no repair), worst case ${money(worst)} (${plural(calls, 'call')} per case, every call at the max_tokens of its effort)`
    }),
    `  total: typical ${money(estimate.totalUsd)}, worst case ${money(config.models.reduce<number | undefined>((total, model) => (total === undefined ? undefined : addOrUndefined(total, worstTotalUsd(suite, model, PLANNER_MAX_OUTPUT_TOKENS, config.reps))), 0))}`,
    `assumptions: input of the first call is ${BASE_INPUT_TOKENS} tokens of rules and node catalog plus the case text, plus 2400 for a PDF, 2000 for a PNG or chars / 3.5 + 400 for a text attachment; typical output is ${estimate.assumptions.outputTokens} tokens per call (thinking included). These are estimates, not measurements, and need a live pilot.`,
    `guard formula: the budget guard reserves, for every case in flight, ${plural(calls, 'call')} x (input + the max_tokens of the case's effort as output tokens) at the price of the model, where the input is the first-call estimate plus, for each of the ${config.maxRepairRounds} repair rounds, the max_tokens of the case's effort for the previous answer and ${REPAIR_MESSAGE_TOKENS} tokens for the issue list (the history a repair round re-sends); ${calls} = 1 + ${config.maxRepairRounds} repair rounds x ${TARGETED_CALLS_PER_ROUND} calls. Every call is priced at that largest input, so the reserve is an upper bound.`,
  ]
  if (estimate.unpricedModels.length > 0) lines.push(`no price for: ${estimate.unpricedModels.join(', ')}; the budget guard needs one, so --yes would refuse this run`)
  if (budgetUsd === undefined) lines.push('budget: n/a (needs a price for every model)')
  else {
    lines.push(
      config.budgetUsd === undefined
        ? `suggested budget: $${formatUsdPlain(budgetUsd)} (the larger of 2 x the typical estimate and the typical estimate plus the guard's reserve for ${plural(config.concurrency, 'case')} in flight, rounded up)`
        : `budget: $${formatUsdPlain(budgetUsd)} (from --budget-usd)`,
    )
    const reserve = guardReserveUsd(worstOne, config.concurrency, estimate.calls)
    const breakEven = breakEvenOutputTokens(estimate, budgetUsd, reserve)
    if (breakEven !== undefined) {
      lines.push(`break-even: at this budget the run can afford about ${Math.floor(breakEven)} output tokens per case on average if every case needs a single call (repair rounds multiply the spend); above that the guard stops the run early and the report is marked PARTIAL.`)
    }
    if (worstOne !== undefined) {
      lines.push(`worst case of one case: ${money(worstOne)}; with ${plural(config.concurrency, 'case')} in flight the guard holds up to ${money(worstOne * config.concurrency)} in reserve.`)
      if (budgetUsd < worstOne) {
        lines.push(`note: this budget is below the worst case of one case (${money(worstOne)}), so the guard would skip every case and the run would end at once as PARTIAL. Raise --budget-usd, lower --max-repair-rounds or --max-output-tokens.`)
      }
    }
  }
  lines.push('', 'Nothing was sent. To run it for real (needs ANTHROPIC_API_KEY in the environment; --budget-usd is required with --yes):', `  ${plannerCommandLine(config, budgetUsd)}`, '')
  return lines.join('\n')
}

function addOrUndefined(left: number, right: number | undefined): number | undefined {
  return right === undefined ? undefined : left + right
}

function typicalEstimate(config: PlannerCliConfig, suite: PlannerSuite): RunEstimate {
  return estimateRun({ suite, models: config.models, reps: config.reps, outputTokens: TYPICAL_OUTPUT_TOKENS })
}

function summaryTable(run: RunResult<PlannerOutput>, models: readonly string[]): string {
  const rows = models.map((model) => {
    const tasks = run.tasks.filter((task) => task.model === model)
    const metrics = plannerMetrics(tasks)
    const fraction = (value: { num: number; den: number }): string => {
      const result = ratio(value)
      return result === null ? 'n/a' : `${(result * 100).toFixed(1)}% (${value.num}/${value.den})`
    }
    return [model, fraction(metrics.casePass), fraction(metrics.firstTryValid), fraction(metrics.structural), fraction(metrics.askRecall), fraction(metrics.overAsk), String(tasks.filter((task) => task.status === 'failed').length), money(metrics.costUsd)]
  })
  const header = ['model', 'case pass', 'first-try valid', 'assertion pass', 'ask recall', 'over-ask', 'failed', 'cost']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

async function runYesMode(config: PlannerCliConfig, suite: PlannerSuite, io: CliIo, estimate: RunEstimate, budgetUsd: number): Promise<number> {
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
  if (!endpointCheck(config.allowBaseUrl, io, endpoint)) return EXIT_ERROR
  const out = config.out ?? join(io.outRoot ?? join(PACKAGE_ROOT, 'results'), `planner-${timestamp(io.now())}`)
  assertWritableDir(out)
  const secrets = [key]
  const createProvider = io.planner?.createProvider ?? createEvalProvider
  io.stdout(`notice: the case prompts, their folder and connection names, and the synthetic attachments (receipt PDF, PNG and text, two of them with a hostile sentence) are sent to ${endpoint.host} for ${config.models.join(', ')}\n`)
  io.stdout(`budget: $${formatUsdPlain(budgetUsd)}, max_tokens set by the planner from the effort (${effortTable({ measurableOnly: true })}), ${suite.cases().length * config.reps * config.models.length} tasks planned, results go to ${out}\n`)
  const total = suite.cases().length * config.reps * config.models.length
  let done = 0
  const progress = (task: TaskResult<PlannerOutput>): void => {
    done += 1
    if (task.status !== 'skipped') appendPartial(out, task, secrets)
    if (done % PLANNER_PROGRESS_EVERY === 0 || done === total) io.stderr(`progress: ${done}/${total}\n`)
  }
  const interrupt = interruptControls(io, config.maxCallSeconds)
  let run: RunResult<PlannerOutput>
  try {
    run = await runEval({
      suite,
      models: config.models,
      reps: config.reps,
      concurrency: config.concurrency,
      maxAttempts: config.maxAttempts,
      maxCallMs: config.maxCallSeconds * 1000,
      maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
      budgetUsd,
      seed: config.seed,
      now: io.now,
      stopSignal: interrupt.stop.signal,
      abortSignal: interrupt.abort.signal,
      createProvider: (model, signal, settings) =>
        createProvider({
          model,
          signal,
          clock: io.now,
          apiKey: key,
          baseURL: endpoint.baseURL,
          maxTokens: settings.maxOutputTokens,
          timeoutMs: config.maxCallSeconds * 1000 + SDK_TIMEOUT_MARGIN_MS,
        }),
      onTask: progress,
    })
  } finally {
    interrupt.dispose()
  }
  if (interrupt.stop.signal.aborted && run.stop === undefined) run = { ...run, stop: 'interrupted', partial: true }
  const createdAt = new Date(io.now()).toISOString()
  const written = writeResults(out, run, {
    suiteName: suite.name,
    suiteVersion: suite.version,
    createdAt,
    seed: config.seed,
    reps: config.reps,
    effort: config.effort ?? 'per case',
    fields: suite.fields,
    models: config.models,
    cases: suite.cases(),
    sentRequestOf: plannerSentRequestOf,
    secrets,
    versions: plannerVersions(config.effort, config.maxRepairRounds),
    maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
  })
  const reportPath = join(out, 'report.md')
  writeFileSync(
    reportPath,
    renderPlannerReport({
      run,
      meta: {
        suiteName: suite.name,
        suiteVersion: suite.version,
        createdAt,
        models: config.models,
        reps: config.reps,
        seed: config.seed,
        effort: config.effort,
        priceTableAsOf: PRICE_TABLE_AS_OF,
        fallback: false,
        baselines: [],
        maxRepairRounds: config.maxRepairRounds,
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
      },
    }),
  )
  io.stdout(`\n${summaryTable(run, config.models)}\n\n`)
  io.stdout(`total cost: ${money(run.spentUsd)} of a $${formatUsdPlain(budgetUsd)} budget\n`)
  const skipped = run.tasks.filter((task) => task.status === 'skipped').length
  if (written.rows === 0) io.stdout('notice: no model produced a scored row. See errors.jsonl in each variant directory.\n')
  io.stdout(`results: ${out}\nreport: ${reportPath}\n`)
  if (run.stop === 'interrupted') {
    io.stdout(`PARTIAL RUN: interrupted; ${skipped} of ${run.tasks.length} tasks were not run\n`)
    return EXIT_INTERRUPTED
  }
  if (run.stop === 'auth') {
    io.stderr(`error: the API rejected the credentials (authentication failure); the run stopped at the first one and ${skipped} of ${run.tasks.length} tasks were not run. Check ANTHROPIC_API_KEY and the model access of the key.\n`)
    return EXIT_ERROR
  }
  if (run.partial === true) {
    io.stdout(`PARTIAL RUN: the budget ran out; ${skipped} of ${run.tasks.length} tasks were skipped. Raise --budget-usd to run them (see the break-even line of the plan).\n`)
    return EXIT_PARTIAL
  }
  return EXIT_OK
}

export async function plannerMain(argv: readonly string[], io: CliIo): Promise<number> {
  let secret: string | undefined
  try {
    const config = parsePlannerCli(argv)
    if (config.help) {
      io.stdout(PLANNER_USAGE)
      return EXIT_OK
    }
    secret = io.env['ANTHROPIC_API_KEY']?.trim()
    const suite = makeSuite(config, io)
    const problems = verifyAttachments(suite.cases().map((testCase) => testCase.spec))
    if (problems.length > 0) {
      io.stderr(`error: the attachments are not usable:\n${problems.slice(0, 10).map((problem) => `  ${problem}`).join('\n')}\n`)
      return EXIT_ERROR
    }
    const estimate = typicalEstimate(config, suite)
    const budgetUsd = budgetFor(config, suite, estimate)
    if (!config.yes) {
      io.stdout(plannerPlanText(config, suite, estimate, budgetUsd))
      return EXIT_OK
    }
    if (config.budgetUsd === undefined) throw new UsageError('--yes needs --budget-usd')
    return await runYesMode(config, suite, io, estimate, config.budgetUsd)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${PLANNER_USAGE}`)
      return EXIT_USAGE
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`error: ${secret === undefined || secret === '' ? message : message.split(secret).join('[redacted]')}\n`)
    return EXIT_ERROR
  }
}
