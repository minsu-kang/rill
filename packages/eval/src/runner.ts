import { LlmError, type LlmUsage } from '@rill/llm'
import { estimateCallUsd, costUsd, priceFor } from './pricing'
import { createEvalProvider, zeroUsage, type EvalProvider, type Exchange } from './record'
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
const WORST_CASE_OUTPUT_TOKENS = 2000
const BUDGET_EPSILON = 1e-9

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
  if (options.ceilingFired === true && (failure.class === 'aborted' || failure.class === 'timeout' || failure.class === 'connection')) {
    return { class: 'timeout_ceiling', retryable: false }
  }
  return failure
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

export interface FailedAttempt {
  attempt: number
  failureClass: FailureClass
  message: string
  usage?: LlmUsage
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
  skipped?: 'budget'
}

export interface RunOptions<C extends EvalCase, O> {
  suite: Suite<C, O>
  models: readonly string[]
  reps: number
  concurrency: number
  maxAttempts?: number
  maxCallMs?: number
  budgetUsd?: number
  seed: number
  createProvider?: (model: string, signal: AbortSignal) => EvalProvider
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  onTask?: (task: TaskResult<O>) => void
}

export interface RunResult<O> {
  tasks: TaskResult<O>[]
  spentUsd: number
  budgetUsd: number | undefined
}

interface Settings<C extends EvalCase, O> {
  suite: Suite<C, O>
  maxAttempts: number
  maxCallMs: number
  createProvider: (model: string, signal: AbortSignal) => EvalProvider
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

async function executeTask<C extends EvalCase, O>(entry: ScheduleEntry<C>, settings: Settings<C, O>): Promise<TaskResult<O>> {
  const { suite, maxAttempts, maxCallMs, createProvider, now, sleep, random } = settings
  const startedAt = now()
  const failedAttempts: FailedAttempt[] = []
  const billed = zeroUsage()
  let cost: number | undefined = priceFor(entry.model) === undefined ? undefined : 0
  let exchanges: Exchange[] = []
  let attempts = 0
  let lastFailure: FailureClass = 'harness'

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
    let provider: EvalProvider | undefined
    let output: O | undefined
    let error: unknown
    let errored = false
    try {
      provider = createProvider(entry.model, ceiling.signal)
      output = await suite.run(entry.testCase, { provider: provider.provider, signal: ceiling.signal })
    } catch (caught) {
      errored = true
      error = caught
    } finally {
      clearTimeout(timer)
    }
    const ceilingFired = ceiling.signal.aborted
    exchanges = provider?.recorder.exchanges() ?? []
    const usage = sumUsage(exchanges)
    billed.inputTokens += usage.inputTokens
    billed.outputTokens += usage.outputTokens
    billed.cacheReadInputTokens += usage.cacheReadInputTokens
    billed.cacheCreationInputTokens += usage.cacheCreationInputTokens
    for (const exchange of exchanges) {
      const price = costUsd(entry.model, exchange.usage)
      cost = cost === undefined || price === undefined ? undefined : cost + price
    }
    const latencyMs = exchanges.findLast(isSuccess)?.durationMs
    const fail = (failureClass: FailureClass, message: string): void => {
      lastFailure = failureClass
      failedAttempts.push({ attempt, failureClass, message, ...(hasUsage(usage) ? { usage } : {}) })
    }

    if (!errored) {
      const mismatch = exchanges.find((exchange) => isSuccess(exchange) && (exchange.model === null || !exchange.model.startsWith(entry.model)))
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
      return finish({ status: score.status, output: output as O, score, latencyMs })
    }

    const failure = classifyFailure(error, { ceilingFired })
    if (failure.status !== undefined) {
      return finish({
        status: failure.status,
        failureClass: failure.class,
        score: { status: failure.status, outcomes: noAnswerOutcomes(suite.fields, failure.status), extra: {} },
        latencyMs,
      })
    }
    fail(failure.class, messageOf(error))
    if (!failure.retryable || attempt >= maxAttempts) break
    await sleep(backoffMs(attempt, random, findLlmError(error)?.retryAfterMs))
  }
  return finish({ status: 'failed', failureClass: lastFailure })
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
}

