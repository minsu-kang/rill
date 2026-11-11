import { describe, expect, it } from 'vitest'
import { amountToCents, normalizeVendor } from '../src/normalize'

describe('normalizeVendor', () => {
  it.each([
    ['Kettle & Crumb, Inc.', 'kettle and crumb'],
    ['KETTLE AND CRUMB LLC', 'kettle and crumb'],
    ['Kettle  &  Crumb', 'kettle and crumb'],
    ['The Coffee Co.', 'coffee'],
    ['Foo Co Ltd', 'foo'],
    ['Acme Corp', 'acme'],
    ['Müller GmbH', 'müller'],
    ["Joe's Diner", 'joes diner'],
    ['Joe’s Diner', 'joes diner'],
    ['Coca-Cola Ltd.', 'coca cola'],
    ['AT&T', 'at and t'],
    ['ＡＢＣ Store', 'abc store'],
    ['  many   spaces\there  ', 'many spaces here'],
    ['스타벅스 강남점', '스타벅스 강남점'],
    ['Store #5 (Downtown)', 'store 5 downtown'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normalizeVendor(input)).toBe(expected)
  })

  it('composes decomposed accents so both spellings compare equal', () => {
    expect(normalizeVendor('Müller')).toBe(normalizeVendor('Müller'))
  })

  it('only drops legal suffixes at the end, and never reduces a name to nothing', () => {
    expect(normalizeVendor('Co-op')).toBe('co op')
    expect(normalizeVendor('Inc Ink')).toBe('inc ink')
    expect(normalizeVendor('The Inc')).toBe('inc')
    expect(normalizeVendor('Inc')).toBe('inc')
    expect(normalizeVendor('The')).toBe('the')
    expect(normalizeVendor('The Co Ltd')).toBe('co')
  })

  it('returns an empty string for text without letters or digits', () => {
    expect(normalizeVendor('')).toBe('')
    expect(normalizeVendor('  ')).toBe('')
    expect(normalizeVendor('!!! ---')).toBe('')
  })

  it('is idempotent', () => {
    for (const name of ['The Kettle & Crumb Co., Ltd.', "Joe's", '스타벅스']) {
      expect(normalizeVendor(normalizeVendor(name))).toBe(normalizeVendor(name))
    }
  })
})

describe('amountToCents (numbers)', () => {
  it.each([
    [12.5, 1250],
    [19.99, 1999],
    [8.2, 820],
    [0.1 + 0.2, 30],
    [0, 0],
    [-5.5, -550],
    [1234567.89, 123456789],
  ])('%d is %d cents', (input, cents) => {
    expect(amountToCents(input)).toBe(cents)
  })

  it('never returns negative zero', () => {
    expect(Object.is(amountToCents(-0.001), 0)).toBe(true)
    expect(Object.is(amountToCents(-0), 0)).toBe(true)
  })

  it('returns null for values that are not finite or not safely representable', () => {
    expect(amountToCents(Number.NaN)).toBeNull()
    expect(amountToCents(Number.POSITIVE_INFINITY)).toBeNull()
    expect(amountToCents(1e300)).toBeNull()
  })
})

describe('amountToCents (strings)', () => {
  it.each([
    ['12.50', 1250],
    ['12', 1200],
    ['$12.50', 1250],
    ['€12,50', 1250],
    ['£12.5', 1250],
    ['USD 1,234.56', 123456],
    ['1,234.56 EUR', 123456],
    ['1,234.56', 123456],
    ['1.234,56', 123456],
    ['1 234,56', 123456],
    ['1 234,56', 123456],
    ['1 234,56', 123456],
    ["1'234.50", 123450],
    ['1,234,567.89', 123456789],
    ['1.234.567,89', 123456789],
    ['12,000원', 1200000],
    ['12,50', 1250],
    ['0,5', 50],
    ['0,500', 50],
    [',50', 50],
    ['.5', 50],
    ['1,234', 123400],
    ['1.234.567', 123456700],
    ['+5', 500],
    ['  7.25  ', 725],
  ])('%j is %d cents', (input, cents) => {
    expect(amountToCents(input)).toBe(cents)
  })

  it.each([
    ['-$12.50', -1250],
    ['$-12.50', -1250],
    ['-12.50', -1250],
    ['−12.50', -1250],
    ['(12.50)', -1250],
    ['12.50-', -1250],
  ])('keeps the sign of %j', (input, cents) => {
    expect(amountToCents(input)).toBe(cents)
  })

  it.each(['', '   ', 'abc', '$', '-', '12.', '12.5.5', '12,34.56', '1e3', '12 apples', '1,2345', '1.2.3', '--5', 'N/A'])(
    'returns null for %j',
    (input) => {
      expect(amountToCents(input)).toBeNull()
    },
  )

  it('reads a single dot as a decimal point', () => {
    expect(amountToCents('1.234')).toBe(123)
  })

  it('never returns negative zero for strings', () => {
    expect(Object.is(amountToCents('-0.00'), 0)).toBe(true)
  })
})
