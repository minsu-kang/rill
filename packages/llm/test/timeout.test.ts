import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS } from '../src/index'
import { closeServers, message, mock, provider, request } from './mock'

afterEach(closeServers)

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
