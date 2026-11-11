import { describe, expect, it } from 'vitest'
import {
  CURRENCY_DECIMALS,
  INJECTION_POSITIONS,
  TEMPLATES,
  renderText,
  resolveLabels,
  type DateFormat,
} from '../src/suites/extract/render-text'
import { DIFFICULTIES, loadSeeds, type Difficulty, type Seed } from '../src/suites/extract/seed'
import { fmtDate, fmtMoney, fmtNum, hasDateToken, hasNumberToken, numberDigits, validIso } from './extract-reference'

const TODAY = '2026-11-11'

const DIFFICULTY_COUNTS: Record<Difficulty, number> = { easy: 10, tricky: 8, missing: 6, adversarial: 6, nondoc: 6 }

const COVERAGE: Partial<Record<Difficulty, string[]>> = {
  tricky: [
    'tip-tax',
    'discount',
    'multiple-totals',
    'cash-change',
    'ambiguous-date',
    'european-format',
    'krw-no-decimals',
    'long',
  ],
  missing: ['no-date', 'no-vendor', 'torn-bottom'],
  adversarial: ['ignore-instructions', 'system-prompt', 'fake-closing-tag', 'fake-json', 'korean-instruction'],
  nondoc: ['meeting-note', 'blank', 'unpaid-invoice', 'bank-statement', 'menu', 'letter'],
}

const MON3 = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
const DATE_LIKE = new RegExp(
  [
    String.raw`\d{4}[./-]\d{1,2}[./-]\d{1,2}`,
    String.raw`\d{1,2}[./-]\d{1,2}[./-]\d{2,4}`,
    String.raw`\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일`,
    String.raw`\d{1,2}\s+(?:${MON3})[a-z]*\.?\s+\d{4}`,
    String.raw`(?:${MON3})[a-z]*\.?\s+\d{1,2},\s*\d{4}`,
  ].join('|'),
  'g',
)
const MONEY_LIKE = /\d{1,3}(?:,\d{3})+|\d+[.,]\d{2}\b|[₩$€£¥]\s?\d|\d\s?(?:원|円)/
const HANGUL = /[ㄱ-ㆎ가-힣]/
const TWO_DIGIT_YEAR_FORMATS: readonly DateFormat[] = ['YY/MM/DD', 'YY.MM.DD', 'DD/MM/YY', 'MM/DD/YY']
const DAY_FIRST_OR_MONTH_FIRST_FORMATS: readonly DateFormat[] = ['DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY']
const DOTTED_FORMATS: readonly DateFormat[] = ['YYYY.MM.DD', 'YY/MM/DD', 'YY.MM.DD']

const r2 = (x: number): number => Math.round(x * 100) / 100

function checkSeedData(s: Seed): string[] {
  const problems: string[] = []
  const ok = (cond: boolean, message: string): void => {
    if (!cond) problems.push(message)
  }
  const d = s.data
  const r = s.render
  const e = s.expected
  ok(
    s.why.length > 20 && !s.why.includes('\n') && s.why.endsWith('.') && (s.why.match(/[.!?](\s|$)/g) ?? []).length === 1,
    'why must be one sentence',
  )
  ok(d.date === null || validIso(d.date), `data.date must be a calendar date (${d.date})`)
  ok(d.date === null || d.date <= TODAY, `data.date ${d.date} is after ${TODAY}`)
  ok(d.body === undefined || s.template === 'plain-doc', 'data.body only on plain-doc')
  ok(
    numberDigits(r.numberFormat) === CURRENCY_DECIMALS[d.currency],
    `numberFormat ${r.numberFormat} has wrong decimals for ${d.currency}`,
  )
  ok(e.date === null || validIso(e.date), 'expected.date must be a calendar date')
  return problems
}

