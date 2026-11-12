import { describe, expect, it } from 'vitest'
import { money, worstCallUsd, worstModelUsd } from '../src/budget'
import { providerPlanLines } from '../src/cli-providers'
import { resolveModelSpecs } from '../src/providers'
import { estimateRun, worstCaseCallUsd } from '../src/runner'
import type { EvalCase, Suite } from '../src/suite'
import { fakeSuite, seeds } from './reestimate-fixtures'

const GROK = 'grok:grok-4.7'
const OPENAI = 'openai:gpt-6.1-sol'

const withoutPdfForGrok = (suite: Suite<EvalCase, unknown>): Suite<EvalCase, unknown> => ({
  ...suite,
  unsupportedReason: (testCase, model) => (testCase.kind === 'pdf' && model === GROK ? 'grok:grok-4.7 reads no PDF' : undefined),
})

describe('worst-case figures skip the cases a model cannot take', () => {
  const suite = withoutPdfForGrok(fakeSuite(seeds(2, ['text', 'pdf']), { text: 800, pdf: 400_000 }))
  const textCase = suite.cases().find((entry) => entry.kind === 'text')!
  const pdfCase = suite.cases().find((entry) => entry.kind === 'pdf')!

  it('sums only the cases it will run, in worstModelUsd', () => {
    const expected = 2 * worstCaseCallUsd(suite, textCase, GROK, 4000)! * 3
    expect(worstModelUsd(suite, GROK, 4000, 3)).toBeCloseTo(expected, 9)
    expect(worstModelUsd(suite, OPENAI, 4000, 1)).toBeCloseTo(2 * worstCaseCallUsd(suite, textCase, OPENAI, 4000)! + 2 * worstCaseCallUsd(suite, pdfCase, OPENAI, 4000)!, 9)
  })

  it('takes the largest of the cases it will run, in worstCallUsd', () => {
    expect(worstCallUsd(suite, [GROK], 4000)).toBeCloseTo(worstCaseCallUsd(suite, textCase, GROK, 4000)!, 9)
    expect(worstCallUsd(suite, [GROK, OPENAI], 4000)).toBeCloseTo(worstCaseCallUsd(suite, pdfCase, OPENAI, 4000)!, 9)
  })
})

describe('providerPlanLines', () => {
  const suite = withoutPdfForGrok(fakeSuite(seeds(2, ['text', 'pdf'])))
  const infos = resolveModelSpecs('--models', [GROK, OPENAI])
  const lines = providerPlanLines({
    infos,
    env: { XAI_API_KEY: 'xai-key-12345678', OPENAI_API_KEY: 'sk-openai-12345678' },
    suite,
    estimate: estimateRun({ suite, models: [GROK, OPENAI], reps: 2 }),
    reps: 2,
    maxOutputTokens: 4000,
    efforts: ['max', 'bogus'],
    anthropicHost: 'api.anthropic.com',
  })
  const lineOf = (model: string) => lines.find((line) => line.startsWith(`  ${model}:`))!

  it('prints the worst case per model, not the typical cost twice', () => {
    for (const model of [GROK, OPENAI]) {
      const worst = worstModelUsd(suite, model, 4000, 2)
      expect(lineOf(model)).toContain(`worst case ${money(worst)}`)
    }
    const typical = estimateRun({ suite, models: [OPENAI], reps: 2 }).perModel[0]!.usd
    expect(lineOf(OPENAI)).toContain(`typical ${money(typical)}`)
    expect(worstModelUsd(suite, OPENAI, 4000, 2)!).toBeGreaterThan(typical!)
  })

  it('notes the soft cap for Grok only, the cases it leaves out, and a collapsed effort', () => {
    expect(lineOf(GROK)).toContain('soft cap')
    expect(lineOf(OPENAI)).not.toContain('soft cap')
    expect(lines.join('\n')).toContain('grok:grok-4.7 reads no PDF: 2 cases not run (n/a)')
    expect(lines.join('\n')).not.toContain('bogus')
    expect(lines.join('\n')).toContain('grok:grok-4.7: effort max runs as xhigh')
  })
})
