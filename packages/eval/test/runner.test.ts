import { LlmError, type LlmErrorKind } from '@rill/llm'
import { RetryableError } from '@rill/nodes-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRICE_TABLE_AS_OF, costUsd, estimateCallUsd } from '../src/pricing'
import { createEvalProvider, type FetchFn } from '../src/record'
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  buildSchedule,
  classifyFailure,
  breakEvenOutputTokens,
  estimateRun,
  findLlmError,
  runEval,
  servedModelMatches,
  type RunOptions,
  type TaskResult,
} from '../src/runner'
import type { EvalCase, Suite } from '../src/suite'

const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const KEY = 'sk-ant-test-SECRET-456'
const DOC_PREFIX = 'SECRET-DOC-'

interface Call {
  model: string
  caseId: string
  callNo: number
  modelCallNo: number
}

interface Scripted {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  elapsedMs?: number
  delayMs?: number
  hang?: boolean
  raw?: string
  contentType?: string
  stream?: 'hang' | 'reset' | 'break'
}

function message(model: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  }
}

const okBody = (model: string) => message(model, '{"value":1}')
const errorBody = (type: string) => ({ type: 'error', error: { type, message: 'nope' } })

function streamBody(mode: 'hang' | 'reset' | 'break', signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"msg_1",'))
      if (mode !== 'hang') {
        setTimeout(() => controller.error(mode === 'reset' ? new TypeError('terminated') : new Error('stream broke')), 1)
        return
      }
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
    },
  })
}

function createHarness() {
  const clock = { now: 0 }
  const sleeps: number[] = []
  const calls: Call[] = []
  const requests: { body: Record<string, unknown>; headers: Headers }[] = []
  const providers: { model: string; signal: AbortSignal }[] = []
  let active = 0
  let maxActive = 0
  const perModel = new Map<string, number>()

  function api(respond: (call: Call) => Scripted): FetchFn {
    return async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] }
      const model = body.model
      const modelCallNo = (perModel.get(model) ?? 0) + 1
      perModel.set(model, modelCallNo)
      const call: Call = {
        model,
        caseId: String(body.messages[0]?.content).slice(DOC_PREFIX.length),
        callNo: calls.length + 1,
        modelCallNo,
      }
      calls.push(call)
      requests.push({ body, headers: new Headers(init?.headers) })
      const scripted = respond(call)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        if (scripted.hang === true) {
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'))
            if (init?.signal?.aborted === true) abort()
            else init?.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        if (scripted.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, scripted.delayMs))
      } finally {
        active -= 1
      }
      clock.now += scripted.elapsedMs ?? 10
      const responseInit = { status: scripted.status ?? 200, headers: { 'content-type': scripted.contentType ?? 'application/json', ...scripted.headers } }
      if (scripted.stream !== undefined) return new Response(streamBody(scripted.stream, init?.signal ?? undefined), responseInit)
      return new Response(scripted.raw ?? JSON.stringify(scripted.body ?? okBody(model)), responseInit)
    }
  }

  function options(respond: (call: Call) => Scripted, extra: Partial<RunOptions<EvalCase, FakeOutput>> = {}) {
    const fetchFn = api(respond)
    return {
      models: [HAIKU],
      reps: 1,
      concurrency: 1,
      seed: 1,
      now: () => clock.now,
      random: () => 0.5,
      sleep: (ms: number) => {
        sleeps.push(ms)
        clock.now += ms
        return Promise.resolve()
      },
      createProvider: (model: string, signal: AbortSignal, settings: { maxOutputTokens: number }) => {
        providers.push({ model, signal })
        return createEvalProvider({ model, apiKey: KEY, signal, fetch: fetchFn, clock: () => clock.now, maxTokens: settings.maxOutputTokens })
      },
      ...extra,
    }
  }

  return { clock, sleeps, calls, requests, providers, options, maxActive: () => maxActive }
}

interface FakeOutput {
  value: number
}

const schema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false }

function makeSuite(count: number, extra: Partial<Suite<EvalCase, FakeOutput>> = {}): Suite<EvalCase, FakeOutput> {
  const cases: EvalCase[] = Array.from({ length: count }, (_, index) => ({
    id: `c${index + 1}`,
    group: `g${Math.floor(index / 2) + 1}`,
    category: index % 2 === 0 ? 'easy' : 'hard',
    tags: ['t'],
    kind: 'text',
  }))
  return {
    name: 'fake',
    version: '1',
    fields: ['value'],
    cases: () => cases,
    run: async (testCase, ctx) => {
      const result = await ctx.provider.generate({ messages: [{ role: 'user', content: `${DOC_PREFIX}${testCase.id}` }], schema })
      return result.data as FakeOutput
    },
    score: (_testCase, output) => ({ status: 'ok', outcomes: { value: output.value === 1 ? 'TP' : 'WRONG' }, extra: { value: output.value } }),
    ...extra,
  }
}

const haikuCost = (inputTokens: number, outputTokens: number) => (inputTokens * 0.1 + outputTokens * 0.5) / 1_000_000

async function runOne(
  respond: (call: Call) => Scripted,
  extra: Partial<RunOptions<EvalCase, FakeOutput>> = {},
  suite: Suite<EvalCase, FakeOutput> = makeSuite(1),
) {
  const harness = createHarness()
  const result = await runEval({ suite, ...harness.options(respond, extra) })
  return { harness, result, task: result.tasks[0] as TaskResult<FakeOutput> }
}