export async function runEval<C extends EvalCase, O>(options: RunOptions<C, O>): Promise<RunResult<O>> {
  const { suite, models, reps, concurrency, budgetUsd } = options
  const maxAttempts = options.maxAttempts ?? 3
  const maxCallMs = options.maxCallMs ?? 60_000
  requirePositiveInteger('reps', reps)
  requirePositiveInteger('concurrency', concurrency)
  requirePositiveInteger('maxAttempts', maxAttempts)
  if (!(maxCallMs > 0)) throw new RangeError('maxCallMs must be positive')
  if (models.length === 0 || new Set(models).size !== models.length) throw new Error('models must be a non-empty list without duplicates')
  if (budgetUsd !== undefined) {
    const unpriced = models.filter((model) => priceFor(model) === undefined)
    if (unpriced.length > 0) throw new Error(`cannot enforce a budget without a price for: ${unpriced.join(', ')}`)
  }
  const cases = suite.cases()
  if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) throw new Error('case ids must be unique')

  const now = options.now ?? Date.now
  const settings: Settings<C, O> = {
    suite,
    maxAttempts,
    maxCallMs,
    now,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? mulberry32(options.seed + 1),
    createProvider:
      options.createProvider ??
      ((model, signal) => {
        const apiKey = process.env['ANTHROPIC_API_KEY']
        return createEvalProvider({ model, signal, clock: now, ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }) })
      }),
  }
  const schedule = buildSchedule({ cases, models, reps, seed: options.seed })
  const tasks: TaskResult<O>[] = new Array<TaskResult<O>>(schedule.length)
  let spent = 0
  let reserved = 0
  let next = 0

  let crash: { error: unknown } | undefined

  const loop = async (): Promise<void> => {
    for (;;) {
      if (crash !== undefined) return
      const entry = schedule[next]
      if (entry === undefined) return
      next += 1
      let reservation = 0
      if (budgetUsd !== undefined) {
        const estimate =
          estimateCallUsd(entry.model, suite.estimateInputTokens?.(entry.testCase) ?? DEFAULT_ESTIMATE_INPUT_TOKENS, WORST_CASE_OUTPUT_TOKENS) ?? 0
        if (spent + reserved + estimate > budgetUsd + BUDGET_EPSILON) {
          const skipped: TaskResult<O> = {
            ...baseResult(entry),
            status: 'skipped',
            attempts: 0,
            failedAttempts: [],
            exchanges: [],
            usage: zeroUsage(),
            costUsd: 0,
            latencyMs: undefined,
            wallMs: 0,
            skipped: 'budget',
          }
          tasks[entry.index] = skipped
          options.onTask?.(skipped)
          continue
        }
        reservation = estimate
        reserved += reservation
      }
      let task: TaskResult<O>
      try {
        task = await executeTask(entry, settings)
      } finally {
        reserved -= reservation
      }
      spent += task.costUsd ?? 0
      tasks[entry.index] = task
      options.onTask?.(task)
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
  return { tasks, spentUsd: spent, budgetUsd }
}

export interface RunEstimate {
  calls: number
  perModel: { model: string; calls: number; usd: number | undefined }[]
  totalUsd: number | undefined
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
  const outputTokens = input.outputTokens ?? 200
  const cases = suite.cases()
  const perModel = models.map((model) => {
    let usd: number | undefined = 0
    for (const testCase of cases) {
      const inputTokens = suite.estimateInputTokens?.(testCase) ?? DEFAULT_ESTIMATE_INPUT_TOKENS
      const call = estimateCallUsd(model, inputTokens, outputTokens)
      usd = usd === undefined || call === undefined ? undefined : usd + call * reps
    }
    return { model, calls: cases.length * reps, usd }
  })
  const unpricedModels = perModel.filter((entry) => priceFor(entry.model) === undefined).map((entry) => entry.model)
  return {
    calls: cases.length * reps * models.length,
    perModel,
    totalUsd: unpricedModels.length > 0 ? undefined : perModel.reduce((total, entry) => total + (entry.usd ?? 0), 0),
    unpricedModels,
    assumptions: {
      outputTokens,
      defaultInputTokens: DEFAULT_ESTIMATE_INPUT_TOKENS,
      inputTokensFromSuite: suite.estimateInputTokens !== undefined,
      includesRetries: false,
    },
  }
}