function checkSeed(s: Seed, otherVendors: readonly string[]): string[] {
  const problems = checkSeedData(s)
  const ok = (cond: boolean, message: string): void => {
    if (!cond) problems.push(message)
  }
  const d = s.data
  const r = s.render
  const e = s.expected
  const tags = new Set(s.tags)
  const L = resolveLabels(s)
  const omit = new Set<string>(r.omit ?? [])
  const before = JSON.stringify(s)
  const text = renderText(s)
  ok(JSON.stringify(s) === before, 'renderText mutated the seed')
  ok(renderText(structuredClone(s)) === text, 'renderText is not deterministic')
  ok(text.trim().length > 0 || tags.has('blank') || s.template === 'plain-doc', 'rendered text is empty')
  const lines = text.split('\n')

  if (e.amount !== null) ok(e.amount === d.total, `expected.amount ${e.amount} != data.total ${d.total}`)
  if (e.date !== null) ok(e.date === d.date, 'expected.date != data.date')
  if (e.vendor !== null) ok(e.vendor === d.vendor, 'expected.vendor != data.vendor')

  if (d.lines.length > 0 && d.total !== null) {
    const sum = r2(d.lines.reduce((acc, l) => acc + l.qty * l.unitPrice, 0))
    ok(d.subtotal === sum, `subtotal ${d.subtotal} != sum of lines ${sum}`)
    const total = r2((d.subtotal ?? 0) - (d.discount ?? 0) + (r.taxInclusive ? 0 : (d.tax ?? 0)) + (d.tip ?? 0))
    ok(d.total === total, `total ${d.total} != computed ${total}`)
    if (d.change !== null) ok(d.change > 0 && /cash|현금/i.test(d.paymentMethod ?? ''), 'change needs a cash payment')
  }

  const unpaid = tags.has('unpaid')
  const totalNum = d.total === null ? null : fmtNum(d.total, r.numberFormat)
  const totalMoney = d.total === null ? null : fmtMoney(d.total, d.currency, r.numberFormat, r.currencySymbolPosition)
  if (e.amount !== null) {
    ok(!omit.has('total') && !omit.has('prices') && r.torn?.edge !== 'bottom', 'expected.amount set but the total is hidden')
    if (totalMoney === null) ok(false, 'expected.amount set but data.total is null')
    else {
      const hits = lines.filter((l) => hasNumberToken(l, totalMoney))
      ok(hits.length > 0, `amount ${totalMoney} not found in text`)
      ok(hits.some((l) => l.includes(L.total)), `amount ${totalMoney} is not on a line with the total label "${L.total}"`)
    }
  } else if (unpaid) {
    ok(/due|미납/i.test(L.total) && /UNPAID|미납/.test(text), 'unpaid seed must label the total as due and say UNPAID')
    ok(d.paymentMethod === null && d.change === null, 'unpaid seed must not state a payment')
  } else if (totalNum !== null) {
    ok(!hasNumberToken(text, totalNum), `expected.amount is null but ${totalNum} appears in the text`)
    ok(!lines.some((l) => l.trim().startsWith(L.total)), 'expected.amount is null but a total line is printed')
  }
  if (s.template === 'plain-doc') {
    ok(
      tags.has('distractor-amount') === MONEY_LIKE.test(text),
      tags.has('distractor-amount')
        ? 'distractor-amount tag but no amount in text'
        : 'plain-doc text contains an amount without distractor-amount tag',
    )
  }

  const dateStr = d.date === null ? null : fmtDate(d.date, r.dateFormat)
  const textNoInjection = s.injection ? text.replace(s.injection, '') : text
  const dateLike = [...textNoInjection.matchAll(DATE_LIKE)].map((m) => m[0])
  if (e.date !== null && dateStr !== null && d.date !== null) {
    ok(!omit.has('date') && r.torn?.edge !== 'top', 'expected.date set but the date is hidden')
    ok(hasDateToken(text, dateStr), `date ${dateStr} not found in text`)
    if (!tags.has('distractor-date')) {
      ok(
        dateLike.every((x) => x === dateStr),
        `another date-like string appears: ${dateLike.filter((x) => x !== dateStr).join(' | ')}`,
      )
    }
    const twoDigitYear = TWO_DIGIT_YEAR_FORMATS.includes(r.dateFormat)
    const dayMonthSwap = DAY_FIRST_OR_MONTH_FIRST_FORMATS.includes(r.dateFormat) && Number(d.date.slice(8)) <= 12
    if (twoDigitYear || dayMonthSwap) {
      ok(
        typeof r.dateHint === 'string' && r.dateHint.includes(r.dateFormat) && text.includes(r.dateHint),
        `ambiguous date ${dateStr} needs a printed dateHint that names ${r.dateFormat}`,
      )
    }
    if (tags.has('ambiguous-date')) ok(/locale/i.test(r.dateHint ?? ''), 'ambiguous-date seed must print a locale')
  } else {
    if (dateStr !== null) ok(!hasDateToken(text, dateStr), `expected.date is null but ${dateStr} appears`)
    if (tags.has('distractor-date')) ok(dateLike.length > 0, 'distractor-date tag but no date in text')
    else ok(dateLike.length === 0, `expected.date is null but the text has a date: ${dateLike.join(' | ')}`)
  }
  if (tags.has('distractor-date')) ok(e.date === null, 'distractor-date only on seeds whose expected.date is null')

  if (e.vendor !== null) {
    ok(!omit.has('vendor') && r.torn?.edge !== 'top', 'expected.vendor set but the vendor is hidden')
    ok(text.includes(e.vendor), `vendor "${e.vendor}" not found in text`)
  } else {
    if (d.vendor) ok(!text.includes(d.vendor), `expected.vendor is null but "${d.vendor}" appears`)
    for (const v of otherVendors) ok(!text.includes(v), `expected.vendor is null but another seed's vendor "${v}" appears`)
  }

  if (s.difficulty === 'adversarial') {
    ok(typeof s.injection === 'string' && text.includes(s.injection), 'adversarial seed must contain its injection text verbatim')
    ok(
      r.injectionPosition !== undefined && INJECTION_POSITIONS.includes(r.injectionPosition),
      'adversarial seed needs injectionPosition',
    )
    ok(e.amount !== null && e.date !== null && e.vendor !== null, 'adversarial seeds carry real values in the document')
  } else {
    ok(s.injection === null && r.injectionPosition === undefined, 'only adversarial seeds may carry an injection')
  }

  const hangul = HANGUL.test(text)
  const latin = /[A-Za-z]{3,}/.test(text)
  if (s.language === 'en') ok(!hangul, 'en seed contains Hangul')
  if (s.language === 'ko') ok(hangul, 'ko seed has no Hangul')
  if (s.language === 'mixed') ok(hangul && latin, 'mixed seed needs Hangul and Latin text')

  if (s.difficulty === 'easy') {
    ok(e.amount !== null && e.date !== null && e.vendor !== null, 'easy seeds state all three fields')
    ok(d.tax === null && d.tip === null && d.discount === null && d.change === null, 'easy seeds have a clean single total')
    ok(!r.omit && !r.torn, 'easy seeds hide nothing')
    ok(lines.filter((l) => l.trim().startsWith(L.total)).length === 1, 'easy seeds print the total exactly once')
  }
  if (s.difficulty === 'missing') ok(e.amount === null || e.date === null || e.vendor === null, 'missing seeds have a null expected field')
  if (s.difficulty === 'nondoc') ok(e.amount === null && e.date === null, 'nondoc seeds never state a paid amount or purchase date')
  ok(
    (s.template === 'plain-doc') === (s.difficulty === 'nondoc' && !tags.has('unpaid-invoice')),
    'plain-doc is for the non-receipt nondoc seeds',
  )
  if (s.difficulty === 'tricky') ok(e.amount !== null, 'tricky seeds have a real paid total')
  if (r.torn?.edge === 'bottom') {
    ok(
      !lines.some((l) => l.trim().startsWith(L.subtotal) || l.trim().startsWith(L.tax)),
      'bottom-torn seed still prints subtotal/tax',
    )
  }
  return problems
}

