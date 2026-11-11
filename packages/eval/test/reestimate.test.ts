import { describe, expect, it } from 'vitest'
import { roundUpBudget } from '../src/budget'
import { BUDGET_P90_FACTOR, LOWER_MAX_OUTPUT_STEPS, MIN_CELL_SAMPLES, RESERVE_SHARE_LIMIT } from '../src/reestimate'
import { estimateRun } from '../src/runner'
import { HAIKU, OPUS, SONNET } from './fake-run'
import { cellOf, fakeSuite, runReestimate as run, sample, seeds } from './reestimate-fixtures'

const MYSTERY = 'claude-mystery-9'

const TEXT_SAMPLES = [sample(SONNET, 'text', 500, 100), sample(SONNET, 'text', 700, 100), sample(SONNET, 'text', 600, 400)]
const PDF_SAMPLES = [sample(SONNET, 'pdf', 2400, 400), sample(SONNET, 'pdf', 2600, 600)]
const MEASURED = [...TEXT_SAMPLES, ...PDF_SAMPLES]
const MEASURED_SUITE = fakeSuite([...seeds(4, ['text']), ...seeds(2, ['pdf'])])

describe('reestimate: mean and 90th percentile per model and kind', () => {
  it('computes the mean and the p90 of input and output tokens by hand', () => {
    const result = run(MEASURED_SUITE, MEASURED, { reps: 2, concurrency: 2 })
    const text = cellOf(result, SONNET, 'text')
    expect(text).toMatchObject({ n: 3, basis: 'measured', calls: 8, inputMean: 600, outputMean: 200 })
    expect(text.inputP90).toBeCloseTo(680, 9)
    expect(text.outputP90).toBeCloseTo(340, 9)
    const pdf = cellOf(result, SONNET, 'pdf')
    expect(pdf).toMatchObject({ n: 2, basis: 'measured', calls: 4, inputMean: 2500, outputMean: 500 })
    expect(pdf.inputP90).toBeCloseTo(2580, 9)
    expect(pdf.outputP90).toBeCloseTo(580, 9)
  })

  it('prices the measured mean per call and the p90 tokens together, then multiplies by the planned calls', () => {
    const result = run(MEASURED_SUITE, MEASURED, { reps: 2, concurrency: 2 })
    const text = cellOf(result, SONNET, 'text')
    expect(text.perCallUsd).toBeCloseTo(0.0032, 12)
    expect(text.perCallP90Usd).toBeCloseTo(0.00476, 12)
    expect(text.meanUsd).toBeCloseTo(0.0256, 12)
    expect(text.p90Usd).toBeCloseTo(0.03808, 12)
    const pdf = cellOf(result, SONNET, 'pdf')
    expect(pdf.perCallUsd).toBeCloseTo(0.01, 12)
    expect(pdf.perCallP90Usd).toBeCloseTo(0.01096, 12)
    expect(pdf.meanUsd).toBeCloseTo(0.04, 12)
    expect(pdf.p90Usd).toBeCloseTo(0.04384, 12)
    const model = result.models[0]
    expect(model?.calls).toBe(12)
    expect(model?.meanUsd).toBeCloseTo(0.0656, 12)
    expect(model?.p90Usd).toBeCloseTo(0.08192, 12)
    expect(result.calls).toBe(12)
    expect(result.meanUsd).toBeCloseTo(0.0656, 12)
    expect(result.p90Usd).toBeCloseTo(0.08192, 12)
  })

  it('counts the calls as cases of the kind times reps, per model', () => {
    const suite = fakeSuite([...seeds(3, ['text']), ...seeds(1, ['pdf'])])
    const result = run(suite, [...TEXT_SAMPLES, ...PDF_SAMPLES, ...TEXT_SAMPLES.map((entry) => ({ ...entry, model: OPUS })), ...PDF_SAMPLES.map((entry) => ({ ...entry, model: OPUS }))], {
      models: [SONNET, OPUS],
      reps: 3,
    })
    expect(cellOf(result, SONNET, 'text').calls).toBe(9)
    expect(cellOf(result, SONNET, 'pdf').calls).toBe(3)
    expect(cellOf(result, OPUS, 'text').calls).toBe(9)
    expect(result.models.map((entry) => entry.calls)).toEqual([12, 12])
    expect(result.calls).toBe(24)
  })

  it('adds up the cache tokens as input and prices them with the cache rates', () => {
    const cached = { ...sample(SONNET, 'text', 400, 100), usage: { inputTokens: 400, outputTokens: 100, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200 } }
    const plain = sample(SONNET, 'text', 1600, 100)
    const result = run(fakeSuite(seeds(1, ['text'])), [cached, plain])
    const cell = cellOf(result, SONNET, 'text')
    expect(cell.inputMean).toBe(1600)
    expect(cell.perCallUsd).toBeCloseTo((((400 * 2 + 100 * 10 + 1000 * 0.1 + 200 * 2.5) / 1e6) + (1600 * 2 + 100 * 10) / 1e6) / 2, 12)
  })
})