describe('classifyFailure', () => {
  it.each([
    ['rate_limit', { class: 'rate_limit', retryable: true }],
    ['overloaded', { class: 'overloaded', retryable: true }],
    ['connection', { class: 'connection', retryable: true }],
    ['timeout', { class: 'timeout', retryable: true }],
    ['auth', { class: 'auth', retryable: false }],
    ['invalid_request', { class: 'invalid_request', retryable: false }],
    ['unknown', { class: 'unknown', retryable: false }],
    ['aborted', { class: 'aborted', retryable: false }],
    ['refusal', { class: 'refusal', status: 'refused', retryable: false }],
    ['truncated', { class: 'truncated', status: 'truncated', retryable: false }],
    ['invalid_output', { class: 'invalid_output', status: 'schema_failed', retryable: false }],
  ] as const satisfies readonly (readonly [LlmErrorKind, object])[])('maps LlmError kind %s', (kind, expected) => {
    expect(classifyFailure(new LlmError(kind, 'x'))).toEqual(expected)
  })

  it('reads the LlmError behind a node RetryableError', () => {
    const wrapped = new RetryableError('the model provider is rate limiting requests (429)', { cause: new LlmError('rate_limit', 'x') })
    expect(classifyFailure(wrapped)).toEqual({ class: 'rate_limit', retryable: true })
    const invalid = new RetryableError('bad json', { cause: new LlmError('invalid_output', 'x') })
    expect(classifyFailure(invalid)).toEqual({ class: 'invalid_output', status: 'schema_failed', retryable: false })
    const deep = new Error('outer', { cause: new Error('middle', { cause: new LlmError('auth', 'x') }) })
    expect(findLlmError(deep)?.kind).toBe('auth')
    expect(findLlmError(new Error('plain'))).toBeUndefined()
    expect(findLlmError('text')).toBeUndefined()
  })

  it('maps the node shape error to schema_failed, never retried at this level', () => {
    expect(classifyFailure(new RetryableError('the model returned an unexpected shape for the declared fields'))).toEqual({
      class: 'unexpected_shape',
      status: 'schema_failed',
      retryable: false,
    })
    expect(classifyFailure(new Error('the model returned an unexpected shape'))).toMatchObject({ status: 'schema_failed' })
    expect(classifyFailure(new RetryableError('network error: ECONNRESET'))).toEqual({ class: 'harness', retryable: false })
  })

  it('treats anything else as a harness failure', () => {
    for (const error of [new TypeError('x'), 'text', undefined, null, { kind: 'rate_limit' }]) {
      expect(classifyFailure(error)).toEqual({ class: 'harness', retryable: false })
    }
  })

  it('turns an abort, timeout or connection error into timeout_ceiling once the ceiling fired', () => {
    for (const kind of ['aborted', 'timeout', 'connection'] as const) {
      expect(classifyFailure(new LlmError(kind, 'x'), { ceilingFired: true })).toEqual({ class: 'timeout_ceiling', retryable: false })
      expect(classifyFailure(new LlmError(kind, 'x'), { ceilingFired: false }).class).toBe(kind)
    }
    expect(classifyFailure(new LlmError('auth', 'x'), { ceilingFired: true }).class).toBe('auth')
    expect(classifyFailure(new LlmError('refusal', 'x'), { ceilingFired: true }).class).toBe('refusal')
  })

  describe('an abort that surfaces between two calls', () => {
    const abort = (): DOMException => new DOMException('This operation was aborted', 'AbortError')
    const wrapped = (cause: unknown): Error => new Error('planning was aborted', { cause })

    it('is timeout_ceiling once the ceiling fired, also behind a wrapper', () => {
      expect(classifyFailure(wrapped(abort()), { ceilingFired: true })).toEqual({ class: 'timeout_ceiling', retryable: false })
      expect(classifyFailure(wrapped(wrapped(abort())), { ceilingFired: true })).toEqual({ class: 'timeout_ceiling', retryable: false })
      expect(classifyFailure(abort(), { ceilingFired: true }).class).toBe('timeout_ceiling')
    })

    it('stays a harness failure when the ceiling did not fire, and for an error that is not an abort', () => {
      expect(classifyFailure(wrapped(abort()), { ceilingFired: false })).toEqual({ class: 'harness', retryable: false })
      expect(classifyFailure(wrapped(abort()))).toEqual({ class: 'harness', retryable: false })
      expect(classifyFailure(wrapped(new TypeError('x')), { ceilingFired: true })).toEqual({ class: 'harness', retryable: false })
      expect(classifyFailure(wrapped('AbortError'), { ceilingFired: true })).toEqual({ class: 'harness', retryable: false })
    })

    it('does not look deeper than the cause chain limit', () => {
      let error: Error = abort()
      for (let depth = 0; depth < 8; depth += 1) error = wrapped(error)
      expect(classifyFailure(error, { ceilingFired: true }).class).toBe('harness')
    })
  })
})

describe('backoffMs', () => {
  it('jitters between half and all of an exponentially growing ceiling', () => {
    expect(BACKOFF_BASE_MS).toBe(1000)
    expect(backoffMs(1, () => 0)).toBe(500)
    expect(backoffMs(1, () => 0.5)).toBe(750)
    expect(backoffMs(1, () => 1)).toBe(1000)
    expect(backoffMs(2, () => 0.5)).toBe(1500)
    expect(backoffMs(3, () => 0)).toBe(2000)
  })

  it('caps the ceiling', () => {
    expect(BACKOFF_CAP_MS).toBe(30_000)
    expect(backoffMs(10, () => 1)).toBe(30_000)
    expect(backoffMs(10, () => 0.5)).toBe(22_500)
  })

  it('honours a longer retry-after hint up to the cap', () => {
    expect(backoffMs(1, () => 0.5, 2500)).toBe(2500)
    expect(backoffMs(1, () => 0.5, 100)).toBe(750)
    expect(backoffMs(1, () => 0.5, 600_000)).toBe(30_000)
  })
})

describe('buildSchedule', () => {
  const cases = makeSuite(12).cases()
  const models = [HAIKU, SONNET, OPUS]
  const ids = (entries: ReturnType<typeof buildSchedule<EvalCase>>) => entries.map((entry) => `${entry.model}|${entry.testCase.id}|${entry.rep}`)

  it('covers every case, rep and model exactly once', () => {
    const schedule = buildSchedule({ cases, models, reps: 3, seed: 1 })
    expect(schedule).toHaveLength(12 * 3 * 3)
    expect(new Set(ids(schedule)).size).toBe(12 * 3 * 3)
    expect(schedule.map((entry) => entry.index)).toEqual(schedule.map((_, position) => position))
  })

  it('repeats for the same seed and differs for another', () => {
    const first = ids(buildSchedule({ cases, models, reps: 2, seed: 7 }))
    expect(ids(buildSchedule({ cases, models, reps: 2, seed: 7 }))).toEqual(first)
    expect(ids(buildSchedule({ cases, models, reps: 2, seed: 8 }))).not.toEqual(first)
  })

  it('interleaves the models instead of running one after another', () => {
    const schedule = buildSchedule({ cases, models, reps: 3, seed: 1 })
    const firstThird = new Set(schedule.slice(0, 36).map((entry) => entry.model))
    expect(firstThird.size).toBe(3)
    const switches = schedule.filter((entry, position) => position > 0 && entry.model !== schedule[position - 1]?.model).length
    expect(switches).toBeGreaterThan(40)
  })
})

