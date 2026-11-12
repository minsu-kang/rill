// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatTimestamp, relativeTime } from '../src/model/time'

const NOW = Date.UTC(2026, 10, 13, 9, 30, 0)
const MINUTE = 60_000

describe('relativeTime', () => {
  it('says just now below one minute, and for a time in the future', () => {
    expect(relativeTime(NOW, NOW)).toEqual({ key: 'time.justNow', count: 0 })
    expect(relativeTime(NOW - 59_999, NOW)).toEqual({ key: 'time.justNow', count: 0 })
    expect(relativeTime(NOW + 5 * MINUTE, NOW)).toEqual({ key: 'time.justNow', count: 0 })
  })

  it('counts whole minutes, hours and days, rounding down', () => {
    expect(relativeTime(NOW - MINUTE, NOW)).toEqual({ key: 'time.minutesAgo', count: 1 })
    expect(relativeTime(NOW - 59 * MINUTE - 59_000, NOW)).toEqual({ key: 'time.minutesAgo', count: 59 })
    expect(relativeTime(NOW - 60 * MINUTE, NOW)).toEqual({ key: 'time.hoursAgo', count: 1 })
    expect(relativeTime(NOW - 23 * 60 * MINUTE - 59 * MINUTE, NOW)).toEqual({ key: 'time.hoursAgo', count: 23 })
    expect(relativeTime(NOW - 24 * 60 * MINUTE, NOW)).toEqual({ key: 'time.daysAgo', count: 1 })
    expect(relativeTime(NOW - 400 * 24 * 60 * MINUTE, NOW)).toEqual({ key: 'time.daysAgo', count: 400 })
  })

  it('does not throw on values that are not finite', () => {
    expect(relativeTime(Number.NaN, NOW).key).toBe('time.justNow')
    expect(relativeTime(NOW, Number.NaN).key).toBe('time.justNow')
    expect(relativeTime(Number.NEGATIVE_INFINITY, NOW).key).toBe('time.justNow')
  })
})

describe('formatTimestamp', () => {
  it('formats the same instant differently for two time zones and the same for the same zone', () => {
    const utc = formatTimestamp(NOW, 'en', 'UTC')
    const seoul = formatTimestamp(NOW, 'en', 'Asia/Seoul')
    expect(utc).toContain('9:30')
    expect(seoul).toContain('6:30')
    expect(formatTimestamp(NOW, 'en', 'UTC')).toBe(utc)
  })

  it('follows the language', () => {
    expect(formatTimestamp(NOW, 'ko', 'UTC')).toMatch(/2026/)
    expect(formatTimestamp(NOW, 'ko', 'UTC')).not.toBe(formatTimestamp(NOW, 'en', 'UTC'))
  })

  it('falls back instead of throwing for an unknown time zone or a bad number', () => {
    expect(formatTimestamp(NOW, 'en', 'Not/AZone')).toContain('2026')
    expect(formatTimestamp(Number.NaN, 'en', 'UTC')).toBe('')
  })
})