describe('reestimate: the fallback chain', () => {
  const suite = fakeSuite(seeds(2, ['text', 'pdf', 'png']))
  const samples = [
    sample(HAIKU, 'text', 600, 100),
    sample(HAIKU, 'text', 800, 300),
    sample(HAIKU, 'pdf', 2400, 500),
    sample(OPUS, 'text', 500, 200),
    sample(OPUS, 'text', 700, 400),
  ]
  const result = run(suite, samples, { models: [HAIKU, SONNET, OPUS], concurrency: 1 })

  it('uses the measured mean when a kind has at least two pilot calls', () => {
    expect(MIN_CELL_SAMPLES).toBe(2)
    expect(cellOf(result, HAIKU, 'text')).toMatchObject({ basis: 'measured', n: 2, inputMean: 700, outputMean: 200 })
    expect(cellOf(result, OPUS, 'text')).toMatchObject({ basis: 'measured', n: 2, inputMean: 600, outputMean: 300 })
  })

  it('falls back to the pilot mean of the model across kinds when a kind has one call or none, and keeps the own n', () => {
    const pdf = cellOf(result, HAIKU, 'pdf')
    expect(pdf).toMatchObject({ basis: 'model-mean', n: 1 })
    expect(pdf.inputMean).toBeCloseTo((600 + 800 + 2400) / 3, 9)
    expect(pdf.outputMean).toBeCloseTo((100 + 300 + 500) / 3, 9)
    const png = cellOf(result, HAIKU, 'png')
    expect(png).toMatchObject({ basis: 'model-mean', n: 0 })
    expect(png.inputMean).toBeCloseTo((600 + 800 + 2400) / 3, 9)
    expect(png.perCallUsd).toBeCloseTo(((600 + 800 + 2400) / 3 * 0.1 + ((100 + 300 + 500) / 3) * 0.5) / 1e6, 12)
    expect(cellOf(result, OPUS, 'pdf')).toMatchObject({ basis: 'model-mean', n: 0, inputMean: 600, outputMean: 300 })
  })

  it('falls back to the original assumption for a model without any pilot row', () => {
    for (const [kind, input] of [['text', 800], ['pdf', 2400], ['png', 2000]] as const) {
      const cell = cellOf(result, SONNET, kind)
      expect(cell).toMatchObject({ basis: 'assumed', n: 0, calls: 2, inputMean: input, inputP90: input, outputMean: 200, outputP90: 200 })
      expect(cell.perCallUsd).toBeCloseTo((input * 2 + 200 * 10) / 1e6, 12)
      expect(cell.perCallP90Usd).toBe(cell.perCallUsd)
    }
    expect(result.models.find((entry) => entry.model === SONNET)?.pilot.calls).toBe(0)
  })

  it('marks every fallback in the warnings, and the unseen model as one that cannot be projected', () => {
    const text = result.warnings.join('\n')
    expect(text).toContain(`${SONNET} has no usage rows in the pilot, so it cannot be projected`)
    expect(text).toContain('first assumption (200 output tokens per call)')
    expect(text).toContain(`${HAIKU} pdf, ${HAIKU} png, ${OPUS} pdf, ${OPUS} png`)
    expect(text).toContain('FALLBACK')
    expect(text).not.toContain(`${HAIKU} text`)
  })

  it('equals the first estimate when nothing was measured', () => {
    const bare = run(suite, [], { models: [HAIKU, SONNET, OPUS], reps: 2 })
    const first = estimateRun({ suite, models: [HAIKU, SONNET, OPUS], reps: 2 })
    expect(first.totalUsd).toBeGreaterThan(0)
    expect(bare.meanUsd).toBeCloseTo(first.totalUsd ?? 0, 12)
    expect(bare.p90Usd).toBeCloseTo(first.totalUsd ?? 0, 12)
    expect(bare.firstEstimateUsd).toBeCloseTo(first.totalUsd ?? 0, 12)
    expect(bare.models.every((entry) => entry.cells.every((cell) => cell.basis === 'assumed'))).toBe(true)
  })

  it('uses the default input estimate of the runner when the suite has none', () => {
    const noEstimate = fakeSuite(seeds(2, ['text']), null)
    const bare = run(noEstimate, [], { models: [SONNET] })
    expect(cellOf(bare, SONNET, 'text')).toMatchObject({ inputMean: 4000 })
  })
})