describe('runEval: outcomes', () => {
  it('runs a successful call and fills in the whole result', async () => {
    const { result, task, harness } = await runOne(() => ({ elapsedMs: 40 }))
    expect(task).toMatchObject({
      caseId: 'c1',
      group: 'g1',
      category: 'easy',
      kind: 'text',
      model: HAIKU,
      rep: 0,
      status: 'ok',
      output: { value: 1 },
      score: { status: 'ok', outcomes: { value: 'TP' }, extra: { value: 1 } },
      attempts: 1,
      failedAttempts: [],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      latencyMs: 40,
      wallMs: 40,
    })
    expect(task.costUsd).toBeCloseTo(haikuCost(1000, 100), 12)
    expect(task.exchanges).toHaveLength(1)
    expect(task.exchanges[0]).toMatchObject({ status: 200, model: HAIKU, durationMs: 40 })
    expect(task.failureClass).toBeUndefined()
    expect(task.skipped).toBeUndefined()
    expect(result.spentUsd).toBeCloseTo(haikuCost(1000, 100), 12)
    expect(harness.sleeps).toEqual([])
  })

  it('takes latency from the last successful request when a suite makes several in one attempt', async () => {
    const suite = makeSuite(1, {
      run: async (testCase, ctx) => {
        const request = { messages: [{ role: 'user' as const, content: `${DOC_PREFIX}${testCase.id}` }], schema }
        await ctx.provider.generate(request)
        const second = await ctx.provider.generate(request)
        return second.data as FakeOutput
      },
    })
    const { task } = await runOne((call) => ({ elapsedMs: call.callNo === 1 ? 100 : 30 }), {}, suite)
    expect(task.exchanges.map((entry) => entry.durationMs)).toEqual([100, 30])
    expect(task.latencyMs).toBe(30)
    expect(task.usage.inputTokens).toBe(2000)
    expect(task.costUsd).toBeCloseTo(2 * haikuCost(1000, 100), 12)
  })

  it('keeps a truncated call, billed and excluded from scoring, and does not retry it', async () => {
    const { task, harness } = await runOne(() => ({ body: message(HAIKU, '{"val', { stop_reason: 'max_tokens', usage: { input_tokens: 1000, output_tokens: 2000 } }) }))
    expect(task).toMatchObject({ status: 'truncated', failureClass: 'truncated', attempts: 1, failedAttempts: [], score: { status: 'truncated', outcomes: { value: 'EXCLUDED' }, extra: {} } })
    expect(task.output).toBeUndefined()
    expect(task.usage).toMatchObject({ inputTokens: 1000, outputTokens: 2000 })
    expect(task.costUsd).toBeCloseTo(haikuCost(1000, 2000), 12)
    expect(task.latencyMs).toBe(10)
    expect(harness.calls).toHaveLength(1)
  })

  it('grades a refusal as no-answer, keeps its slot, bills its usage and does not retry it', async () => {
    const { task, harness, result } = await runOne(() => ({
      body: message(HAIKU, '', { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: { input_tokens: 300, output_tokens: 0 } }),
    }))
    expect(task).toMatchObject({ status: 'refused', failureClass: 'refusal', attempts: 1, failedAttempts: [], score: { status: 'refused', outcomes: { value: 'NO_ANSWER' } } })
    expect(task.usage).toMatchObject({ inputTokens: 300, outputTokens: 0 })
    expect(task.costUsd).toBeCloseTo(haikuCost(300, 0), 12)
    expect(result.spentUsd).toBeCloseTo(haikuCost(300, 0), 12)
    expect(harness.calls).toHaveLength(1)
  })

  it('grades text that is not JSON as schema_failed without a harness retry', async () => {
    const { task, harness } = await runOne(() => ({ body: message(HAIKU, 'sorry, I cannot') }))
    expect(task).toMatchObject({ status: 'schema_failed', failureClass: 'invalid_output', attempts: 1, score: { outcomes: { value: 'NO_ANSWER' } } })
    expect(task.usage.inputTokens).toBe(1000)
    expect(harness.calls).toHaveLength(1)
  })

  it('grades the node shape error as schema_failed without calling the API again', async () => {
    const suite = makeSuite(1, {
      run: () => Promise.reject(new RetryableError('the model returned an unexpected shape for the declared fields')),
    })
    const { task, harness } = await runOne(() => ({}), {}, suite)
    expect(task).toMatchObject({ status: 'schema_failed', failureClass: 'unexpected_shape', attempts: 1, score: { outcomes: { value: 'NO_ANSWER' } } })
    expect(harness.calls).toHaveLength(0)
  })

  it('uses the status the suite reports when its own scoring finds a bad shape', async () => {
    const suite = makeSuite(1, { score: () => ({ status: 'schema_failed', outcomes: { value: 'NO_ANSWER' }, extra: {} }) })
    const { task } = await runOne(() => ({}), {}, suite)
    expect(task).toMatchObject({ status: 'schema_failed', output: { value: 1 } })
  })
})

