import { LlmError, type LlmUsage } from '@rill/llm'
import { estimateCallUsd, costUsd, priceFor } from './pricing'
import { DEFAULT_MAX_OUTPUT_TOKENS, zeroUsage, type EvalProvider, type Exchange } from './record'
import { noAnswerOutcomes, type CallStatus } from './score'
import { mulberry32, shuffle } from './stats'
import type { CaseScore, EvalCase, Suite } from './suite'

export type FailureClass =
  | 'rate_limit'
  | 'overloaded'
  | 'connection'
  | 'timeout'
  | 'auth'
  | 'invalid_request'
  | 'unknown'
  | 'aborted'
  | 'timeout_ceiling'
  | 'served_model_mismatch'
  | 'bad_response'
  | 'harness'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'unexpected_shape'

export interface Failure {
  class: FailureClass
  status?: Exclude<CallStatus, 'ok'>
  retryable: boolean
}

const UNEXPECTED_SHAPE_PREFIX = 'the model returned an unexpected shape'
const MAX_CAUSE_DEPTH = 5
const MAX_MESSAGE = 300
const DEFAULT_ESTIMATE_INPUT_TOKENS = 4000
const BUDGET_EPSILON = 1e-9
const BODY_FAILURE = /\bterminated\b|ECONNRESET|UND_ERR_SOCKET|other side closed|socket hang up/u
const CEILING_CLASSES: ReadonlySet<FailureClass> = new Set(['aborted', 'timeout', 'connection', 'unknown', 'bad_response'])

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 30_000

export function findLlmError(error: unknown): LlmError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof LlmError) return current
    current = current.cause
  }
  return undefined
}

function causeChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (pattern.test(current.message) || (typeof code === 'string' && pattern.test(code))) return true
    current = current.cause
  }
  return false
}

function failureOfKind(error: LlmError): Failure {
  switch (error.kind) {
    case 'rate_limit':
    case 'overloaded':
    case 'connection':
    case 'timeout':
      return { class: error.kind, retryable: true }
    case 'auth':
    case 'invalid_request':
    case 'unknown':
    case 'aborted':
      return { class: error.kind, retryable: false }
    case 'refusal':
      return { class: 'refusal', status: 'refused', retryable: false }
    case 'truncated':
      return { class: 'truncated', status: 'truncated', retryable: false }
    case 'invalid_output':
      return { class: 'invalid_output', status: 'schema_failed', retryable: false }
  }
}

export function classifyFailure(error: unknown, options: { ceilingFired?: boolean } = {}): Failure {
  const llmError = findLlmError(error)
  let failure: Failure
  if (llmError !== undefined) failure = failureOfKind(llmError)
  else if (error instanceof Error && error.message.startsWith(UNEXPECTED_SHAPE_PREFIX)) {
    failure = { class: 'unexpected_shape', status: 'schema_failed', retryable: false }
  } else failure = { class: 'harness', retryable: false }
  if (failure.class === 'unknown' && causeChainMatches(error, BODY_FAILURE)) failure = { class: 'connection', retryable: true }
  if (options.ceilingFired === true && CEILING_CLASSES.has(failure.class)) return { class: 'timeout_ceiling', retryable: false }
  return failure
}

export function servedModelMatches(requested: string, served: string): boolean {
  if (served === requested) return true
  if (!served.startsWith(`${requested}-`)) return false
  return /^\d{8}$/u.test(served.slice(requested.length + 1))
}

export function backoffMs(attempt: number, random: () => number, retryAfterMs?: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
  const jittered = Math.round(ceiling / 2 + (random() * ceiling) / 2)
  return Math.max(jittered, Math.min(retryAfterMs ?? 0, BACKOFF_CAP_MS))
}

export interface ScheduleEntry<C extends EvalCase> {
  index: number
  testCase: C
  model: string
  rep: number
}

export function buildSchedule<C extends EvalCase>(input: {
  cases: readonly C[]
  models: readonly string[]
  reps: number
  seed: number
}): ScheduleEntry<C>[] {
  const entries: Omit<ScheduleEntry<C>, 'index'>[] = []
  for (const testCase of input.cases) {
    for (let rep = 0; rep < input.reps; rep += 1) {
      for (const model of input.models) entries.push({ testCase, model, rep })
    }
  }
  return shuffle(entries, mulberry32(input.seed)).map((entry, index) => ({ ...entry, index }))
}

export type TaskStatus = CallStatus | 'failed' | 'skipped'

