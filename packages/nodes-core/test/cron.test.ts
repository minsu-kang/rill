import { describe, expect, it } from 'vitest'
import { CronParseError, nextCronTime, parseCron } from '../src/cron'

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s)
const next = (expression: string, after: number) => nextCronTime(parseCron(expression), after, 'utc')

function naiveNext(expression: string, after: number): number | null {
  const spec = parseCron(expression)
  const parts = expression.trim().split(/\s+/)
  const bothRestricted = !parts[2]!.startsWith('*') && !parts[4]!.startsWith('*')
  for (let t = Math.floor(after / 60_000) * 60_000 + 60_000; t <= after + 400 * 86_400_000; t += 60_000) {
    const d = new Date(t)
    const dayOk = spec.days.has(d.getUTCDate())
    const weekdayOk = spec.weekdays.has(d.getUTCDay())
    const dayMatch = bothRestricted ? dayOk || weekdayOk : dayOk && weekdayOk
    if (
      spec.minutes.has(d.getUTCMinutes()) &&
      spec.hours.has(d.getUTCHours()) &&
      spec.months.has(d.getUTCMonth() + 1) &&
      dayMatch
    ) {
      return t
    }
  }
  return null
}

const REFERENCE_EXPRESSIONS = [
  '*/7 * * * *',
  '5 4 * * *',
  '0 0 */2 * *',
  '0 0 * * */2',
  '30 6 1,15 * *',
  '0 12 * * mon-fri',
  '0 0 1 jan,jul *',
  '15 */3 * * 6,0',
  '59 23 31 * *',
  '0 0 1 * 1',
  '0 0 */3 * 5',
  '*/20 8-10 * 3-4 *',
]
const REFERENCE_STARTS = [utc(2026, 1, 1), utc(2026, 2, 28, 23, 59), utc(2026, 11, 30, 12, 30), utc(2027, 12, 31, 23, 59, 59)]

describe('parseCron', () => {
  it('expands lists, ranges, steps and names', () => {
    const spec = parseCron('10-30/10 0,12 1 jan,jul mon-fri')
    expect([...spec.minutes]).toEqual([10, 20, 30])
    expect([...spec.hours]).toEqual([0, 12])
    expect([...spec.days]).toEqual([1])
    expect([...spec.months]).toEqual([1, 7])
    expect([...spec.weekdays]).toEqual([1, 2, 3, 4, 5])
  })

  it('treats 7 as Sunday and */n as unrestricted for the day rule', () => {
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0])
    const spec = parseCron('0 0 */2 * *')
    expect(spec.daysRestricted).toBe(false)
    expect(spec.weekdaysRestricted).toBe(false)
    expect(parseCron('0 0 1 * 1').daysRestricted).toBe(true)
  })

  it('stops a weekday step at Saturday so 7 never sneaks in as Sunday', () => {
    expect([...parseCron('0 0 * * 3/2').weekdays]).toEqual([3, 5])
  })

  it('accepts surrounding and repeated whitespace', () => {
    expect([...parseCron('  5   *  *  *  *  ').minutes]).toEqual([5])
  })

  it.each([
    ['* * * *', 'expected 5 fields'],
    ['* * * * * *', 'expected 5 fields'],
    ['60 * * * *', 'minute out of range 0-59'],
    ['* 24 * * *', 'hour out of range 0-23'],
    ['* * 0 * *', 'day of month out of range 1-31'],
    ['* * * 13 *', 'month out of range 1-12'],
    ['*/0 * * * *', 'invalid step in minute'],
    ['*/a * * * *', 'invalid step in minute'],
    ['1/2/3 * * * *', 'invalid step in minute'],
    ['a * * * *', 'invalid minute value: a'],
    ['5-1 * * * *', 'descending range in minute'],
    ['1-2-3 * * * *', 'invalid range in minute'],
    ['1,,2 * * * *', 'empty item in minute'],
    ['', 'expected 5 fields'],
  ])('rejects %j', (expression, message) => {
    expect(() => parseCron(expression)).toThrow(CronParseError)
    expect(() => parseCron(expression)).toThrow(message)
  })
})

describe('nextCronTime', () => {
  it('finds the next step minute', () => {
    expect(next('*/15 * * * *', utc(2026, 11, 11, 10, 7, 30))).toBe(utc(2026, 11, 11, 10, 15))
  })

  it('is strictly after the given time', () => {
    expect(next('* * * * *', utc(2026, 11, 11, 10, 0, 0))).toBe(utc(2026, 11, 11, 10, 1))
    expect(next('0 10 * * *', utc(2026, 11, 11, 10, 0, 0))).toBe(utc(2026, 11, 12, 10, 0))
  })

  it('skips weekends for a weekday schedule', () => {
    const friday = utc(2026, 11, 13, 9, 0)
    expect(new Date(friday).getUTCDay()).toBe(5)
    expect(next('0 9 * * 1-5', friday)).toBe(utc(2026, 11, 16, 9, 0))
  })

  it('treats 7 as Sunday', () => {
    expect(next('0 0 * * 7', utc(2026, 11, 13, 9, 0))).toBe(utc(2026, 11, 15, 0, 0))
  })

  it('handles leap days and short months', () => {
    expect(next('0 0 29 2 *', utc(2026, 3, 1))).toBe(utc(2028, 2, 29, 0, 0))
    expect(next('0 0 31 * *', utc(2026, 4, 30, 12, 0))).toBe(utc(2026, 5, 31, 0, 0))
  })

  it('uses month names', () => {
    expect(next('0 12 1 jan,jul *', utc(2026, 2, 1))).toBe(utc(2026, 7, 1, 12, 0))
  })

  it('matches either day field when both are restricted', () => {
    const sunday = utc(2026, 11, 1, 0, 0)
    expect(new Date(sunday).getUTCDay()).toBe(0)
    expect(next('0 0 1 * 1', sunday)).toBe(utc(2026, 11, 2, 0, 0))
  })

  it('honours */n in the day and weekday fields', () => {
    const days: number[] = []
    let cursor = utc(2026, 11, 30, 12)
    for (let i = 0; i < 4; i += 1) {
      cursor = next('0 0 */2 * *', cursor)!
      days.push(new Date(cursor).getUTCDate())
    }
    expect(days).toEqual([1, 3, 5, 7])
    const weekdays: number[] = []
    cursor = utc(2026, 11, 8, 12)
    for (let i = 0; i < 4; i += 1) {
      cursor = next('0 0 * * */2', cursor)!
      weekdays.push(new Date(cursor).getUTCDay())
    }
    expect(weekdays).toEqual([2, 4, 6, 0])
  })

  it.each(REFERENCE_EXPRESSIONS)('agrees with a minute-by-minute scan for %s', (expression) => {
    for (const start of REFERENCE_STARTS) {
      expect(next(expression, start)).toBe(naiveNext(expression, start))
    }
  })

  it('returns null for an expression that can never fire', () => {
    expect(next('0 0 30 2 *', utc(2026, 1, 1))).toBeNull()
  })

  it('works in the local zone', () => {
    const after = new Date(2026, 10, 11, 10, 7, 30).getTime()
    const result = nextCronTime(parseCron('*/15 * * * *'), after, 'local')
    expect(result).toBe(new Date(2026, 10, 11, 10, 15).getTime())
  })
})