describe('runEval: failures and retries', () => {
  it('retries a 429, lists the failed attempt and takes latency only from the final request', async () => {
    const { task, harness } = await runOne((call) => (call.callNo === 1 ? { status: 429, elapsedMs: 900, body: errorBody('rate_limit_error') } : { elapsedMs: 30 }))
    expect(task.status).toBe('ok')
    expect(task.attempts).toBe(2)
    expect(task.failedAttempts).toEqual([{ attempt: 1, failureClass: 'rate_limit', message: expect.stringContaining('429') }])
    expect(task.failedAttempts[0]).not.toHaveProperty('usage')
    expect(task.exchanges).toHaveLength(1)
    expect(task.latencyMs).toBe(30)
    expect(task.wallMs).toBe(900 + 750 + 30)
    expect(task.usage.inputTokens).toBe(1000)
    expect(task.costUsd).toBeCloseTo(haikuCost(1000, 100), 12)
    expect(harness.sleeps).toEqual([750])
    expect(harness.calls).toHaveLength(2)
  })

  it('waits at least the retry-after hint of a 429', async () => {
    const { harness } = await runOne((call) => (call.callNo === 1 ? { status: 429, headers: { 'retry-after-ms': '2500' }, body: errorBody('rate_limit_error') } : {}))
    expect(harness.sleeps).toEqual([2500])
  })

  it('gives every attempt a fresh provider, recorder and ceiling signal', async () => {
    const { harness } = await runOne((call) => (call.callNo === 1 ? { status: 529, body: errorBody('overloaded_error') } : {}))
    expect(harness.providers).toHaveLength(2)
    expect(harness.providers[0]?.signal).not.toBe(harness.providers[1]?.signal)
    expect(harness.providers[0]?.signal.aborted).toBe(false)
  })

  it('bills a failed attempt only when its response carried usage', async () => {
    const { task } = await runOne((call) =>
      call.callNo === 1
        ? { status: 500, body: { ...errorBody('api_error'), usage: { input_tokens: 50, output_tokens: 5 } } }
        : { body: message(HAIKU, '{"value":1}', { usage: { input_tokens: 1000, output_tokens: 100 } }) },
    )
    expect(task.failedAttempts).toEqual([expect.objectContaining({ failureClass: 'overloaded', usage: { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })])
    expect(task.usage).toMatchObject({ inputTokens: 1050, outputTokens: 105 })
    expect(task.costUsd).toBeCloseTo(haikuCost(50, 5) + haikuCost(1000, 100), 12)
  })

  it('does not retry a 401 and reports it as an infrastructure failure', async () => {
    const { task, harness, result } = await runOne(() => ({ status: 401, body: errorBody('authentication_error') }))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'auth', attempts: 1 })
    expect(task.failedAttempts).toEqual([expect.objectContaining({ attempt: 1, failureClass: 'auth' })])
    expect(task.output).toBeUndefined()
    expect(task.score).toBeUndefined()
    expect(task.latencyMs).toBeUndefined()
    expect(task.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    expect(task.costUsd).toBe(0)
    expect(result.spentUsd).toBe(0)
    expect(harness.calls).toHaveLength(1)
    expect(harness.sleeps).toEqual([])
  })

  it('does not retry a rejected request either', async () => {
    const { task, harness } = await runOne(() => ({ status: 400, body: errorBody('invalid_request_error') }))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'invalid_request', attempts: 1 })
    expect(harness.calls).toHaveLength(1)
  })

  it('gives up after maxAttempts when a 500 storm never ends', async () => {
    const { task, harness } = await runOne(() => ({ status: 500, body: errorBody('api_error') }))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'overloaded', attempts: 3 })
    expect(task.failedAttempts.map((entry) => entry.attempt)).toEqual([1, 2, 3])
    expect(task.failedAttempts.every((entry) => entry.failureClass === 'overloaded')).toBe(true)
    expect(harness.calls).toHaveLength(3)
    expect(harness.sleeps).toEqual([750, 1500])
    expect(task.exchanges).toHaveLength(1)
    expect(task.costUsd).toBe(0)
  })

  it('honours a custom maxAttempts', async () => {
    const two = await runOne(() => ({ status: 500, body: errorBody('api_error') }), { maxAttempts: 2 })
    expect(two.task.attempts).toBe(2)
    expect(two.harness.sleeps).toEqual([750])
    const one = await runOne(() => ({ status: 500, body: errorBody('api_error') }), { maxAttempts: 1 })
    expect(one.task).toMatchObject({ status: 'failed', attempts: 1 })
    expect(one.harness.sleeps).toEqual([])
  })

  it('retries a transient LlmError that a node wrapped in a RetryableError', async () => {
    let tries = 0
    const suite = makeSuite(1, {
      run: () => {
        tries += 1
        return tries === 1 ? Promise.reject(new RetryableError('busy', { cause: new LlmError('overloaded', 'busy') })) : Promise.resolve({ value: 1 })
      },
    })
    const { task, harness } = await runOne(() => ({}), {}, suite)
    expect(task).toMatchObject({ status: 'ok', attempts: 2, failedAttempts: [expect.objectContaining({ failureClass: 'overloaded' })] })
    expect(harness.sleeps).toEqual([750])
  })

  it('fails the attempt, bills it and does not retry when a different model answered', async () => {
    const { task, harness, result } = await runOne(() => ({ body: okBody('claude-opus-4-8') }))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'served_model_mismatch', attempts: 1 })
    expect(task.failedAttempts).toEqual([
      expect.objectContaining({ failureClass: 'served_model_mismatch', message: expect.stringContaining('claude-opus-4-8'), usage: expect.objectContaining({ inputTokens: 1000 }) }),
    ])
    expect(task.output).toBeUndefined()
    expect(task.usage.inputTokens).toBe(1000)
    expect(task.costUsd).toBeCloseTo(haikuCost(1000, 100), 12)
    expect(result.spentUsd).toBeCloseTo(haikuCost(1000, 100), 12)
    expect(harness.calls).toHaveLength(1)
    expect(harness.sleeps).toEqual([])
  })

  it('accepts a dated snapshot of the requested model', async () => {
    const { task } = await runOne(() => ({ body: okBody(`${HAIKU}-20260301`) }))
    expect(task.status).toBe('ok')
  })

  it('stops a call at the ceiling, reports timeout_ceiling and does not retry', async () => {
    const { task, harness } = await runOne(() => ({ hang: true }), { maxCallMs: 25 })
    expect(task).toMatchObject({ status: 'failed', failureClass: 'timeout_ceiling', attempts: 1 })
    expect(task.exchanges).toEqual([expect.objectContaining({ status: null, failure: 'AbortError' })])
    expect(task.latencyMs).toBeUndefined()
    expect(harness.sleeps).toEqual([])
    expect(harness.calls).toHaveLength(1)
    expect(harness.providers[0]?.signal.aborted).toBe(true)
  })

  it('lets later tasks run after one hit the ceiling', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: makeSuite(2), ...harness.options((call) => (call.caseId === 'c1' ? { hang: true } : {}), { maxCallMs: 25 }) })
    const byCase = new Map(result.tasks.map((entry) => [entry.caseId, entry]))
    expect(byCase.get('c1')).toMatchObject({ status: 'failed', failureClass: 'timeout_ceiling' })
    expect(byCase.get('c2')).toMatchObject({ status: 'ok' })
    expect(harness.providers.filter((entry) => entry.signal.aborted)).toHaveLength(1)
  })

  it('does not fire the ceiling for a call that finishes in time', async () => {
    const { task } = await runOne(() => ({ delayMs: 5 }), { maxCallMs: 5000 })
    expect(task.status).toBe('ok')
  })

  it('reports a harness failure when the suite throws, without retrying', async () => {
    const { task, harness } = await runOne(() => ({}), {}, makeSuite(1, { run: () => Promise.reject(new TypeError('file is missing')) }))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'harness', attempts: 1, failedAttempts: [expect.objectContaining({ message: 'file is missing' })] })
    expect(harness.calls).toHaveLength(0)
  })

  it('reports a harness failure, still billing the call, when scoring throws', async () => {
    const suite = makeSuite(1, {
      score: () => {
        throw new Error('scorer bug')
      },
    })
    const { task } = await runOne(() => ({}), {}, suite)
    expect(task).toMatchObject({ status: 'failed', failureClass: 'harness', attempts: 1 })
    expect(task.usage.inputTokens).toBe(1000)
    expect(task.costUsd).toBeGreaterThan(0)
  })

  it('reports a provider that cannot be created as a harness failure', async () => {
    const { task } = await runOne(() => ({}), {
      createProvider: () => {
        throw new Error('no credentials')
      },
    })
    expect(task).toMatchObject({ status: 'failed', failureClass: 'harness', exchanges: [], costUsd: 0 })
  })

  it('has no cost for a model without a price, but still records usage', async () => {
    const { task, result } = await runOne(() => ({}), { models: ['mystery-model'] })
    expect(task.status).toBe('ok')
    expect(task.costUsd).toBeUndefined()
    expect(task.usage.inputTokens).toBe(1000)
    expect(result.spentUsd).toBe(0)
  })

  it('prices cost per request so the long-prompt tier applies to the request that crossed it', async () => {
    const { task } = await runOne((call) =>
      call.callNo === 1
        ? { status: 500, body: { ...errorBody('api_error'), usage: { input_tokens: 60_000, output_tokens: 0 } } }
        : { body: message(HAIKU, '{"value":1}', { usage: { input_tokens: 60_000, output_tokens: 0 } }) },
    )
    expect(task.usage.inputTokens).toBe(120_000)
    expect(task.costUsd).toBeCloseTo(2 * haikuCost(60_000, 0), 12)
    expect(costUsd(HAIKU, task.usage)).toBeGreaterThan(task.costUsd ?? 0)
  })
})

