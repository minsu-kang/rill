import { worstCaseCallUsd } from './runner'
import type { EvalCase, Suite } from './suite'

export function roundUpBudget(raw: number): number {
  if (!(raw > 0)) return 0.01
  if (raw >= 0.01) return Math.ceil(raw * 100 - 1e-9) / 100
  const step = 10 ** (Math.floor(Math.log10(raw)) - 1)
  return Number((Math.ceil(raw / step - 1e-9) * step).toPrecision(2))
}

export function formatUsdPlain(value: number): string {
  const cents = value * 100
  if (value >= 0.01 && Math.abs(cents - Math.round(cents)) < 1e-9) return value.toFixed(2)
  const text = String(value)
  if (!text.includes('e')) return text
  return value.toFixed(20).replace(/0+$/u, '').replace(/\.$/u, '')
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function money(value: number | undefined): string {
  if (value === undefined) return 'n/a'
  if (value > 0 && value < 0.0001) return `$${formatUsdPlain(value)}`
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

export function worstCallUsd<C extends EvalCase, O>(suite: Suite<C, O>, models: readonly string[], maxOutputTokens: number): number | undefined {
  let worst: number | undefined = 0
  for (const model of models) {
    for (const testCase of suite.cases()) {
      const call = worstCaseCallUsd(suite, testCase, model, maxOutputTokens)
      worst = worst === undefined || call === undefined ? undefined : Math.max(worst, call)
    }
  }
  return worst
}

export function guardReserveUsd(worstUsd: number | undefined, concurrency: number, calls: number): number {
  return worstUsd === undefined ? 0 : worstUsd * Math.min(concurrency, calls)
}
