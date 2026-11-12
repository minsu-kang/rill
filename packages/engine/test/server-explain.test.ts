import { LlmError } from '@rill/llm'
import { ExplainError } from '@rill/planner'
import { ERROR_CODES, METHODS, RillClient } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import type { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'
import { GOOD, RUN_MARKER, TOKEN, failure, http, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { waitFor } from './process'
import type { Step } from './plan-helpers'

const dirOf = useTempDir()
useCleanups()

const start = (steps: Step[] = [], engineOptions = {}, options: { llm?: boolean } = {}) => startEnv(dirOf.get(), steps, engineOptions, options)

function quiet(env: Awaited<ReturnType<typeof start>>, extra: string[] = []): void {
  const responses = env.frames.filter((frame) => frame.startsWith('{"type":"response"'))
  const everything = [...responses, ...env.logs].join('\n')
  expect(everything).not.toContain(RUN_MARKER)
  for (const text of extra) expect(everything).not.toContain(text)
}

describe('explainRun on a run that can be explained', () => {
  it('explains a failed run and answers with the schema of the method', async () => {
    const env = await start([{ data: { ...GOOD, fixProposal: { nodeId: 'n1', requestText: 'Wait and run it again later' } } }])
    const runId = await env.run([http(env.base, '/status/404')])
    const result = await env.client.request('explainRun', { runId })
    expect(Value.Check(METHODS.explainRun.result, result)).toBe(true)
    expect(result).toMatchObject({
      runId,
      explanation: GOOD.explanation,
      likelyCause: 'external_service',
      suggestedActions: ['wait_and_retry'],
      fixProposal: { nodeId: 'n1', requestText: 'Wait and run it again later' },
      signals: [{ nodeId: 'n1', signal: 'http_status_404' }],
      meta: { provider: 'scripted', model: 'claude-sonnet-5-5', truncated: false, repaired: false, effort: { requested: 'low', effective: 'low', native: 'low', collapsed: false } },
    })
    expect(result.meta.digestChars).toBeGreaterThan(200)
    expect(env.provider.requests).toHaveLength(1)
    expect(JSON.stringify(env.provider.requests[0])).toContain(`HTTP 404: ${RUN_MARKER} answer 404`)
  })

  it('explains a run that succeeded with a step that failed and was continued', async () => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/500', { onError: 'continue' })])
    expect((await env.engine.getRunDetail(runId)).run.status).toBe('succeeded')
    const result = await env.client.request('explainRun', { runId })
    expect(result.signals).toEqual([{ nodeId: 'n1', signal: 'http_status_5xx' }])
    expect(JSON.stringify(env.provider.requests[0])).toContain('continued')
  })

  it('explains a failed run that has no step, from the run error', async () => {
    const env = await start([{ data: GOOD }])
    const workflowId = env.workflow([http(env.base, '/ok')])
    const run = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    env.engine.store.markRunRunning(run.id)
    env.engine.store.finishRun(run.id, 'failed', 'graph contains a cycle')
    const result = await env.client.request('explainRun', { runId: run.id })
    expect(result.signals).toEqual([])
    expect(JSON.stringify(env.provider.requests[0])).toContain('graph contains a cycle')
  })

  it.each([
    ['medium', 3000],
    ['high', 4000],
  ] as const)('passes the effort %s on to the provider', async (effort, maxTokens) => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    const result = await env.client.request('explainRun', { runId, effort })
    expect(env.provider.requests[0]!.maxTokens).toBe(maxTokens)
    expect(result.meta.effort).toMatchObject({ requested: effort, effective: effort })
  })

  it('does not memoise: a second call asks the model again', async () => {
    const env = await start([{ data: GOOD }, { data: { ...GOOD, explanation: 'A second answer.' } }])
    const runId = await env.run([http(env.base, '/status/404')])
    expect((await env.client.request('explainRun', { runId })).explanation).toBe(GOOD.explanation)
    expect((await env.client.request('explainRun', { runId })).explanation).toBe('A second answer.')
    expect(env.provider.requests).toHaveLength(2)
  })

  it('repairs once and says so', async () => {
    const env = await start([{ data: { ...GOOD, extra: true } }, { data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    const result = await env.client.request('explainRun', { runId })
    expect(result.meta.repaired).toBe(true)
    expect(env.provider.requests).toHaveLength(2)
  })
})

describe('RUN_NOT_EXPLAINABLE', () => {
  const MESSAGE = 'only a finished run that failed or has a failed step can be explained'

  async function refused(env: Awaited<ReturnType<typeof start>>, runId: string) {
    const error = await failure(env.client.request('explainRun', { runId }))
    expect(error).toMatchObject({ code: 'RUN_NOT_EXPLAINABLE', message: MESSAGE })
    expect(env.provider.requests).toHaveLength(0)
  }

  it('refuses a run that succeeded without a failed step', async () => {
    const env = await start()
    await refused(env, await env.run([http(env.base, '/ok')]))
  })

  it('refuses a queued run and a running run, also one that has a failed attempt', async () => {
    const env = await start()
    const workflowId = env.workflow([http(env.base, '/ok')])
    const queued = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    await refused(env, queued.id)
    const running = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    env.engine.store.markRunRunning(running.id)
    await refused(env, running.id)
    const attempt = env.engine.store.startAttempt({ runId: running.id, nodeId: 'n1', input: {}, idempotencyKey: 'k' })
    env.engine.store.finishAttempt(running.id, 'n1', attempt, { status: 'failed', error: 'HTTP 500' })
    await refused(env, running.id)
  })

  it('refuses a cancelled run that has no failed step', async () => {
    const env = await start()
    const workflowId = env.workflow([http(env.base, '/ok')])
    const run = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    env.db.run("UPDATE runs SET status = 'cancelled' WHERE id = ?", run.id)
    await refused(env, run.id)
  })

  it('answers NOT_FOUND for a run that does not exist, before anything about the model', async () => {
    const env = await start([], {}, { llm: false })
    const error = await failure(env.client.request('explainRun', { runId: 'no-such-run' }))
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'run not found: no-such-run' })
  })
})

describe('INVALID_PARAMS', () => {
  it.each([
    ['xhigh', { runId: 'r', effort: 'xhigh' }],
    ['max', { runId: 'r', effort: 'max' }],
    ['an extra parameter', { runId: 'r', useMemory: true }],
    ['a missing run id', {}],
    ['a run id that is not text', { runId: 5 }],
  ])('refuses %s without calling the model', async (_name, params) => {
    const env = await start([{ data: GOOD }])
    const error = await failure(env.client.request('explainRun', params as never))
    expect(error.code).toBe('INVALID_PARAMS')
    expect(env.provider.requests).toHaveLength(0)
  })
})

describe('LLM_UNAVAILABLE', () => {
  it('answers when no provider is configured', async () => {
    const env = await start([], {}, { llm: false })
    const runId = await env.run([http(env.base, '/status/404')])
    expect(await failure(env.client.request('explainRun', { runId }))).toMatchObject({ code: 'LLM_UNAVAILABLE', message: 'no model provider is configured for explaining' })
  })

  it.each([
    ['a 401', { status: 401 }, 'the model provider rejected the credentials'],
    ['no status', {}, 'the model provider rejected the credentials'],
    ['a 403', { status: 403 }, 'the model provider refused account access'],
    ['a 402', { status: 402 }, 'the model provider reports a billing or quota problem'],
    ['a quota category', { category: 'insufficient_quota' }, 'the model provider reports a billing or quota problem'],
  ])('words the authentication error of %s with one of the three texts, without the vendor text', async (_name, options, message) => {
    const env = await start([{ error: new LlmError('auth', `vendor says ${RUN_MARKER}`, options) }])
    const runId = await env.run([http(env.base, '/status/404')])
    const error = await failure(env.client.request('explainRun', { runId }))
    expect(error).toMatchObject({ code: 'LLM_UNAVAILABLE', message })
    quiet(env)
  })
})

describe('EXPLAIN_PROVIDER, EXPLAIN_INVALID and EXPLAIN_BUSY', () => {
  it('words a provider failure with a fixed text and keeps the vendor text and the run out of every frame and log', async () => {
    const env = await start([{ error: new LlmError('overloaded', `vendor says ${RUN_MARKER}`, { status: 529 }) }])
    const runId = await env.run([http(env.base, '/status/404')])
    const error = await failure(env.client.request('explainRun', { runId }))
    expect(error).toMatchObject({ code: 'EXPLAIN_PROVIDER', message: 'the model provider failed' })
    expect(error.problems).toEqual([])
    quiet(env, ['vendor says'])
    expect(JSON.stringify(error)).not.toContain('vendor')
  })

  it('words an answer that stays invalid after the repair with a fixed text', async () => {
    const bad = { ...GOOD, explanation: `${RUN_MARKER} ${'x'.repeat(1600)}` }
    const env = await start([{ data: bad }, { data: bad }])
    const runId = await env.run([http(env.base, '/status/404')])
    const error = await failure(env.client.request('explainRun', { runId }))
    expect(error).toMatchObject({ code: 'EXPLAIN_INVALID', message: 'the model did not return a usable explanation' })
    expect(env.provider.requests).toHaveLength(2)
    quiet(env)
  })

  it('words a provider that fails in an unexpected way as a provider failure', async () => {
    const env = await start([{ error: new TypeError(`broken ${RUN_MARKER}`) }])
    const runId = await env.run([http(env.base, '/status/404')])
    expect(await failure(env.client.request('explainRun', { runId }))).toMatchObject({ code: 'EXPLAIN_PROVIDER', message: 'the model provider failed' })
    quiet(env)
  })

  it('refuses a third explanation while two are running and lets the two finish', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const env = await start([
      { gate, data: GOOD },
      { gate, data: GOOD },
    ])
    const runId = await env.run([http(env.base, '/status/404')])
    const first = env.client.request('explainRun', { runId })
    const second = env.client.request('explainRun', { runId })
    await env.provider.calls(2)
    expect(await failure(env.client.request('explainRun', { runId }))).toMatchObject({ code: 'EXPLAIN_BUSY', message: 'too many explanations are running (at most 2 at a time)' })
    release()
    expect((await first).explanation).toBe(GOOD.explanation)
    expect((await second).explanation).toBe(GOOD.explanation)
    expect(env.provider.requests).toHaveLength(2)
  })

  it('frees the place of an explanation that failed', async () => {
    const env = await start([{ error: new LlmError('overloaded', 'busy') }, { error: new LlmError('overloaded', 'busy') }, { error: new LlmError('overloaded', 'busy') }, { data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    for (let index = 0; index < 3; index++) expect((await failure(env.client.request('explainRun', { runId }))).code).toBe('EXPLAIN_PROVIDER')
    expect((await env.client.request('explainRun', { runId })).explanation).toBe(GOOD.explanation)
  })
})

describe('an explanation that was cancelled', () => {
  it('is answered with the provider code and a fixed text', async () => {
    const thrown = { on: () => () => undefined, explainRun: () => Promise.reject(new ExplainError('aborted', 'the explanation was cancelled')) } as unknown as Engine
    const server = new RillServer({ engine: thrown, token: TOKEN, log: () => undefined })
    const port = await server.listen()
    const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN)
    try {
      expect(await failure(client.request('explainRun', { runId: 'run-1' }))).toMatchObject({ code: 'EXPLAIN_PROVIDER', message: 'the explanation was cancelled' })
    } finally {
      client.close()
      await server.close()
    }
  })
})

describe('the cost of a call that is refused', () => {
  it('does not load the steps of a run when no provider is configured', async () => {
    const env = await start([], {}, { llm: false })
    const runId = await env.run([http(env.base, '/status/404')])
    const loading = vi.spyOn(env.engine.store, 'listStepDetails')
    expect(await failure(env.client.request('explainRun', { runId }))).toMatchObject({ code: 'LLM_UNAVAILABLE' })
    expect(loading).not.toHaveBeenCalled()
  })

  it('does not load the steps of a run when two explanations are already running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const env = await start([{ gate, data: GOOD }], { maxConcurrentExplains: 1 })
    const runId = await env.run([http(env.base, '/status/404')])
    const first = env.client.request('explainRun', { runId })
    await env.provider.calls(1)
    const loading = vi.spyOn(env.engine.store, 'listStepDetails')
    expect(await failure(env.client.request('explainRun', { runId }))).toMatchObject({ code: 'EXPLAIN_BUSY' })
    expect(loading).not.toHaveBeenCalled()
    release()
    await first
  })

  it('loads the run row before anything else, so a run that does not exist is NOT_FOUND with or without a provider', async () => {
    const env = await start([], { maxConcurrentExplains: 0 }, { llm: false })
    expect(await failure(env.client.request('explainRun', { runId: 'gone' }))).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('a client that goes away', () => {
  it('stops the call to the provider and gives the place back', async () => {
    const env = await start([{ wait: true }, { data: GOOD }], { maxConcurrentExplains: 1 })
    const runId = await env.run([http(env.base, '/status/404')])
    const other = await env.connect()
    const abandoned = other.client.request('explainRun', { runId }).catch(() => undefined)
    await env.provider.calls(1)
    expect(env.provider.signals[0]!.aborted).toBe(false)
    expect(await failure(env.client.request('explainRun', { runId }))).toMatchObject({ code: 'EXPLAIN_BUSY' })
    other.client.close()
    await waitFor(() => env.provider.signals[0]!.aborted)
    await abandoned
    let answer: { explanation: string } | undefined
    for (let attempt = 0; attempt < 40 && answer === undefined; attempt++) {
      try {
        answer = await env.client.request('explainRun', { runId })
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    expect(answer?.explanation).toBe(GOOD.explanation)
  })

  it('does not stop the call of a client that stays', async () => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    await env.client.request('explainRun', { runId })
    expect(env.provider.signals[0]!.aborted).toBe(false)
  })
})

describe('the error codes', () => {
  it('are in the protocol list', () => {
    for (const code of ['RUN_NOT_EXPLAINABLE', 'EXPLAIN_BUSY', 'EXPLAIN_PROVIDER', 'EXPLAIN_INVALID']) expect(ERROR_CODES as readonly string[]).toContain(code)
  })
})