describe('runEval: budget', () => {
  const suite = (count: number) => makeSuite(count, { estimateInputTokens: () => 1000 })
  const budget = (budgetUsd: number) => ({ budgetUsd, maxOutputTokens: 2000 })
  const sonnetReply = () => ({ body: message(SONNET, '{"value":1}') })

  it('skips the remaining tasks, calling nothing for them, once the worst case no longer fits', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: suite(6), ...harness.options(sonnetReply, { models: [SONNET], ...budget(0.03) }) })
    expect(result.tasks.map((entry) => entry.status)).toEqual(['ok', 'ok', 'ok', 'skipped', 'skipped', 'skipped'])
    expect(harness.calls).toHaveLength(3)
    expect(result.spentUsd).toBeCloseTo(0.009, 12)
    expect(result.budgetUsd).toBe(0.03)
    const skipped = result.tasks[3] as TaskResult<FakeOutput>
    expect(skipped).toMatchObject({ skipped: 'budget', attempts: 0, failedAttempts: [], exchanges: [], costUsd: 0, model: SONNET })
    expect(skipped.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    expect(skipped.output).toBeUndefined()
  })

  it('uses the real cost of finished tasks, not the worst case, when it moves on', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: suite(4), ...harness.options(sonnetReply, { models: [SONNET], ...budget(0.1) }) })
    expect(result.tasks.every((entry) => entry.status === 'ok')).toBe(true)
    expect(result.spentUsd).toBeCloseTo(0.012, 12)
  })

  it('reserves the worst case of calls still in flight', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: suite(6), ...harness.options(() => ({ ...sonnetReply(), delayMs: 5 }), { models: [SONNET], concurrency: 3, ...budget(0.05) }) })
    expect(result.tasks.map((entry) => entry.status)).toEqual(['ok', 'ok', 'skipped', 'skipped', 'skipped', 'skipped'])
    expect(harness.calls).toHaveLength(2)
  })

  it('counts the cost of failed attempts that were billed', async () => {
    const harness = createHarness()
    const result = await runEval({
      suite: suite(6),
      ...harness.options(() => ({ body: okBody('claude-opus-4-8') }), { models: [SONNET], ...budget(0.03) }),
    })
    expect(result.tasks.map((entry) => entry.status)).toEqual(['failed', 'failed', 'failed', 'skipped', 'skipped', 'skipped'])
    expect(result.spentUsd).toBeCloseTo(0.009, 12)
  })

  it('refuses a budget for a model without a price', async () => {
    const harness = createHarness()
    await expect(runEval({ suite: suite(1), ...harness.options(() => ({}), { models: [HAIKU, 'mystery-model'], budgetUsd: 1 }) })).rejects.toThrow(/mystery-model/)
    expect(harness.calls).toHaveLength(0)
  })

  it('runs everything when no budget is set', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: suite(6), ...harness.options((call) => ({ body: okBody(call.model) }), { models: [OPUS] }) })
    expect(result.tasks.every((entry) => entry.status === 'ok')).toBe(true)
    expect(harness.calls).toHaveLength(6)
    expect(result.budgetUsd).toBeUndefined()
  })
})

