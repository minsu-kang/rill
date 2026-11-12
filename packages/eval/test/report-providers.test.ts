import { describe, expect, it } from 'vitest'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { renderReport, type ReportMeta } from '../src/report'
import { effortLines, groupByProvider, notRunSection, providerLines, showProviders, softCapMark } from '../src/provider-report'
import type { RunResult, TaskResult } from '../src/runner'
import { oraclePlanner } from '../src/suites/planner/fakes'
import { renderPlannerReport, type PlannerReportMeta } from '../src/suites/planner/report'
import { fakeTask } from './fake-run'
import { runFake } from './planner-helpers'

const HAIKU = 'claude-haiku-5-5'
const GPT = 'openai:gpt-6.1-sol'
const GROK = 'grok:grok-4.7'
const GEMINI = 'gemini:gemini-3.8-flash'
const GPT_LUNA = 'openai:gpt-6-luna'

describe('provider grouping helpers', () => {
  it('groups models by provider in the order the providers first appear, keeping the model order inside a group', () => {
    expect(groupByProvider([GPT, HAIKU, GROK, GPT_LUNA, GEMINI])).toEqual([GPT, GPT_LUNA, HAIKU, GROK, GEMINI])
    expect(groupByProvider([HAIKU, 'claude-sonnet-5-5'])).toEqual([HAIKU, 'claude-sonnet-5-5'])
  })

  it('shows the provider column only for a run that is not Claude alone', () => {
    expect(showProviders([HAIKU, 'claude-sonnet-5-5'])).toBe(false)
    expect(showProviders([HAIKU, GPT])).toBe(true)
    expect(showProviders([GPT])).toBe(true)
  })

  it('names the providers and marks the soft cap ones in the header', () => {
    expect(providerLines([HAIKU, 'claude-sonnet-5-5'])).toEqual([])
    const lines = providerLines([GPT, GPT_LUNA, GROK])
    expect(lines.join('\n')).toContain('- Providers: openai (gpt-6.1-sol, gpt-6-luna), grok (grok-4.7)')
    expect(lines.join('\n')).toMatch(/grok:grok-4\.7.*soft cap/)
    expect(lines.join('\n')).not.toMatch(/openai:gpt-6\.1-sol.*soft cap/)
  })

  it('marks a cost as soft cap only for a model whose reasoning is not capped', () => {
    expect(softCapMark(GROK, '$0.0123')).toBe('$0.0123 (soft cap)')
    expect(softCapMark(GROK, 'n/a')).toBe('n/a')
    expect(softCapMark(GPT, '$0.0123')).toBe('$0.0123')
    expect(softCapMark(HAIKU, '$0.0123')).toBe('$0.0123')
  })

  it('shows the effective effort and marks the models that collapse it', () => {
    expect(effortLines([HAIKU, GPT], 'xhigh')).toEqual([])
    const lines = effortLines([GPT, 'gemini:gemini-3.8-flash', 'grok:grok-4.5', 'grok:grok-4.7'], 'xhigh').join('\n')
    expect(lines).toContain('gemini:gemini-3.8-flash high (collapsed from xhigh)')
    expect(lines).toContain('grok:grok-4.5 high (collapsed from xhigh)')
    expect(lines).not.toContain('grok:grok-4.7 high')
    expect(lines).toContain('grok:grok-4.7 xhigh')
    expect(effortLines([GPT, GROK], 'high')).toEqual([])
    expect(effortLines([GPT], undefined)).toEqual([])
  })

  it('lists the pairs that did not run, by model, with the reason', () => {
    const run: RunResult<unknown> = { tasks: [], spentUsd: 0, budgetUsd: undefined, notRun: [{ caseId: 'a:pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF files' }, { caseId: 'b:pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF files' }] }
    const text = notRunSection(run).join('\n')
    expect(text).toContain('## Not run (n/a)')
    expect(text).toContain('| grok:grok-4.7 | 2 | grok:grok-4.7 reads no PDF files |')
    expect(notRunSection({ ...run, notRun: undefined })).toEqual([])
  })
})

