import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_MS, startDeadline } from '../src/deadline'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startDeadline', () => {
  it('aborts its signal and reports expiry when the time is up', () => {
    const deadline = startDeadline(100, undefined)
    vi.advanceTimersByTime(99)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.expired()).toBe(true)
  })

  it('passes a caller abort on and does not report expiry', () => {
    const caller = new AbortController()
    const deadline = startDeadline(100, caller.signal)
    caller.abort('stop')
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.signal.reason).toBe('stop')
    expect(deadline.expired()).toBe(false)
  })

  it('does not report expiry when the timer fires after a caller abort', () => {
    const caller = new AbortController()
    const deadline = startDeadline(100, caller.signal)
    caller.abort()
    vi.advanceTimersByTime(200)
    expect(deadline.expired()).toBe(false)
  })

  it('starts aborted when the caller already aborted', () => {
    const caller = new AbortController()
    caller.abort()
    const deadline = startDeadline(100, caller.signal)
    expect(deadline.signal.aborted).toBe(true)
    vi.advanceTimersByTime(200)
    expect(deadline.expired()).toBe(false)
  })

  it('stops the timer and detaches from the caller on dispose', () => {
    const caller = new AbortController()
    const deadline = startDeadline(100, caller.signal)
    expect(vi.getTimerCount()).toBe(1)
    deadline.dispose()
    expect(vi.getTimerCount()).toBe(0)
    caller.abort()
    expect(deadline.signal.aborted).toBe(false)
  })

  it('keeps the timer inside the range setTimeout accepts', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    startDeadline(Number.POSITIVE_INFINITY, undefined).dispose()
    startDeadline(Number.NaN, undefined).dispose()
    startDeadline(MAX_TIMER_MS * 2, undefined).dispose()
    expect(spy.mock.calls.map((call) => call[1])).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, MAX_TIMER_MS])
  })
})