export type StopReason = 'budget' | 'auth' | 'interrupted'

export interface FailedAttempt {
  attempt: number
  failureClass: FailureClass
  message: string
  usage?: LlmUsage
  assumedUsd?: number
}

export interface TaskResult<O> {
  caseId: string
  group: string
  category: string
  kind: string
  model: string
  rep: number
  status: TaskStatus
  failureClass?: FailureClass
  output?: O
  score?: CaseScore
  attempts: number
  failedAttempts: FailedAttempt[]
  exchanges: Exchange[]
  usage: LlmUsage
  costUsd: number | undefined
  latencyMs: number | undefined
  wallMs: number
  skipped?: StopReason
}

export interface ProviderSettings {
  maxOutputTokens: number
}

export interface RunOptions<C extends EvalCase, O> {
  suite: Suite<C, O>
  models: readonly string[]
  reps: number
  concurrency: number
  maxAttempts?: number
  maxCallMs?: number
  maxOutputTokens?: number
  budgetUsd?: number
  seed: number
  createProvider: (model: string, signal: AbortSignal, settings: ProviderSettings) => EvalProvider
  stopSignal?: AbortSignal
  abortSignal?: AbortSignal
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  onTask?: (task: TaskResult<O>) => void
}

export interface RunResult<O> {
  tasks: TaskResult<O>[]
  spentUsd: number
  budgetUsd: number | undefined
  maxOutputTokens?: number
  stop?: StopReason
  partial?: boolean
}

interface Ledger {
  spent: number
  reserved: number
}