describe('runEval: scheduling', () => {
  const suite = makeSuite(4)
  const models = [HAIKU, SONNET]

  async function callOrder(seed: number) {
    const harness = createHarness()
    const result = await runEval({
      suite,
      ...harness.options((call) => ({ body: okBody(call.model) }), { models, reps: 2, seed }),
    })
    return { order: harness.calls.map((call) => `${call.model}|${call.caseId}`), result }
  }

  it('starts tasks in the order of the seeded schedule, and returns results in that order', async () => {
    const first = await callOrder(11)
    const schedule = buildSchedule({ cases: suite.cases(), models, reps: 2, seed: 11 })
    expect(first.order).toEqual(schedule.map((entry) => `${entry.model}|${entry.testCase.id}`))
    expect(first.result.tasks.map((entry) => [entry.model, entry.caseId, entry.rep])).toEqual(schedule.map((entry) => [entry.model, entry.testCase.id, entry.rep]))
    expect(new Set(first.result.tasks.map((entry) => `${entry.model}|${entry.caseId}|${entry.rep}`)).size).toBe(16)
  })

  it('repeats the order for the same seed and changes it for another', async () => {
    const first = await callOrder(11)
    expect((await callOrder(11)).order).toEqual(first.order)
    expect((await callOrder(12)).order).not.toEqual(first.order)
  })

  it('interleaves the models in time', async () => {
    const { order } = await callOrder(11)
    expect(new Set(order.slice(0, 8).map((entry) => entry.split('|')[0])).size).toBe(2)
  })

  it('never runs more tasks at once than the concurrency limit, and reaches it', async () => {
    for (const concurrency of [1, 3]) {
      const harness = createHarness()
      const result = await runEval({
        suite: makeSuite(8),
        ...harness.options(() => ({ delayMs: 30 }), { concurrency }),
      })
      expect(result.tasks.every((entry) => entry.status === 'ok')).toBe(true)
      expect(harness.maxActive()).toBe(concurrency)
    }
  })

  it('does not start more workers than there are tasks', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: makeSuite(2), ...harness.options(() => ({ delayMs: 5 }), { concurrency: 50 }) })
    expect(result.tasks).toHaveLength(2)
    expect(harness.maxActive()).toBe(2)
  })

  it('calls onTask once per task, skipped ones included', async () => {
    const harness = createHarness()
    const seen: TaskResult<FakeOutput>[] = []
    const result = await runEval({
      suite: makeSuite(4, { estimateInputTokens: () => 1000 }),
      ...harness.options(() => ({ body: message(SONNET, '{"value":1}') }), { models: [SONNET], budgetUsd: 0.03, maxOutputTokens: 2000, onTask: (task) => seen.push(task) }),
    })
    expect(seen).toHaveLength(4)
    expect(new Set(seen)).toEqual(new Set(result.tasks))
    expect(seen.filter((task) => task.skipped === 'budget')).toHaveLength(1)
  })

  it('stops starting new tasks and rethrows when onTask throws', async () => {
    const harness = createHarness()
    const failure = new Error('disk full')
    await expect(
      runEval({
        suite: makeSuite(9),
        ...harness.options(() => ({ delayMs: 5 }), {
          concurrency: 3,
          onTask: () => {
            throw failure
          },
        }),
      }),
    ).rejects.toBe(failure)
    expect(harness.calls).toHaveLength(3)
  })

  it('returns an empty result for a suite without cases', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: makeSuite(0), ...harness.options(() => ({})) })
    expect(result).toEqual({ tasks: [], spentUsd: 0, budgetUsd: undefined, maxOutputTokens: 16_000, partial: false })
  })
})

describe('runEval: inputs and secrets', () => {
  it.each([
    ['reps', { reps: 0 }],
    ['concurrency', { concurrency: 0 }],
    ['concurrency', { concurrency: 1.5 }],
    ['maxAttempts', { maxAttempts: 0 }],
    ['maxCallMs', { maxCallMs: 0 }],
    ['models', { models: [] }],
    ['models', { models: [HAIKU, HAIKU] }],
  ])('rejects invalid %s', async (name, extra) => {
    const harness = createHarness()
    await expect(runEval({ suite: makeSuite(1), ...harness.options(() => ({}), extra) })).rejects.toThrow(new RegExp(name))
    expect(harness.calls).toHaveLength(0)
  })

  it('rejects duplicate case ids', async () => {
    const harness = createHarness()
    const base = makeSuite(2)
    const duplicated = makeSuite(2, { cases: () => base.cases().map((testCase) => ({ ...testCase, id: 'same' })) })
    await expect(runEval({ suite: duplicated, ...harness.options(() => ({})) })).rejects.toThrow(/unique/)
  })

  it('keeps the key, the request body and the headers out of every result', async () => {
    const harness = createHarness()
    const result = await runEval({
      suite: makeSuite(3),
      ...harness.options((call) => (call.callNo === 2 ? { status: 429, body: errorBody('rate_limit_error') } : {})),
    })
    expect(harness.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(harness.requests[0]?.body)).toContain(DOC_PREFIX)
    const dump = JSON.stringify(result)
    for (const forbidden of [KEY, DOC_PREFIX, 'authorization', 'Bearer', 'x-api-key', 'messages']) {
      expect(dump).not.toContain(forbidden)
    }
  })
})

