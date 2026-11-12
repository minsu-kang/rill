import { LlmError, type LlmErrorKind } from './types'

export const MAX_RETRIES = 2
export const MAX_RETRY_AFTER_MS = 60_000
const BASE_DELAY_MS = 500
const JITTER_AFTER_HINT_MS = 250
const RETRIED_KINDS: ReadonlySet<LlmErrorKind> = new Set(['rate_limit', 'overloaded', 'connection'])

export interface RetryAttempt {
  outputStarted(): void
}

export interface RetryOptions {
  signal?: AbortSignal
  abortError?: () => LlmError
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxRetries?: number
  shouldRetry?: (error: LlmError) => boolean
}

export function retryDelayMs(error: LlmError, retryIndex: number, random: () => number): number {
  if (error.retryAfterMs !== undefined) return Math.round(Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS) + random() * JITTER_AFTER_HINT_MS)
  const step = BASE_DELAY_MS * 2 ** retryIndex
  return Math.round(step / 2 + (step / 2) * random())
}

function realSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function pause(ms: number, options: RetryOptions, fallback: LlmError): Promise<void> {
  const { signal } = options
  const abort = () => options.abortError?.() ?? new LlmError('aborted', 'the request was cancelled', { cause: fallback })
  const isAborted = () => signal?.aborted === true
  if (isAborted()) throw abort()
  if (options.sleep === undefined) await realSleep(ms, signal)
  else {
    let onAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([options.sleep(ms), aborted])
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
  }
  if (isAborted()) throw abort()
}

export async function withRetry<T>(attempt: (context: RetryAttempt) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const random = options.random ?? Math.random
  for (let index = 0; ; index++) {
    let started = false
    try {
      return await attempt({ outputStarted: () => void (started = true) })
    } catch (error) {
      const retryable =
        !started &&
        error instanceof LlmError &&
        RETRIED_KINDS.has(error.kind) &&
        index < maxRetries &&
        (options.shouldRetry === undefined || options.shouldRetry(error))
      if (!retryable) throw error
      await pause(retryDelayMs(error, index, random), options, error)
    }
  }
}
