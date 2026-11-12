import { describe, expect, it } from 'vitest'
import { LlmError, MAX_RETRY_AFTER_MS, retryDelayMs, withRetry } from '../src/index'

const fail = (kind: ConstructorParameters<typeof LlmError>[0], retryAfterMs?: number) => new LlmError(kind, kind, { retryAfterMs })

function harness(outcomes: (LlmError | string)[], options: Parameters<typeof withRetry>[1] = {}) {
  const sleeps: number[] = []
  let calls = 0
  const run = () =>
    withRetry(
      async () => {
        const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
        calls += 1
        if (outcome instanceof LlmError) throw outcome
        return outcome
      },
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, ...options },
    )
  return { run, sleeps, calls: () => calls }
}

describe('retryDelayMs', () => {
  it('backs off exponentially with jitter between half and the full step', () => {
    expect(retryDelayMs(fail('overloaded'), 0, () => 0)).toBe(250)
    expect(retryDelayMs(fail('overloaded'), 0, () => 1)).toBe(500)
    expect(retryDelayMs(fail('overloaded'), 1, () => 0)).toBe(500)
    expect(retryDelayMs(fail('overloaded'), 1, () => 1)).toBe(1000)
  })

  it('waits at least as long as retry-after asks, plus a little jitter', () => {
    expect(retryDelayMs(fail('rate_limit', 3000), 0, () => 0)).toBe(3000)
    expect(retryDelayMs(fail('rate_limit', 3000), 0, () => 1)).toBeGreaterThan(3000)
    expect(retryDelayMs(fail('rate_limit', 3000), 0, () => 1)).toBeLessThanOrEqual(3250)
    expect(retryDelayMs(fail('rate_limit', 0), 0, () => 0)).toBe(0)
  })

  it('caps retry-after at 60 seconds', () => {
    expect(retryDelayMs(fail('rate_limit', 3_600_000), 0, () => 0)).toBe(MAX_RETRY_AFTER_MS)
    expect(MAX_RETRY_AFTER_MS).toBe(60_000)
  })
})

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const h = harness(['ok'])
    await expect(h.run()).resolves.toBe('ok')
    expect(h.calls()).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  it.each(['rate_limit', 'overloaded', 'connection'] as const)('retries %s up to two times and then gives up', async (kind) => {
    const h = harness([fail(kind)])
    await expect(h.run()).rejects.toMatchObject({ kind })
    expect(h.calls()).toBe(3)
    expect(h.sleeps).toHaveLength(2)
  })

  it('recovers when a later attempt succeeds', async () => {
    const h = harness([fail('overloaded'), 'ok'])
    await expect(h.run()).resolves.toBe('ok')
    expect(h.calls()).toBe(2)
  })

  it.each(['auth', 'invalid_request', 'refusal', 'truncated', 'invalid_output', 'timeout', 'aborted', 'unknown'] as const)('does not retry %s', async (kind) => {
    const h = harness([fail(kind)])
    await expect(h.run()).rejects.toMatchObject({ kind })
    expect(h.calls()).toBe(1)
  })

  it('does not retry a plain error', async () => {
    let calls = 0
    await expect(withRetry(async () => { calls += 1; throw new Error('bug') }, { sleep: async () => undefined })).rejects.toThrow('bug')
    expect(calls).toBe(1)
  })

  it('never retries after output started, even for a retryable kind', async () => {
    let calls = 0
    const run = withRetry(
      async (attempt) => {
        calls += 1
        attempt.outputStarted()
        throw fail('connection')
      },
      { sleep: async () => undefined },
    )
    await expect(run).rejects.toMatchObject({ kind: 'connection' })
    expect(calls).toBe(1)
  })

  it('counts output per attempt: an early failure retries, a later one with output does not', async () => {
    let calls = 0
    const run = withRetry(
      async (attempt) => {
        calls += 1
        if (calls === 1) throw fail('overloaded')
        attempt.outputStarted()
        throw fail('connection')
      },
      { sleep: async () => undefined },
    )
    await expect(run).rejects.toMatchObject({ kind: 'connection' })
    expect(calls).toBe(2)
  })

  it('honours retry-after through the injected sleep and random', async () => {
    const h = harness([fail('rate_limit', 4000)], { random: () => 0 })
    await expect(h.run()).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(h.sleeps).toEqual([4000, 4000])
  })

  it('lets the caller narrow what is retried', async () => {
    const h = harness([fail('rate_limit')], { shouldRetry: () => false })
    await expect(h.run()).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(h.calls()).toBe(1)
  })

  it('can be told to retry less often', async () => {
    const h = harness([fail('overloaded')], { maxRetries: 1 })
    await expect(h.run()).rejects.toBeInstanceOf(LlmError)
    expect(h.calls()).toBe(2)
  })

  it('stops waiting when the signal aborts during the pause and reports the abort error', async () => {
    const controller = new AbortController()
    const abortError = new LlmError('aborted', 'cancelled')
    let calls = 0
    const run = withRetry(
      async () => {
        calls += 1
        throw fail('overloaded')
      },
      { signal: controller.signal, abortError: () => abortError, sleep: () => new Promise<void>(() => undefined) },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(run).rejects.toBe(abortError)
    expect(calls).toBe(1)
  })

  it('does not start a pause when the signal is already aborted', async () => {
    const controller = new AbortController()
    const abortError = new LlmError('timeout', 'late')
    const sleeps: number[] = []
    const run = withRetry(
      async () => {
        controller.abort()
        throw fail('overloaded')
      },
      { signal: controller.signal, abortError: () => abortError, sleep: async (ms) => void sleeps.push(ms) },
    )
    await expect(run).rejects.toBe(abortError)
    expect(sleeps).toEqual([])
  })

  it('uses real timers by default and leaves none behind', async () => {
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
    const run = withRetry(async () => { throw fail('overloaded') }, { random: () => 0, maxRetries: 1 })
    await expect(run).rejects.toMatchObject({ kind: 'overloaded' })
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBeLessThanOrEqual(before)
  }, 5000)
})
