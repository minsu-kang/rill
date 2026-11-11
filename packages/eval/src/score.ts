import { amountToCents, normalizeVendor } from './normalize'

export const FIELD_NAMES = ['amount', 'date', 'vendor'] as const
export type FieldName = (typeof FIELD_NAMES)[number]

export const FIELD_OUTCOMES = ['TP', 'WRONG', 'MISS', 'TN', 'HALLUC', 'NO_ANSWER', 'EXCLUDED'] as const
export type FieldOutcome = (typeof FIELD_OUTCOMES)[number]

export type CallStatus = 'ok' | 'refused' | 'schema_failed' | 'truncated'

export interface Expected {
  amount: number | null
  date: string | null
  vendor: string | null
}

export interface Output {
  amount: number | string | null
  date: string | null
  vendor: string | null
}

export interface FieldResult {
  outcome: FieldOutcome
  tags: string[]
}

export interface ScoreFieldsInput {
  expected: Expected
  output: Output | null
  vendorAliases?: readonly string[]
  status?: CallStatus
}

export interface ScoreFieldsResult {
  status: CallStatus
  fields: Record<FieldName, FieldResult>
  outcomes: Record<FieldName, FieldOutcome>
  casePass: boolean
  vendorPartial: number
}

const MIN_PARTIAL_LENGTH = 4

function statusOutcome(status: Exclude<CallStatus, 'ok'>): FieldOutcome {
  return status === 'truncated' ? 'EXCLUDED' : 'NO_ANSWER'
}

export function noAnswerOutcomes(fields: readonly string[], status: Exclude<CallStatus, 'ok'>): Record<string, FieldOutcome> {
  const outcome = statusOutcome(status)
  return Object.fromEntries(fields.map((field) => [field, outcome]))
}

export function isPassingOutcome(outcome: FieldOutcome): boolean {
  return outcome === 'TP' || outcome === 'TN'
}

function classify(expectedPresent: boolean, answered: boolean, matches: boolean): FieldOutcome {
  if (!expectedPresent) return answered ? 'HALLUC' : 'TN'
  if (!answered) return 'MISS'
  return matches ? 'TP' : 'WRONG'
}

function scoreAmount(expected: number | null, output: number | string | null): FieldResult {
  const tags: string[] = []
  if (output === null) return { outcome: classify(expected !== null, false, false), tags }
  const got = amountToCents(output)
  if (got === null) {
    tags.push('amount_unparseable')
    return { outcome: classify(expected !== null, true, false), tags }
  }
  if (expected === null) return { outcome: 'HALLUC', tags }
  const want = amountToCents(expected)
  if (want === null) throw new Error(`invalid expected amount: ${String(expected)}`)
  if (got !== want && got === -want) tags.push('amount_sign_flipped')
  return { outcome: classify(true, true, got === want), tags }
}

function scoreDate(expected: string | null, output: string | null): FieldResult {
  const answered = output !== null
  return { outcome: classify(expected !== null, answered, answered && output === expected), tags: [] }
}

function scoreVendor(
  expected: string | null,
  output: string | null,
  vendorAliases: readonly string[],
): { result: FieldResult; partial: number } {
  const tags: string[] = []
  if (output === null || expected === null) {
    return { result: { outcome: classify(expected !== null, output !== null, false), tags }, partial: 0 }
  }
  const want = normalizeVendor(expected)
  const got = normalizeVendor(output)
  if (want === got) return { result: { outcome: 'TP', tags }, partial: 0 }
  const [shorter, longer] = got.length <= want.length ? [got, want] : [want, got]
  if (shorter === '' || !longer.includes(shorter)) return { result: { outcome: 'WRONG', tags }, partial: 0 }
  if (vendorAliases.some((alias) => normalizeVendor(alias) === shorter)) {
    tags.push('vendor_alias_match')
    return { result: { outcome: 'TP', tags }, partial: 0 }
  }
  tags.push('vendor_containment')
  return { result: { outcome: 'WRONG', tags }, partial: shorter.length >= MIN_PARTIAL_LENGTH ? shorter.length / longer.length : 0 }
}

function finish(status: CallStatus, fields: Record<FieldName, FieldResult>, vendorPartial: number): ScoreFieldsResult {
  const outcomes = {
    amount: fields.amount.outcome,
    date: fields.date.outcome,
    vendor: fields.vendor.outcome,
  }
  return {
    status,
    fields,
    outcomes,
    casePass: status === 'ok' && FIELD_NAMES.every((name) => isPassingOutcome(outcomes[name])),
    vendorPartial,
  }
}

