import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError, type LlmProvider } from '@rill/llm'
import { RetryableError, createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { MAX_RETRY_AFTER_MS, computeBackoff, retryDelay } from '../src/executor'
import { linearWorkflow } from './helpers'

const full = () => 1
const none = () => 0

const withRetryAfter = (value: unknown): RetryableError => {
  const cause = new LlmError('rate_limit', 'slow down', { retryAfterMs: value as number })
  return new RetryableError('slow down', { cause })
}

describe('retryDelay', () => {
  it('is the plain backoff when the error carries no retry-after', () => {
    expect(retryDelay(1, 500, full, new RetryableError('x'))).toBe(computeBackoff(1, 500, full))
    expect(retryDelay(3, 500, full, new Error('x'))).toBe(2000)
    expect(retryDelay(2, 500, none, 'text')).toBe(0)
  })

  it('waits for the longer of the backoff and the retry-after of the error behind it', () => {
    expect(retryDelay(1, 500, full, withRetryAfter(4000))).toBe(4000)
    expect(retryDelay(1, 500, none, withRetryAfter(4000))).toBe(4000)
    expect(retryDelay(1, 500, full, withRetryAfter(100))).toBe(500)
    expect(retryDelay(3, 500, full, withRetryAfter(100))).toBe(2000)
    expect(retryDelay(1, 500, full, withRetryAfter(500))).toBe(500)
  })

  it('reads retry-after from the error itself and from a cause several levels down', () => {
    const direct = Object.assign(new RetryableError('x'), { retryAfterMs: 2500 })
    expect(retryDelay(1, 500, full, direct)).toBe(2500)
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: new LlmError('overloaded', 'd', { retryAfterMs: 7000 }) }) }) })
    expect(retryDelay(1, 500, full, deep)).toBe(7000)
  })

  it('takes the outermost value when several errors in the chain carry one', () => {
    const inner = new LlmError('rate_limit', 'x', { retryAfterMs: 9000 })
    const outer = Object.assign(new RetryableError('x', { cause: inner }), { retryAfterMs: 3000 })
    expect(retryDelay(1, 500, full, outer)).toBe(3000)
  })

  it('caps the wait at 60 seconds', () => {
    expect(MAX_RETRY_AFTER_MS).toBe(60_000)
    expect(retryDelay(1, 500, full, withRetryAfter(600_000))).toBe(60_000)
    expect(retryDelay(1, 500, full, withRetryAfter(60_000))).toBe(60_000)
    expect(retryDelay(1, 500, full, withRetryAfter(60_001))).toBe(60_000)
    expect(retryDelay(1, 500, full, withRetryAfter(Number.MAX_VALUE))).toBe(60_000)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -5000],
    ['a string', '5000'],
    ['null', null],
    ['an object', {}],
  ])('ignores a retry-after that is %s', (_name, value) => {
    expect(retryDelay(2, 500, full, withRetryAfter(value))).toBe(1000)
  })

  it('stops looking after a few levels and survives a cause that points back at itself', () => {
    const loop: Error & { cause?: unknown } = new Error('loop')
    loop.cause = loop
    expect(retryDelay(1, 500, full, loop)).toBe(500)
    let chain: unknown = new LlmError('rate_limit', 'x', { retryAfterMs: 9000 })
    for (let level = 0; level < 10; level++) chain = new Error(`level ${level}`, { cause: chain })
    expect(retryDelay(1, 500, full, chain)).toBe(500)
  })

  it('does not read the random source more than the backoff does', () => {
    let calls = 0
    retryDelay(1, 500, () => (calls++, 1), withRetryAfter(4000))
    expect(calls).toBe(1)
  })
})

function engineWith(script: unknown[], sleeps: number[], random: () => number = full) {
  let call = 0
  const registry = createCoreRegistry().register(
    defineAction({
      type: 'test.limited@1',
      title: 'Limited',
      description: 'Fails with a rate limit as scripted, then succeeds.',
      sideEffect: 'none',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ attempt: Type.Integer() }),
      execute: async (_config, ctx) => {
        const next = script[call++]
        if (next === 'ok') return { attempt: ctx.attempt }
        throw next instanceof Error ? next : new RetryableError('limited')
      },
    }),
  )
  return new Engine({
    db: Db.open(':memory:'),
    registry,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random,
  })
}

