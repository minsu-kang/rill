import type { LlmUsage } from '@rill/llm'
import { guardReserveUsd, money, plural, roundUpBudget, worstCallUsd } from './budget'
import { costUsd, estimateCallUsd, priceFor } from './pricing'
import { ESTIMATE_OUTPUT_TOKENS, breakEvenOutputTokens, estimateRun, type RunEstimate } from './runner'
import { softCapFactor } from './spec'
import { mean, percentile } from './stats'
import type { EvalCase, Suite } from './suite'

export const BUDGET_P90_FACTOR = 1.3
export const MIN_CELL_SAMPLES = 2
export const PESSIMISTIC_PERCENTILE = 90
export const RESERVE_SHARE_LIMIT = 0.2
export const LOWER_MAX_OUTPUT_STEPS: readonly number[] = [2000, 4000, 8000]
export const LOWER_MAX_OUTPUT_MARGIN = 2

export type SampleOutcome = 'ok' | 'truncated' | 'refused' | 'invalid'

export type Basis = 'measured' | 'model-mean' | 'assumed'

export interface PilotSample {
  model: string
  kind: string
  group: string
  outcome: SampleOutcome
  usage: LlmUsage
}

export interface PilotData {
  source: 'results' | 'partial'
  suiteVersion: string | null
  effort: string | null
  maxOutputTokens: number | null
  partialRun: boolean
  failed: number
  skipped: number
  withoutUsage: number
  samples: PilotSample[]
}

export interface ReestimateInput<C extends EvalCase, O> {
  suite: Suite<C, O>
  pilot: PilotData
  models: readonly string[]
  reps: number
  concurrency: number
  maxOutputTokens: number
}

export interface CellProjection {
  kind: string
  calls: number
  n: number
  basis: Basis
  inputMean: number
  inputP90: number
  outputMean: number
  outputP90: number
  perCallUsd: number | undefined
  perCallP90Usd: number | undefined
  meanUsd: number | undefined
  p90Usd: number | undefined
  inputUsd: number | undefined
  usdPerOutputToken: number | undefined
}

export interface ModelPilot {
  calls: number
  ok: number
  truncated: number
  refused: number
  invalid: number
  outputMean: number | null
  outputP90: number | null
  outputMax: number | null
}

export interface ModelProjection {
  model: string
  priced: boolean
  calls: number
  cells: CellProjection[]
  meanUsd: number | undefined
  p90Usd: number | undefined
  firstEstimateUsd: number | undefined
  pilot: ModelPilot
}

export interface LowerMaxOutput {
  maxOutputTokens: number
  suggestedBudgetUsd: number
  reserveUsd: number
  worstCallUsd: number
  largestOutputTokens: number
  pilotCallsOver: number
}

export interface Reestimate {
  models: ModelProjection[]
  calls: number
  maxOutputTokens: number
  meanUsd: number | undefined
  p90Usd: number | undefined
  firstEstimateUsd: number | undefined
  worstCallUsd: number | undefined
  reserveUsd: number
  suggestedBudgetUsd: number | undefined
  suggestedFrom: 'p90' | 'reserve'
  breakEvenOutputTokens: number | undefined
  measuredOutputPerCall: number
  lowerMaxOutput: LowerMaxOutput | undefined
  truncatedCeilingUsd: number | undefined
  warnings: string[]
}

interface Pool {
  n: number
  inputMean: number
  inputP90: number
  outputMean: number
  outputP90: number
  perCallUsd: number | undefined
  p90CallUsd: number | undefined
  inputCallUsd: number | undefined
}

interface Projection {
  models: ModelProjection[]
  calls: number
  meanUsd: number | undefined
  p90Usd: number | undefined
  worstUsd: number | undefined
  reserveUsd: number
  budgetUsd: number | undefined
  from: 'p90' | 'reserve'
  breakEven: number | undefined
  measuredOutputPerCall: number
}

function meanOf(values: readonly number[]): number {
  return mean(values) ?? 0
}

function p90Of(values: readonly number[]): number {
  return percentile(values, PESSIMISTIC_PERCENTILE) ?? 0
}