export function scoreFields(input: ScoreFieldsInput): ScoreFieldsResult {
  const status = input.status ?? 'ok'
  if (status !== 'ok') {
    const outcome = statusOutcome(status)
    const field = (): FieldResult => ({ outcome, tags: [] })
    return finish(status, { amount: field(), date: field(), vendor: field() }, 0)
  }
  if (input.output === null) throw new Error('scoreFields needs an output when the call status is ok')
  const { expected, output } = input
  const vendor = scoreVendor(expected.vendor, output.vendor, input.vendorAliases ?? [])
  return finish(
    status,
    { amount: scoreAmount(expected.amount, output.amount), date: scoreDate(expected.date, output.date), vendor: vendor.result },
    vendor.partial,
  )
}

export function allNullOutput(): Output {
  return { amount: null, date: null, vendor: null }
}

export function oracleOutput(expected: Expected): Output {
  return { amount: expected.amount, date: expected.date, vendor: expected.vendor }
}

export interface ScoredRow {
  caseId: string
  group: string
  category: string
  model: string
  rep: number
  status: CallStatus
  outcomes: Record<string, FieldOutcome>
}

export interface FieldMetrics {
  counts: Record<FieldOutcome, number>
  precision: number | null
  recall: number | null
  specificity: number | null
  hallucinationRate: number | null
  missRate: number | null
  fieldAccuracy: number | null
}

export interface Aggregate {
  calls: number
  scoredCalls: number
  truncatedCalls: number
  casePassCount: number
  casePassRate: number | null
  noAnswerCalls: number
  noAnswerRate: number | null
  fields: Record<string, FieldMetrics>
  pooled: FieldMetrics
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function emptyCounts(): Record<FieldOutcome, number> {
  return { TP: 0, WRONG: 0, MISS: 0, TN: 0, HALLUC: 0, NO_ANSWER: 0, EXCLUDED: 0 }
}

function metricsFrom(counts: Record<FieldOutcome, number>): FieldMetrics {
  const { TP, WRONG, MISS, TN, HALLUC, NO_ANSWER } = counts
  return {
    counts,
    precision: ratio(TP, TP + WRONG + HALLUC),
    recall: ratio(TP, TP + WRONG + MISS),
    specificity: ratio(TN, TN + HALLUC),
    hallucinationRate: ratio(HALLUC, TN + HALLUC),
    missRate: ratio(MISS, TP + WRONG + MISS),
    fieldAccuracy: ratio(TP + TN, TP + WRONG + MISS + TN + HALLUC + NO_ANSWER),
  }
}

export function aggregate(rows: readonly ScoredRow[]): Aggregate {
  const perField = new Map<string, Record<FieldOutcome, number>>()
  const pooled = emptyCounts()
  let scoredCalls = 0
  let casePassCount = 0
  let noAnswerCalls = 0
  for (const row of rows) {
    const entries = Object.entries(row.outcomes)
    for (const [field, outcome] of entries) {
      const counts = perField.get(field) ?? emptyCounts()
      counts[outcome] += 1
      pooled[outcome] += 1
      perField.set(field, counts)
    }
    if (row.status === 'truncated') continue
    scoredCalls += 1
    if (row.status === 'refused' || row.status === 'schema_failed') noAnswerCalls += 1
    if (entries.length > 0 && entries.every(([, outcome]) => isPassingOutcome(outcome))) casePassCount += 1
  }
  return {
    calls: rows.length,
    scoredCalls,
    truncatedCalls: rows.length - scoredCalls,
    casePassCount,
    casePassRate: ratio(casePassCount, scoredCalls),
    noAnswerCalls,
    noAnswerRate: ratio(noAnswerCalls, scoredCalls),
    fields: Object.fromEntries([...perField].map(([field, counts]) => [field, metricsFrom(counts)])),
    pooled: metricsFrom(pooled),
  }
}

export function allNullBaseline(expected: readonly Expected[]): Aggregate {
  return aggregate(
    expected.map((entry, index) => ({
      caseId: `baseline-${index}`,
      group: `baseline-${index}`,
      category: 'baseline',
      model: 'all-null',
      rep: 0,
      status: 'ok' as const,
      outcomes: scoreFields({ expected: entry, output: allNullOutput() }).outcomes,
    })),
  )
}
