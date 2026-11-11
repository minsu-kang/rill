import { reestimate, type PilotData, type PilotSample, type Reestimate, type SampleOutcome } from '../src/reestimate'
import type { EvalCase, Suite } from '../src/suite'
import { SONNET } from './fake-run'

export interface PlanCase {
  group: string
  kind: string
}

export function fakeSuite(cases: readonly PlanCase[], inputs: Readonly<Record<string, number>> | null = { text: 800, pdf: 2400, png: 2000 }, version = 'v-now'): Suite<EvalCase, unknown> {
  const list: EvalCase[] = cases.map((entry) => ({ id: `${entry.group}:${entry.kind}`, group: entry.group, category: 'easy', tags: [], kind: entry.kind }))
  return {
    name: 'extract',
    version,
    fields: ['amount', 'date', 'vendor'],
    cases: () => list,
    run: () => Promise.reject(new Error('not used')),
    score: () => {
      throw new Error('not used')
    },
    ...(inputs === null ? {} : { estimateInputTokens: (testCase: EvalCase) => inputs[testCase.kind] ?? 0 }),
  }
}

export function seeds(count: number, kinds: readonly string[]): PlanCase[] {
  return Array.from({ length: count }, (_, index) => kinds.map((kind) => ({ group: `g${index + 1}`, kind }))).flat()
}

export function sample(model: string, kind: string, input: number, output: number, outcome: SampleOutcome = 'ok', group = 'g1'): PilotSample {
  return { model, kind, group, outcome, usage: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
}

export function pilotOf(samples: PilotSample[], overrides: Partial<PilotData> = {}): PilotData {
  return { source: 'results', suiteVersion: 'v-now', effort: 'low', maxOutputTokens: 4000, partialRun: false, failed: 0, skipped: 0, withoutUsage: 0, samples, ...overrides }
}

export function runReestimate(
  suite: Suite<EvalCase, unknown>,
  samples: PilotSample[],
  options: { models?: string[]; reps?: number; concurrency?: number; maxOutputTokens?: number; pilot?: Partial<PilotData> } = {},
): Reestimate {
  return reestimate({
    suite,
    pilot: pilotOf(samples, options.pilot),
    models: options.models ?? [SONNET],
    reps: options.reps ?? 1,
    concurrency: options.concurrency ?? 4,
    maxOutputTokens: options.maxOutputTokens ?? 4000,
  })
}

export function cellOf(result: Reestimate, model: string, kind: string) {
  const cell = result.models.find((entry) => entry.model === model)?.cells.find((entry) => entry.kind === kind)
  if (cell === undefined) throw new Error(`no cell for ${model} ${kind}`)
  return cell
}