function summed(values: readonly (number | undefined)[]): number | undefined {
  let total = 0
  for (const value of values) {
    if (value === undefined) return undefined
    total += value
  }
  return total
}

function averaged(values: readonly (number | undefined)[]): number | undefined {
  const total = summed(values)
  return total === undefined || values.length === 0 ? undefined : total / values.length
}

function promptTokens(usage: LlmUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
}

function measuredPool(model: string, samples: readonly PilotSample[], maxOutputTokens: number): Pool {
  const ceiling = maxOutputTokens * softCapFactor(model)
  const usages = samples.map(({ usage }) => ({ ...usage, outputTokens: Math.min(usage.outputTokens, ceiling) }))
  const inputs = usages.map(promptTokens)
  const outputs = usages.map((usage) => usage.outputTokens)
  const inputP90 = p90Of(inputs)
  const outputP90 = p90Of(outputs)
  return {
    n: samples.length,
    inputMean: meanOf(inputs),
    inputP90,
    outputMean: meanOf(outputs),
    outputP90,
    perCallUsd: averaged(usages.map((usage) => costUsd(model, usage))),
    p90CallUsd: costUsd(model, { inputTokens: inputP90, outputTokens: outputP90, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }),
    inputCallUsd: averaged(usages.map((usage) => costUsd(model, { ...usage, outputTokens: 0 }))),
  }
}

function assumedPool(model: string, inputs: readonly number[]): Pool {
  const inputMean = meanOf(inputs)
  const perCallUsd = averaged(inputs.map((tokens) => estimateCallUsd(model, tokens, ESTIMATE_OUTPUT_TOKENS)))
  return {
    n: 0,
    inputMean,
    inputP90: inputMean,
    outputMean: ESTIMATE_OUTPUT_TOKENS,
    outputP90: ESTIMATE_OUTPUT_TOKENS,
    perCallUsd,
    p90CallUsd: perCallUsd,
    inputCallUsd: averaged(inputs.map((tokens) => estimateCallUsd(model, tokens, 0))),
  }
}

function perOutputTokenUsd(model: string, inputTokens: number): number | undefined {
  const withOne = estimateCallUsd(model, inputTokens, 1)
  const bare = estimateCallUsd(model, inputTokens, 0)
  return withOne === undefined || bare === undefined ? undefined : withOne - bare
}

function countOutcome(samples: readonly PilotSample[], outcome: SampleOutcome): number {
  return samples.filter((sample) => sample.outcome === outcome).length
}

function pilotOf(samples: readonly PilotSample[]): ModelPilot {
  const outputs = samples.map((sample) => sample.usage.outputTokens)
  return {
    calls: samples.length,
    ok: countOutcome(samples, 'ok'),
    truncated: countOutcome(samples, 'truncated'),
    refused: countOutcome(samples, 'refused'),
    invalid: countOutcome(samples, 'invalid'),
    outputMean: mean(outputs),
    outputP90: percentile(outputs, PESSIMISTIC_PERCENTILE),
    outputMax: outputs.length === 0 ? null : Math.max(...outputs),
  }
}