describe('reestimate: truncated, refused and invalid rows with usage', () => {
  const suite = fakeSuite(seeds(2, ['text']))
  const samples = [sample(SONNET, 'text', 500, 100), sample(SONNET, 'text', 500, 4000, 'truncated'), sample(SONNET, 'text', 500, 20, 'refused'), sample(SONNET, 'text', 500, 60, 'invalid')]

  it('counts every row with usage in the means and tallies the outcomes', () => {
    const result = run(suite, samples, { maxOutputTokens: 4000 })
    const model = result.models[0]
    expect(model?.pilot).toMatchObject({ calls: 4, ok: 1, truncated: 1, refused: 1, invalid: 1, outputMax: 4000 })
    expect(model?.pilot.outputMean).toBeCloseTo((100 + 4000 + 20 + 60) / 4, 9)
    const cell = cellOf(result, SONNET, 'text')
    expect(cell.n).toBe(4)
    expect(cell.outputMean).toBeCloseTo(1045, 9)
    expect(cell.perCallUsd).toBeCloseTo((2000 + 41_000 + 1200 + 1600) / 4 / 1e6, 12)
  })

  it('treats the output of a truncated call as a lower bound when the full run allows more tokens', () => {
    const higher = run(suite, samples, { maxOutputTokens: 16_000 })
    expect(higher.warnings.join('\n')).toContain(
      `Truncated pilot calls: ${SONNET} 1 of 4. They were cut at the pilot's cap of 4000 output tokens. What they would use under --max-output-tokens 16000 is unknown and at least 4000, so the projection is a minimum. If each of them used the whole 16000, the projected total at the mean would be $0.0829 instead of $0.0229.`,
    )
    expect(higher.meanUsd).toBeCloseTo(0.0229, 12)
    expect(higher.truncatedCeilingUsd).toBeCloseTo(0.0829, 12)
    const same = run(suite, samples, { maxOutputTokens: 4000 })
    expect(same.warnings.join('\n')).toContain(`Truncated pilot calls: ${SONNET} 1 of 4. They were cut at the pilot's cap of 4000 output tokens.`)
    expect(same.warnings.join('\n')).not.toContain('is unknown and at least')
    expect(same.truncatedCeilingUsd).toBeUndefined()
    expect(run(suite, samples.slice(0, 1), { maxOutputTokens: 16_000 }).truncatedCeilingUsd).toBeUndefined()
  })

  it('clamps the pilot output at --max-output-tokens and says how many pilot calls would have been truncated', () => {
    const result = run(suite, samples, { maxOutputTokens: 2000 })
    const cell = cellOf(result, SONNET, 'text')
    expect(cell.outputMean).toBeCloseTo((100 + 2000 + 20 + 60) / 4, 9)
    expect(cell.perCallUsd).toBeCloseTo((2000 + 21_000 + 1200 + 1600) / 4 / 1e6, 12)
    expect(result.warnings.join('\n')).toContain('With --max-output-tokens 2000, 1 of the 4 pilot calls would have been truncated')
    expect(run(suite, samples, { maxOutputTokens: 4000 }).warnings.join('\n')).not.toContain('would have been truncated')
  })
})

describe('reestimate: models without a price', () => {
  it('keeps the token figures, leaves every dollar figure and the budget out, and warns', () => {
    const suite = fakeSuite(seeds(2, ['text']))
    const result = run(suite, [sample(MYSTERY, 'text', 500, 100), sample(MYSTERY, 'text', 700, 300)], { models: [MYSTERY, SONNET] })
    const mystery = result.models.find((entry) => entry.model === MYSTERY)
    expect(mystery?.priced).toBe(false)
    expect(mystery?.cells[0]).toMatchObject({ basis: 'measured', n: 2, inputMean: 600, outputMean: 200, perCallUsd: undefined, meanUsd: undefined, p90Usd: undefined })
    expect(mystery?.meanUsd).toBeUndefined()
    expect(result.meanUsd).toBeUndefined()
    expect(result.p90Usd).toBeUndefined()
    expect(result.suggestedBudgetUsd).toBeUndefined()
    expect(result.breakEvenOutputTokens).toBeUndefined()
    expect(result.worstCallUsd).toBeUndefined()
    expect(result.warnings.join('\n')).toContain(`No price in the price table for ${MYSTERY}`)
    expect(result.models.find((entry) => entry.model === SONNET)?.meanUsd).toBeGreaterThan(0)
  })
})

