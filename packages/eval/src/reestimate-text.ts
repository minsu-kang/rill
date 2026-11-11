import { formatUsdPlain, money, plural } from './budget'
import { PRICE_TABLE_AS_OF } from './pricing'
import { ESTIMATE_OUTPUT_TOKENS } from './runner'
import { BUDGET_P90_FACTOR, PESSIMISTIC_PERCENTILE, type Basis, type CellProjection, type ModelProjection, type PilotData, type Reestimate } from './reestimate'

export interface ReestimateTextInput {
  dir: string
  suiteName: string
  suiteVersion: string
  pilot: PilotData
  result: Reestimate
  plan: { seeds: number; kinds: readonly string[]; cases: number; reps: number; concurrency: number; models: readonly string[] }
  command: string | undefined
  lowerCommand: string | undefined
}

const BASIS_LABEL: Readonly<Record<Basis, string>> = {
  measured: 'measured',
  'model-mean': 'FALLBACK: pilot mean of the model across kinds',
  assumed: 'FALLBACK: first assumption, no pilot data',
}

function tokens(value: number): string {
  return String(Math.round(value))
}

function pair(mean: number, p90: number, basis: Basis): string {
  return basis === 'assumed' ? `${tokens(mean)} / -` : `${tokens(mean)} / ${tokens(p90)}`
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    `  ${cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()}`
  return [line(header), ...rows.map(line)]
}

function cellRow(cell: CellProjection): string[] {
  return [
    cell.kind,
    String(cell.calls),
    String(cell.n),
    pair(cell.inputMean, cell.inputP90, cell.basis),
    pair(cell.outputMean, cell.outputP90, cell.basis),
    money(cell.perCallUsd),
    money(cell.meanUsd),
    money(cell.p90Usd),
    BASIS_LABEL[cell.basis],
  ]
}

function modelBlock(entry: ModelProjection): string[] {
  const rows = entry.cells.map(cellRow)
  rows.push(['total', String(entry.calls), '', '', '', '', money(entry.meanUsd), money(entry.p90Usd), ''])
  const pilot = entry.pilot
  const lines = [entry.model, ...table(['kind', 'calls', 'pilot n', 'input tokens mean / p90', 'output tokens mean / p90', '$ per call', 'cost at mean', 'cost at p90', 'basis'], rows)]
  if (pilot.calls === 0) {
    lines.push(`  pilot: no usage rows for this model; every figure above is the first assumption (${ESTIMATE_OUTPUT_TOKENS} output tokens per call)`)
  } else {
    const times = pilot.outputMean === null ? '' : ` (${(pilot.outputMean / ESTIMATE_OUTPUT_TOKENS).toFixed(1)} x the ${ESTIMATE_OUTPUT_TOKENS} the first estimate assumed)`
    lines.push(
      `  output tokens per call in the pilot, thinking included: mean ${tokens(pilot.outputMean ?? 0)}, p${PESSIMISTIC_PERCENTILE} ${tokens(pilot.outputP90 ?? 0)}, largest ${tokens(pilot.outputMax ?? 0)}${times}`,
      `  pilot calls: ${pilot.calls} (ok ${pilot.ok}, truncated ${pilot.truncated}, refused ${pilot.refused}, invalid ${pilot.invalid}); first estimate for the full plan: ${money(entry.firstEstimateUsd)}`,
    )
  }
  lines.push('')
  return lines
}