interface Settings<C extends EvalCase, O> {
  suite: Suite<C, O>
  maxAttempts: number
  maxCallMs: number
  maxOutputTokens: number
  budgetUsd: number | undefined
  ledger: Ledger
  createProvider: (model: string, signal: AbortSignal, settings: ProviderSettings) => EvalProvider
  stopRequested: () => boolean
  abortSignal: AbortSignal | undefined
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

function sumUsage(exchanges: readonly Exchange[]): LlmUsage {
  const total = zeroUsage()
  for (const exchange of exchanges) {
    total.inputTokens += exchange.usage.inputTokens
    total.outputTokens += exchange.usage.outputTokens
    total.cacheReadInputTokens += exchange.usage.cacheReadInputTokens
    total.cacheCreationInputTokens += exchange.usage.cacheCreationInputTokens
  }
  return total
}

function hasUsage(usage: LlmUsage): boolean {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens > 0
}

function isSuccess(exchange: Exchange): boolean {
  return exchange.status !== null && exchange.status >= 200 && exchange.status < 300
}

function messageOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').trim()
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function baseResult<C extends EvalCase>(entry: ScheduleEntry<C>) {
  return {
    caseId: entry.testCase.id,
    group: entry.testCase.group,
    category: entry.testCase.category,
    kind: entry.testCase.kind,
    model: entry.model,
    rep: entry.rep,
  }
}

function inputEstimateOf<C extends EvalCase, O>(suite: Suite<C, O>, testCase: C): number {
  return suite.estimateInputTokens?.(testCase) ?? DEFAULT_ESTIMATE_INPUT_TOKENS
}

export function worstCaseCallUsd<C extends EvalCase, O>(suite: Suite<C, O>, testCase: C, model: string, maxOutputTokens: number): number | undefined {
  return estimateCallUsd(model, inputEstimateOf(suite, testCase), maxOutputTokens)
}

interface AttemptView {
  exchanges: readonly Exchange[]
  ceilingFired: boolean
  userAborted: boolean
}

function classifyAttempt(error: unknown, view: AttemptView): Failure {
  if (view.userAborted) return { class: 'aborted', retryable: false }
  const base = classifyFailure(error, { ceilingFired: view.ceilingFired })
  if (base.class === 'timeout_ceiling') return base
  const successes = view.exchanges.filter(isSuccess)
  if (successes.some((exchange) => exchange.failure !== null)) {
    return view.ceilingFired ? { class: 'timeout_ceiling', retryable: false } : { class: 'connection', retryable: true }
  }
  return base
}

function assumedChargeUsd(
  view: AttemptView,
  recorded: LlmUsage,
  recordedUsd: number,
  worstUsd: number,
  inputUsd: number,
): number {
  const { exchanges } = view
  if (exchanges.length === 0) return 0
  const bodyLost = exchanges.some((exchange) => isSuccess(exchange) && exchange.failure !== null)
  if (view.ceilingFired || view.userAborted || bodyLost) return Math.max(0, worstUsd - recordedUsd)
  if (hasUsage(recorded)) return 0
  const unanswered = exchanges.some((exchange) => exchange.status === null || (isSuccess(exchange) && exchange.badReply !== null))
  return unanswered ? inputUsd : 0
}

async function executeTask<C extends EvalCase, O>(entry: ScheduleEntry<C>, settings: Settings<C, O>): Promise<TaskResult<O>> {
  const { suite, maxAttempts, maxCallMs, maxOutputTokens, ledger, createProvider, now, sleep, random } = settings
  const startedAt = now()
  const failedAttempts: FailedAttempt[] = []
  const billed = zeroUsage()
  const priced = priceFor(entry.model) !== undefined
  let cost: number | undefined = priced ? 0 : undefined
  let exchanges: Exchange[] = []
  let attempts = 0
  let lastFailure: FailureClass = 'harness'
  const inputTokens = inputEstimateOf(suite, entry.testCase)
  const worstUsd = estimateCallUsd(entry.model, inputTokens, maxOutputTokens) ?? 0
  const inputUsd = estimateCallUsd(entry.model, inputTokens, 0) ?? 0

  const finish = (fields: Partial<TaskResult<O>> & Pick<TaskResult<O>, 'status'>): TaskResult<O> => ({
    ...baseResult(entry),
    attempts,
    failedAttempts,
    exchanges,
    usage: billed,
    costUsd: cost,
    latencyMs: undefined,
    wallMs: now() - startedAt,
    ...fields,
  })

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt
    const ceiling = new AbortController()
    const timer = setTimeout(() => ceiling.abort(), maxCallMs)
    const signal = settings.abortSignal === undefined ? ceiling.signal : AbortSignal.any([ceiling.signal, settings.abortSignal])
    let provider: EvalProvider | undefined
    let output: O | undefined
    let error: unknown
    let errored = false
    try {
      provider = createProvider(entry.model, signal, { maxOutputTokens })
      output = await suite.run(entry.testCase, { provider: provider.provider, signal })
    } catch (caught) {
      errored = true
      error = caught
    } finally {
      clearTimeout(timer)
    }
    const view: AttemptView = {
      exchanges: provider?.recorder.exchanges() ?? [],
      ceilingFired: ceiling.signal.aborted,
      userAborted: settings.abortSignal?.aborted === true && !ceiling.signal.aborted,
    }
    exchanges = [...view.exchanges]
    const oversized = exchanges.find((exchange) => exchange.requestMaxTokens !== null && exchange.requestMaxTokens > maxOutputTokens)
    if (oversized !== undefined) {
      throw new Error(`a request asked for max_tokens ${oversized.requestMaxTokens} but the budget reserves ${maxOutputTokens}; stopping the run`)
    }
    const usage = sumUsage(exchanges)
    billed.inputTokens += usage.inputTokens
    billed.outputTokens += usage.outputTokens
    billed.cacheReadInputTokens += usage.cacheReadInputTokens
    billed.cacheCreationInputTokens += usage.cacheCreationInputTokens
    let attemptUsd: number | undefined = priced ? 0 : undefined
    for (const exchange of exchanges) {
      const price = costUsd(entry.model, exchange.usage)
      attemptUsd = attemptUsd === undefined || price === undefined ? undefined : attemptUsd + price
    }
    const latencyMs = exchanges.findLast(isSuccess)?.durationMs
    const charge = (assumed: number): void => {
      if (attemptUsd === undefined || cost === undefined) {
        cost = undefined
        return
      }
      const total = attemptUsd + assumed
      cost += total
      ledger.spent += total
    }
    const fail = (failureClass: FailureClass, message: string, assumed = 0): void => {
      lastFailure = failureClass
      failedAttempts.push({
        attempt,
        failureClass,
        message,
        ...(hasUsage(usage) ? { usage } : {}),
        ...(assumed > 0 && attemptUsd !== undefined ? { assumedUsd: assumed } : {}),
      })
      charge(assumed)
    }

    const badReply = exchanges.find((exchange) => isSuccess(exchange) && exchange.failure === null && exchange.badReply !== null)
    if (!errored && badReply === undefined) {
      const mismatch = exchanges.find((exchange) => isSuccess(exchange) && (exchange.model === null || !servedModelMatches(entry.model, exchange.model)))
      if (mismatch !== undefined) {
        fail('served_model_mismatch', `requested ${entry.model} but the API served ${mismatch.model ?? 'an unknown model'}`)
        break
      }
      let score: CaseScore
      try {
        score = suite.score(entry.testCase, output as O)
      } catch (scoreError) {
        fail('harness', messageOf(scoreError))
        break
      }
      charge(0)
      return finish({ status: score.status, output: output as O, score, latencyMs })
    }

    const failure = badReply !== undefined && !view.ceilingFired && !view.userAborted ? { class: 'bad_response' as const, retryable: true } : classifyAttempt(error, view)
    const assumed = attemptUsd === undefined ? 0 : assumedChargeUsd(view, usage, attemptUsd, worstUsd, inputUsd)
    if (failure.status !== undefined) {
      charge(assumed)
      return finish({
        status: failure.status,
        failureClass: failure.class,
        score: { status: failure.status, outcomes: noAnswerOutcomes(suite.fields, failure.status), extra: {} },
        latencyMs,
      })
    }
    fail(failure.class, failure.class === 'bad_response' && badReply?.badReply != null ? badReply.badReply : messageOf(error), assumed)
    if (!failure.retryable || attempt >= maxAttempts) break
    if (settings.stopRequested()) break
    if (settings.budgetUsd !== undefined && ledger.spent + ledger.reserved > settings.budgetUsd + BUDGET_EPSILON) break
    await sleep(backoffMs(attempt, random, findLlmError(error)?.retryAfterMs))
  }
  return finish({ status: 'failed', failureClass: lastFailure })
}