describe('reestimate: the suggested budget', () => {
  it('is the larger of 1.3 x the p90 total and the mean total plus the reserve of the calls in flight, rounded up to the cent', () => {
    expect(BUDGET_P90_FACTOR).toBe(1.3)
    const reserveBound = run(MEASURED_SUITE, MEASURED, { reps: 2, concurrency: 2, maxOutputTokens: 4000 })
    expect(reserveBound.worstCallUsd).toBeCloseTo((2400 * 2 + 4000 * 10) / 1e6, 12)
    expect(reserveBound.reserveUsd).toBeCloseTo(2 * 0.0448, 12)
    expect(reserveBound.suggestedFrom).toBe('reserve')
    expect(reserveBound.suggestedBudgetUsd).toBe(0.16)
    const p90Bound = run(MEASURED_SUITE, MEASURED, { reps: 2, concurrency: 1, maxOutputTokens: 1000 })
    expect(p90Bound.reserveUsd).toBeCloseTo(0.0148, 12)
    expect(p90Bound.suggestedFrom).toBe('p90')
    expect(p90Bound.suggestedBudgetUsd).toBe(0.11)
  })

  it('never lets the reserve exceed the calls the run has', () => {
    const suite = fakeSuite(seeds(1, ['text']))
    const result = run(suite, [sample(SONNET, 'text', 500, 100), sample(SONNET, 'text', 700, 300)], { concurrency: 16, maxOutputTokens: 1000 })
    expect(result.calls).toBe(1)
    expect(result.reserveUsd).toBeCloseTo((800 * 2 + 1000 * 10) / 1e6, 12)
  })

  it('rounds up to the next cent and uses more digits below a cent', () => {
    const suite = fakeSuite(seeds(1, ['text']))
    const tiny = run(suite, [sample(HAIKU, 'text', 100, 10), sample(HAIKU, 'text', 100, 10)], { models: [HAIKU], concurrency: 1, maxOutputTokens: 100 })
    const mean = tiny.meanUsd ?? 0
    expect(tiny.suggestedBudgetUsd).toBe(roundUpBudget(Math.max(1.3 * (tiny.p90Usd ?? 0), mean + tiny.reserveUsd)))
    expect(tiny.suggestedBudgetUsd).toBeLessThan(0.01)
    expect(tiny.suggestedBudgetUsd).toBeGreaterThanOrEqual(mean + tiny.reserveUsd)
  })

  it('computes the break-even output tokens per call at that budget and the pilot average it compares with', () => {
    const result = run(MEASURED_SUITE, MEASURED, { reps: 2, concurrency: 2, maxOutputTokens: 4000 })
    expect(result.suggestedBudgetUsd).toBe(0.16)
    expect(result.measuredOutputPerCall).toBeCloseTo((8 * 200 + 4 * 500) / 12, 9)
    expect(result.breakEvenOutputTokens).toBeCloseTo((0.16 - 0.0896 - 0.0296) / 0.00012, 6)
  })

  it('reports the budget at a lower cap and its consequence when the reserve is a large share of the cost and nothing was truncated', () => {
    expect(RESERVE_SHARE_LIMIT).toBe(0.2)
    expect(LOWER_MAX_OUTPUT_STEPS).toEqual([2000, 4000, 8000])
    const suite = fakeSuite(seeds(3, ['text']))
    const samples = [sample(OPUS, 'text', 600, 300), sample(OPUS, 'text', 600, 400), sample(OPUS, 'text', 600, 500)]
    const result = run(suite, samples, { models: [OPUS], concurrency: 4, maxOutputTokens: 16_000 })
    expect(result.meanUsd).toBeCloseTo(0.0312, 12)
    expect(result.reserveUsd).toBeCloseTo(3 * 0.3232, 12)
    expect(result.suggestedBudgetUsd).toBe(1.01)
    expect(result.lowerMaxOutput).toMatchObject({ maxOutputTokens: 2000, suggestedBudgetUsd: 0.17, pilotCallsOver: 0, largestOutputTokens: 500 })
    expect(result.lowerMaxOutput?.reserveUsd).toBeCloseTo(3 * 0.0432, 12)
    const text = result.warnings.join('\n')
    expect(text).toContain('At --max-output-tokens 16000 the budget guard holds back')
    expect(text).toContain('With --max-output-tokens 2000 the reserve is')
    expect(text).toContain('a call that needs more than 2000 output tokens is cut off and recorded as truncated')
    expect(text).toContain('none of the pilot calls would have been cut')
  })

  it('picks the step that leaves twice the largest pilot reply and stays silent when none is lower than the cap', () => {
    const suite = fakeSuite(seeds(3, ['text']))
    const big = [sample(OPUS, 'text', 600, 1500), sample(OPUS, 'text', 600, 900), sample(OPUS, 'text', 600, 1200)]
    expect(run(suite, big, { models: [OPUS], maxOutputTokens: 16_000 }).lowerMaxOutput?.maxOutputTokens).toBe(4000)
    const huge = [sample(OPUS, 'text', 600, 5000), sample(OPUS, 'text', 600, 900), sample(OPUS, 'text', 600, 1200)]
    expect(run(suite, huge, { models: [OPUS], maxOutputTokens: 16_000, pilot: { maxOutputTokens: 16_000 } }).lowerMaxOutput).toBeUndefined()
    expect(run(suite, big, { models: [OPUS], maxOutputTokens: 4000 }).lowerMaxOutput).toBeUndefined()
    const truncated = [sample(OPUS, 'text', 600, 300), sample(OPUS, 'text', 600, 4000, 'truncated'), sample(OPUS, 'text', 600, 500)]
    expect(run(suite, truncated, { models: [OPUS], maxOutputTokens: 16_000 }).lowerMaxOutput).toBeUndefined()
  })

  it('does not suggest a lower cap when the reserve is a small share of the cost', () => {
    const suite = fakeSuite(seeds(36, ['text', 'pdf', 'png']))
    const samples = (['text', 'pdf', 'png'] as const).flatMap((kind) => [sample(OPUS, kind, 1000, 3000), sample(OPUS, kind, 1000, 3500), sample(OPUS, kind, 1000, 3200)])
    const result = run(suite, samples, { models: [OPUS], reps: 3, concurrency: 4, maxOutputTokens: 16_000 })
    expect(result.reserveUsd).toBeLessThan(RESERVE_SHARE_LIMIT * (result.meanUsd ?? 0))
    expect(result.lowerMaxOutput).toBeUndefined()
    expect(result.warnings.join('\n')).not.toContain('holds back')
  })
})

