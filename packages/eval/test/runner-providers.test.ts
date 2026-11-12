import { openaiDescriptor, type LlmProvider, type LlmResult } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { replyOf as openaiReply } from '../../llm/test/openai-wire'
import { createFakeTransport } from '../../llm/test/fake-transport'
import { costUsd, estimateCallUsd } from '../src/pricing'
import { createRecorder, zeroUsage, type EvalProvider } from '../src/record'
import { SOFT_CAP_RESERVE_FACTOR } from '../src/spec'
import { buildSchedule, estimateRun, runEval, unsupportedPairs, worstCaseCallUsd } from '../src/runner'
import type { EvalCase, Suite } from '../src/suite'

interface Case extends EvalCase {
  needsPdf: boolean
}

const cases: Case[] = [
  { id: 'a:text', group: 'a', category: 'easy', tags: [], kind: 'text', needsPdf: false },
  { id: 'a:pdf', group: 'a', category: 'easy', tags: [], kind: 'pdf', needsPdf: true },
]

function suite(extra: Partial<Suite<Case, string>> = {}): Suite<Case, string> {
  return {
    name: 'fake',
    version: '1',
    fields: ['x'],
    cases: () => cases,
    run: async () => 'out',
    score: () => ({ status: 'ok', outcomes: { x: 'TP' }, extra: {} }),
    estimateInputTokens: () => 1000,
    unsupportedReason: (testCase, model) => (testCase.needsPdf && model.startsWith('grok:') ? 'grok:grok-4.7 reads no PDF' : undefined),
    ...extra,
  }
}

const GROK = 'grok:grok-4.7'
const OPENAI = 'openai:gpt-6.1-sol'
const HAIKU = 'claude-haiku-5-5'

describe('cases a model cannot take', () => {
  it('lists the pairs the suite says a model cannot take', () => {
    expect(unsupportedPairs(suite(), [GROK, OPENAI])).toEqual([{ caseId: 'a:pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF' }])
    expect(unsupportedPairs(suite({ unsupportedReason: undefined }), [GROK])).toEqual([])
  })

  it('leaves them out of the schedule', () => {
    const entries = buildSchedule({ cases, models: [GROK, OPENAI], reps: 2, seed: 1, supported: (testCase, model) => !(testCase.needsPdf && model === GROK) })
    expect(entries).toHaveLength(6)
    expect(entries.filter((entry) => entry.model === GROK).map((entry) => entry.testCase.id)).toEqual(['a:text', 'a:text'])
  })

  it('counts them out of the estimate and reports them', () => {
    const estimate = estimateRun({ suite: suite(), models: [GROK, OPENAI], reps: 2 })
    expect(estimate.calls).toBe(6)
    expect(estimate.perModel.find((entry) => entry.model === GROK)).toMatchObject({ calls: 2, notRun: 1 })
    expect(estimate.perModel.find((entry) => entry.model === OPENAI)).toEqual({ model: OPENAI, calls: 4, usd: expect.any(Number) })
  })

  it('does not run them, does not mark the run partial and records them as not run', async () => {
    const created: string[] = []
    const result = await runEval({
      suite: suite(),
      models: [GROK, OPENAI],
      reps: 1,
      concurrency: 1,
      seed: 1,
      createProvider: (model): EvalProvider => {
        created.push(model)
        const provider: LlmProvider = {
          name: 'fake',
          generate: async (): Promise<LlmResult> => ({ data: {}, usage: zeroUsage(), model, requestedModel: model, stopReason: 'end_turn', durationMs: 0, fallbackUsed: false }),
        }
        return { provider, recorder: createRecorder() }
      },
    })
    expect(result.tasks).toHaveLength(3)
    expect(result.tasks.some((task) => task.caseId === 'a:pdf' && task.model === GROK)).toBe(false)
    expect(result.partial).toBe(false)
    expect(result.notRun).toEqual([{ caseId: 'a:pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF' }])
    expect(created.filter((model) => model === GROK)).toHaveLength(1)
  })

  it('leaves notRun out when every pair runs', async () => {
    const result = await runEval({
      suite: suite({ unsupportedReason: undefined }),
      models: [HAIKU],
      reps: 1,
      concurrency: 1,
      seed: 1,
      createProvider: (): EvalProvider => ({ provider: { name: 'fake', generate: async () => ({ data: {}, usage: zeroUsage(), model: HAIKU, requestedModel: HAIKU, stopReason: 'end_turn', durationMs: 0, fallbackUsed: false }) }, recorder: createRecorder() }),
    })
    expect(result.notRun).toBeUndefined()
  })
})

describe('the budget reserve for a soft cap', () => {
  it('multiplies the output part for a model whose reasoning max tokens do not cap', () => {
    const plain = estimateCallUsd(GROK, 1000, 16_000)!
    const soft = estimateCallUsd(GROK, 1000, 16_000 * SOFT_CAP_RESERVE_FACTOR)!
    expect(worstCaseCallUsd(suite(), cases[0]!, GROK, 16_000)).toBe(soft)
    expect(soft).toBeGreaterThan(plain)
  })

  it('leaves a capped model as it was', () => {
    expect(worstCaseCallUsd(suite(), cases[0]!, OPENAI, 16_000)).toBe(estimateCallUsd(OPENAI, 1000, 16_000))
    expect(worstCaseCallUsd(suite(), cases[0]!, HAIKU, 16_000)).toBe(estimateCallUsd(HAIKU, 1000, 16_000))
  })
})

describe('a run through a provider with a spec', () => {
  it('prices the spec, and does not call a reply of the bare model id a mismatch', async () => {
    const transport = createFakeTransport()
    transport.script(openaiReply(false, 'completed', '{"a":1}'))
    const result = await runEval({
      suite: suite({
        unsupportedReason: undefined,
        cases: () => [cases[0]!],
        run: async (_testCase, ctx) => {
          await ctx.provider.generate({ messages: [], schema: {} })
          return 'out'
        },
      }),
      models: [OPENAI],
      reps: 1,
      concurrency: 1,
      seed: 1,
      budgetUsd: 1,
      createProvider: (): EvalProvider => {
        const recorder = createRecorder(transport.fetch, undefined, openaiDescriptor.exchange)
        const provider: LlmProvider = {
          name: 'openai',
          generate: async (): Promise<LlmResult> => {
            await recorder.fetch('https://example.test', { method: 'POST', body: JSON.stringify({ max_output_tokens: 1000 }) })
            return { data: {}, usage: zeroUsage(), model: 'gpt-6.1-sol', requestedModel: 'gpt-6.1-sol', stopReason: 'end_turn', durationMs: 0, fallbackUsed: false }
          },
        }
        return { provider, recorder }
      },
    })
    const [task] = result.tasks
    expect(task?.status).toBe('ok')
    expect(task?.failureClass).toBeUndefined()
    expect(task?.costUsd).toBeCloseTo(costUsd(OPENAI, { inputTokens: 9300, outputTokens: 1450, cacheReadInputTokens: 300, cacheCreationInputTokens: 200 })!, 12)
    expect(task?.usage.inputTokens).toBe(9300)
  })

  it('runs with a budget for a spec that has a price and refuses one that has none', async () => {
    const attempt = (model: string) =>
      runEval({ suite: suite({ unsupportedReason: undefined }), models: [model], reps: 1, concurrency: 1, seed: 1, budgetUsd: 1, createProvider: () => ({ provider: { name: 'x', generate: async () => { throw new Error('no') } }, recorder: createRecorder() }) })
    await expect(attempt('openai:gpt-9')).rejects.toThrow('cannot enforce a budget without a price for: openai:gpt-9')
  })
})