describe('estimateRun', () => {
  const suite = makeSuite(3, { estimateInputTokens: (testCase) => Number(testCase.id.slice(1)) * 1000 })

  it('prices every model from the suite input estimate and the output assumption', () => {
    const estimate = estimateRun({ suite, models: [HAIKU, SONNET], reps: 2 })
    expect(estimate.calls).toBe(12)
    expect(estimate.perModel).toEqual([
      { model: HAIKU, calls: 6, usd: expect.closeTo(0.0018, 12) },
      { model: SONNET, calls: 6, usd: expect.closeTo(0.036, 12) },
    ])
    expect(estimate.totalUsd).toBeCloseTo(0.0378, 12)
    expect(estimate.unpricedModels).toEqual([])
    expect(estimate.assumptions).toEqual({ outputTokens: 200, defaultInputTokens: 4000, inputTokensFromSuite: true, includesRetries: false })
  })

  it('takes the output token assumption from the caller', () => {
    const estimate = estimateRun({ suite, models: [OPUS], reps: 1, outputTokens: 1000 })
    expect(estimate.perModel[0]?.usd).toBeCloseTo((6000 * 4 + 3000 * 20) / 1_000_000, 12)
    expect(estimate.assumptions.outputTokens).toBe(1000)
  })

  it('falls back to a default input size and says so', () => {
    const estimate = estimateRun({ suite: makeSuite(2), models: [SONNET], reps: 1 })
    expect(estimate.perModel[0]?.usd).toBeCloseTo(2 * (4000 * 2 + 200 * 10) / 1_000_000, 12)
    expect(estimate.assumptions).toMatchObject({ inputTokensFromSuite: false, defaultInputTokens: 4000 })
  })

  it('returns n/a (undefined) instead of guessing for a model without a price', () => {
    const estimate = estimateRun({ suite, models: [HAIKU, 'mystery-model'], reps: 1 })
    expect(estimate.perModel[1]).toEqual({ model: 'mystery-model', calls: 3, usd: undefined })
    expect(estimate.perModel[0]?.usd).toBeGreaterThan(0)
    expect(estimate.totalUsd).toBeUndefined()
    expect(estimate.unpricedModels).toEqual(['mystery-model'])
  })

  it('is keyed to a dated price table', () => {
    expect(PRICE_TABLE_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('runEval: no implicit provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses to run without createProvider, even with a key in the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-env-key')
    const options = { suite: makeSuite(1), models: [HAIKU], reps: 1, concurrency: 1, seed: 1 } as unknown as RunOptions<EvalCase, FakeOutput>
    await expect(runEval(options)).rejects.toThrow(/createProvider/)
  })

  it('needs an explicit, non-blank key to build the eval provider', () => {
    expect(() => createEvalProvider({ model: HAIKU, apiKey: '   ' })).toThrow(/apiKey/)
  })
})

describe('runEval: budget guard', () => {
  const suite = (count: number) => makeSuite(count, { estimateInputTokens: () => 1000 })
  const worst = (model: string, outputTokens: number) => estimateCallUsd(model, 1000, outputTokens) as number
  const input = (model: string) => estimateCallUsd(model, 1000, 0) as number

  it('reserves exactly the max_tokens the request sends, 16000 by default', async () => {
    const fits = createHarness()
    const ran = await runEval({ suite: suite(1), ...fits.options(() => ({ body: okBody(SONNET) }), { models: [SONNET], budgetUsd: worst(SONNET, 16_000) }) })
    expect(ran.tasks[0]?.status).toBe('ok')
    expect(fits.requests.map((request) => request.body['max_tokens'])).toEqual([16_000])
    expect(ran.maxOutputTokens).toBe(16_000)
    const short = createHarness()
    const skipped = await runEval({ suite: suite(1), ...short.options(() => ({}), { models: [SONNET], budgetUsd: worst(SONNET, 16_000) - 1e-6 }) })
    expect(skipped.tasks[0]?.status).toBe('skipped')
    expect(short.calls).toHaveLength(0)
  })

  it('sends and reserves a custom maxOutputTokens', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: suite(2), ...harness.options(() => ({ body: okBody(SONNET) }), { models: [SONNET], maxOutputTokens: 3000, budgetUsd: worst(SONNET, 3000) + 0.003 }) })
    expect(harness.requests.map((request) => request.body['max_tokens'])).toEqual([3000, 3000])
    expect(result.tasks.map((task) => task.status)).toEqual(['ok', 'ok'])
    expect(result.maxOutputTokens).toBe(3000)
  })

  it('stops the run when a request asks for more max_tokens than the reservation', async () => {
    const harness = createHarness()
    const base = harness.options(() => ({}), { budgetUsd: 1 })
    await expect(
      runEval({ suite: suite(3), ...base, maxOutputTokens: 1000, createProvider: (model, signal) => base.createProvider(model, signal, { maxOutputTokens: 1001 }) }),
    ).rejects.toThrow(/max_tokens 1001/)
    expect(harness.calls).toHaveLength(1)
  })

  it('stops dispatching after the first budget skip, even when a cheaper task would still fit', async () => {
    const harness = createHarness()
    const budgetUsd = worst(OPUS, 2000) + 0.001
    const result = await runEval({ suite: suite(4), ...harness.options((call) => ({ body: okBody(call.model) }), { models: [OPUS, HAIKU], maxOutputTokens: 2000, budgetUsd }) })
    const statuses = result.tasks.map((task) => task.status)
    const firstSkip = statuses.indexOf('skipped')
    expect(firstSkip).toBeGreaterThan(0)
    expect(statuses.slice(firstSkip).every((status) => status === 'skipped')).toBe(true)
    expect(result.tasks.slice(firstSkip).some((task) => task.model === HAIKU)).toBe(true)
    expect(result.spentUsd + worst(HAIKU, 2000)).toBeLessThan(budgetUsd)
    expect(result).toMatchObject({ stop: 'budget', partial: true })
    expect(result.tasks.filter((task) => task.status === 'skipped').every((task) => task.skipped === 'budget')).toBe(true)
  })

  it('charges an attempt stopped at the ceiling its worst case', async () => {
    const { task, result } = await runOne(() => ({ hang: true }), { maxCallMs: 25, maxOutputTokens: 2000 }, suite(1))
    expect(task.failureClass).toBe('timeout_ceiling')
    expect(task.costUsd).toBeCloseTo(worst(HAIKU, 2000), 12)
    expect(result.spentUsd).toBeCloseTo(worst(HAIKU, 2000), 12)
    expect(task.failedAttempts[0]?.assumedUsd).toBeCloseTo(worst(HAIKU, 2000), 12)
  })

  it('charges the input estimate of a sent attempt that has no usage and no HTTP answer', async () => {
    const result = await runEval({
      suite: suite(1),
      models: [HAIKU],
      reps: 1,
      concurrency: 1,
      seed: 1,
      sleep: () => Promise.resolve(),
      createProvider: (model, signal, settings) =>
        createEvalProvider({ model, apiKey: KEY, signal, maxTokens: settings.maxOutputTokens, fetch: () => Promise.reject(new TypeError('fetch failed')) }),
    })
    const task = result.tasks[0] as TaskResult<FakeOutput>
    expect(task).toMatchObject({ status: 'failed', failureClass: 'connection', attempts: 3 })
    expect(task.costUsd).toBeCloseTo(3 * input(HAIKU), 12)
    expect(result.spentUsd).toBeCloseTo(3 * input(HAIKU), 12)
  })

  it('sends no retry that would no longer fit the budget, and stops the run there', async () => {
    const budgetUsd = worst(HAIKU, 2000) + input(HAIKU) / 2
    const result = await runEval({
      suite: suite(2),
      models: [HAIKU],
      reps: 1,
      concurrency: 1,
      seed: 1,
      maxOutputTokens: 2000,
      budgetUsd,
      sleep: () => Promise.resolve(),
      createProvider: (model, signal, settings) =>
        createEvalProvider({ model, apiKey: KEY, signal, maxTokens: settings.maxOutputTokens, fetch: () => Promise.reject(new TypeError('fetch failed')) }),
    })
    expect(result.tasks.map((task) => [task.status, task.attempts])).toEqual([
      ['failed', 1],
      ['skipped', 0],
    ])
    expect(result.spentUsd).toBeLessThanOrEqual(budgetUsd)
    expect(result.stop).toBe('budget')
  })

  it('does not charge an HTTP error answer that carried no usage', async () => {
    const { task } = await runOne(() => ({ status: 429, body: errorBody('rate_limit_error') }), {}, suite(1))
    expect(task.costUsd).toBe(0)
  })

  it.each([
    ['huge output tokens', { output_tokens: 1e308, input_tokens: 10 }],
    ['negative input tokens', { input_tokens: -5, output_tokens: 10 }],
    ['infinite cache tokens', { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 1e9 }],
    ['string tokens', { input_tokens: '5', output_tokens: 10 }],
  ])('turns a reply with invalid usage (%s) into bad_response instead of a cost', async (_name, usage) => {
    const { task, result } = await runOne(() => ({ body: message(HAIKU, '{"value":1}', { usage }) }), {}, suite(1))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'bad_response', attempts: 3 })
    expect(task.score).toBeUndefined()
    expect(Number.isFinite(result.spentUsd)).toBe(true)
    expect(result.spentUsd).toBeCloseTo(3 * input(HAIKU), 12)
    expect(task.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })
})