export function reestimateText(input: ReestimateTextInput): string {
  const { pilot, result, plan } = input
  const pilotModels = [...new Set(pilot.samples.map((sample) => sample.model))]
  const lines = [
    `rill eval: ${input.suiteName} (suite version ${input.suiteVersion}), re-estimate of the full run from a pilot`,
    '',
    `pilot: ${input.dir}`,
    `  ${plural(pilot.samples.length, 'call')} with usage${pilotModels.length > 0 ? ` (${pilotModels.join(', ')})` : ''}, effort ${pilot.effort ?? 'unknown'}, pilot cap ${pilot.maxOutputTokens === null ? 'unknown' : `${pilot.maxOutputTokens} output tokens`}${pilot.source === 'partial' ? ', read from tasks.partial.jsonl because the run has no run.json' : ''}`,
    `plan: ${plural(plan.seeds, 'seed')} x ${plural(plan.kinds.length, 'kind')} (${plan.kinds.join(', ')}) = ${plural(plan.cases, 'case')}, ${plural(plan.reps, 'rep')}, ${plural(plan.models.length, 'model')}: ${plural(result.calls, 'call')}`,
    `  concurrency ${plan.concurrency}, max_tokens ${result.maxOutputTokens} per request`,
    `costs are the measured tokens priced from the price table (as of ${PRICE_TABLE_AS_OF}); "cost at p90" prices the ${PESSIMISTIC_PERCENTILE}th percentile of the input tokens and of the output tokens together, a pessimistic bound.`,
    '',
  ]
  for (const entry of result.models) lines.push(...modelBlock(entry))
  lines.push(
    `all models: ${plural(result.calls, 'call')}`,
    `  projected at the mean: ${money(result.meanUsd)}`,
    `  projected at the p${PESSIMISTIC_PERCENTILE} (pessimistic): ${money(result.p90Usd)}`,
    `  first estimate from the assumptions: ${money(result.firstEstimateUsd)}`,
  )
  if (result.truncatedCeilingUsd !== undefined) {
    lines.push(`  if every truncated pilot call used the whole max_tokens of ${result.maxOutputTokens}: ${money(result.truncatedCeilingUsd)} at the mean`)
  }
  if (result.suggestedBudgetUsd === undefined) {
    lines.push('SUGGESTED BUDGET: n/a (needs a price for every model)')
  } else {
    const budget = result.suggestedBudgetUsd
    lines.push(
      `SUGGESTED BUDGET: $${formatUsdPlain(budget)}`,
      `  the larger of ${BUDGET_P90_FACTOR} x the p${PESSIMISTIC_PERCENTILE} total (${money((result.p90Usd ?? 0) * BUDGET_P90_FACTOR)}) and the mean total plus the guard's reserve (${money((result.meanUsd ?? 0) + result.reserveUsd)}), rounded up to the next cent; the ${result.suggestedFrom === 'p90' ? `${BUDGET_P90_FACTOR} x p${PESSIMISTIC_PERCENTILE}` : 'reserve'} term decides`,
      `  the guard's reserve: the worst case of one call (${money(result.worstCallUsd)}) x ${plural(Math.min(plan.concurrency, result.calls), 'call')} in flight = ${money(result.reserveUsd)}`,
    )
    if (result.breakEvenOutputTokens !== undefined) {
      lines.push(
        `  break-even: at this budget the run can afford an average of about ${Math.floor(result.breakEvenOutputTokens)} output tokens per call (thinking included, after the reserve); the pilot saw about ${tokens(result.measuredOutputPerCall)} on average over the planned calls. Above the break-even the guard stops the run early and the report is marked PARTIAL.`,
      )
    }
    if (result.truncatedCeilingUsd !== undefined && result.truncatedCeilingUsd > budget) {
      lines.push(`  note: the ceiling for truncated calls (${money(result.truncatedCeilingUsd)}) is above this budget; if they run long, the guard stops the run early and the report is marked PARTIAL.`)
    }
  }
  lines.push('')
  if (result.warnings.length > 0) {
    lines.push('warnings:', ...result.warnings.map((warning) => `  - ${warning}`), '')
  }
  if (input.command === undefined) {
    lines.push('Nothing was sent and nothing was written. There is no command to print without a budget; give every model a price in src/pricing.ts first.', '')
  } else {
    lines.push('Nothing was sent and nothing was written. To run the full plan for real (needs ANTHROPIC_API_KEY in the environment):', `  ${input.command}`)
    if (input.lowerCommand !== undefined && result.lowerMaxOutput !== undefined) {
      lines.push(`with the lower cap of --max-output-tokens ${result.lowerMaxOutput.maxOutputTokens} instead:`, `  ${input.lowerCommand}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