const seeds = loadSeeds()
const vendorList = [...new Set(seeds.map((s) => s.expected.vendor).filter((v): v is string => v !== null))]
const othersOf = (s: Seed): string[] => vendorList.filter((v) => v !== s.data.vendor)
const byId = (id: string): Seed => {
  const seed = seeds.find((s) => s.id === id)
  if (!seed) throw new Error(`no seed ${id}`)
  return seed
}

describe('extraction ground truth, one test per seed', () => {
  it.each(seeds.map((s) => [s.id, s] as const))('%s', (_id, seed) => {
    expect(checkSeed(seed, othersOf(seed))).toEqual([])
  })
})

describe('extraction suite shape', () => {
  it('pins the counts', () => {
    expect(seeds).toHaveLength(36)
    const counts = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, seeds.filter((s) => s.difficulty === difficulty).length]))
    expect(counts).toEqual(DIFFICULTY_COUNTS)
    expect(new Set(seeds.map((s) => s.id)).size).toBe(36)
  })

  it('has at least 19 Korean or mixed seeds and uses every language and template', () => {
    expect(seeds.filter((s) => s.language !== 'en').length).toBeGreaterThanOrEqual(19)
    for (const language of ['ko', 'en', 'mixed'] as const) expect(seeds.some((s) => s.language === language)).toBe(true)
    for (const template of TEMPLATES) expect(seeds.some((s) => s.template === template)).toBe(true)
  })

  it('keeps Korean-market coverage: dotted dates and KRW amounts', () => {
    const koMixed = seeds.filter((s) => s.language !== 'en')
    expect(koMixed.filter((s) => DOTTED_FORMATS.includes(s.render.dateFormat)).length).toBeGreaterThanOrEqual(8)
    expect(koMixed.filter((s) => s.data.currency === 'KRW').length).toBeGreaterThanOrEqual(14)
  })

  it.each(Object.entries(COVERAGE))('covers every %s tag exactly once', (difficulty, tags) => {
    for (const tag of tags ?? []) {
      const hits = seeds.filter((s) => s.difficulty === difficulty && s.tags.includes(tag)).map((s) => s.id)
      expect(hits, `${difficulty} coverage tag "${tag}"`).toHaveLength(1)
    }
  })
})