const META: ReportMeta = {
  suiteName: 'extract',
  suiteVersion: 'v-test',
  createdAt: '2026-11-13T09:00:00.000Z',
  models: [HAIKU, GPT, GROK],
  reps: 1,
  seed: 1,
  effort: undefined,
  priceTableAsOf: PRICE_TABLE_AS_OF,
  fallback: false,
  baselines: [],
}

function tasksFor(models: readonly string[]): TaskResult<unknown>[] {
  return models.flatMap((model) => [1, 2, 3].map((seed) => fakeTask({ model, group: `s${seed}`, kind: 'text', costUsd: 0.01 })))
}

describe('the extract report across providers', () => {
  const run: RunResult<unknown> = {
    tasks: tasksFor([GPT, HAIKU, GROK]),
    spentUsd: 0.09,
    budgetUsd: 1,
    notRun: [{ caseId: 's1:pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF files' }],
  }
  const report = renderReport({ run, meta: META })

  it('names the providers in the header and groups the results table by provider', () => {
    expect(report).toContain('- Providers: anthropic (claude-haiku-5-5), openai (gpt-6.1-sol), grok (grok-4.7)')
    const results = report.slice(report.indexOf('## Results by model'), report.indexOf('## Precision'))
    expect(results).toContain('| Provider | Model |')
    const order = results.split('\n').filter((line) => /^\| (anthropic|openai|grok) \|/.test(line)).map((line) => line.split('|')[1]!.trim())
    expect(order).toEqual(['anthropic', 'openai', 'grok'])
  })

  it('marks the cost of a model whose hidden reasoning is not capped as soft cap', () => {
    const performance = report.slice(report.indexOf('## Latency, tokens and cost'), report.indexOf('## By difficulty'))
    const grok = performance.split('\n').find((line) => line.startsWith(`| ${GROK} |`))!
    expect(grok).toContain('(soft cap)')
    const openai = performance.split('\n').find((line) => line.startsWith(`| ${GPT} |`))!
    expect(openai).not.toContain('soft cap')
  })

  it('lists what did not run for a model and is not marked partial for it', () => {
    expect(report).toContain('## Not run (n/a)')
    expect(report).toContain('| grok:grok-4.7 | 1 | grok:grok-4.7 reads no PDF files |')
    expect(report).not.toContain('PARTIAL RUN')
  })

  it('stays as it was for a run of Claude models alone', () => {
    const claude: ReportMeta = { ...META, models: [HAIKU, 'claude-sonnet-5-5'] }
    const plain = renderReport({ run: { tasks: tasksFor([HAIKU, 'claude-sonnet-5-5']), spentUsd: 0, budgetUsd: undefined }, meta: claude })
    expect(plain).not.toContain('Provider')
    expect(plain).not.toContain('Not run')
    expect(plain).not.toContain('soft cap')
    expect(plain).toContain('| Model | Case pass (95% CI) |')
  })
})

describe('the planner report across providers', () => {
  const META_PLANNER: PlannerReportMeta = { ...META, suiteName: 'planner', models: [HAIKU, GROK], maxRepairRounds: 3, maxOutputTokens: 16_000 }

  it('groups by provider, marks the soft cap and lists the cases a model could not take', async () => {
    const fake = await runFake(oraclePlanner, {}, [GROK, HAIKU])
    expect(fake.run.notRun?.length).toBeGreaterThan(0)
    const report = renderPlannerReport({ run: fake.run, meta: META_PLANNER })
    expect(report).toContain('- Providers: anthropic (claude-haiku-5-5), grok (grok-4.7)')
    expect(report).toContain('| Provider | Model |')
    expect(report).toContain('## Not run (n/a)')
    expect(report).toMatch(/\| grok:grok-4\.7 \| \d+ \| grok:grok-4\.7 reads no PDF files \|/)
    const performance = report.slice(report.indexOf('## Latency, calls and cost'), report.indexOf('## By category'))
    expect(performance.split('\n').find((line) => line.startsWith(`| ${GROK} |`))).toContain('(soft cap)')
  })
})
