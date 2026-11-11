import { describe, expect, it } from 'vitest'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { INDICATIVE_BELOW, MIN_SEEDS_FOR_VERDICT, noiseFloorPoints, renderReport, type ReportMeta } from '../src/report'
import type { RunResult, TaskResult } from '../src/runner'
import { clusterBootstrapRatio } from '../src/stats'
import { ALL_TP, AMOUNT_WRONG, HAIKU, OPUS, SONNET, fakeTask, type FakeTaskInput } from './fake-run'

const META: ReportMeta = {
  suiteName: 'extract',
  suiteVersion: '1.1-aaaaaaaaaaaa-bbbbbbbbbbbb',
  createdAt: '2026-11-11T09:00:00.000Z',
  models: [HAIKU, SONNET],
  reps: 2,
  seed: 1,
  effort: undefined,
  priceTableAsOf: PRICE_TABLE_AS_OF,
  fallback: false,
  baselines: [],
}

function run(tasks: TaskResult<unknown>[], extra: Partial<RunResult<unknown>> = {}): RunResult<unknown> {
  return { tasks, spentUsd: 0, budgetUsd: undefined, ...extra }
}

function section(report: string, title: string): string {
  const start = report.indexOf(`## ${title}`)
  expect(start, `missing section ${title}`).toBeGreaterThanOrEqual(0)
  const next = report.indexOf('\n## ', start + 3)
  return report.slice(start, next < 0 ? undefined : next)
}

function row(report: string, title: string, first: string): string {
  const found = section(report, title)
    .split('\n')
    .find((line) => line.startsWith(`| ${first} |`))
  expect(found, `missing row ${first} in ${title}`).toBeDefined()
  return found as string
}

interface Grid {
  seeds: number
  reps: number
  kinds?: string[]
  category?: (seed: number) => string
  pass: (model: string, seed: number, kind: string, rep: number) => boolean
  models?: string[]
  extend?: (model: string, seed: number, kind: string, rep: number) => FakeTaskInput
}

function grid(spec: Grid): TaskResult<unknown>[] {
  const tasks: TaskResult<unknown>[] = []
  for (const model of spec.models ?? [HAIKU, SONNET]) {
    for (let seed = 1; seed <= spec.seeds; seed += 1) {
      for (const kind of spec.kinds ?? ['text', 'pdf']) {
        for (let rep = 0; rep < spec.reps; rep += 1) {
          tasks.push(
            fakeTask({
              group: `s${seed}`,
              kind,
              model,
              rep,
              category: spec.category?.(seed) ?? 'easy',
              outcomes: spec.pass(model, seed, kind, rep) ? ALL_TP : AMOUNT_WRONG,
              ...spec.extend?.(model, seed, kind, rep),
            }),
          )
        }
      }
    }
  }
  return tasks
}

describe('noiseFloorPoints', () => {
  it('is the paired minimum detectable difference at p 0.5 and correlation 0.5, conservative over seeds', () => {
    const floor = noiseFloorPoints(36, 3)
    expect(floor.conservative).toBeCloseTo(23.33, 2)
    expect(floor.optimistic).toBeCloseTo(13.47, 2)
    expect(noiseFloorPoints(100, 3).conservative).toBeCloseTo(14, 2)
  })
})

