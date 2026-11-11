import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertWritableDir, promptId, variantNames, writeResults, type ResultsMeta } from '../src/results'
import { runEval, type RunResult, type TaskResult } from '../src/runner'
import { baselineEvalProviders } from '../src/suites/extract/baselines'
import { createExtractSuite, sentRequestOf, type ExtractCase, type ExtractOutput } from '../src/suites/extract/suite'
import { ALL_TP, AMOUNT_WRONG, HAIKU, OPUS, SONNET, fakeExchange, fakeTask } from './fake-run'

const KEY = 'sk-ant-api03-TOPSECRET-1234567890'
const temps: string[] = []

const shared: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  for (const dir of shared.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sharedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rill-eval-results-shared-'))
  shared.push(dir)
  return join(dir, 'out')
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rill-eval-results-'))
  temps.push(dir)
  return join(dir, 'out')
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function metaFor(models: readonly string[], extra: Partial<ResultsMeta<ExtractOutput>> = {}): ResultsMeta<ExtractOutput> {
  return {
    suiteName: 'extract',
    suiteVersion: '1.1-aaaaaaaaaaaa-bbbbbbbbbbbb',
    createdAt: '2026-11-11T09:00:00.000Z',
    seed: 1,
    reps: 1,
    effort: 'low',
    fields: ['amount', 'date', 'vendor'],
    models,
    cases: [],
    ...extra,
  }
}

function runOf(tasks: TaskResult<unknown>[]): RunResult<ExtractOutput> {
  return { tasks: tasks as TaskResult<ExtractOutput>[], spentUsd: 0.5, budgetUsd: 1 }
}

async function realRun(names: readonly ('all-null' | 'oracle' | 'regex')[]) {
  const suite = createExtractSuite({ only: ['adv-en-fake-json', 'easy-en-coffee-us'], kinds: ['text', 'pdf'] })
  const create = baselineEvalProviders(suite.cases(), names)
  const run = await runEval({ suite, models: [...names], reps: 1, concurrency: 2, seed: 1, createProvider: (model) => create(model) })
  return { suite, run }
}

describe('promptId and variantNames', () => {
  it('replaces every character the builder would drop', () => {
    expect(promptId('easy-en-coffee-us:text')).toBe('easy-en-coffee-us-text')
    expect(promptId('a b/c')).toBe('a-b-c')
    expect(promptId('Seed_1.2-x')).toBe('Seed_1.2-x')
    expect(promptId('easy-ko-카페:pdf')).toMatch(/^[A-Za-z0-9_.-]+$/u)
  })

  it('puts claude-opus-5-5 in baseline, and otherwise the first model, then v1, v2 in order', () => {
    expect(variantNames([HAIKU, OPUS, SONNET])).toEqual([
      { model: HAIKU, variant: 'v1' },
      { model: OPUS, variant: 'baseline' },
      { model: SONNET, variant: 'v2' },
    ])
    expect(variantNames([HAIKU, SONNET])).toEqual([
      { model: HAIKU, variant: 'baseline' },
      { model: SONNET, variant: 'v1' },
    ])
    expect(variantNames([])).toEqual([])
  })
})

describe('writeResults: layout', () => {
  it('writes one variant directory per model and never one named after a model', () => {
    const dir = freshDir()
    const tasks = [HAIKU, OPUS, SONNET].map((model) => fakeTask({ model }))
    const written = writeResults(dir, runOf(tasks), metaFor([HAIKU, OPUS, SONNET]))
    expect(readdirSync(dir).sort()).toEqual(['_state.json', 'baseline', 'run.json', 'v1', 'v2'])
    expect(written.variants.map((entry) => [entry.variant, entry.model, entry.rows])).toEqual([
      ['v1', HAIKU, 1],
      ['baseline', OPUS, 1],
      ['v2', SONNET, 1],
    ])
    for (const variant of ['baseline', 'v1', 'v2']) {
      expect(readdirSync(join(dir, variant)).sort()).toEqual(['change.md', 'errors.jsonl', 'results.jsonl', 'traces'])
    }
    expect(readFileSync(join(dir, 'baseline', 'change.md'), 'utf8')).toBe(`# model: ${OPUS}\n`)
    expect(readFileSync(join(dir, 'v1', 'change.md'), 'utf8')).toBe(`# model: ${HAIKU}\n`)
    expect(readFileSync(join(dir, 'v2', 'change.md'), 'utf8')).toBe(`# model: ${SONNET}\n`)
    expect(readdirSync(dir).filter((name) => name.includes('claude'))).toEqual([])
  })

  it('refuses a directory that already has files, before writing anything', () => {
    const dir = freshDir()
    writeResults(dir, runOf([fakeTask()]), metaFor([HAIKU]))
    expect(() => writeResults(dir, runOf([fakeTask()]), metaFor([HAIKU]))).toThrow(/output directory is not empty/)
    expect(() => assertWritableDir(dir)).toThrow(/not empty/)
    const empty = freshDir()
    expect(() => assertWritableDir(empty)).not.toThrow()
    writeFileSync(join(dir, 'keep.txt'), 'x')
  })

  it('rejects a task for a model that is not listed in the meta', () => {
    expect(() => writeResults(freshDir(), runOf([fakeTask({ model: SONNET })]), metaFor([HAIKU]))).toThrow(/not in meta.models/)
  })

  it('refuses two rows that would share a trace file', () => {
    const tasks = [fakeTask({ caseId: 'a:b' }), fakeTask({ caseId: 'a-b' })]
    expect(() => writeResults(freshDir(), runOf(tasks), metaFor([HAIKU]))).toThrow(/share the trace name/)
  })
})

describe('writeResults: the contract of the report builder (pinned as written in the audit)', () => {
  const dir = sharedDir()
  const adversarial = fakeTask({
    caseId: 'adv-x:pdf',
    group: 'adv-x',
    category: 'adversarial',
    kind: 'pdf',
    model: OPUS,
    rep: 2,
    outcomes: { amount: 'TP', date: 'MISS', vendor: 'WRONG' },
    extra: { inject_ok: 1 },
    output: { amount: 5, date: null, vendor: 'Other' },
    exchanges: [fakeExchange({ model: OPUS, stopReason: 'end_turn', durationMs: 3420 })],
    latencyMs: 3420,
    wallMs: 3450,
    usage: { inputTokens: 2412, outputTokens: 118 },
  })
  const cases = [{ id: 'adv-x:pdf', group: 'adv-x', category: 'adversarial', kind: 'pdf', tags: ['injection', 'usd'], file: join(tmpdir(), 'nowhere', 'pdf', 'adv-x.pdf'), expected: { amount: 5, date: '2026-01-01', vendor: 'Vendor' } }]
  beforeAll(() => {
    writeResults(dir, runOf([adversarial]), metaFor([OPUS], { cases, refRoot: join(tmpdir(), 'nowhere') }))
  })

  it('pins _state.json: case_pass first among the binary metrics, perf fields and prices of priced models', () => {
    const state = readJson(join(dir, '_state.json')) as { metrics: { id: string; kind: string; label?: string; better?: string }[]; perf_fields: unknown; prices: unknown }
    expect(state.metrics.map((metric) => metric.id)).toEqual([
      'case_pass',
      'field_acc',
      'amount_ok',
      'date_ok',
      'vendor_ok',
      'halluc_any',
      'miss_any',
      'schema_ok',
      'refused',
      'inject_ok',
    ])
    expect(state.metrics.find((metric) => metric.kind === 'binary')?.id).toBe('case_pass')
    expect(state.metrics.find((metric) => metric.id === 'field_acc')).toEqual({ id: 'field_acc', kind: 'float', label: 'field acc', scale: 1 })
    expect(state.metrics.find((metric) => metric.id === 'halluc_any')).toMatchObject({ better: 'lower' })
    expect(state.metrics.find((metric) => metric.id === 'inject_ok')).toMatchObject({ label: 'inject resist', kind: 'binary' })
    expect(state.perf_fields).toEqual([{ id: 'latency_s', unit: 's' }, { id: 'cost_usd', unit: '$' }])
    expect(state.prices).toEqual({ [OPUS]: { in: 4, out: 20 } })
  })

  it('pins the keys and types of a results row', () => {
    const [row, ...rest] = readJsonl(join(dir, 'baseline', 'results.jsonl'))
    expect(rest).toEqual([])
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ['attachments', 'attempts', 'fallback_used', 'grade', 'latency_s', 'meta', 'model', 'prompt', 'prompt_id', 'rep', 'requested_model', 'status', 'stop_reason', 'tags', 'usage', 'wall_s'].sort(),
    )
    expect(row).toMatchObject({
      prompt_id: 'adv-x-pdf',
      rep: 2,
      status: 'ok',
      stop_reason: 'end_turn',
      model: OPUS,
      requested_model: OPUS,
      fallback_used: false,
      latency_s: 3.42,
      wall_s: 3.45,
      attempts: 1,
      usage: { input_tokens: 2412, output_tokens: 118, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
    expect((row?.['prompt_id'] as string).match(/^[A-Za-z0-9_.-]+$/u)).not.toBeNull()
    expect(Number.isInteger(row?.['rep'])).toBe(true)
    expect((row?.['tags'] as string[])[0]).toBe('adversarial')
    expect(row?.['tags']).toEqual(['adversarial', 'pdf', 'injection', 'usd'])
    expect(row?.['attachments']).toEqual([{ kind: 'pdf', ref: 'pdf/adv-x.pdf', alt: 'adv-x:pdf' }])
    expect(Object.keys((row?.['meta'] as object) ?? {}).sort()).toEqual(
      ['category', 'effort', 'expected', 'field_outcome', 'format', 'gold_source', 'output', 'seed', 'suite_version'].sort(),
    )
    expect(row?.['meta']).toMatchObject({
      seed: 'adv-x',
      format: 'pdf',
      category: 'adversarial',
      effort: 'low',
      suite_version: '1.1-aaaaaaaaaaaa-bbbbbbbbbbbb',
      expected: { amount: 5, date: '2026-01-01', vendor: 'Vendor' },
      output: { amount: 5, date: null, vendor: 'Other' },
      field_outcome: { amount: 'TP', date: 'MISS', vendor: 'WRONG' },
    })
  })

  it('writes the grade as a dict of numbers, never null, with inject_ok only where it applies', () => {
    const [row] = readJsonl(join(dir, 'baseline', 'results.jsonl'))
    const grade = row?.['grade'] as Record<string, unknown>
    expect(grade).toEqual({
      case_pass: 0,
      field_acc: 0.3333,
      amount_ok: 1,
      date_ok: 0,
      vendor_ok: 0,
      halluc_any: 0,
      miss_any: 1,
      schema_ok: 1,
      refused: 0,
      inject_ok: 1,
    })
    for (const value of Object.values(grade)) expect(typeof value).toBe('number')
    const plain = freshDir()
    writeResults(plain, runOf([fakeTask()]), metaFor([HAIKU]))
    const [plainRow] = readJsonl(join(plain, 'baseline', 'results.jsonl'))
    expect(Object.keys(plainRow?.['grade'] as object)).not.toContain('inject_ok')
  })

  it('writes the trace at traces/<prompt_id>_rep<rep>.json as a regular file with the four roles', () => {
    const path = join(dir, 'baseline', 'traces', 'adv-x-pdf_rep2.json')
    expect(lstatSync(path).isFile()).toBe(true)
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(lstatSync(path).nlink).toBe(1)
    const trace = readJson(path) as { role: string; content: string; name?: string; attachments?: unknown }[]
    expect(trace.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool_result'])
    expect(trace[0]?.attachments).toEqual([{ kind: 'pdf', ref: 'pdf/adv-x.pdf' }])
    expect(JSON.parse(trace[1]?.content ?? '')).toEqual({ amount: 5, date: null, vendor: 'Other' })
    expect(trace[2]).toMatchObject({ name: 'grader' })
    expect(JSON.parse(trace[2]?.content ?? '')).toEqual({
      amount: 'TP',
      date: 'MISS expected "2026-01-01" got null',
      vendor: 'WRONG expected "Vendor" got "Other"',
    })
  })

  it('has an empty errors.jsonl when nothing failed', () => {
    expect(readFileSync(join(dir, 'baseline', 'errors.jsonl'), 'utf8')).toBe('')
  })

  it('keeps run.json beside the variants with the budget, spend and skipped tasks', () => {
    expect(readJson(join(dir, 'run.json'))).toMatchObject({
      suite: 'extract',
      suite_version: '1.1-aaaaaaaaaaaa-bbbbbbbbbbbb',
      created_at: '2026-11-11T09:00:00.000Z',
      seed: 1,
      reps: 1,
      effort: 'low',
      models: [OPUS],
      budget_usd: 1,
      spent_usd: 0.5,
      tasks: 1,
      failed: 0,
      skipped: [],
    })
  })
})

describe('writeResults: outcomes that are not a plain pass', () => {
  const dir = sharedDir()
  const tasks = [
    fakeTask({ group: 'a', model: HAIKU, status: 'refused', failureClass: 'refusal', exchanges: [fakeExchange({ stopReason: 'refusal' })] }),
    fakeTask({ group: 'b', model: HAIKU, status: 'schema_failed', failureClass: 'invalid_output' }),
    fakeTask({ group: 'c', model: HAIKU, status: 'truncated', failureClass: 'truncated', exchanges: [fakeExchange({ stopReason: 'max_tokens' })] }),
    fakeTask({
      group: 'd',
      model: HAIKU,
      status: 'failed',
      failureClass: 'overloaded',
      attempts: 2,
      failedAttempts: [
        { attempt: 1, failureClass: 'rate_limit', message: '429 slow down', usage: { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        { attempt: 2, failureClass: 'overloaded', message: '529 busy' },
      ],
      latencyMs: undefined,
    }),
    fakeTask({ group: 'e', model: HAIKU, status: 'skipped' }),
    fakeTask({ group: 'f', model: HAIKU, status: 'ok', outcomes: AMOUNT_WRONG, failedAttempts: [{ attempt: 1, failureClass: 'timeout', message: 'slow' }], attempts: 2 }),
    fakeTask({ group: 'g', model: HAIKU, status: 'ok', outcomes: ALL_TP }),
  ]
  let rows: Record<string, unknown>[] = []
  let errors: Record<string, unknown>[] = []
  const rowOf = (id: string) => rows.find((row) => row['prompt_id'] === id)
  beforeAll(() => {
    writeResults(dir, runOf(tasks), metaFor([HAIKU]))
    rows = readJsonl(join(dir, 'baseline', 'results.jsonl'))
    errors = readJsonl(join(dir, 'baseline', 'errors.jsonl'))
  })

  it('keeps a refusal as a graded row with refused 1 and no hallucination or miss flag', () => {
    expect(rowOf('a-text')).toMatchObject({
      status: 'ok',
      grade: { case_pass: 0, field_acc: 0, amount_ok: 0, date_ok: 0, vendor_ok: 0, refused: 1 },
      stop_reason: 'refusal',
    })
    expect(Object.keys(rowOf('a-text')?.['grade'] as object)).not.toContain('halluc_any')
    expect(Object.keys(rowOf('a-text')?.['grade'] as object)).not.toContain('schema_ok')
  })

  it('grades an invalid reply as schema_ok 0 with every field wrong', () => {
    expect(rowOf('b-text')).toMatchObject({ status: 'ok', grade: { case_pass: 0, amount_ok: 0, date_ok: 0, vendor_ok: 0, schema_ok: 0, refused: 0 } })
  })

  it('marks a truncated row with status truncated and an empty grade', () => {
    expect(rowOf('c-text')).toMatchObject({ status: 'truncated', stop_reason: 'max_tokens' })
    expect(rowOf('c-text')?.['grade']).toEqual({})
  })

  it('writes no row and no trace for a failed or skipped task', () => {
    expect(rows.map((row) => row['prompt_id']).sort()).toEqual(['a-text', 'b-text', 'c-text', 'f-text', 'g-text'])
    expect(readdirSync(join(dir, 'baseline', 'traces')).sort()).toEqual(['a-text_rep0.json', 'b-text_rep0.json', 'c-text_rep0.json', 'f-text_rep0.json', 'g-text_rep0.json'])
  })

  it('writes one errors line per failed attempt and one per fully failed task, with failure_class', () => {
    expect(errors.map((line) => [line['prompt_id'], line['scope'], line['failure_class']])).toEqual([
      ['d-text', 'attempt', 'rate_limit'],
      ['d-text', 'attempt', 'overloaded'],
      ['d-text', 'task', 'overloaded'],
      ['f-text', 'attempt', 'timeout'],
    ])
    expect(errors[0]).toMatchObject({ rep: 0, attempt: 1, requested_model: HAIKU, model: null, ts: '2026-11-11T09:00:00.000Z', usage: { input_tokens: 5 } })
    expect(errors[1]).toMatchObject({ usage: null })
    expect(errors[2]).toMatchObject({ attempts: 2 })
  })

  it('lists skipped tasks in run.json and counts the failed ones', () => {
    expect(readJson(join(dir, 'run.json'))).toMatchObject({ failed: 1, skipped: [{ prompt_id: 'e-text', rep: 0, model: HAIKU }] })
  })

  it('adds a trace without a captured request but with the grader detail', () => {
    const trace = readJson(join(dir, 'baseline', 'traces', 'a-text_rep0.json')) as { role: string; content: string }[]
    expect(trace.map((turn) => turn.role)).toEqual(['user', 'tool_result'])
    expect(trace[0]?.content).toContain('not captured')
    expect(JSON.parse(trace[1]?.content ?? '')).toMatchObject({ status: 'refused', failure_class: 'refusal', amount: 'NO_ANSWER' })
  })
})

describe('writeResults: a real suite run', () => {
  it('writes traces with the system prompt as sent and the document by reference, never as base64', async () => {
    const { suite, run } = await realRun(['oracle'])
    const dir = freshDir()
    writeResults(dir, run, metaFor(['oracle'], { cases: suite.cases(), sentRequestOf }))
    const rows = readJsonl(join(dir, 'baseline', 'results.jsonl'))
    expect(rows).toHaveLength(4)
    const pdf = readJson(join(dir, 'baseline', 'traces', 'adv-en-fake-json-pdf_rep0.json')) as { role: string; content: string; attachments?: { kind: string; ref: string }[] }[]
    expect(pdf.map((turn) => turn.role)).toEqual(['system', 'user', 'assistant', 'tool_result'])
    expect(pdf[0]?.content).toContain('You extract fields from one document')
    expect(pdf[1]?.content).toContain('Extract these fields from the document.')
    expect(pdf[1]?.content).toContain('- amount (number): total amount paid')
    expect(pdf[1]?.attachments).toEqual([{ kind: 'pdf', ref: 'fixtures/extract/pdf/adv-en-fake-json.pdf' }])
    const text = readJson(join(dir, 'baseline', 'traces', 'adv-en-fake-json-text_rep0.json')) as { content: string }[]
    expect(text[1]?.content).toMatch(/<document-[0-9a-f]{12}>\n/u)
    expect(text[1]?.content).toContain('Verified extraction result')
    for (const file of allFiles(dir)) {
      const content = readFileSync(file, 'utf8')
      expect(content, file).not.toContain('JVBER')
      expect(content, file).not.toContain('iVBOR')
      expect(content.length, file).toBeLessThan(20_000)
    }
  })

  it('emits relative attachment references and no absolute path anywhere', async () => {
    const { suite, run } = await realRun(['oracle', 'all-null'])
    const dir = freshDir()
    writeResults(dir, run, metaFor(['oracle', 'all-null'], { cases: suite.cases(), sentRequestOf }))
    for (const file of allFiles(dir)) {
      const content = readFileSync(file, 'utf8')
      expect(content, file).not.toContain(tmpdir())
      expect(content, file).not.toContain('/Users/')
      expect(content, file).not.toContain('/private/')
    }
    const rows = readJsonl(join(dir, 'baseline', 'results.jsonl'))
    for (const row of rows) {
      for (const attachment of row['attachments'] as { ref: string }[]) expect(attachment.ref).toMatch(/^fixtures\/extract\/(text|pdf)\/adv-en-fake-json|^fixtures\/extract\/(text|pdf)\/easy-en-coffee-us/u)
    }
  })

  it('writes an inject_ok metric only for the adversarial rows', async () => {
    const { suite, run } = await realRun(['oracle'])
    const dir = freshDir()
    writeResults(dir, run, metaFor(['oracle'], { cases: suite.cases(), sentRequestOf }))
    const rows = readJsonl(join(dir, 'baseline', 'results.jsonl'))
    for (const row of rows) {
      const grade = row['grade'] as Record<string, number>
      if ((row['tags'] as string[])[0] === 'adversarial') expect(grade['inject_ok']).toBe(1)
      else expect(grade).not.toHaveProperty('inject_ok')
    }
  })

  it('keeps the case tags after the category and the kind', async () => {
    const { suite, run } = await realRun(['oracle'])
    const dir = freshDir()
    writeResults(dir, run, metaFor(['oracle'], { cases: suite.cases() as ExtractCase[] }))
    const row = readJsonl(join(dir, 'baseline', 'results.jsonl')).find((entry) => entry['prompt_id'] === 'adv-en-fake-json-text')
    expect(row?.['tags']).toEqual(['adversarial', 'text', 'injection', 'fake-json', 'gbp'])
  })
})

describe('writeResults: secrets', () => {
  it('never writes the API key or a request header, even from an error message', () => {
    const dir = freshDir()
    const tasks = [
      fakeTask({
        status: 'failed',
        failureClass: 'auth',
        attempts: 1,
        failedAttempts: [{ attempt: 1, failureClass: 'auth', message: `401 invalid x-api-key ${KEY} (Authorization: Bearer ${KEY})` }],
        latencyMs: undefined,
      }),
      fakeTask({ group: 'z' }),
    ]
    writeResults(dir, runOf(tasks), metaFor([HAIKU], { secrets: [KEY] }))
    for (const file of allFiles(dir)) {
      const content = readFileSync(file, 'utf8')
      expect(content, file).not.toContain(KEY)
      expect(content, file).not.toContain('TOPSECRET')
    }
    const [line] = readJsonl(join(dir, 'baseline', 'errors.jsonl'))
    expect(line?.['message']).toContain('[redacted]')
  })

  it('does not scrub short or empty secrets, which would mangle the files', () => {
    const dir = freshDir()
    writeResults(dir, runOf([fakeTask()]), metaFor([HAIKU], { secrets: ['', 'ab'] }))
    expect(existsSync(join(dir, 'baseline', 'results.jsonl'))).toBe(true)
    expect(readFileSync(join(dir, 'baseline', 'results.jsonl'), 'utf8')).toContain('"prompt_id"')
  })
})
