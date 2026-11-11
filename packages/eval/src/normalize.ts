const LEGAL_SUFFIXES: ReadonlySet<string> = new Set(['inc', 'llc', 'ltd', 'gmbh', 'co', 'corp'])

const CURRENCY_CODES = /\b(?:usd|eur|gbp|jpy|krw|cad|aud|chf|cny|inr|mxn|brl|sek|nok|dkk|pln|czk|sgd|hkd|nzd)\b/giu

export function normalizeVendor(value: string): string {
  const text = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/['‘’´`.]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const tokens = text === '' ? [] : text.split(' ')
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift()
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1] ?? '')) tokens.pop()
  return tokens.join(' ')
}

const HANGUL = /\p{Script=Hangul}/u

export function vendorKey(normalized: string, other: string): string {
  return HANGUL.test(normalized) || HANGUL.test(other) ? normalized.replace(/\s+/gu, '') : normalized
}

export function vendorsEqual(left: string, right: string): boolean {
  if (left === '' || right === '') return false
  return left === right || vendorKey(left, right) === vendorKey(right, left)
}

function centsFromNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const cents = Math.round(value * 100)
  if (!Number.isSafeInteger(cents)) return null
  return cents === 0 ? 0 : cents
}

function isGrouped(parts: readonly string[]): boolean {
  const [first, ...rest] = parts
  return (
    first !== undefined &&
    /^\d{1,3}$/u.test(first) &&
    rest.every((group) => /^\d{3}$/u.test(group))
  )
}

function splitDigits(text: string): { whole: string; fraction: string } | null {
  const lastDot = text.lastIndexOf('.')
  const lastComma = text.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma)
    const decimal = text.charAt(decimalAt)
    const grouping = decimal === '.' ? ',' : '.'
    const whole = text.slice(0, decimalAt)
    const fraction = text.slice(decimalAt + 1)
    if (whole.includes(decimal) || !isGrouped(whole.split(grouping)) || !/^\d+$/u.test(fraction)) return null
    return { whole: whole.split(grouping).join(''), fraction }
  }
  if (lastComma >= 0) {
    const parts = text.split(',')
    if (parts.length === 2) {
      const [whole = '', fraction = ''] = parts
      if (/^\d*$/u.test(whole) && /^\d{1,2}$/u.test(fraction)) return { whole, fraction }
      if (whole === '0' && /^\d+$/u.test(fraction)) return { whole, fraction }
    }
    return isGrouped(parts) ? { whole: parts.join(''), fraction: '' } : null
  }
  if (lastDot >= 0) {
    const parts = text.split('.')
    if (parts.length === 2) {
      const [whole = '', fraction = ''] = parts
      return /^\d*$/u.test(whole) && /^\d+$/u.test(fraction) ? { whole, fraction } : null
    }
    return isGrouped(parts) ? { whole: parts.join(''), fraction: '' } : null
  }
  return /^\d+$/u.test(text) ? { whole: text, fraction: '' } : null
}

function centsFromString(raw: string): number | null {
  let text = raw.normalize('NFKC').trim()
  let negative = false
  if (/^\(.*\)$/u.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  text = text
    .replace(/[−–—]/gu, '-')
    .replace(/\p{Sc}/gu, '')
    .replace(CURRENCY_CODES, '')
    .replace(/원/gu, '')
    .replace(/[\s'’]/gu, '')
  if (text.startsWith('-') || text.endsWith('-')) {
    negative = true
    text = text.startsWith('-') ? text.slice(1) : text.slice(0, -1)
  } else if (text.startsWith('+')) {
    text = text.slice(1)
  }
  const digits = splitDigits(text)
  if (digits === null) return null
  const magnitude = Number(`${digits.whole === '' ? '0' : digits.whole}.${digits.fraction === '' ? '0' : digits.fraction}`)
  return centsFromNumber(negative ? -magnitude : magnitude)
}

export function amountToCents(value: number | string): number | null {
  return typeof value === 'number' ? centsFromNumber(value) : centsFromString(value)
}