describe('renderReport: header', () => {
  const report = renderReport({ run: run(grid({ seeds: 4, reps: 2, pass: () => true })), meta: META })

  it('states the suite, date, models, reps, seed, effort and price table date', () => {
    expect(report).toContain('# Eval report: extract')
    expect(report).toContain('- Suite version: 1.1-aaaaaaaaaaaa-bbbbbbbbbbbb')
    expect(report).toContain('- Date: 2026-11-11T09:00:00.000Z')
    expect(report).toContain(`- Models: ${HAIKU}, ${SONNET}`)
    expect(report).toContain('- Reps per case: 2')
    expect(report).toContain('- Schedule seed: 1')
    expect(report).toContain('- Effort: low (as the node ships)')
    expect(report).toContain(`- Price table as of ${PRICE_TABLE_AS_OF}.`)
  })

  it('carries the caveats word for word', () => {
    expect(report).toContain('- Comparison: each model as the node ships it, at that effort. This is not a model-only comparison.')
    expect(report).toContain('- Refusal fallback: off for every model.')
    expect(report).toContain('- Data: synthetic clean receipts only. The results say nothing about photos, scans or real receipts.')
  })

  it('leads with the conservative noise floor from the scored seeds and states its assumptions', () => {
    expect(report).toContain('- Noise floor: about 70 points with 4 seeds.')
    expect(report).toContain('Optimistic bound: about 49 points, only if the 2 reps of every case were independent draws.')
    const bigger = renderReport({ run: run(grid({ seeds: 36, reps: 3, pass: () => true })), meta: { ...META, reps: 3 } })
    expect(bigger).toContain('- Noise floor: about 23 points with 36 seeds.')
    expect(bigger).toContain('Optimistic bound: about 13 points')
    for (const phrase of ['minimum detectable difference, not a significance threshold', '80% power', '5% level', 'pass rate near 50%', 'between-model correlation 0.5', 'clustered by seed']) {
      expect(bigger).toContain(phrase)
    }
  })

  it('treats an explicit low as the shipped setting', () => {
    const explicit = renderReport({ run: run(grid({ seeds: 1, reps: 1, pass: () => true })), meta: { ...META, effort: 'low', reps: 1 } })
    expect(explicit).toContain('- Effort: low (as the node ships)')
    expect(explicit).not.toContain('override')
  })

  it('names an effort override and one seed in the singular', () => {
    const overridden = renderReport({ run: run(grid({ seeds: 1, reps: 1, pass: () => true })), meta: { ...META, effort: 'high', reps: 1 } })
    expect(overridden).toContain('- Effort: high (override; the node ships low)')
    expect(overridden).toContain('about 140 points with 1 seed.')
    expect(overridden).toContain('the 1 rep of every case')
  })

  it('shows the fallback as on when it was on', () => {
    const meta = { ...META, fallback: true } as unknown as ReportMeta
    expect(renderReport({ run: run([]), meta })).toContain('- Refusal fallback: on for every model.')
  })
})

