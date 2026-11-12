import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeResults, type ResultsMeta } from '../src/results'
import type { RunResult, TaskResult } from '../src/runner'
import type { ExtractOutput } from '../src/suites/extract/suite'
import { HAIKU, fakeExchange, fakeTask } from './fake-run'

const GPT = 'openai:gpt-6.1-sol'
const GROK = 'grok:grok-4.7'
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rill-eval-results-providers-'))
  temps.push(dir)
  return join(dir, 'out')
}

const meta = (models: readonly string[]): ResultsMeta<ExtractOutput> => ({
  suiteName: 'extract',
  suiteVersion: 'v-test',
  createdAt: '2026-11-13T09:00:00.000Z',
  seed: 1,
  reps: 1,
  effort: 'low',
  fields: ['amount', 'date', 'vendor'],
  models,
  cases: [],
})

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const jsonl = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('results for provider:model specs', () => {
  const tasks = [
    fakeTask({ model: HAIKU, group: 's1' }),
    fakeTask({ model: GPT, group: 's1', exchanges: [fakeExchange({ model: 'gpt-6.1-sol' })] }),
    fakeTask({ model: GROK, group: 's1' }),
  ]
  const run: RunResult<ExtractOutput> = {
    tasks: tasks as TaskResult<ExtractOutput>[],
    spentUsd: 0.1,
    budgetUsd: 1,
    notRun: [{ caseId: 's1:pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF files' }],
  }

  it('carries the provider and the model of every row, and the model asked for', () => {
    const dir = fresh()
    const written = writeResults(dir, run, meta([HAIKU, GPT, GROK]))
    const variantOf = (model: string) => written.variants.find((variant) => variant.model === model)!
    const gpt = jsonl(join(variantOf(GPT).dir, 'results.jsonl'))[0]!
    expect(gpt['provider']).toBe('openai')
    expect(gpt['requested_model']).toBe(GPT)
    expect(gpt['model']).toBe('gpt-6.1-sol')
    expect(jsonl(join(variantOf(HAIKU).dir, 'results.jsonl'))[0]!['provider']).toBe('anthropic')
    expect(jsonl(join(variantOf(GROK).dir, 'results.jsonl'))[0]!['provider']).toBe('grok')
  })

  it('prices the specs in the state file and names providers and not-run cases in run.json', () => {
    const dir = fresh()
    writeResults(dir, run, meta([HAIKU, GPT, GROK]))
    const state = json(join(dir, '_state.json'))
    expect(Object.keys(state['prices'] as object)).toEqual([HAIKU, GPT, GROK])
    const summary = json(join(dir, 'run.json'))
    expect(summary['providers']).toEqual({ [HAIKU]: 'anthropic', [GPT]: 'openai', [GROK]: 'grok' })
    expect(summary['not_run']).toEqual([{ prompt_id: 's1-pdf', model: GROK, reason: 'grok:grok-4.7 reads no PDF files' }])
    expect(summary['partial']).toBe(false)
  })

  it('leaves out not_run when every case ran', () => {
    const dir = fresh()
    writeResults(dir, { ...run, notRun: undefined }, meta([HAIKU, GPT, GROK]))
    expect(json(join(dir, 'run.json'))).not.toHaveProperty('not_run')
  })
})
