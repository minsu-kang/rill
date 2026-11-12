import { describe, expect, it } from 'vitest'
import { costUsd } from '../src/pricing'
import type { EvalCase, Suite } from '../src/suite'
import { SONNET } from './fake-run'
import { cellOf, fakeSuite, pilotOf, runReestimate, sample, seeds } from './reestimate-fixtures'
import { reestimate } from '../src/reestimate'

const GROK = 'grok:grok-4.7'
const OPENAI = 'openai:gpt-6.1-sol'

const noPdfForGrok = (suite: Suite<EvalCase, unknown>): Suite<EvalCase, unknown> => ({
  ...suite,
  unsupportedReason: (testCase, model) => (testCase.kind === 'pdf' && model === GROK ? 'grok:grok-4.7 reads no PDF' : undefined),
})

describe('reestimate for a model whose reasoning is not capped by max tokens', () => {
  const suite = fakeSuite(seeds(3, ['text']))
  const pilotSamples = (model: string, output: number) => ['g1', 'g2', 'g3'].map((group) => sample(model, 'text', 800, output, 'ok', group))
  const measured = (model: string, output: number) => pilotSamples(model, output).reduce((total, entry) => total + costUsd(model, entry.usage)!, 0)

  it('keeps the output it measured above max tokens, so the projection is not below what the pilot cost', () => {
    const result = runReestimate(suite, pilotSamples(GROK, 30_000), { models: [GROK], maxOutputTokens: 16_000, pilot: { maxOutputTokens: 16_000 } })
    expect(result.meanUsd).toBeCloseTo(measured(GROK, 30_000), 6)
    expect(result.suggestedBudgetUsd!).toBeGreaterThanOrEqual(measured(GROK, 30_000))
  })

  it('still stops at twice max tokens, the most the budget guard reserves', () => {
    const result = runReestimate(suite, pilotSamples(GROK, 50_000), { models: [GROK], maxOutputTokens: 16_000, pilot: { maxOutputTokens: 16_000 } })
    expect(result.meanUsd).toBeCloseTo(measured(GROK, 32_000), 6)
  })

  it('keeps clamping at max tokens for a model whose reasoning the cap does cover', () => {
    const result = runReestimate(suite, pilotSamples(SONNET, 30_000), { models: [SONNET], maxOutputTokens: 16_000, pilot: { maxOutputTokens: 16_000 } })
    expect(result.meanUsd).toBeCloseTo(measured(SONNET, 16_000), 6)
  })

  it('uses the same rule for a cell without enough samples, which borrows the model mean', () => {
    const mixed = fakeSuite(seeds(3, ['text', 'png']))
    const result = runReestimate(mixed, pilotSamples(GROK, 30_000), { models: [GROK], maxOutputTokens: 16_000, pilot: { maxOutputTokens: 16_000 } })
    const png = cellOf(result, GROK, 'png')
    expect(png.basis).toBe('model-mean')
    expect(png.outputMean).toBe(30_000)
  })
})

describe('reestimate for cases a model cannot take', () => {
  it('counts only the cases the model will run, as the run itself does', () => {
    const suite = noPdfForGrok(fakeSuite(seeds(2, ['text', 'pdf'])))
    const samples = [sample(GROK, 'text', 800, 300, 'ok', 'g1'), sample(GROK, 'text', 800, 300, 'ok', 'g2')]
    const result = reestimate({ suite, pilot: pilotOf(samples), models: [GROK, OPENAI], reps: 2, concurrency: 1, maxOutputTokens: 4000 })
    expect(result.models.find((entry) => entry.model === GROK)?.calls).toBe(4)
    expect(result.models.find((entry) => entry.model === OPENAI)?.calls).toBe(8)
    expect(result.calls).toBe(12)
    expect(result.models.find((entry) => entry.model === GROK)?.cells.map((cell) => cell.kind)).toEqual(['text'])
    expect(result.models.find((entry) => entry.model === GROK)?.meanUsd).toBeGreaterThan(0)
  })

  it('still projects a total when every case of a model is one it cannot take', () => {
    const suite = { ...fakeSuite(seeds(2, ['pdf'])), unsupportedReason: (_case: EvalCase, model: string) => (model === GROK ? 'no pdf' : undefined) }
    const result = reestimate({ suite, pilot: pilotOf([]), models: [GROK, OPENAI], reps: 1, concurrency: 1, maxOutputTokens: 4000 })
    expect(result.models.find((entry) => entry.model === GROK)?.calls).toBe(0)
    expect(result.calls).toBe(2)
    expect(result.meanUsd).toBeGreaterThan(0)
  })
})
