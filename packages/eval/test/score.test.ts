import { describe, expect, it } from 'vitest'
import {
  aggregate,
  allNullBaseline,
  allNullOutput,
  noAnswerOutcomes,
  oracleOutput,
  scoreFields,
  type Expected,
  type FieldOutcome,
  type Output,
  type ScoredRow,
} from '../src/score'

const expected: Expected = { amount: 12.5, date: '2026-03-14', vendor: 'Kettle & Crumb Bakery' }

function score(output: Partial<Output>, extra: { vendorAliases?: string[]; expected?: Expected } = {}) {
  const gold = extra.expected ?? expected
  return scoreFields({
    expected: gold,
    output: { ...oracleOutput(gold), ...output },
    vendorAliases: extra.vendorAliases ?? ['Kettle & Crumb', 'Kettle and Crumb Bakery'],
  })
}

describe('scoreFields: amount', () => {
  it('passes when the integer cents are equal', () => {
    expect(score({ amount: 12.5 }).outcomes.amount).toBe('TP')
    expect(score({ amount: 12.504 }).outcomes.amount).toBe('TP')
    expect(score({ amount: '12.50' }).outcomes.amount).toBe('TP')
    expect(score({ amount: '$12,50' }).outcomes.amount).toBe('TP')
  })

  it('is a WRONG answer for another value, and tags a flipped sign', () => {
    expect(score({ amount: 12.51 }).outcomes.amount).toBe('WRONG')
    expect(score({ amount: 8 }).fields.amount.tags).toEqual([])
    const flipped = score({ amount: -12.5 })
    expect(flipped.outcomes.amount).toBe('WRONG')
    expect(flipped.fields.amount.tags).toEqual(['amount_sign_flipped'])
  })

  it('keeps the sign of a refund', () => {
    const refund: Expected = { amount: -9.99, date: '2026-03-14', vendor: 'X Store' }
    expect(score({ amount: -9.99 }, { expected: refund }).outcomes.amount).toBe('TP')
    expect(score({ amount: 9.99 }, { expected: refund }).outcomes.amount).toBe('WRONG')
  })

  it('treats an unparseable string as a wrong answer, not a miss', () => {
    const unreadable = score({ amount: 'twelve' })
    expect(unreadable.outcomes.amount).toBe('WRONG')
    expect(unreadable.fields.amount.tags).toEqual(['amount_unparseable'])
    expect(score({ amount: 'twelve' }, { expected: { ...expected, amount: null } }).outcomes.amount).toBe('HALLUC')
  })

  it('maps null on both sides to TN, a null answer to MISS and a value for null to HALLUC', () => {
    const none: Expected = { amount: null, date: null, vendor: null }
    expect(score({ amount: null }, { expected: none }).outcomes.amount).toBe('TN')
    expect(score({ amount: 3 }, { expected: none }).outcomes.amount).toBe('HALLUC')
    expect(score({ amount: null }).outcomes.amount).toBe('MISS')
  })

  it('rejects a gold amount that cannot be priced', () => {
    expect(() => score({ amount: 1 }, { expected: { ...expected, amount: Number.NaN } })).toThrow(/invalid expected amount/)
  })
})

describe('scoreFields: date', () => {
  it('needs exact string equality', () => {
    expect(score({ date: '2026-03-14' }).outcomes.date).toBe('TP')
    expect(score({ date: '2026-03-15' }).outcomes.date).toBe('WRONG')
    expect(score({ date: '2026-14-03' }).outcomes.date).toBe('WRONG')
    expect(score({ date: '2026-3-14' }).outcomes.date).toBe('WRONG')
    expect(score({ date: null }).outcomes.date).toBe('MISS')
  })

  it('maps expected null to TN or HALLUC', () => {
    const none = { ...expected, date: null }
    expect(score({ date: null }, { expected: none }).outcomes.date).toBe('TN')
    expect(score({ date: '2026-03-14' }, { expected: none }).outcomes.date).toBe('HALLUC')
  })
})