function project<C extends EvalCase, O>(input: ReestimateInput<C, O>, maxOutputTokens: number, defaultInputTokens: number, firstEstimate: RunEstimate): Projection {
  const { suite, pilot, models, reps, concurrency } = input
  const cases = suite.cases()
  const kinds = [...new Set(cases.map((testCase) => testCase.kind))]
  const projections = models.map((model): ModelProjection => {
    const own = pilot.samples.filter((sample) => sample.model === model)
    const runnable = kinds
      .map((kind) => ({ kind, kindCases: cases.filter((testCase) => testCase.kind === kind && suite.unsupportedReason?.(testCase, model) === undefined) }))
      .filter(({ kindCases }) => kindCases.length > 0)
    const cells = runnable.map(({ kind, kindCases }): CellProjection => {
      const cellSamples = own.filter((sample) => sample.kind === kind)
      let basis: Basis
      let pool: Pool
      if (cellSamples.length >= MIN_CELL_SAMPLES) {
        basis = 'measured'
        pool = measuredPool(model, cellSamples, maxOutputTokens)
      } else if (own.length > 0) {
        basis = 'model-mean'
        pool = { ...measuredPool(model, own, maxOutputTokens), n: cellSamples.length }
      } else {
        basis = 'assumed'
        pool = assumedPool(model, kindCases.map((testCase) => suite.estimateInputTokens?.(testCase) ?? defaultInputTokens))
      }
      const calls = kindCases.length * reps
      const perToken = perOutputTokenUsd(model, pool.inputMean)
      return {
        kind,
        calls,
        n: pool.n,
        basis,
        inputMean: pool.inputMean,
        inputP90: pool.inputP90,
        outputMean: pool.outputMean,
        outputP90: pool.outputP90,
        perCallUsd: pool.perCallUsd,
        perCallP90Usd: pool.p90CallUsd,
        meanUsd: pool.perCallUsd === undefined ? undefined : pool.perCallUsd * calls,
        p90Usd: pool.p90CallUsd === undefined ? undefined : pool.p90CallUsd * calls,
        inputUsd: pool.inputCallUsd === undefined ? undefined : pool.inputCallUsd * calls,
        usdPerOutputToken: perToken === undefined ? undefined : perToken * calls,
      }
    })
    return {
      model,
      priced: priceFor(model) !== undefined,
      calls: cells.reduce((total, cell) => total + cell.calls, 0),
      cells,
      meanUsd: summed(cells.map((cell) => cell.meanUsd)),
      p90Usd: summed(cells.map((cell) => cell.p90Usd)),
      firstEstimateUsd: firstEstimate.perModel.find((entry) => entry.model === model)?.usd,
      pilot: pilotOf(own),
    }
  })
  const allCells = projections.flatMap((entry) => entry.cells)
  const calls = allCells.reduce((total, cell) => total + cell.calls, 0)
  const meanUsd = summed(projections.map((entry) => entry.meanUsd))
  const p90Usd = summed(projections.map((entry) => entry.p90Usd))
  const worstUsd = worstCallUsd(suite, models, maxOutputTokens)
  const reserveUsd = guardReserveUsd(worstUsd, concurrency, calls)
  const p90Term = p90Usd === undefined ? undefined : p90Usd * BUDGET_P90_FACTOR
  const reserveTerm = meanUsd === undefined ? undefined : meanUsd + reserveUsd
  const budgetUsd = p90Term === undefined || reserveTerm === undefined ? undefined : roundUpBudget(Math.max(p90Term, reserveTerm))
  const inputUsd = summed(allCells.map((cell) => cell.inputUsd))
  const usdPerOutputToken = summed(allCells.map((cell) => cell.usdPerOutputToken))
  return {
    models: projections,
    calls,
    meanUsd,
    p90Usd,
    worstUsd,
    reserveUsd,
    budgetUsd,
    from: p90Term !== undefined && reserveTerm !== undefined && p90Term >= reserveTerm ? 'p90' : 'reserve',
    breakEven: budgetUsd === undefined ? undefined : breakEvenOutputTokens({ calls, inputUsd, usdPerOutputToken }, budgetUsd, reserveUsd),
    measuredOutputPerCall: calls === 0 ? 0 : allCells.reduce((total, cell) => total + cell.calls * cell.outputMean, 0) / calls,
  }
}

export function reestimate<C extends EvalCase, O>(input: ReestimateInput<C, O>): Reestimate {
  const { suite, pilot, models, reps, maxOutputTokens } = input
  const firstEstimate = estimateRun({ suite, models, reps })
  const defaultInputTokens = firstEstimate.assumptions.defaultInputTokens
  const base = project(input, maxOutputTokens, defaultInputTokens, firstEstimate)
  const planSamples = pilot.samples.filter((sample) => models.includes(sample.model))
  const lowerMaxOutput = lowerMaxOutputOf(input, base, planSamples, defaultInputTokens, firstEstimate)
  const censored = (sample: PilotSample): boolean => sample.outcome === 'truncated' && sample.usage.outputTokens < maxOutputTokens
  const truncatedCeilingUsd = planSamples.some(censored)
    ? project(
        { ...input, pilot: { ...pilot, samples: pilot.samples.map((sample) => (censored(sample) ? { ...sample, usage: { ...sample.usage, outputTokens: maxOutputTokens } } : sample)) } },
        maxOutputTokens,
        defaultInputTokens,
        firstEstimate,
      ).meanUsd
    : undefined
  return {
    models: base.models,
    calls: base.calls,
    maxOutputTokens,
    meanUsd: base.meanUsd,
    p90Usd: base.p90Usd,
    firstEstimateUsd: firstEstimate.totalUsd,
    worstCallUsd: base.worstUsd,
    reserveUsd: base.reserveUsd,
    suggestedBudgetUsd: base.budgetUsd,
    suggestedFrom: base.from,
    breakEvenOutputTokens: base.breakEven,
    measuredOutputPerCall: base.measuredOutputPerCall,
    lowerMaxOutput,
    truncatedCeilingUsd,
    warnings: warningsOf(input, base, planSamples, lowerMaxOutput, truncatedCeilingUsd),
  }
}

