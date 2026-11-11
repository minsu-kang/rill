import type { Currency, NumberFormat, SymbolPosition } from '../src/suites/extract/render-text'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const DATE_TOKENS = ['YYYY', 'MMMM', 'MMM', 'YY', 'MM', 'DD', 'M', 'D']

export function fmtDate(iso: string, pattern: string): string {
  const [y = 0, m = 0, d = 0] = iso.split('-').map(Number)
  const month = MONTHS[m - 1] ?? ''
  const values: Record<string, string> = {
    YYYY: String(y),
    YY: String(y).slice(-2),
    MMMM: month,
    MMM: month.slice(0, 3),
    MM: String(m).padStart(2, '0'),
    DD: String(d).padStart(2, '0'),
    M: String(m),
    D: String(d),
  }
  let out = ''
  for (let i = 0; i < pattern.length; ) {
    const rest = pattern.slice(i)
    const token = DATE_TOKENS.find((candidate) => rest.startsWith(candidate))
    if (token === undefined) {
      out += pattern.charAt(i)
      i += 1
    } else {
      out += values[token] ?? ''
      i += token.length
    }
  }
  return out
}

const NUM: Record<NumberFormat, [decimal: string, group: string, digits: number]> = {
  '1,234.50': ['.', ',', 2],
  '1.234,50': [',', '.', 2],
  '1 234,50': [',', ' ', 2],
  "1'234.50": ['.', "'", 2],
  '1234.50': ['.', '', 2],
  '12,500': ['', ',', 0],
  '12500': ['', '', 0],
}

export const numberDigits = (key: NumberFormat): number => NUM[key][2]

export function fmtNum(n: number, key: NumberFormat): string {
  const [decimal, group, digits] = NUM[key]
  const [ip = '', fp = ''] = Math.abs(n).toFixed(digits).split('.')
  let grouped = ''
  for (let i = 0; i < ip.length; i += 1) {
    if (i > 0 && (ip.length - i) % 3 === 0) grouped += group
    grouped += ip.charAt(i)
  }
  return grouped + (digits ? decimal + fp : '')
}

const SYM: Record<Currency, [prefix: string, prefixGap: string, suffix: string, suffixGap: string]> = {
  USD: ['$', '', '$', ' '],
  EUR: ['€', '', '€', ' '],
  GBP: ['£', '', '£', ' '],
  KRW: ['₩', '', '원', ''],
  JPY: ['¥', '', '円', ''],
  CHF: ['CHF', ' ', 'CHF', ' '],
}

export function fmtMoney(n: number, currency: Currency, key: NumberFormat, position: SymbolPosition): string {
  const body = fmtNum(n, key)
  if (position === 'none') return body
  const [prefix, prefixGap, suffix, suffixGap] = SYM[currency]
  return position === 'prefix' ? prefix + prefixGap + body : body + suffixGap + suffix
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const hasNumberToken = (text: string, token: string): boolean =>
  new RegExp(`(?<![\\d.,'])${escapeRegExp(token)}(?!\\d|[.,']\\d)`).test(text)

export const hasDateToken = (text: string, token: string): boolean =>
  new RegExp(`(?<!\\d)${escapeRegExp(token)}(?!\\d)`).test(text)

export function validIso(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const date = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s
}

export const normalizeSpace = (s: string): string => s.replace(/\s+/g, ' ').trim()