describe('scoreFields: vendor', () => {
  it('passes when the normalised names are equal', () => {
    for (const vendor of ['Kettle & Crumb Bakery', 'KETTLE AND CRUMB BAKERY, INC.', 'the kettle & crumb   bakery']) {
      const result = score({ vendor })
      expect(result.outcomes.vendor).toBe('TP')
      expect(result.vendorPartial).toBe(0)
    }
  })

  it('passes an output that equals a normalised alias', () => {
    const shorter = score({ vendor: 'Kettle and Crumb' })
    expect(shorter.outcomes.vendor).toBe('TP')
    expect(shorter.fields.vendor.tags).toEqual(['vendor_alias_match'])
    expect(shorter.vendorPartial).toBe(0)
    const gold = { ...expected, vendor: 'Kettle & Crumb' }
    const longer = 'Kettle & Crumb Bakery'
    expect(score({ vendor: longer }, { expected: gold, vendorAliases: ['Kettle and Crumb Bakery'] }).outcomes.vendor).toBe('TP')
  })

  it('never passes a longer output that merely contains the gold or an alias', () => {
    const gold = { ...expected, vendor: 'Kettle & Crumb' }
    const contained = score({ vendor: 'Kettle & Crumb Bakery' }, { expected: gold, vendorAliases: ['Kettle & Crumb'] })
    expect(contained.outcomes.vendor).toBe('WRONG')
    expect(contained.fields.vendor.tags).toEqual(['vendor_containment'])
    expect(contained.vendorPartial).toBeGreaterThan(0)
    const harbor = { ...expected, vendor: 'Harbor Print Co.' }
    for (const vendor of ['INVOICE from Harbor Print Co. Payment status UNPAID', 'Harbor Printing', 'Harbor Printers Supply Inc']) {
      expect(score({ vendor }, { expected: harbor, vendorAliases: ['Harbor Print'] }).outcomes.vendor, vendor).toBe('WRONG')
    }
    const pizza = { ...expected, vendor: 'Brightwater Pizza Co.' }
    expect(score({ vendor: 'Not Brightwater Pizza' }, { expected: pizza, vendorAliases: ['Brightwater Pizza', 'Brightwater'] }).outcomes.vendor).toBe('WRONG')
    expect(score({ vendor: 'Brightwater' }, { expected: pizza, vendorAliases: ['Brightwater Pizza', 'Brightwater'] }).outcomes.vendor).toBe('TP')
  })

  it('compares Hangul vendors with every space removed', () => {
    const gold = { ...expected, vendor: '다온커피 연남점' }
    expect(score({ vendor: '다온커피연남점' }, { expected: gold, vendorAliases: [] }).outcomes.vendor).toBe('TP')
    expect(score({ vendor: '다온 커피 연남점' }, { expected: gold, vendorAliases: [] }).outcomes.vendor).toBe('TP')
    expect(score({ vendor: '다온커피연남' }, { expected: { ...expected, vendor: '다온커피' }, vendorAliases: ['다온 커피 연남'] }).outcomes.vendor).toBe('TP')
    expect(score({ vendor: '다온커피 합정점' }, { expected: gold, vendorAliases: [] }).outcomes.vendor).toBe('WRONG')
    expect(score({ vendor: 'Kettle andCrumb Bakery' }).outcomes.vendor).toBe('WRONG')
  })

  it('does not pass containment without an alias, and reports the length ratio as vendorPartial', () => {
    const result = score({ vendor: 'Kettle & Crumb' }, { vendorAliases: [] })
    expect(result.outcomes.vendor).toBe('WRONG')
    expect(result.fields.vendor.tags).toEqual(['vendor_containment'])
    expect(result.vendorPartial).toBeCloseTo(16 / 23, 12)
  })

  it('does not count the expected name itself as an alias', () => {
    const result = score({ vendor: 'Kettle & Crumb Bakery Downtown Branch' }, { vendorAliases: ['Kettle & Crumb'] })
    expect(result.outcomes.vendor).toBe('WRONG')
    expect(result.vendorPartial).toBeCloseTo(23 / 39, 12)
  })

  it('gives no partial credit when the shorter side has under four characters', () => {
    const gold = { ...expected, vendor: 'Joe Pizza' }
    const noAlias = score({ vendor: 'Joe' }, { expected: gold, vendorAliases: [] })
    expect(noAlias.outcomes.vendor).toBe('WRONG')
    expect(noAlias.vendorPartial).toBe(0)
    expect(score({ vendor: 'Joe' }, { expected: gold, vendorAliases: ['Joe'] }).outcomes.vendor).toBe('TP')
    expect(score({ vendor: 'a' }, { expected: { ...expected, vendor: 'Alpha Store' }, vendorAliases: [] })).toMatchObject({
      outcomes: { vendor: 'WRONG' },
      vendorPartial: 0,
    })
  })

  it('fails an unrelated name with no partial value', () => {
    const result = score({ vendor: '12 Main Street' })
    expect(result.outcomes.vendor).toBe('WRONG')
    expect(result.vendorPartial).toBe(0)
    expect(result.fields.vendor.tags).toEqual([])
  })

  it('does not treat an empty answer as contained in everything', () => {
    expect(score({ vendor: '' }).outcomes.vendor).toBe('WRONG')
    expect(score({ vendor: '' }, { vendorAliases: [''] }).outcomes.vendor).toBe('WRONG')
  })

  it('maps null on either side', () => {
    expect(score({ vendor: null }).outcomes.vendor).toBe('MISS')
    expect(score({ vendor: 'Kettle' }, { expected: { ...expected, vendor: null } }).outcomes.vendor).toBe('HALLUC')
    expect(score({ vendor: null }, { expected: { ...expected, vendor: null } }).outcomes.vendor).toBe('TN')
  })
})

