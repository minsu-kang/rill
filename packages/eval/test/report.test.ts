import { describe, expect, it } from 'vitest'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { INDICATIVE_BELOW, noiseFloorPoints, renderReport, type ReportMeta } from '../src/report'
import type { RunResult, TaskResult } from '../src/runner'
import { wilson } from '../src/stats'
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
  it('is the paired minimum detectable difference at the worst-case proportion', () => {
    const floor = noiseFloorPoints(36, 3)
    expect(floor.typical).toBeCloseTo(13.47, 2)
    expect(floor.worst).toBeCloseTo(23.33, 2)
    expect(noiseFloorPoints(100, 3).typical).toBeCloseTo(8.08, 2)
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

  it('computes the noise floor from the scored seeds and reps, not a constant', () => {
    expect(report).toContain('with 4 seeds and 2 reps')
    expect(report).toContain('smaller than about 49 points')
    expect(report).toContain('up to about 70 points')
    const bigger = renderReport({ run: run(grid({ seeds: 36, reps: 3, pass: () => true })), meta: { ...META, reps: 3 } })
    expect(bigger).toContain('with 36 seeds and 3 reps')
    expect(bigger).toContain('smaller than about 13 points')
    expect(bigger).toContain('up to about 23 points')
  })

  it('names an effort override and one seed in the singular', () => {
    const overridden = renderReport({ run: run(grid({ seeds: 1, reps: 1, pass: () => true })), meta: { ...META, effort: 'high', reps: 1 } })
    expect(overridden).toContain('- Effort: high (override; the node ships low)')
    expect(overridden).toContain('with 1 seed and 1 rep,')
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

  it('reports case pass with a Wilson interval and the counts', () => {
    const haiku = wilson(10, 16)
    expect(haiku).not.toBeNull()
    const line = row(report, 'Results by model', HAIKU)
    expect(line).toContain(`${(((haiku?.p ?? 0) * 100).toFixed(1))}% (${((haiku?.lo ?? 0) * 100).toFixed(1)}% to ${((haiku?.hi ?? 0) * 100).toFixed(1)}%), 10/16`)
    expect(line).toContain('62.5% (')
    expect(row(report, 'Results by model', SONNET)).toContain('100.0% (')
    expect(section(report, 'Results by model')).toContain('clustered')
    expect(section(report, 'Results by model')).toContain('Wilson 95%')
  })

  it('reports field accuracy per field', () => {
    const line = row(report, 'Results by model', HAIKU)
    expect(line.split('|').map((cell) => cell.trim())).toContain('62.5%')
    expect(line.split('|').map((cell) => cell.trim()).filter((cell) => cell === '100.0%')).toHaveLength(2)
    expect(row(report, 'Results by model', SONNET)).toMatch(/\| 100.0% \| 100.0% \| 100.0% \| 0.0% \|/)
  })

  it('reports pooled precision, recall, specificity, hallucination and miss rate', () => {
    const haiku = row(report, 'Precision, recall and the two ways to be wrong', HAIKU)
    expect(haiku).toBe(`| ${HAIKU} | 87.5% | 87.5% | n/a | n/a | 0.0% |`)
    expect(row(report, 'Precision, recall and the two ways to be wrong', SONNET)).toBe(`| ${SONNET} | 100.0% | 100.0% | n/a | n/a | 0.0% |`)
  })

  it('counts injection failures on any and the mean', () => {
    expect(row(report, 'Results by model', HAIKU)).toContain('| 1 of 8 failed (mean 0.88) |')
    expect(row(report, 'Results by model', SONNET)).toContain('| 1 of 8 failed (mean 0.88) |')
  })

  it('reports latency percentiles, mean tokens and cost', () => {
    const haiku = row(report, 'Latency, tokens and cost', HAIKU)
    expect(haiku).toBe(`| ${HAIKU} | 1.75 | 2.40 | 1000 | 100 | $0.0160 | $0.10 |`)
    const sonnet = row(report, 'Latency, tokens and cost', SONNET)
    expect(sonnet).toBe(`| ${SONNET} | 2.75 | 3.40 | 2000 | 300 | $0.16 | $1.00 |`)
  })

  it('calls a delta whose interval touches zero not distinguishable', () => {
    const line = row(report, 'Paired deltas on case pass', SONNET)
    expect(line).toBe(`| ${SONNET} | +37.5 points | +0.0 to +75.0 | not distinguishable | 4 seeds, 16 pairs |`)
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
    const tasks = grid({ seeds: 12, reps: 1, pass: (model) => model === SONNET })
    const report = renderReport({ run: run(tasks), meta: { ...META, reps: 1 } })
    const line = row(report, 'Paired deltas on case pass', SONNET)
    expect(line).toContain('+100.0 points')
    expect(line).toContain('| better |')
    expect(line).toContain('12 seeds, 24 pairs')
    expect(report).not.toContain('not distinguishable')
    expect(section(report, 'Paired deltas on case pass')).toContain(`Each model against ${HAIKU}`)
  })

  it('says not distinguishable when the interval contains zero', () => {
    const tasks = grid({ seeds: 12, reps: 1, pass: (model, seed) => (model === HAIKU ? seed % 2 === 0 : seed % 3 === 0) })
    const report = renderReport({ run: run(tasks), meta: { ...META, reps: 1 } })
    const line = row(report, 'Paired deltas on case pass', SONNET)
    expect(line).toContain('| not distinguishable |')
    expect(line).toMatch(/\| [+-]\d+\.\d points \| [+-]\d+\.\d to [+-]\d+\.\d \|/)
  })

  it('says worse when the second model is clearly behind and repeats for a given seed', () => {
    const tasks = grid({ seeds: 12, reps: 1, pass: (model) => model === HAIKU })
    const meta = { ...META, reps: 1 }
    const report = renderReport({ run: run(tasks), meta })
    expect(row(report, 'Paired deltas on case pass', SONNET)).toContain('-100.0 points')
    expect(row(report, 'Paired deltas on case pass', SONNET)).toContain('| worse |')
    expect(renderReport({ run: run(tasks), meta })).toBe(report)
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

  it('counts a refusal as no answer and a failed case, and leaves truncated rows out of the rate', () => {
    const line = row(report, 'Results by model', SONNET)
    expect(line).toContain('75.0% (')
    expect(line).toContain(', 3/4 |')
    expect(line).toContain('| 25.0% |')
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
    expect(text).not.toContain('| regex (baseline)')
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
    expect(report).toContain('with 3 seeds and 1 rep,')
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
    expect(row(report, 'Results by model', HAIKU)).toBe(`| ${HAIKU} | n/a | n/a | n/a | n/a | n/a | n/a |`)
    expect(row(report, 'Precision, recall and the two ways to be wrong', HAIKU)).toBe(`| ${HAIKU} | n/a | n/a | n/a | n/a | n/a |`)
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