describe('renderReport: numbers', () => {
  const tasks = grid({
    seeds: 4,
    reps: 2,
    category: (seed) => (seed <= 2 ? 'easy' : 'tricky'),
    pass: (model, seed, kind) => (model === HAIKU ? !(seed === 1 || (seed === 4 && kind === 'pdf')) : true),
    extend: (model, seed, kind, rep) => ({
      latencyMs: (model === HAIKU ? 1000 : 2000) + rep * 1000 + seed * 100,
      usage: model === HAIKU ? { inputTokens: 1000, outputTokens: 100 } : { inputTokens: 2000, outputTokens: 300 },
      costUsd: model === HAIKU ? 0.001 : 0.01,
      ...(kind === 'text' && seed === 3 && rep === 0 ? { extra: { inject_ok: 0 } } : kind === 'text' ? { extra: { inject_ok: 1 } } : {}),
    }),
  })
  const report = renderReport({ run: run(tasks, { budgetUsd: 1, spentUsd: 0.1 }), meta: META })

  it('reports case pass with a seed-cluster bootstrap interval and the counts', () => {
    const haikuRows = tasks.filter((task) => task.model === HAIKU).map((task) => ({ group: task.group, num: Object.values(task.score?.outcomes ?? {}).every((outcome) => outcome === 'TP') ? 1 : 0, den: 1 }))
    const expected = clusterBootstrapRatio(haikuRows, { seed: META.seed, resamples: 4000 })
    const line = row(report, 'Results by model', HAIKU)
    expect(line).toContain(`62.5% (${((expected.lo ?? 0) * 100).toFixed(1)}% to ${((expected.hi ?? 0) * 100).toFixed(1)}%), 10/16`)
    expect(row(report, 'Results by model', SONNET)).toContain('100.0% (100.0% to 100.0%), 16/16')
    expect(section(report, 'Results by model')).toContain('seed-cluster bootstrap')
    expect(section(report, 'Results by model')).not.toContain('Wilson')
  })

  it('makes a seed-clustered interval wider than one that treats the calls as independent', () => {
    const correlated = clusterBootstrapRatio(
      Array.from({ length: 40 }, (_, index) => ({ group: `s${Math.floor(index / 4)}`, num: Math.floor(index / 4) % 2, den: 1 })),
      { seed: 1, resamples: 4000 },
    )
    const independent = clusterBootstrapRatio(Array.from({ length: 40 }, (_, index) => ({ group: `s${index}`, num: index % 2, den: 1 })), { seed: 1, resamples: 4000 })
    expect((correlated.hi ?? 0) - (correlated.lo ?? 0)).toBeGreaterThan(((independent.hi ?? 0) - (independent.lo ?? 0)) * 1.5)
  })

  it('reports field accuracy per field', () => {
    const line = row(report, 'Results by model', HAIKU)
    const cells = line.split('|').map((cell) => cell.trim())
    expect(cells[3]).toMatch(/^62\.5% \(/u)
    expect(cells[4]).toBe('100.0% (100.0% to 100.0%)')
    expect(cells[5]).toBe('100.0% (100.0% to 100.0%)')
    expect(row(report, 'Results by model', SONNET)).toContain('| 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | n/a | 0.0% |')
  })

  it('reports pooled precision, recall, specificity, hallucination and miss rate', () => {
    const haiku = row(report, 'Precision, recall and the two ways to be wrong', HAIKU)
    expect(haiku).toBe(`| ${HAIKU} | 87.5% | 87.5% | n/a | n/a | 0.0% | 0.0% |`)
    expect(row(report, 'Precision, recall and the two ways to be wrong', SONNET)).toBe(`| ${SONNET} | 100.0% | 100.0% | n/a | n/a | 0.0% | 0.0% |`)
  })

  it('counts injection failures, no answers and resisted cases', () => {
    expect(row(report, 'Results by model', HAIKU)).toContain('| inject_ok: 1 failed, 0 no answer, 7 resisted, of 8 |')
    expect(row(report, 'Results by model', SONNET)).toContain('| inject_ok: 1 failed, 0 no answer, 7 resisted, of 8 |')
  })

  it('reports latency percentiles, mean tokens and cost', () => {
    const haiku = row(report, 'Latency, tokens and cost', HAIKU)
    expect(haiku).toBe(`| ${HAIKU} | 1.75 | 2.40 | 1000 | 100 | $0.0160 | $0.10 |`)
    const sonnet = row(report, 'Latency, tokens and cost', SONNET)
    expect(sonnet).toBe(`| ${SONNET} | 2.75 | 3.40 | 2000 | 300 | $0.16 | $1.00 |`)
  })

  it('refuses to call a delta from four seeds', () => {
    const line = row(report, 'Paired deltas on case pass', SONNET)
    expect(line).toBe(`| ${SONNET} | +37.5 points | +0.0 to +75.0 | too few seeds to call | 4 seeds, 16 pairs |`)
  })

  it('shows the budget line', () => {
    expect(report).toContain('Budget: $1.00, spent $0.10.')
  })

  it('breaks down by difficulty and fixture kind with n, flagging n below 20 as indicative only', () => {
    expect(INDICATIVE_BELOW).toBe(20)
    expect(row(report, 'By difficulty', HAIKU)).toBe(`| ${HAIKU} | easy | 8 | 50.0% (4/8) | indicative only |`)
    const kinds = section(report, 'By fixture kind')
    expect(kinds).toContain(`| ${HAIKU} | pdf | 8 | 50.0% (4/8) | indicative only |`)
    expect(kinds).toContain(`| ${HAIKU} | text | 8 | 75.0% (6/8) | indicative only |`)
    expect(kinds).toContain(`| ${SONNET} | text | 8 | 100.0% (8/8) | indicative only |`)
  })

  it('drops the indicative note once n reaches 20', () => {
    const large = renderReport({ run: run(grid({ seeds: 10, reps: 1, pass: () => true, models: [HAIKU] })), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(row(large, 'By difficulty', HAIKU)).toBe(`| ${HAIKU} | easy | 20 | 100.0% (20/20) |  |`)
    const small = renderReport({ run: run(grid({ seeds: 9, reps: 1, pass: () => true, models: [HAIKU] })), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(row(small, 'By difficulty', HAIKU)).toContain('indicative only')
  })
})

describe('renderReport: paired deltas', () => {
  it('names a clear gap and keeps the interval off zero', () => {
    const tasks = grid({ seeds: 24, reps: 1, pass: (model) => model === SONNET })
    const report = renderReport({ run: run(tasks), meta: { ...META, reps: 1 } })
    const line = row(report, 'Paired deltas on case pass', SONNET)
    expect(line).toContain('+100.0 points')
    expect(line).toContain('| better |')
    expect(line).toContain('24 seeds, 48 pairs')
    expect(report).not.toContain('not distinguishable')
    expect(section(report, 'Paired deltas on case pass')).toContain(`Each model against ${HAIKU}`)
  })

  it('says not distinguishable when the interval contains zero', () => {
    const tasks = grid({ seeds: 48, reps: 1, pass: (model, seed) => (model === HAIKU ? seed % 2 === 0 : seed % 3 === 0) })
    const report = renderReport({ run: run(tasks), meta: { ...META, reps: 1 } })
    const line = row(report, 'Paired deltas on case pass', SONNET)
    expect(line).toContain('| not distinguishable |')
    expect(line).toMatch(/\| [+-]\d+\.\d points \| [+-]\d+\.\d to [+-]\d+\.\d \|/)
  })

  it('says worse when the second model is clearly behind and repeats for a given seed', () => {
    const tasks = grid({ seeds: 24, reps: 1, pass: (model) => model === HAIKU })
    const meta = { ...META, reps: 1 }
    const report = renderReport({ run: run(tasks), meta })
    expect(row(report, 'Paired deltas on case pass', SONNET)).toContain('-100.0 points')
    expect(row(report, 'Paired deltas on case pass', SONNET)).toContain('| worse |')
    expect(renderReport({ run: run(tasks), meta })).toBe(report)
  })

  it('says too few seeds below the minimum, even for a perfect split', () => {
    expect(MIN_SEEDS_FOR_VERDICT).toBe(20)
    const one = grid({ seeds: 1, reps: 1, kinds: ['text'], pass: (model) => model === SONNET })
    expect(row(renderReport({ run: run(one), meta: { ...META, reps: 1 } }), 'Paired deltas on case pass', SONNET)).toContain('| too few seeds to call |')
    const nineteen = grid({ seeds: 19, reps: 1, pass: (model) => model === SONNET })
    expect(row(renderReport({ run: run(nineteen), meta: { ...META, reps: 1 } }), 'Paired deltas on case pass', SONNET)).toContain('| too few seeds to call |')
  })

  it('says too few seeds when the interval is wider than the noise floor', () => {
    const noisy = grid({ seeds: 20, reps: 1, kinds: ['text'], pass: (model, seed) => (model === HAIKU ? seed % 2 === 0 : seed % 2 === 1) })
    const line = row(renderReport({ run: run(noisy), meta: { ...META, reps: 1 } }), 'Paired deltas on case pass', SONNET)
    expect(line).toContain('| too few seeds to call |')
  })

  it('compares every later model with the first and needs two models', () => {
    const three = grid({ seeds: 6, reps: 1, pass: () => true, models: [HAIKU, SONNET, OPUS] })
    const report = renderReport({ run: run(three), meta: { ...META, models: [HAIKU, SONNET, OPUS], reps: 1 } })
    expect(section(report, 'Paired deltas on case pass')).toContain(`| ${SONNET} |`)
    expect(section(report, 'Paired deltas on case pass')).toContain(`| ${OPUS} |`)
    const single = renderReport({ run: run(grid({ seeds: 2, reps: 1, pass: () => true, models: [HAIKU] })), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(section(single, 'Paired deltas on case pass')).toContain('Needs at least two models.')
  })
})

describe('renderReport: rep agreement', () => {
  it('counts the cases whose graded outcome was the same on every rep', () => {
    const tasks = grid({
      seeds: 4,
      reps: 3,
      kinds: ['text'],
      models: [HAIKU],
      pass: () => true,
      extend: (_model, seed, _kind, rep) => ({
        output: { amount: 5, date: null, vendor: rep === 0 ? 'Kiso Ramen' : 'KISO RAMEN' },
        ...(seed === 2 && rep === 1 ? { outcomes: AMOUNT_WRONG } : {}),
      }),
    })
    const report = renderReport({ run: run(tasks), meta: { ...META, models: [HAIKU], reps: 3 } })
    expect(row(report, 'Rep agreement', HAIKU)).toBe(`| ${HAIKU} | 4 | 75.0% (3/4) |`)
  })

  it('needs two reps and ignores truncated calls', () => {
    const single = renderReport({ run: run(grid({ seeds: 2, reps: 1, pass: () => true, models: [HAIKU] })), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(row(single, 'Rep agreement', HAIKU)).toBe(`| ${HAIKU} | 0 | n/a |`)
    const truncated = [
      fakeTask({ group: 'a', rep: 0 }),
      fakeTask({ group: 'a', rep: 1, status: 'truncated', failureClass: 'truncated' }),
    ]
    expect(row(renderReport({ run: run(truncated), meta: { ...META, models: [HAIKU] } }), 'Rep agreement', HAIKU)).toBe(`| ${HAIKU} | 0 | n/a |`)
  })

  it('counts a refusal on one rep as a disagreement', () => {
    const tasks = [fakeTask({ group: 'a', rep: 0 }), fakeTask({ group: 'a', rep: 1, status: 'refused', failureClass: 'refusal' })]
    expect(row(renderReport({ run: run(tasks), meta: { ...META, models: [HAIKU] } }), 'Rep agreement', HAIKU)).toBe(`| ${HAIKU} | 1 | 0.0% (0/1) |`)
  })
})

describe('renderReport: errors, truncation and the budget', () => {
  const tasks = [
    ...grid({ seeds: 3, reps: 1, kinds: ['text'], pass: () => true }),
    fakeTask({
      group: 's9',
      model: HAIKU,
      status: 'failed',
      failureClass: 'overloaded',
      attempts: 3,
      failedAttempts: [1, 2, 3].map((attempt) => ({ attempt, failureClass: 'overloaded' as const, message: 'busy' })),
      latencyMs: undefined,
    }),
    fakeTask({ group: 's8', model: SONNET, status: 'refused', failureClass: 'refusal' }),
    fakeTask({ group: 's7', model: SONNET, status: 'truncated', failureClass: 'truncated', rep: 1 }),
    fakeTask({ group: 's6', model: HAIKU, status: 'ok', failedAttempts: [{ attempt: 1, failureClass: 'rate_limit', message: '429' }], attempts: 2 }),
    fakeTask({ group: 's5', model: HAIKU, status: 'skipped' }),
    fakeTask({ group: 's5', model: SONNET, status: 'skipped' }),
  ]
  const report = renderReport({ run: run(tasks), meta: META })

  it('counts failure classes per model and says how each is treated', () => {
    const errors = section(report, 'Errors')
    expect(errors).toContain(`| Failure class | ${HAIKU} | ${SONNET} | Treated as |`)
    expect(errors).toContain('| overloaded | 3 | 0 | infrastructure, excluded |')
    expect(errors).toContain('| rate_limit | 1 | 0 | infrastructure, excluded |')
    expect(errors).toContain('| refusal | 0 | 1 | graded outcome |')
    expect(errors).toContain('| truncated | 0 | 1 | graded outcome |')
  })

  it('counts failed calls and the tasks skipped by the budget', () => {
    expect(section(report, 'Errors')).toContain('- Calls that failed after all attempts: 1 (no score, left out of every number).')
    expect(section(report, 'Errors')).toContain('- Tasks skipped because of the budget: 2.')
  })

  it('puts a PARTIAL RUN notice at the top with completed and skipped tasks per model', () => {
    const lines = report.split('\n')
    expect(lines[2]).toMatch(/^> \*\*PARTIAL RUN\*\*/u)
    expect(lines[2]).toContain(`${HAIKU} 5 completed, 1 skipped; ${SONNET} 5 completed, 1 skipped`)
    const stopped = renderReport({ run: run(tasks, { stop: 'budget', partial: true }), meta: META })
    expect(stopped).toContain('the budget ran out')
    const clean = renderReport({ run: run(grid({ seeds: 2, reps: 1, pass: () => true })), meta: { ...META, reps: 1 } })
    expect(clean).not.toContain('PARTIAL RUN')
  })

  it('counts a refusal as no answer and a failed case, and leaves truncated rows out of the rate', () => {
    const line = row(report, 'Results by model', SONNET)
    expect(line).toContain('75.0% (')
    expect(line).toContain(', 3/4 |')
    expect(line).toContain('| 25.0% |')
    expect(row(report, 'Precision, recall and the two ways to be wrong', SONNET)).toMatch(/\| 25\.0% \|$/u)
  })

  it('leaves a truncated call out of the latency and token means', () => {
    const base = grid({ seeds: 2, reps: 1, kinds: ['text'], pass: () => true, models: [HAIKU] })
    const withTruncated = [...base, fakeTask({ group: 's9', model: HAIKU, status: 'truncated', failureClass: 'truncated', latencyMs: 600_000, usage: { inputTokens: 90_000, outputTokens: 90_000 } })]
    const meta = { ...META, models: [HAIKU], reps: 1 }
    const line = row(renderReport({ run: run(withTruncated), meta }), 'Latency, tokens and cost', HAIKU)
    expect(line).toBe(row(renderReport({ run: run(base), meta }), 'Latency, tokens and cost', HAIKU).replace('$0.0020 | $0.10', '$0.0030 | $0.15'))
    expect(line).toContain('| 1.00 | 1.00 | 1000 | 100 |')
  })

  it('lists the truncated rows that were excluded', () => {
    const truncated = section(report, 'Truncated rows')
    expect(truncated).toContain('1 row left out of every mean')
    expect(truncated).toContain(`- s7:text rep 1 (${SONNET})`)
  })

  it('says so when nothing went wrong', () => {
    const clean = renderReport({ run: run(grid({ seeds: 2, reps: 1, pass: () => true })), meta: { ...META, reps: 1 } })
    expect(section(clean, 'Errors')).toContain('No failed attempts and no refusals.')
    expect(section(clean, 'Errors')).toContain('- Tasks skipped because of the budget: 0.')
    expect(section(clean, 'Truncated rows')).toContain('None.')
  })
})

describe('renderReport: baselines', () => {
  const base = [
    ...grid({ seeds: 3, reps: 1, pass: () => true, models: [HAIKU] }),
    ...grid({ seeds: 3, reps: 1, pass: () => true, models: ['oracle'] }),
    ...grid({
      seeds: 3,
      reps: 1,
      pass: () => false,
      models: ['all-null'],
      extend: () => ({ outcomes: { amount: 'MISS', date: 'MISS', vendor: 'MISS' } }),
    }),
  ]

  it('shows baselines as separate rows labelled baseline, below the models', () => {
    const report = renderReport({ run: run(base), meta: { ...META, models: [HAIKU], reps: 1, baselines: ['all-null', 'oracle', 'regex'] } })
    const text = section(report, 'Baselines')
    expect(text).toContain('| oracle (baseline) | 100.0% (6/6) | 100.0% | 100.0% | n/a | n/a | 0.0% |')
    expect(text).toContain('| all-null (baseline) | 0.0% (0/6) | n/a | 0.0% | n/a | n/a | 100.0% |')
    expect(text).not.toContain('| regex (')
    const regex = grid({ seeds: 3, reps: 1, kinds: ['text'], pass: () => true, models: ['regex'] })
    const labelled = renderReport({ run: run([...base, ...regex]), meta: { ...META, models: [HAIKU], reps: 1, baselines: ['all-null', 'oracle', 'regex'], baselineNotes: { regex: 'text only' } } })
    expect(section(labelled, 'Baselines')).toContain('| regex (text only) | 100.0% (3/3) |')
    expect(report.indexOf('## Baselines')).toBeGreaterThan(report.indexOf('## Results by model'))
    expect(section(report, 'Results by model')).not.toContain('oracle')
    expect(section(report, 'Results by model')).not.toContain('all-null')
  })

  it('leaves the section out when no baseline ran', () => {
    const report = renderReport({ run: run(grid({ seeds: 2, reps: 1, pass: () => true, models: [HAIKU] })), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(report).not.toContain('## Baselines')
  })

  it('renders a baselines-only run', () => {
    const report = renderReport({
      run: run(grid({ seeds: 3, reps: 1, pass: () => true, models: ['oracle'] })),
      meta: { ...META, models: [], reps: 1, baselines: ['oracle'] },
    })
    expect(report).toContain('- Models: (none, baselines only)')
    expect(report).toContain('No model under test in this run.')
    expect(report).toContain('| oracle (baseline) | 100.0% (6/6) |')
    expect(report).toContain('about 81 points with 3 seeds.')
  })
})

describe('renderReport: gold suspects', () => {
  const tasks = grid({
    seeds: 4,
    reps: 2,
    pass: (model, seed, kind, rep) => !(seed === 1 && kind === 'text') && !(seed === 2 && kind === 'pdf' && model === HAIKU) && !(seed === 3 && kind === 'pdf' && rep === 0 && model === SONNET),
  })

  it('lists cases every model missed on every rep, and only those', () => {
    const report = renderReport({ run: run(tasks), meta: META })
    const suspects = section(report, 'Gold suspects')
    expect(suspects).toContain('| s1:text | 4 | amount | ')
    expect(suspects).toContain(`${HAIKU}, ${SONNET} |`)
    expect(suspects).not.toContain('s2:pdf')
    expect(suspects).not.toContain('s3:pdf')
    expect(suspects).not.toContain('s4:')
    expect(suspects).toContain('Read these first')
  })

  it('ignores baselines, truncated rows and failed calls when looking for suspects', () => {
    const extra = [
      ...tasks,
      ...grid({ seeds: 4, reps: 2, pass: () => true, models: ['oracle'] }),
      fakeTask({ group: 's4', kind: 'text', model: HAIKU, status: 'truncated', failureClass: 'truncated', rep: 7 }),
      fakeTask({ group: 's4', kind: 'pdf', model: SONNET, status: 'failed', failureClass: 'overloaded', rep: 7 }),
    ]
    const report = renderReport({ run: run(extra), meta: { ...META, baselines: ['oracle'] } })
    expect(section(report, 'Gold suspects')).toContain('s1:text')
    expect(section(report, 'Gold suspects')).not.toContain('s4:')
  })

  it('says so when there is none', () => {
    const report = renderReport({ run: run(grid({ seeds: 2, reps: 1, pass: () => true })), meta: { ...META, reps: 1 } })
    expect(section(report, 'Gold suspects')).toContain('No case was missed by every model on every rep.')
  })
})

describe('renderReport: degenerate runs', () => {
  it('renders a run with no success at all', () => {
    const tasks = [HAIKU, SONNET].flatMap((model) =>
      [1, 2].map((seed) =>
        fakeTask({
          group: `s${seed}`,
          model,
          status: 'failed',
          failureClass: 'auth',
          attempts: 1,
          failedAttempts: [{ attempt: 1, failureClass: 'auth', message: '401' }],
          latencyMs: undefined,
          costUsd: 0,
        }),
      ),
    )
    const report = renderReport({ run: run(tasks), meta: META })
    expect(report).toContain('- Noise floor: n/a, no call was scored.')
    expect(row(report, 'Results by model', HAIKU)).toBe(`| ${HAIKU} | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`)
    expect(row(report, 'Precision, recall and the two ways to be wrong', HAIKU)).toBe(`| ${HAIKU} | n/a | n/a | n/a | n/a | n/a | n/a |`)
    expect(row(report, 'Latency, tokens and cost', HAIKU)).toBe(`| ${HAIKU} | n/a | n/a | n/a | n/a | $0.0000 | n/a |`)
    expect(section(report, 'Paired deltas on case pass')).toContain('no paired rows')
    expect(section(report, 'Errors')).toContain('| auth | 2 | 2 | infrastructure, excluded |')
    expect(section(report, 'Errors')).toContain('- Calls that failed after all attempts: 4')
    expect(section(report, 'Gold suspects')).toContain('No case was missed')
  })

  it('renders an empty run', () => {
    const report = renderReport({ run: run([]), meta: META })
    expect(report).toContain('## Errors')
    expect(report).toContain('- Tasks skipped because of the budget: 0.')
  })

  it('shows n/a for cost when a model has no price', () => {
    const tasks = grid({ seeds: 2, reps: 1, pass: () => true, models: ['mystery-model'], extend: () => ({ costUsd: undefined }) })
    const report = renderReport({ run: run(tasks), meta: { ...META, models: ['mystery-model'], reps: 1 } })
    const line = row(report, 'Latency, tokens and cost', 'mystery-model')
    expect(line).toBe('| mystery-model | 1.00 | 1.00 | 1000 | 100 | n/a | n/a |')
  })

  it('shows n/a for the cost of only the unpriced model', () => {
    const tasks = [
      ...grid({ seeds: 2, reps: 1, pass: () => true, models: [HAIKU] }),
      ...grid({ seeds: 2, reps: 1, pass: () => true, models: ['mystery-model'], extend: () => ({ costUsd: undefined }) }),
    ]
    const report = renderReport({ run: run(tasks), meta: { ...META, models: [HAIKU, 'mystery-model'], reps: 1 } })
    expect(row(report, 'Latency, tokens and cost', HAIKU)).toContain('| $0.0040 | $0.10 |')
    expect(row(report, 'Latency, tokens and cost', 'mystery-model')).toContain('| n/a | n/a |')
  })

  it('is a pure function of its input: same input, same text, and the date comes from the meta', () => {
    const input = { run: run(grid({ seeds: 3, reps: 2, pass: (_m, seed) => seed !== 2 })), meta: META }
    expect(renderReport(input)).toBe(renderReport(input))
    const later = renderReport({ ...input, meta: { ...META, createdAt: '2030-01-01T00:00:00.000Z' } })
    expect(later).toContain('- Date: 2030-01-01T00:00:00.000Z')
    expect(later.replace('2030-01-01T00:00:00.000Z', META.createdAt)).toBe(renderReport(input))
  })
})

describe('renderReport: injection and vendor partial cells', () => {
  it('counts refused or invalid adversarial calls as no answer, apart from failures and resisted cases', () => {
    const adversarial = { category: 'adversarial' }
    const tasks = [
      fakeTask({ group: 'a1', ...adversarial, extra: { inject_ok: 0 } }),
      fakeTask({ group: 'a2', ...adversarial, extra: { inject_ok: 1 } }),
      fakeTask({ group: 'a3', ...adversarial, extra: { inject_ok: 1 } }),
      fakeTask({ group: 'a4', ...adversarial, status: 'refused', failureClass: 'refusal' }),
      fakeTask({ group: 'a5', ...adversarial, status: 'schema_failed', failureClass: 'invalid_output' }),
      fakeTask({ group: 'e1', status: 'refused', failureClass: 'refusal' }),
    ]
    const report = renderReport({ run: run(tasks), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(row(report, 'Results by model', HAIKU)).toContain('| inject_ok: 1 failed, 2 no answer, 2 resisted, of 5 |')
  })

  it('shows how many wrong vendors were partial matches and their mean overlap', () => {
    const vendorWrong = { amount: 'TP', date: 'TP', vendor: 'WRONG' } as const
    const tasks = [
      { ...fakeTask({ group: 'a', outcomes: vendorWrong }), score: { status: 'ok' as const, outcomes: vendorWrong, extra: {}, partial: { vendor: 0.5 } } },
      { ...fakeTask({ group: 'b', outcomes: vendorWrong }), score: { status: 'ok' as const, outcomes: vendorWrong, extra: {}, partial: { vendor: 0 } } },
      fakeTask({ group: 'c' }),
    ]
    const report = renderReport({ run: run(tasks), meta: { ...META, models: [HAIKU], reps: 1 } })
    expect(row(report, 'Results by model', HAIKU)).toContain('| 1 of 2 wrong (mean overlap 0.50) |')
    expect(section(report, 'Results by model')).toContain('exact or alias')
  })
})
