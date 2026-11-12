import { findModel, type LlmCapabilities, type LlmProvider, type LlmResult } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { guardReserveUsd, worstCallUsd } from '../src/budget'
import { estimateCallUsd } from '../src/pricing'
import { zeroUsage } from '../src/record'
import { SOFT_CAP_RESERVE_FACTOR } from '../src/spec'
import { createExtractSuite } from '../src/suites/extract/suite'
import { effortMaxTokens, firstCallInputTokens, plannerWorstCaseUsd, worstCallInputTokens, worstCaseCalls } from '../src/suites/planner/budget'
import { createPlannerSuite } from '../src/suites/planner/suite'
import { runEval } from '../src/runner'
import { createRecorder } from '../src/record'

const GROK = 'grok:grok-4.7'
const GEMINI = 'gemini:gemini-3.8-flash'
const OPENAI = 'openai:gpt-6.1-sol'
const HAIKU = 'claude-haiku-5-5'

function providerWith(name: string, capabilities: LlmCapabilities | undefined, onRequest: () => void = () => undefined): LlmProvider {
  return {
    name,
    ...(capabilities === undefined ? {} : { capabilities }),
    generate: async (): Promise<LlmResult> => {
      onRequest()
      return { data: { amount: 1, date: '2026-01-01', vendor: 'V' }, usage: zeroUsage(), model: 'x', requestedModel: 'x', stopReason: 'end_turn', durationMs: 0, fallbackUsed: false }
    },
  }
}

describe('the extract suite and provider capabilities', () => {
  const suite = createExtractSuite({ only: 'easy-ko-cafe-yeonnam' })
  const byKind = (kind: string) => suite.cases().find((testCase) => testCase.kind === kind)!

  it('leaves a PDF case out for a model that reads no PDF and says why', () => {
    expect(suite.unsupportedReason?.(byKind('pdf'), GROK)).toMatch(/PDF/)
    expect(suite.unsupportedReason?.(byKind('pdf'), GROK)).toContain(GROK)
  })

  it('keeps text and PNG cases for that model, and every case for the others', () => {
    for (const model of [GROK, GEMINI, OPENAI, HAIKU]) {
      expect(suite.unsupportedReason?.(byKind('text'), model)).toBeUndefined()
      expect(suite.unsupportedReason?.(byKind('png'), model)).toBeUndefined()
    }
    for (const model of [GEMINI, OPENAI, HAIKU, 'meta:muse-spark-1.3']) expect(suite.unsupportedReason?.(byKind('pdf'), model)).toBeUndefined()
  })

  it('hands the provider capabilities on to the node, so a PDF is refused before any request', async () => {
    let sent = 0
    const provider = providerWith('grok', findModel(GROK)!.capabilities, () => (sent += 1))
    await expect(suite.run(byKind('pdf'), { provider, signal: new AbortController().signal })).rejects.toThrow(/cannot read a PDF with the grok provider/)
    expect(sent).toBe(0)
    await expect(suite.run(byKind('png'), { provider, signal: new AbortController().signal })).resolves.toBeDefined()
    expect(sent).toBe(1)
  })

  it('runs only the cases a model can take', async () => {
    const created: string[] = []
    const result = await runEval({
      suite,
      models: [GROK],
      reps: 1,
      concurrency: 1,
      seed: 1,
      createProvider: (model) => {
        created.push(model)
        return { provider: providerWith('grok', findModel(GROK)!.capabilities), recorder: createRecorder() }
      },
    })
    expect(result.tasks.map((task) => task.kind).sort()).toEqual(['png', 'text'])
    expect(result.notRun?.map((entry) => entry.caseId)).toEqual([byKind('pdf').id])
  })

  it('leaves the worst case of a run out of the cases that do not run', () => {
    const pdfOnly = { ...suite, cases: () => [byKind('pdf')] }
    expect(worstCallUsd(pdfOnly, [GROK], 16_000)).toBe(0)
    expect(worstCallUsd(pdfOnly, [GEMINI], 16_000)).toBeGreaterThan(0)
    expect(guardReserveUsd(worstCallUsd(pdfOnly, [GROK], 16_000), 4, 1)).toBe(0)
  })
})

describe('the planner suite and provider capabilities', () => {
  const suite = createPlannerSuite()
  const caseOf = (id: string) => suite.cases().find((testCase) => testCase.id === id)!
  const pdfCase = caseOf('attach-01-sample-pdf-extract-to-csv')
  const pngCase = caseOf('attach-02-sample-png-english')
  const textCase = caseOf('attach-04-text-injection-outside-path')

  it('leaves a case with a PDF attachment out for a model that reads no PDF', () => {
    expect(suite.unsupportedReason?.(pdfCase, GROK)).toMatch(/PDF/)
    expect(suite.unsupportedReason?.(pdfCase, GEMINI)).toBeUndefined()
    expect(suite.unsupportedReason?.(pngCase, GROK)).toBeUndefined()
    expect(suite.unsupportedReason?.(textCase, GROK)).toBeUndefined()
    expect(suite.unsupportedReason?.(suite.cases()[0]!, GROK)).toBeUndefined()
  })

  it('hands the provider capabilities to the planner, which refuses the PDF before any request', async () => {
    let sent = 0
    const provider = providerWith('grok', findModel(GROK)!.capabilities, () => (sent += 1))
    await expect(suite.run(pdfCase, { provider, signal: new AbortController().signal })).rejects.toThrow(/PDF/)
    expect(sent).toBe(0)
  })

  it('reserves more for a soft-cap model in the worst case of a case', () => {
    const first = firstCallInputTokens(pdfCase.spec, [], 1000)
    const maxOut = effortMaxTokens('medium')
    const input = worstCallInputTokens(first, 3, maxOut)
    expect(plannerWorstCaseUsd(OPENAI, first, 3, maxOut)).toBeCloseTo(estimateCallUsd(OPENAI, input, maxOut)! * worstCaseCalls(3), 12)
    expect(plannerWorstCaseUsd(GROK, first, 3, maxOut)).toBeCloseTo(estimateCallUsd(GROK, input, maxOut * SOFT_CAP_RESERVE_FACTOR)! * worstCaseCalls(3), 12)
  })
})