describe('reestimate: the other warnings', () => {
  const suite = fakeSuite(seeds(4, ['text']))

  it('says how few calls the pilot saw per model and kind', () => {
    const result = run(suite, TEXT_SAMPLES)
    expect(result.warnings.join('\n')).toContain('The pilot saw only 3 calls per model and kind, so the projection is rough')
    const uneven = run(fakeSuite(seeds(4, ['text', 'pdf'])), [...TEXT_SAMPLES, ...PDF_SAMPLES.slice(0, 1)])
    expect(uneven.warnings.join('\n')).toContain('The pilot saw only 1 to 3 calls per model and kind')
  })

  it('says how many of the plan seeds the pilot covered', () => {
    const result = run(suite, TEXT_SAMPLES.map((entry, index) => ({ ...entry, group: `g${index + 1}` })))
    expect(result.warnings.join('\n')).toContain('The pilot covered 3 of the 4 seeds of this plan')
    const all = run(suite, [...TEXT_SAMPLES, sample(SONNET, 'text', 600, 200, 'ok', 'g4')].map((entry, index) => ({ ...entry, group: `g${index + 1}` })))
    expect(all.warnings.join('\n')).not.toContain('The pilot covered')
  })

  it('warns about a suite version that differs, or is unknown', () => {
    expect(run(suite, TEXT_SAMPLES).warnings.join('\n')).not.toContain('suite version')
    const changed = run(suite, TEXT_SAMPLES, { pilot: { suiteVersion: 'v-then' } }).warnings.join('\n')
    expect(changed).toContain('The pilot ran suite version v-then; this checkout has v-now.')
    const unknown = run(suite, TEXT_SAMPLES, { pilot: { suiteVersion: null, source: 'partial' } }).warnings.join('\n')
    expect(unknown).toContain('The suite version of the pilot is unknown')
  })

  it('reports failed and skipped pilot tasks, a partial run, unused rows and rows of models outside the plan', () => {
    const result = run(suite, [...TEXT_SAMPLES, sample(HAIKU, 'text', 10, 10)], { pilot: { failed: 2, skipped: 5, partialRun: true, withoutUsage: 1 } })
    const text = result.warnings.join('\n')
    expect(text).toContain('Pilot tasks without a result row: 2 failed, 5 skipped.')
    expect(text).toContain('The pilot run was partial')
    expect(text).toContain('Pilot rows without token usage are ignored: 1.')
    expect(text).toContain(`Pilot rows of ${HAIKU} are not used: not in --models`)
    expect(result.models.map((entry) => entry.model)).toEqual([SONNET])
  })
})