function lowerMaxOutputOf<C extends EvalCase, O>(
  input: ReestimateInput<C, O>,
  base: Projection,
  planSamples: readonly PilotSample[],
  defaultInputTokens: number,
  firstEstimate: RunEstimate,
): LowerMaxOutput | undefined {
  if (base.meanUsd === undefined || base.budgetUsd === undefined || planSamples.length === 0) return undefined
  if (planSamples.some((sample) => sample.outcome === 'truncated')) return undefined
  if (!(base.reserveUsd > RESERVE_SHARE_LIMIT * base.meanUsd)) return undefined
  const largest = Math.max(...planSamples.map((sample) => sample.usage.outputTokens))
  const lower = LOWER_MAX_OUTPUT_STEPS.find((step) => step >= largest * LOWER_MAX_OUTPUT_MARGIN)
  if (lower === undefined || lower >= input.maxOutputTokens) return undefined
  const alternative = project(input, lower, defaultInputTokens, firstEstimate)
  if (alternative.budgetUsd === undefined || alternative.worstUsd === undefined) return undefined
  return {
    maxOutputTokens: lower,
    suggestedBudgetUsd: alternative.budgetUsd,
    reserveUsd: alternative.reserveUsd,
    worstCallUsd: alternative.worstUsd,
    largestOutputTokens: largest,
    pilotCallsOver: planSamples.filter((sample) => sample.usage.outputTokens > lower).length,
  }
}