const MAX_OUTPUT_TOKENS_LIMIT = 64_000

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
}

function skippedTask<C extends EvalCase, O>(entry: ScheduleEntry<C>, reason: StopReason): TaskResult<O> {
  return {
    ...baseResult(entry),
    status: 'skipped',
    attempts: 0,
    failedAttempts: [],
    exchanges: [],
    usage: zeroUsage(),
    costUsd: 0,
    latencyMs: undefined,
    wallMs: 0,
    skipped: reason,
  }
}

export async function runEval<C extends EvalCase, O>(options: RunOptions<C, O>): Promise<RunResult<O>> {
  const { suite, models, reps, concurrency, budgetUsd } = options
  const maxAttempts = options.maxAttempts ?? 3
  const maxCallMs = options.maxCallMs ?? 60_000
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  requirePositiveInteger('reps', reps)
  requirePositiveInteger('concurrency', concurrency)
  requirePositiveInteger('maxAttempts', maxAttempts)
  requirePositiveInteger('maxOutputTokens', maxOutputTokens)
  if (maxOutputTokens > MAX_OUTPUT_TOKENS_LIMIT) throw new RangeError(`maxOutputTokens must be at most ${MAX_OUTPUT_TOKENS_LIMIT}`)
  if (typeof options.createProvider !== 'function') throw new TypeError('runEval needs createProvider; it never builds a paid provider on its own')
  if (!(maxCallMs > 0)) throw new RangeError('maxCallMs must be positive')
  if (budgetUsd !== undefined && !(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new RangeError('budgetUsd must be a finite positive number')
  if (models.length === 0 || new Set(models).size !== models.length) throw new Error('models must be a non-empty list without duplicates')
  if (budgetUsd !== undefined) {
    const unpriced = models.filter((model) => priceFor(model) === undefined)
    if (unpriced.length > 0) throw new Error(`cannot enforce a budget without a price for: ${unpriced.join(', ')}`)
  }
  const cases = suite.cases()
  if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) throw new Error('case ids must be unique')

  const ledger: Ledger = { spent: 0, reserved: 0 }
  let stop: StopReason | undefined
  const stopRequested = (): boolean => {
    if (stop === undefined && options.stopSignal?.aborted === true) stop = 'interrupted'
    return stop === 'interrupted' || stop === 'auth'
  }
  const settings: Settings<C, O> = {
    suite,
    maxAttempts,
    maxCallMs,
    maxOutputTokens,
    budgetUsd,
    ledger,
    stopRequested,
    abortSignal: options.abortSignal,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? mulberry32(options.seed + 1),
    createProvider: options.createProvider,
  }
  const schedule = buildSchedule({ cases, models, reps, seed: options.seed })
  const tasks: TaskResult<O>[] = new Array<TaskResult<O>>(schedule.length)
  let next = 0
  let crash: { error: unknown } | undefined

  const record = (entry: ScheduleEntry<C>, task: TaskResult<O>): void => {
    tasks[entry.index] = task
    options.onTask?.(task)
  }

  const loop = async (): Promise<void> => {
    for (;;) {
      if (crash !== undefined) return
      const entry = schedule[next]
      if (entry === undefined) return
      next += 1
      stopRequested()
      if (stop !== undefined) {
        record(entry, skippedTask(entry, stop))
        continue
      }
      let reservation = 0
      if (budgetUsd !== undefined) {
        const worst = worstCaseCallUsd(suite, entry.testCase, entry.model, maxOutputTokens) ?? 0
        if (ledger.spent + ledger.reserved + worst > budgetUsd + BUDGET_EPSILON) {
          stop = 'budget'
          record(entry, skippedTask(entry, 'budget'))
          continue
        }
        reservation = worst
        ledger.reserved += reservation
      }
      let task: TaskResult<O>
      try {
        task = await executeTask(entry, settings)
      } finally {
        ledger.reserved -= reservation
      }
      if (task.failedAttempts.some((attempt) => attempt.failureClass === 'auth')) stop ??= 'auth'
      record(entry, task)
    }
  }
  const worker = async (): Promise<void> => {
    try {
      await loop()
    } catch (error) {
      crash ??= { error }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, schedule.length) }, () => worker()))
  if (crash !== undefined) throw crash.error
  stopRequested()
  const partial = stop !== undefined || tasks.some((task) => task.status === 'skipped')
  return { tasks, spentUsd: ledger.spent, budgetUsd, maxOutputTokens, ...(stop === undefined ? {} : { stop }), partial }
}

