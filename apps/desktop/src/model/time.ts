import type { Locale } from '../i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface Relative {
  key: 'time.justNow' | 'time.minutesAgo' | 'time.hoursAgo' | 'time.daysAgo'
  count: number
}

export function relativeTime(then: number, now: number): Relative {
  const age = now - then
  if (!Number.isFinite(age) || age < MINUTE) return { key: 'time.justNow', count: 0 }
  if (age < HOUR) return { key: 'time.minutesAgo', count: Math.floor(age / MINUTE) }
  if (age < DAY) return { key: 'time.hoursAgo', count: Math.floor(age / HOUR) }
  return { key: 'time.daysAgo', count: Math.floor(age / DAY) }
}

export function formatTimestamp(at: number, locale: Locale, timeZone?: string): string {
  if (!Number.isFinite(at)) return ''
  const language = locale === 'ko' ? 'ko-KR' : 'en-US'
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium', timeZone }).format(at)
  } catch {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(at)
  }
}