describe('scoreFields: case and call status', () => {
  it('passes a case when every field is TP or TN', () => {
    expect(score({}).casePass).toBe(true)
    expect(score({}).outcomes).toEqual({ amount: 'TP', date: 'TP', vendor: 'TP' })
    const none: Expected = { amount: null, date: null, vendor: null }
    expect(scoreFields({ expected: none, output: allNullOutput() })).toMatchObject({ casePass: true, outcomes: { amount: 'TN', date: 'TN', vendor: 'TN' } })
    expect(score({ date: '2026-03-15' }).casePass).toBe(false)
    expect(score({ amount: null }).casePass).toBe(false)
  })

  it('makes every field NO_ANSWER, never TN, for a refusal or a schema failure', () => {
    const none: Expected = { amount: null, date: null, vendor: null }
    for (const status of ['refused', 'schema_failed'] as const) {
      const result = scoreFields({ expected: none, output: null, status })
      expect(result.outcomes).toEqual({ amount: 'NO_ANSWER', date: 'NO_ANSWER', vendor: 'NO_ANSWER' })
      expect(result.casePass).toBe(false)
      expect(result.status).toBe(status)
    }
  })

  it('excludes every field of a truncated call', () => {
    const result = scoreFields({ expected, output: null, status: 'truncated' })
    expect(result.outcomes).toEqual({ amount: 'EXCLUDED', date: 'EXCLUDED', vendor: 'EXCLUDED' })
    expect(result.casePass).toBe(false)
  })

  it('ignores an output that comes with a non-ok status', () => {
    const result = scoreFields({ expected, output: oracleOutput(expected), status: 'refused' })
    expect(result.outcomes.amount).toBe('NO_ANSWER')
  })

  it('refuses an ok call without an output', () => {
    expect(() => scoreFields({ expected, output: null })).toThrow(/needs an output/)
  })

  it('lets the oracle pass every case and the all-null answer fail every positive one', () => {
    expect(scoreFields({ expected, output: oracleOutput(expected) }).casePass).toBe(true)
    const nulls = scoreFields({ expected, output: allNullOutput() })
    expect(nulls.outcomes).toEqual({ amount: 'MISS', date: 'MISS', vendor: 'MISS' })
    expect(allNullOutput()).toEqual({ amount: null, date: null, vendor: null })
  })

  it('keeps tags as plain arrays the suite can extend', () => {
    const result = score({ amount: 1 })
    result.fields.amount.tags.push('equals_subtotal')
    expect(result.fields.amount.tags).toEqual(['equals_subtotal'])
  })
})