function warningsOf<C extends EvalCase, O>(
  input: ReestimateInput<C, O>,
  base: Projection,
  planSamples: readonly PilotSample[],
  lower: LowerMaxOutput | undefined,
  ceilingUsd: number | undefined,
): string[] {
  const { suite, pilot, models, maxOutputTokens } = input
  const warnings: string[] = []
  if (pilot.suiteVersion === null) {
    warnings.push(`The suite version of the pilot is unknown (it was read from tasks.partial.jsonl), so it cannot be checked against this checkout (${suite.version}).`)
  } else if (pilot.suiteVersion !== suite.version) {
    warnings.push(
      `The pilot ran suite version ${pilot.suiteVersion}; this checkout has ${suite.version}. The fixtures, the scorer, the injection rules or the price table changed since, so the measured token counts may not carry over.`,
    )
  }
  const unpriced = models.filter((model) => priceFor(model) === undefined)
  if (unpriced.length > 0) {
    warnings.push(`No price in the price table for ${unpriced.join(', ')}: its cost cannot be projected, there is no suggested budget, and --yes would refuse this run.`)
  }
  const unseen = base.models.filter((entry) => entry.pilot.calls === 0)
  for (const entry of unseen) {
    warnings.push(
      `${entry.model} has no usage rows in the pilot, so it cannot be projected: its figures are the first assumption (${ESTIMATE_OUTPUT_TOKENS} output tokens per call), not a measurement, and the suggested budget does not cover its real cost reliably.`,
    )
  }
  const seen = base.models.filter((entry) => entry.pilot.calls > 0)
  const counts = seen.flatMap((entry) => entry.cells.map((cell) => cell.n))
  if (counts.length > 0) {
    const low = Math.min(...counts)
    const high = Math.max(...counts)
    warnings.push(
      `The pilot saw only ${low === high ? plural(low, 'call') : `${low} to ${high} calls`} per model and kind, so the projection is rough: a 90th percentile of so few calls is close to the largest of them.`,
    )
  }
  const planSeeds = new Set(suite.cases().map((testCase) => testCase.group)).size
  const pilotSeeds = new Set(planSamples.map((sample) => sample.group)).size
  if (planSamples.length > 0 && pilotSeeds < planSeeds) {
    warnings.push(`The pilot covered ${pilotSeeds} of the ${planSeeds} seeds of this plan. Its seeds were not drawn at random, so another mix of receipts can cost differently.`)
  }
  const fallbacks = seen.flatMap((entry) => entry.cells.filter((cell) => cell.basis !== 'measured').map((cell) => `${entry.model} ${cell.kind}`))
  if (fallbacks.length > 0) {
    warnings.push(`Fewer than ${MIN_CELL_SAMPLES} pilot calls for ${fallbacks.join(', ')}: the table marks these FALLBACK (the pilot mean of the model across kinds).`)
  }
  const cutModels = base.models.filter((entry) => entry.pilot.truncated > 0)
  if (cutModels.length > 0) {
    const cap = pilot.maxOutputTokens ?? Math.max(...cutModels.map((entry) => entry.pilot.outputMax ?? 0))
    const list = cutModels.map((entry) => `${entry.model} ${entry.pilot.truncated} of ${entry.pilot.calls}`).join(', ')
    const cut = `Truncated pilot calls: ${list}. They were cut at the pilot's cap of ${cap} output tokens.`
    const ceiling =
      ceilingUsd === undefined || base.meanUsd === undefined ? '' : ` If each of them used the whole ${maxOutputTokens}, the projected total at the mean would be ${money(ceilingUsd)} instead of ${money(base.meanUsd)}.`
    warnings.push(
      cap < maxOutputTokens
        ? `${cut} What they would use under --max-output-tokens ${maxOutputTokens} is unknown and at least ${cap}, so the projection is a minimum.${ceiling}`
        : cut,
    )
  }
  const over = planSamples.filter((sample) => sample.usage.outputTokens > maxOutputTokens).length
  if (over > 0) {
    warnings.push(
      `With --max-output-tokens ${maxOutputTokens}, ${over} of the ${plural(planSamples.length, 'pilot call')} would have been truncated: they used more output tokens than that (thinking included). The projection counts them at ${maxOutputTokens} tokens, and in the real run the report lists them as truncated and leaves them out of every mean.`,
    )
  }
  if (lower !== undefined && base.budgetUsd !== undefined && base.meanUsd !== undefined) {
    warnings.push(
      `At --max-output-tokens ${maxOutputTokens} the budget guard holds back ${money(base.reserveUsd)} for the calls in flight, ${Math.round((base.reserveUsd / base.meanUsd) * 100)}% of the projected ${money(base.meanUsd)}, so the budget has to be ${money(base.budgetUsd)}. The largest pilot reply was ${lower.largestOutputTokens} output tokens (thinking included). With --max-output-tokens ${lower.maxOutputTokens} the reserve is ${money(lower.reserveUsd)} and the suggested budget ${money(lower.suggestedBudgetUsd)}. The consequence: a call that needs more than ${lower.maxOutputTokens} output tokens is cut off and recorded as truncated, which counts as no answer and is left out of every mean; ${lower.pilotCallsOver === 0 ? 'none of the pilot calls would have been cut' : `${plural(lower.pilotCallsOver, 'pilot call')} would have been cut`}.`,
    )
  }
  if (pilot.failed > 0 || pilot.skipped > 0) {
    warnings.push(`Pilot tasks without a result row: ${pilot.failed} failed, ${pilot.skipped} skipped. They are not in the means.`)
  }
  if (pilot.partialRun) warnings.push('The pilot run was partial (it stopped before every task ran), so there are fewer calls than planned.')
  if (pilot.withoutUsage > 0) warnings.push(`Pilot rows without token usage are ignored: ${pilot.withoutUsage}.`)
  const ignored = [...new Set(pilot.samples.filter((sample) => !models.includes(sample.model)).map((sample) => sample.model))]
  if (ignored.length > 0) warnings.push(`Pilot rows of ${ignored.join(', ')} are not used: not in --models.`)
  return warnings
}