export const ESTIMATE_OUTPUT_TOKENS = 200

export interface RunEstimate {
  calls: number
  perModel: { model: string; calls: number; usd: number | undefined }[]
  totalUsd: number | undefined
  inputUsd: number | undefined
  usdPerOutputToken: number | undefined
  unpricedModels: string[]
  assumptions: {
    outputTokens: number
    defaultInputTokens: number
    inputTokensFromSuite: boolean
    includesRetries: false
  }
}

export function estimateRun<C extends EvalCase, O>(input: {
  suite: Suite<C, O>
  models: readonly string[]
  reps: number
  outputTokens?: number
}): RunEstimate {
  const { suite, models, reps } = input
  const outputTokens = input.outputTokens ?? ESTIMATE_OUTPUT_TOKENS
  const cases = suite.cases()
  let inputUsd: number | undefined = 0
  let usdPerOutputToken: number | undefined = 0
  const perModel = models.map((model) => {
    let usd: number | undefined = 0
    for (const testCase of cases) {
      const inputTokens = inputEstimateOf(suite, testCase)
      const call = estimateCallUsd(model, inputTokens, outputTokens)
      const bare = estimateCallUsd(model, inputTokens, 0)
      const withOne = estimateCallUsd(model, inputTokens, 1)
      usd = usd === undefined || call === undefined ? undefined : usd + call * reps
      inputUsd = inputUsd === undefined || bare === undefined ? undefined : inputUsd + bare * reps
      usdPerOutputToken = usdPerOutputToken === undefined || bare === undefined || withOne === undefined ? undefined : usdPerOutputToken + (withOne - bare) * reps
    }
    return { model, calls: cases.length * reps, usd }
  })
  const unpricedModels = perModel.filter((entry) => priceFor(entry.model) === undefined).map((entry) => entry.model)
  return {
    calls: cases.length * reps * models.length,
    perModel,
    totalUsd: unpricedModels.length > 0 ? undefined : perModel.reduce((total, entry) => total + (entry.usd ?? 0), 0),
    inputUsd: unpricedModels.length > 0 ? undefined : inputUsd,
    usdPerOutputToken: unpricedModels.length > 0 ? undefined : usdPerOutputToken,
    unpricedModels,
    assumptions: {
      outputTokens,
      defaultInputTokens: DEFAULT_ESTIMATE_INPUT_TOKENS,
      inputTokensFromSuite: suite.estimateInputTokens !== undefined,
      includesRetries: false,
    },
  }
}

export function breakEvenOutputTokens(estimate: RunEstimate, budgetUsd: number, reserveUsd = 0): number | undefined {
  if (estimate.inputUsd === undefined || estimate.usdPerOutputToken === undefined || estimate.usdPerOutputToken <= 0 || estimate.calls === 0) return undefined
  return Math.max(0, (budgetUsd - reserveUsd - estimate.inputUsd) / estimate.usdPerOutputToken)
}
