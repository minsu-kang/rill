import { describe, expect, it } from 'vitest'
import type { Reestimate } from '../src/reestimate'
import { reestimateText, type ReestimateTextInput } from '../src/reestimate-text'
import { HAIKU, SONNET } from './fake-run'
import { fakeSuite, pilotOf, runReestimate, sample, seeds } from './reestimate-fixtures'

const TEXT = [sample(SONNET, 'text', 500, 100), sample(SONNET, 'text', 700, 100), sample(SONNET, 'text', 600, 400)]
const PDF = [sample(SONNET, 'pdf', 2400, 400), sample(SONNET, 'pdf', 2600, 600)]
const SUITE = fakeSuite([...seeds(4, ['text']), ...seeds(2, ['pdf'])])

function textFor(result: Reestimate, overrides: Partial<ReestimateTextInput> = {}, concurrency = 2): string {
  return reestimateText({
    dir: '/results/pilot',
    suiteName: 'extract',
    suiteVersion: 'v-now',
    pilot: pilotOf([...TEXT, ...PDF]),
    result,
    plan: { seeds: 4, kinds: ['text', 'pdf'], cases: 6, reps: 2, concurrency, models: [SONNET] },
    command: 'pnpm eval extract --yes --budget-usd 1',
    lowerCommand: undefined,
    ...overrides,
  })
}

describe('reestimateText', () => {
  const result = runReestimate(SUITE, [...TEXT, ...PDF], { reps: 2, concurrency: 2 })

  it('shows the mean and the p90 of the measured rows, and only the mean for an assumed one', () => {
    const text = textFor(runReestimate(SUITE, [...TEXT, ...PDF], { models: [SONNET, HAIKU], reps: 2, concurrency: 2 }))
    expect(text).toMatch(/^\s+text\s+8\s+3\s+600 \/ 680\s+200 \/ 340\s/mu)
    expect(text).toMatch(/^\s+pdf\s+4\s+2\s+2500 \/ 2580\s+500 \/ 580\s/mu)
    expect(text).toMatch(/^\s+text\s+8\s+0\s+800 \/ -\s+200 \/ -\s/mu)
    expect(text).not.toMatch(/800 \/ 800/u)
  })

  it('names the term that decides the suggested budget', () => {
    expect(result.suggestedFrom).toBe('reserve')
    expect(textFor(result)).toContain('the reserve term decides')
    const p90 = runReestimate(SUITE, [...TEXT, ...PDF], { reps: 2, concurrency: 1, maxOutputTokens: 1000 })
    expect(p90.suggestedFrom).toBe('p90')
    expect(textFor(p90, {}, 1)).toContain('the 1.3 x p90 term decides')
  })

  it('counts the calls in flight as the smaller of the concurrency and the calls of the run', () => {
    expect(textFor(result)).toContain('x 2 calls in flight = ')
    const one = runReestimate(fakeSuite(seeds(1, ['text'])), TEXT, { concurrency: 16, maxOutputTokens: 1000 })
    expect(textFor(one, {}, 16)).toContain('x 1 call in flight = ')
  })

  it('rounds the break-even down to a whole token and prints the pilot average next to it', () => {
    const text = textFor({ ...result, breakEvenOutputTokens: 912.7, measuredOutputPerCall: 300.4 })
    expect(text).toContain('an average of about 912 output tokens per call')
    expect(text).toContain('the pilot saw about 300 on average')
  })

  it('prints the budget with the digits the command uses, and the command last', () => {
    const text = textFor({ ...result, suggestedBudgetUsd: 0.0083 }, { command: 'pnpm eval extract --yes --budget-usd 0.0083' })
    expect(text).toContain('SUGGESTED BUDGET: $0.0083')
    expect(text.trimEnd().split('\n').at(-1)).toBe('  pnpm eval extract --yes --budget-usd 0.0083')
  })

  it('shows the ceiling for truncated pilot calls and says when the budget is below it', () => {
    const cut = runReestimate(SUITE, [...TEXT, sample(SONNET, 'pdf', 2400, 4000, 'truncated'), sample(SONNET, 'pdf', 2600, 4000, 'truncated')], { reps: 2, concurrency: 2, maxOutputTokens: 16_000 })
    const ceiling = cut.truncatedCeilingUsd ?? 0
    expect(ceiling).toBeGreaterThan(cut.suggestedBudgetUsd ?? 0)
    const text = textFor(cut)
    expect(text).toContain('if every truncated pilot call used the whole max_tokens of 16000: $')
    expect(text).toContain('note: the ceiling for truncated calls ($')
    expect(textFor({ ...cut, truncatedCeilingUsd: 0.0001 })).not.toContain('note: the ceiling')
    expect(textFor({ ...cut, truncatedCeilingUsd: undefined })).not.toContain('truncated pilot call used')
  })

  it('says where the pilot was read from, and with which effort and cap', () => {
    const text = textFor(result, { pilot: pilotOf([...TEXT, ...PDF], { source: 'partial', effort: null, maxOutputTokens: null, suiteVersion: null }) })
    expect(text).toContain('effort unknown, pilot cap unknown, read from tasks.partial.jsonl because the run has no run.json')
    expect(textFor(result)).toContain('effort low, pilot cap 4000 output tokens')
    expect(textFor(result)).not.toContain('tasks.partial.jsonl')
  })
})
