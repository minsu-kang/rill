export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

export type CronZone = 'utc' | 'local'

export interface CronSpec {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
  daysRestricted: boolean
  weekdaysRestricted: boolean
}

interface FieldSpec {
  name: string
  min: number
  max: number
  upper?: number
  names?: string[]
  nameOffset?: number
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 }
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 }
const DAY: FieldSpec = { name: 'day of month', min: 1, max: 31 }
const MONTH: FieldSpec = { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 }
const WEEKDAY: FieldSpec = { name: 'day of week', min: 0, max: 7, upper: 6, names: WEEKDAY_NAMES, nameOffset: 0 }

function parseValue(raw: string, field: FieldSpec): number {
  const nameIndex = field.names?.indexOf(raw.toLowerCase()) ?? -1
  if (nameIndex >= 0) return nameIndex + (field.nameOffset ?? 0)
  if (!/^\d+$/.test(raw)) throw new CronParseError(`invalid ${field.name} value: ${raw}`)
  const value = Number(raw)
  if (value < field.min || value > field.max) {
    throw new CronParseError(`${field.name} out of range ${field.min}-${field.max}: ${raw}`)
  }
  return value
}

function parseField(text: string, field: FieldSpec): Set<number> {
  const values = new Set<number>()
  for (const item of text.split(',')) {
    if (item === '') throw new CronParseError(`empty item in ${field.name}`)
    const pieces = item.split('/')
    if (pieces.length > 2) throw new CronParseError(`invalid step in ${field.name}: ${item}`)
    const [rangeText = '', stepText] = pieces
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new CronParseError(`invalid step in ${field.name}: ${item}`)
      }
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (rangeText === '*') {
      from = field.min
      to = field.upper ?? field.max
    } else if (rangeText.includes('-')) {
      const bounds = rangeText.split('-')
      if (bounds.length !== 2) throw new CronParseError(`invalid range in ${field.name}: ${item}`)
      from = parseValue(bounds[0]!, field)
      to = parseValue(bounds[1]!, field)
      if (from > to) throw new CronParseError(`descending range in ${field.name}: ${item}`)
    } else {
      from = parseValue(rangeText, field)
      to = stepText === undefined ? from : (field.upper ?? field.max)
    }
    for (let value = from; value <= to; value += step) {
      values.add(field === WEEKDAY && value === 7 ? 0 : value)
    }
  }
  return values
}

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(`expected 5 fields (minute hour day month weekday), got ${expression.trim() === '' ? 0 : parts.length}`)
  }
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string]
  return {
    minutes: parseField(minute, MINUTE),
    hours: parseField(hour, HOUR),
    days: parseField(day, DAY),
    months: parseField(month, MONTH),
    weekdays: parseField(weekday, WEEKDAY),
    daysRestricted: !day.startsWith('*'),
    weekdaysRestricted: !weekday.startsWith('*'),
  }
}

function readFields(date: Date, zone: CronZone) {
  if (zone === 'utc') {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      weekday: date.getUTCDay(),
    }
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    weekday: date.getDay(),
  }
}

function makeDate(zone: CronZone, year: number, month: number, day: number, hour: number, minute: number): Date {
  return zone === 'utc'
    ? new Date(Date.UTC(year, month - 1, day, hour, minute))
    : new Date(year, month - 1, day, hour, minute)
}

function dayMatches(spec: CronSpec, day: number, weekday: number): boolean {
  const dayOk = spec.days.has(day)
  const weekdayOk = spec.weekdays.has(weekday)
  return spec.daysRestricted && spec.weekdaysRestricted ? dayOk || weekdayOk : dayOk && weekdayOk
}

function minuteKey(f: { year: number; month: number; day: number; hour: number; minute: number }): string {
  return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}`
}

export function nextCronTime(spec: CronSpec, after: number, zone: CronZone = 'local'): number | null {
  const limit = after + 8 * 366 * 86_400_000
  const afterKey = minuteKey(readFields(new Date(after), zone))
  const fixedHours = spec.hours.size < 24
  let cursor = new Date(Math.floor(after / 60_000) * 60_000 + 60_000)
  const move = (to: Date): void => {
    cursor = to.getTime() > cursor.getTime() ? to : new Date(cursor.getTime() + 60_000)
  }
  for (let guard = 0; guard < 100_000 && cursor.getTime() <= limit; guard += 1) {
    const f = readFields(cursor, zone)
    if (!spec.months.has(f.month)) move(makeDate(zone, f.year, f.month + 1, 1, 0, 0))
    else if (!dayMatches(spec, f.day, f.weekday)) move(makeDate(zone, f.year, f.month, f.day + 1, 0, 0))
    else if (!spec.hours.has(f.hour)) move(new Date(cursor.getTime() + (60 - f.minute) * 60_000))
    else if (!spec.minutes.has(f.minute)) move(new Date(cursor.getTime() + 60_000))
    else if (cursor.getTime() > after && !(fixedHours && minuteKey(f) === afterKey)) return cursor.getTime()
    else cursor = new Date(cursor.getTime() + 60_000)
  }
  return null
}