describe('runEval: outcome buckets', () => {
  it.each([
    ['an HTML page', { raw: '<html>portal</html>', contentType: 'text/html' }],
    ['HTML labelled as JSON', { raw: '<html>portal</html>' }],
    ['an empty body', { raw: '' }],
    ['a cut-off JSON body', { raw: '{"id":"m","type":"mess' }],
    ['an object without content', { body: { id: 'm', type: 'message', model: HAIKU, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['a message without usage', { body: { id: 'm', type: 'message', model: HAIKU, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"value":1}' }] } }],
  ])('retries %s as bad_response and never grades it', async (_name, scripted: Scripted) => {
    const { task, harness } = await runOne(() => scripted)
    expect(task).toMatchObject({ status: 'failed', failureClass: 'bad_response', attempts: 3 })
    expect(task.score).toBeUndefined()
    expect(task.failedAttempts.map((attempt) => attempt.failureClass)).toEqual(['bad_response', 'bad_response', 'bad_response'])
    expect(harness.calls).toHaveLength(3)
  })

  it('grades the model once a good reply follows a bad one', async () => {
    const { task } = await runOne((call) => (call.callNo === 1 ? { raw: '<html></html>' } : {}))
    expect(task.status).toBe('ok')
    expect(task.failedAttempts.map((attempt) => attempt.failureClass)).toEqual(['bad_response'])
  })

  it.each(['reset', 'break'] as const)('retries a body that breaks off mid-read (%s) as a connection failure', async (stream) => {
    const { task } = await runOne((call) => (call.callNo === 1 ? { stream } : {}))
    expect(task.status).toBe('ok')
    expect(task.failedAttempts.map((attempt) => attempt.failureClass)).toEqual(['connection'])
  })

  it('reports a body that hangs until the ceiling as timeout_ceiling, not unknown', async () => {
    const { task } = await runOne(() => ({ stream: 'hang' }), { maxCallMs: 25 })
    expect(task).toMatchObject({ status: 'failed', failureClass: 'timeout_ceiling', attempts: 1 })
  })

  it('maps an unknown error whose cause is a terminated body to connection', () => {
    const error = new LlmError('unknown', 'unexpected error calling the model provider: terminated', { cause: new TypeError('terminated') })
    expect(classifyFailure(error)).toEqual({ class: 'connection', retryable: true })
    expect(classifyFailure(new LlmError('unknown', 'x'), { ceilingFired: true })).toEqual({ class: 'timeout_ceiling', retryable: false })
  })

  it.each([
    [HAIKU, true],
    [`${HAIKU}-20260301`, true],
    [`${HAIKU}x-evil`, false],
    [`${HAIKU}-evil`, false],
    [`${HAIKU}-2026030`, false],
    [`${HAIKU}-202603011`, false],
    [`${HAIKU}-20260301-x`, false],
    ['claude-haiku-5', false],
  ])('accepts %s as the served model: %s', (served, ok) => {
    expect(servedModelMatches(HAIKU, served)).toBe(ok)
  })

  it('fails a reply from a look-alike model id', async () => {
    const { task } = await runOne(() => ({ body: okBody(`${HAIKU}x-evil`) }))
    expect(task).toMatchObject({ status: 'failed', failureClass: 'served_model_mismatch' })
  })
})

describe('runEval: stopping early', () => {
  it('stops at the first authentication failure and sends nothing more', async () => {
    const harness = createHarness()
    const result = await runEval({ suite: makeSuite(4), ...harness.options(() => ({ status: 401, body: errorBody('authentication_error') })) })
    expect(harness.calls).toHaveLength(1)
    expect(result.tasks.filter((task) => task.status === 'failed')).toHaveLength(1)
    expect(result.tasks.filter((task) => task.skipped === 'auth')).toHaveLength(3)
    expect(result).toMatchObject({ stop: 'auth', partial: true })
  })

  it('stops dispatching when the stop signal fires and lets the call in flight finish', async () => {
    const harness = createHarness()
    const stop = new AbortController()
    const result = await runEval({
      suite: makeSuite(5),
      ...harness.options(() => ({ delayMs: 5 }), {
        concurrency: 2,
        stopSignal: stop.signal,
        onTask: () => stop.abort(),
      }),
    })
    expect(harness.calls).toHaveLength(2)
    expect(result.tasks.filter((task) => task.status === 'ok')).toHaveLength(2)
    expect(result.tasks.filter((task) => task.skipped === 'interrupted')).toHaveLength(3)
    expect(result).toMatchObject({ stop: 'interrupted', partial: true })
  })

  it('aborts the calls in flight on the abort signal and charges their worst case', async () => {
    const harness = createHarness()
    const stop = new AbortController()
    const abort = new AbortController()
    setTimeout(() => {
      stop.abort()
      abort.abort()
    }, 10)
    const result = await runEval({
      suite: makeSuite(3, { estimateInputTokens: () => 1000 }),
      ...harness.options(() => ({ hang: true }), { stopSignal: stop.signal, abortSignal: abort.signal, maxCallMs: 60_000, maxOutputTokens: 2000 }),
    })
    const [first] = result.tasks.filter((task) => task.status === 'failed')
    expect(first).toMatchObject({ failureClass: 'aborted', attempts: 1 })
    expect(first?.costUsd).toBeCloseTo(estimateCallUsd(HAIKU, 1000, 2000) as number, 12)
    expect(result.tasks.filter((task) => task.skipped === 'interrupted')).toHaveLength(2)
  })
})

describe('breakEvenOutputTokens', () => {
  it('is the average output per call that spends the budget after inputs and the reserve', () => {
    const suite = makeSuite(10, { estimateInputTokens: () => 1000 })
    const estimate = estimateRun({ suite, models: [HAIKU, SONNET], reps: 2 })
    expect(estimate.inputUsd).toBeCloseTo(20 * (1000 * 0.1 + 1000 * 2) / 1e6, 12)
    expect(estimate.usdPerOutputToken).toBeCloseTo(20 * (0.5 + 10) / 1e6, 15)
    const inputUsd = estimate.inputUsd as number
    const perToken = estimate.usdPerOutputToken as number
    expect(breakEvenOutputTokens(estimate, 1)).toBeCloseTo((1 - inputUsd) / perToken, 6)
    expect(breakEvenOutputTokens(estimate, 1, 0.25)).toBeCloseTo((0.75 - inputUsd) / perToken, 6)
    expect(breakEvenOutputTokens(estimate, 0.001)).toBe(0)
    expect(breakEvenOutputTokens(estimateRun({ suite, models: ['mystery'], reps: 1 }), 1)).toBeUndefined()
  })
})
