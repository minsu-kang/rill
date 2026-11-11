import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS, STREAMING_ABOVE_MAX_TOKENS } from '../src/index'
import { closeServers, errorBody, message, mock, provider, request, sse, streamEvents } from './mock'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeServers()
})

const slow = (delayMs: number) => () => ({ body: message('{"a":1}'), delayMs })

describe('per-call timeout', () => {
  it('times out a slow reply at the per-call value while the provider default would not', async () => {
    const { baseURL } = await mock(slow(400))
    const generous = provider(baseURL)
    expect(generous.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    await expect(generous.generate(request)).resolves.toMatchObject({ data: { a: 1 } })
    const error = await generous.generate(request, { timeoutMs: 50 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true, name: 'LlmError' })
  })

  it('gives up near the per-call value, not near the reply time', async () => {
    const { baseURL } = await mock(slow(3000))
    const startedAt = Date.now()
    await expect(provider(baseURL).generate(request, { timeoutMs: 60 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - startedAt).toBeLessThan(1500)
  })

  it('lets a per-call value above the provider default win', async () => {
    const { baseURL } = await mock(slow(300))
    const strict = provider(baseURL, { timeoutMs: 50 })
    await expect(strict.generate(request)).rejects.toMatchObject({ kind: 'timeout' })
    await expect(strict.generate(request, { timeoutMs: 5000 })).resolves.toMatchObject({ data: { a: 1 } })
  })

  it('applies per call: a later call without the option goes back to the provider value', async () => {
    const { baseURL } = await mock(slow(300))
    const generous = provider(baseURL)
    await expect(generous.generate(request, { timeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' })
    await expect(generous.generate(request)).resolves.toMatchObject({ data: { a: 1 } })
  })

  it('still reports an abort as aborted when a timeout is set too', async () => {
    const { baseURL } = await mock(slow(2000))
    const controller = new AbortController()
    const pending = provider(baseURL).generate(request, { signal: controller.signal, timeoutMs: 5000 })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_CALL_TIMEOUT_MS + 1])(
    'rejects timeoutMs %s before any network call',
    async (timeoutMs) => {
      const { seen, baseURL } = await mock(slow(0))
      const error = await provider(baseURL).generate(request, { timeoutMs }).catch((e: unknown) => e)
      expect(error).toMatchObject({ kind: 'invalid_request', retryable: false })
      expect(seen).toHaveLength(0)
    },
  )

  it('accepts the smallest and the largest allowed value', async () => {
    const { baseURL } = await mock(slow(0))
    await expect(provider(baseURL).generate(request, { timeoutMs: MAX_CALL_TIMEOUT_MS })).resolves.toMatchObject({ data: { a: 1 } })
    const outcome = await provider(baseURL).generate(request, { timeoutMs: 1 }).catch((e: unknown) => e)
    expect(outcome).not.toMatchObject({ kind: 'invalid_request' })
  })
})

describe('deadline of a streamed call', () => {
  const LONG = STREAMING_ABOVE_MAX_TOKENS + 1
  const full = streamEvents(message('{"a":1}'))
  const stalled = () => ({ sse: { events: full.slice(0, 1), then: 'hold' as const } })

  function trackTimers() {
    const created: { handle: unknown; delay: number | undefined }[] = []
    const cleared = new Set<unknown>()
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...args: unknown[]) => {
      const handle: unknown = realSet(fn, delay, ...args)
      created.push({ handle, delay })
      return handle
    }) as typeof setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(handle)
      realClear(handle)
    }) as typeof clearTimeout)
    return (delay: number) => {
      const own = created.filter((entry) => entry.delay === delay)
      return { count: own.length, leaked: own.filter((entry) => !cleared.has(entry.handle)).length }
    }
  }

  it('times out a body that stalls after message_start and closes the connection', async () => {
    const { seen, baseURL } = await mock(stalled)
    const startedAt = Date.now()
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }, { timeoutMs: 100 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true, name: 'LlmError' })
    expect(Date.now() - startedAt).toBeLessThan(400)
    await expect.poll(() => seen[0]!.closed).toBe(true)
  })

  it('uses the provider timeout when the call gives none', async () => {
    const { baseURL } = await mock(stalled)
    const error = await provider(baseURL, { timeoutMs: 100 }).generate({ ...request, maxTokens: LONG }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('lets a per-call value above the provider timeout win', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: full, then: 'end' as const }, delayMs: 250 }))
    const strict = provider(baseURL, { timeoutMs: 100 })
    await expect(strict.generate({ ...request, maxTokens: LONG }, { timeoutMs: 5000 })).resolves.toMatchObject({ data: { a: 1 } })
  })

  it('counts the whole call, not the gap between events', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: full.slice(0, 3), then: 'hold' as const } }))
    const startedAt = Date.now()
    const error = await provider(baseURL).generate({ ...request, maxTokens: LONG }, { timeoutMs: 150 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout' })
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('still reports a caller abort as aborted while the deadline is pending', async () => {
    const { seen, baseURL } = await mock(stalled)
    const controller = new AbortController()
    const pending = provider(baseURL).generate({ ...request, maxTokens: LONG }, { signal: controller.signal, timeoutMs: 5000 })
    setTimeout(() => controller.abort(), 60)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    await expect.poll(() => seen[0]!.closed).toBe(true)
  })

  it('reports an abort that came before the call as aborted, not as a timeout', async () => {
    const { baseURL } = await mock(stalled)
    const controller = new AbortController()
    controller.abort()
    await expect(provider(baseURL).generate({ ...request, maxTokens: LONG }, { signal: controller.signal, timeoutMs: 50 })).rejects.toMatchObject({
      kind: 'aborted',
    })
  })

  it('reports a timeout that came before the caller abort as a timeout', async () => {
    const { baseURL } = await mock(stalled)
    const controller = new AbortController()
    const pending = provider(baseURL).generate({ ...request, maxTokens: LONG }, { signal: controller.signal, timeoutMs: 60 })
    setTimeout(() => controller.abort(), 1000)
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('leaves a stream that finishes in time untouched', async () => {
    const { baseURL } = await mock(() => ({ sse: { events: full, then: 'end' as const } }))
    const result = await provider(baseURL).generate({ ...request, maxTokens: LONG }, { timeoutMs: 5000 })
    expect(result).toMatchObject({ data: { a: 1 }, stopReason: 'end_turn' })
  })

  it('clears its timer and the caller listener after success, after an error and after a timeout', async () => {
    const delays = trackTimers()
    const signal = new AbortController().signal
    const ok = await mock(() => ({ sse: { events: full, then: 'end' as const } }))
    await provider(ok.baseURL).generate({ ...request, maxTokens: LONG }, { signal, timeoutMs: 54_321 })
    expect(delays(54_321).count).toBeGreaterThan(0)
    expect(delays(54_321).leaked).toBe(0)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)

    const broken = await mock(() => ({ sse: { events: [...full.slice(0, 3), sse('error', errorBody('overloaded_error', 'busy'))] } }))
    await expect(provider(broken.baseURL).generate({ ...request, maxTokens: LONG }, { signal, timeoutMs: 54_322 })).rejects.toMatchObject({ kind: 'overloaded' })
    expect(delays(54_322).count).toBeGreaterThan(0)
    expect(delays(54_322).leaked).toBe(0)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)

    const hung = await mock(stalled)
    await expect(provider(hung.baseURL).generate({ ...request, maxTokens: LONG }, { signal, timeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(delays(100).leaked).toBe(0)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('does not start a deadline for a call that does not stream', async () => {
    const delays = trackTimers()
    const { baseURL } = await mock(() => ({ body: message('{"a":1}') }))
    await provider(baseURL).generate({ ...request, maxTokens: STREAMING_ABOVE_MAX_TOKENS }, { timeoutMs: 54_323 })
    const streamed = await mock(() => ({ sse: { events: full, then: 'end' as const } }))
    await provider(streamed.baseURL).generate({ ...request, maxTokens: LONG }, { timeoutMs: 54_324 })
    expect(delays(54_324).count).toBe(delays(54_323).count + 1)
  })
})