const run = async (engine: Engine, maxAttempts: number) => {
  const id = engine.deploy(
    linearWorkflow([{ id: 't1', type: 'trigger.manual@1' }, { id: 'n1', type: 'test.limited@1', retry: { maxAttempts } }]),
  )
  return engine.startRun(id)
}

describe('the executor waits for retry-after through the injected sleep', () => {
  it('uses the longer retry-after, then the plain backoff when the next error has none, then a retry-after again', async () => {
    const sleeps: number[] = []
    const engine = engineWith([withRetryAfter(3000), new RetryableError('plain'), withRetryAfter(5000), 'ok'], sleeps)
    expect((await run(engine, 4)).status).toBe('succeeded')
    expect(sleeps).toEqual([3000, 1000, 5000])
  })

  it('keeps the plain backoff when the retry-after is shorter, absent or not a usable number', async () => {
    const sleeps: number[] = []
    const engine = engineWith([withRetryAfter(100), withRetryAfter(Number.NaN), withRetryAfter(Number.POSITIVE_INFINITY), 'ok'], sleeps)
    expect((await run(engine, 4)).status).toBe('succeeded')
    expect(sleeps).toEqual([500, 1000, 2000])
  })

  it('caps a huge retry-after at 60 seconds', async () => {
    const sleeps: number[] = []
    const engine = engineWith([withRetryAfter(3_600_000), 'ok'], sleeps)
    expect((await run(engine, 2)).status).toBe('succeeded')
    expect(sleeps).toEqual([60_000])
  })

  it('does not sleep after the last attempt, and does not retry a plain error', async () => {
    const sleeps: number[] = []
    const engine = engineWith([withRetryAfter(3000), withRetryAfter(3000)], sleeps)
    expect((await run(engine, 2)).status).toBe('failed')
    expect(sleeps).toEqual([3000])
    const plain: number[] = []
    expect((await run(engineWith([new Error('permanent')], plain), 3)).status).toBe('failed')
    expect(plain).toEqual([])
  })

  it('uses the retry-after even when the jitter would pick no wait at all', async () => {
    const sleeps: number[] = []
    const engine = engineWith([withRetryAfter(2000), 'ok'], sleeps, none)
    expect((await run(engine, 2)).status).toBe('succeeded')
    expect(sleeps).toEqual([2000])
  })
})

describe('llm.extract hands the retry-after of the provider to the executor', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rill-retry-after-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function engineFor(errors: LlmError[], sleeps: number[]) {
    const replies: (LlmError | { amount: number })[] = [...errors, { amount: 4 }]
    const llm: LlmProvider = {
      name: 'fake',
      generate: async () => {
        const next = replies.shift()!
        if (next instanceof Error) throw next
        return {
          data: next,
          model: 'fake',
          requestedModel: 'fake',
          stopReason: 'end_turn',
          durationMs: 1,
          fallbackUsed: false,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }
      },
    }
    return new Engine({
      db: Db.open(':memory:'),
      registry: createCoreRegistry(),
      allowedRoots: [dir],
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: full,
      llm,
    })
  }

  const extractRun = async (engine: Engine, maxAttempts: number) => {
    const file = join(dir, 'doc.txt')
    writeFileSync(file, 'total 4')
    const id = engine.deploy({
      schemaVersion: 1,
      name: 'extract',
      nodes: [
        { id: 't1', type: 'trigger.manual@1', config: {} },
        { id: 'ex', type: 'llm.extract@1', config: { file, fields: [{ name: 'amount', type: 'number' }] }, retry: { maxAttempts } },
      ],
      edges: [{ from: 't1', to: 'ex' }],
    })
    return engine.startRun(id)
  }

  it('waits for the retry-after of a 429 that the provider reports', async () => {
    const sleeps: number[] = []
    const result = await extractRun(engineFor([new LlmError('rate_limit', 'slow down', { status: 429, retryAfterMs: 8000 })], sleeps), 2)
    expect(result.status).toBe('succeeded')
    expect(sleeps).toEqual([8000])
  })

  it('applies the cap and each error\'s own value across attempts', async () => {
    const sleeps: number[] = []
    const errors = [
      new LlmError('overloaded', 'busy', { retryAfterMs: 120_000 }),
      new LlmError('rate_limit', 'slow down'),
      new LlmError('rate_limit', 'slow down', { retryAfterMs: 2500 }),
    ]
    const result = await extractRun(engineFor(errors, sleeps), 4)
    expect(result.status).toBe('succeeded')
    expect(sleeps).toEqual([60_000, 1000, 2500])
  })
})