describe('noAnswerOutcomes', () => {
  it('maps a status to the outcome of every field', () => {
    expect(noAnswerOutcomes(['a', 'b'], 'refused')).toEqual({ a: 'NO_ANSWER', b: 'NO_ANSWER' })
    expect(noAnswerOutcomes(['a'], 'schema_failed')).toEqual({ a: 'NO_ANSWER' })
    expect(noAnswerOutcomes(['a'], 'truncated')).toEqual({ a: 'EXCLUDED' })
    expect(noAnswerOutcomes([], 'refused')).toEqual({})
  })
})

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(numbersIn)
}

const row = (
  caseId: string,
  status: ScoredRow['status'],
  outcomes: [FieldOutcome, FieldOutcome, FieldOutcome],
  overrides: Partial<ScoredRow> = {},
): ScoredRow => ({
  caseId,
  group: caseId,
  category: 'easy',
  model: 'm',
  rep: 0,
  status,
  outcomes: { amount: outcomes[0], date: outcomes[1], vendor: outcomes[2] },
  ...overrides,
})

describe('aggregate', () => {
  const rows = [
    row('r1', 'ok', ['TP', 'TP', 'TN']),
    row('r2', 'ok', ['WRONG', 'MISS', 'HALLUC']),
    row('r3', 'refused', ['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER']),
    row('r4', 'truncated', ['EXCLUDED', 'EXCLUDED', 'EXCLUDED']),
    row('r5', 'ok', ['TP', 'TN', 'TP']),
  ]
  const result = aggregate(rows)

  it('counts every outcome per field', () => {
    expect(result.fields['amount']?.counts).toEqual({ TP: 2, WRONG: 1, MISS: 0, TN: 0, HALLUC: 0, NO_ANSWER: 1, EXCLUDED: 1 })
    expect(result.fields['date']?.counts).toEqual({ TP: 1, WRONG: 0, MISS: 1, TN: 1, HALLUC: 0, NO_ANSWER: 1, EXCLUDED: 1 })
    expect(result.fields['vendor']?.counts).toEqual({ TP: 1, WRONG: 0, MISS: 0, TN: 1, HALLUC: 1, NO_ANSWER: 1, EXCLUDED: 1 })
    expect(result.pooled.counts).toEqual({ TP: 4, WRONG: 1, MISS: 1, TN: 2, HALLUC: 1, NO_ANSWER: 3, EXCLUDED: 3 })
  })

  it('computes the per-field ratios from the counts', () => {
    expect(result.fields['amount']).toMatchObject({ precision: 2 / 3, recall: 2 / 3, specificity: null, hallucinationRate: null, missRate: 0, fieldAccuracy: 0.5 })
    expect(result.fields['date']).toMatchObject({ precision: 1, recall: 0.5, specificity: 1, hallucinationRate: 0, missRate: 0.5, fieldAccuracy: 0.5 })
    expect(result.fields['vendor']).toMatchObject({ precision: 0.5, recall: 1, specificity: 0.5, hallucinationRate: 0.5, missRate: 0, fieldAccuracy: 0.5 })
  })

  it('pools by field instance (micro average), not by averaging the per-field ratios', () => {
    expect(result.pooled.precision).toBeCloseTo(4 / 6, 12)
    expect(result.pooled.recall).toBeCloseTo(4 / 6, 12)
    expect(result.pooled.specificity).toBeCloseTo(2 / 3, 12)
    expect(result.pooled.hallucinationRate).toBeCloseTo(1 / 3, 12)
    expect(result.pooled.missRate).toBeCloseTo(1 / 6, 12)
    expect(result.pooled.fieldAccuracy).toBe(0.5)
    expect(result.pooled.specificity).not.toBeCloseTo(((result.fields['vendor']?.specificity ?? 0) + (result.fields['date']?.specificity ?? 0)) / 2, 6)
  })

  it('weights by instance when cases contribute different numbers of instances', () => {
    const uneven = aggregate([
      { ...row('a', 'ok', ['TP', 'TP', 'TP']), outcomes: { amount: 'TP' } },
      row('b', 'ok', ['MISS', 'MISS', 'MISS']),
    ])
    expect(uneven.fields['amount']?.recall).toBe(0.5)
    expect(uneven.fields['date']?.recall).toBe(0)
    expect(uneven.pooled.recall).toBe(0.25)
  })

  it('computes case pass and no-answer rates over calls that are not excluded', () => {
    expect(result).toMatchObject({ calls: 5, scoredCalls: 4, truncatedCalls: 1, casePassCount: 2, casePassRate: 0.5, noAnswerCalls: 1, noAnswerRate: 0.25 })
  })

  it('counts a schema failure as no-answer', () => {
    const schemaFailed = aggregate([row('a', 'schema_failed', ['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER']), row('b', 'ok', ['TP', 'TP', 'TP'])])
    expect(schemaFailed).toMatchObject({ noAnswerCalls: 1, noAnswerRate: 0.5, casePassRate: 0.5 })
  })

  it('returns null, never NaN, for ratios with a zero denominator', () => {
    const empty = aggregate([])
    expect(empty).toMatchObject({ calls: 0, casePassRate: null, noAnswerRate: null })
    expect(empty.pooled).toMatchObject({ precision: null, recall: null, specificity: null, hallucinationRate: null, missRate: null, fieldAccuracy: null })
    const onlyTruncated = aggregate([row('t', 'truncated', ['EXCLUDED', 'EXCLUDED', 'EXCLUDED'])])
    expect(onlyTruncated.casePassRate).toBeNull()
    expect(onlyTruncated.pooled.fieldAccuracy).toBeNull()
    for (const value of [result, empty, onlyTruncated]) expect(numbersIn(value).every(Number.isFinite)).toBe(true)
  })

  it('works for the field names of any suite', () => {
    const planner = aggregate([
      { caseId: 'p', group: 'p', category: 'plan', model: 'm', rep: 0, status: 'ok', outcomes: { valid_plan: 'TP', uses_tools: 'WRONG' } },
    ])
    expect(Object.keys(planner.fields)).toEqual(['valid_plan', 'uses_tools'])
    expect(planner.pooled.precision).toBe(0.5)
    expect(planner.casePassRate).toBe(0)
  })
})

describe('allNullBaseline', () => {
  it('scores an all-null answer: recall 0 and specificity 1', () => {
    const baseline = allNullBaseline([
      { amount: 10, date: '2026-01-01', vendor: 'Acme' },
      { amount: null, date: null, vendor: null },
    ])
    expect(baseline.pooled.counts).toMatchObject({ TP: 0, MISS: 3, TN: 3, WRONG: 0, HALLUC: 0 })
    expect(baseline.pooled).toMatchObject({ precision: null, recall: 0, specificity: 1, hallucinationRate: 0, missRate: 1, fieldAccuracy: 0.5 })
    expect(baseline.casePassRate).toBe(0.5)
  })

  it('has nothing to report for an empty gold set', () => {
    expect(allNullBaseline([]).casePassRate).toBeNull()
  })
})
