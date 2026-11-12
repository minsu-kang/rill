import { EFFORT_LEVELS, type LlmEffort } from '@rill/llm'
import { resolveEffort } from '@rill/planner'
import type { RunResult } from './runner'
import { SOFT_CAP_RESERVE_FACTOR, capabilitiesOfSpec, modelIdOf, providerOfSpec, softCapFactor } from './spec'

const providerName = (model: string): string => providerOfSpec(model) ?? 'unknown'

export function groupByProvider(models: readonly string[]): string[] {
  const order = [...new Set(models.map(providerName))]
  return order.flatMap((provider) => models.filter((model) => providerName(model) === provider))
}

export function showProviders(models: readonly string[]): boolean {
  return models.some((model) => providerName(model) !== 'anthropic')
}

export function providerCell(model: string): string {
  return providerName(model)
}

export function providerLines(models: readonly string[]): string[] {
  if (!showProviders(models)) return []
  const grouped = groupByProvider(models)
  const providers = [...new Set(grouped.map(providerName))].map((provider) => `${provider} (${grouped.filter((model) => providerName(model) === provider).map(modelIdOf).join(', ')})`)
  const soft = grouped.filter((model) => softCapFactor(model) > 1)
  return [
    `- Providers: ${providers.join(', ')}`,
    ...(soft.length === 0
      ? []
      : [`- Soft cap: ${soft.join(', ')} ${soft.length === 1 ? 'does' : 'do'} not count hidden reasoning against max tokens, so ${soft.length === 1 ? 'its costs are' : 'their costs are'} soft cap figures and the budget guard reserves ${SOFT_CAP_RESERVE_FACTOR} times the output for ${soft.length === 1 ? 'it' : 'them'}.`]),
  ]
}

export function softCapMark(model: string, text: string): string {
  return softCapFactor(model) > 1 && text !== 'n/a' ? `${text} (soft cap)` : text
}

const isEffort = (value: string | undefined): value is LlmEffort => value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value)

export function effortLines(models: readonly string[], effort: string | undefined): string[] {
  if (!isEffort(effort)) return []
  const resolved = models.map((model) => ({ model, ...resolveEffort(capabilitiesOfSpec(model), effort) }))
  if (!resolved.some((entry) => entry.collapsed)) return []
  const cells = resolved.map((entry) => `${entry.model} ${entry.effective}${entry.collapsed ? ` (collapsed from ${effort})` : ''}`)
  return [`- Effective effort per model: ${cells.join(', ')}`]
}

export function notRunSection(run: Pick<RunResult<unknown>, 'notRun'>): string[] {
  const pairs = run.notRun ?? []
  if (pairs.length === 0) return []
  const byModel = new Map<string, { count: number; reasons: Set<string> }>()
  for (const pair of pairs) {
    const entry = byModel.get(pair.model) ?? { count: 0, reasons: new Set<string>() }
    entry.count += 1
    entry.reasons.add(pair.reason)
    byModel.set(pair.model, entry)
  }
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [
    '## Not run (n/a)',
    '',
    'These cases were not sent because the model cannot take the input. They are left out of that model\'s numbers (n/a); they are not counted as failures and the run is not partial because of them.',
    '',
    line(['Model', 'Cases not run', 'Reason']),
    line(['---', '---', '---']),
    ...[...byModel].map(([model, entry]) => line([model, String(entry.count), [...entry.reasons].join('; ')])),
    '',
  ]
}
