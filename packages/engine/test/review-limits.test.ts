import { MAX_REVIEW_FINDINGS, MAX_REVIEW_TEXT_CHARS, REVIEW_SEVERITIES as PLANNER_SEVERITIES, checkReview } from '@rill/planner'
import { REVIEW_FINDING_MAX_CHARS, REVIEW_MAX_FINDINGS, REVIEW_SEVERITIES, REVIEW_SUMMARY_MAX_CHARS, ReviewSchema, ReviewSeveritySchema } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'

describe('the limits of a review in the planner and in the protocol', () => {
  it('are the same numbers and the same severities', () => {
    expect(MAX_REVIEW_TEXT_CHARS).toBe(REVIEW_SUMMARY_MAX_CHARS)
    expect(MAX_REVIEW_TEXT_CHARS).toBe(REVIEW_FINDING_MAX_CHARS)
    expect(MAX_REVIEW_FINDINGS).toBe(REVIEW_MAX_FINDINGS)
    expect([...PLANNER_SEVERITIES]).toEqual([...REVIEW_SEVERITIES])
    expect(ReviewSeveritySchema.anyOf.map((literal) => literal.const).sort()).toEqual([...REVIEW_SEVERITIES].sort())
  })

  it('accept the same largest answer and refuse one past it', () => {
    const largest = { summary: 'x'.repeat(MAX_REVIEW_TEXT_CHARS), findings: Array.from({ length: MAX_REVIEW_FINDINGS }, () => ({ severity: 'info', text: 'y'.repeat(MAX_REVIEW_TEXT_CHARS) })) }
    expect(checkReview(largest).answer).toBeDefined()
    expect(Value.Check(ReviewSchema, largest)).toBe(true)
    const past = [
      { ...largest, summary: 'x'.repeat(MAX_REVIEW_TEXT_CHARS + 1) },
      { ...largest, findings: [...largest.findings, largest.findings[0]] },
      { ...largest, findings: [{ severity: 'info', text: 'y'.repeat(MAX_REVIEW_TEXT_CHARS + 1) }] },
    ]
    for (const answer of past) {
      expect(checkReview(answer).answer).toBeUndefined()
      expect(Value.Check(ReviewSchema, answer)).toBe(false)
    }
  })
})