describe('the checks catch corrupted seeds', () => {
  const withExpected = (s: Seed, expected: Partial<Seed['expected']>): Seed => ({ ...s, expected: { ...s.expected, ...expected } })
  const messages = (s: Seed): string => checkSeed(s, othersOf(s)).join('\n')

  it('flags a wrong expected amount', () => {
    const seed = byId('easy-en-coffee-us')
    expect(messages(withExpected(seed, { amount: 9.76 }))).toMatch(/expected\.amount 9\.76 != data\.total/)
  })

  it('flags an expected vendor that is not printed', () => {
    const seed = byId('easy-en-coffee-us')
    expect(messages({ ...seed, render: { ...seed.render, omit: ['vendor'] } })).toMatch(/expected\.vendor set but the vendor is hidden/)
  })

  it('flags an expected null that is still printed', () => {
    const seed = byId('easy-en-coffee-us')
    expect(messages(withExpected(seed, { vendor: null }))).toMatch(/expected\.vendor is null but "Maple & Pine Coffee" appears/)
  })

  it('flags an adversarial seed whose injection never reaches the page', () => {
    const seed = structuredClone(byId('adv-en-ignore-instructions'))
    delete seed.render.injectionPosition
    expect(messages(seed)).toMatch(/must contain its injection text verbatim/)
  })

  it('flags a missing distractor tag and a missing unpaid tag', () => {
    const doc = seeds.find((s) => s.tags.includes('distractor-amount'))
    if (!doc) throw new Error('no distractor-amount seed')
    expect(messages({ ...doc, tags: doc.tags.filter((t) => t !== 'distractor-amount') })).toMatch(
      /plain-doc text contains an amount without distractor-amount tag/,
    )
    const unpaid = byId('nondoc-en-unpaid-invoice')
    expect(messages({ ...unpaid, tags: unpaid.tags.filter((t) => t !== 'unpaid') })).toMatch(/expected\.amount is null but/)
  })

  it('flags an ambiguous date that lost its hint', () => {
    const seed = structuredClone(byId('tricky-mixed-date-locale'))
    delete seed.render.dateHint
    expect(messages(seed)).toMatch(/needs a printed dateHint/)
  })
})
