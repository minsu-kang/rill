import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PilotDirError, readPilot } from '../src/pilot'
import { appendPartial } from '../src/results'
import { HAIKU, OPUS, SONNET, fakeTask } from './fake-run'
import { PILOT_SUITE_VERSION, writePilotDir, type PilotRow } from './pilot-dir'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rill-eval-pilot-'))
  temps.push(dir)
  return dir
}

function freshDir(): string {
  return join(freshRoot(), 'out')
}

const ROWS: PilotRow[] = [
  { model: HAIKU, kind: 'text', group: 'easy-ko', input: 700, output: 150 },
  { model: HAIKU, kind: 'pdf', group: 'easy-ko', input: 2300, output: 220 },
  { model: SONNET, kind: 'text', group: 'easy-ko', input: 650, output: 320 },
  { model: SONNET, kind: 'png', group: 'tricky-en', input: 1900, output: 4000, status: 'truncated' },
  { model: OPUS, kind: 'text', group: 'adv-en', input: 640, output: 25, status: 'refused' },
  { model: OPUS, kind: 'pdf', group: 'adv-en', input: 2290, output: 80, status: 'schema_failed' },
]

describe('readPilot: a finished results directory', () => {
  it('reads one sample per row with the requested model, kind, seed, outcome and billed usage', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    const pilot = readPilot(dir)
    expect(pilot.source).toBe('results')
    expect(pilot.samples).toHaveLength(6)
    const byKey = Object.fromEntries(pilot.samples.map((entry) => [`${entry.model}|${entry.kind}`, entry]))
    expect(byKey[`${HAIKU}|text`]).toEqual({ model: HAIKU, kind: 'text', group: 'easy-ko', outcome: 'ok', usage: { inputTokens: 700, outputTokens: 150, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })
    expect(byKey[`${SONNET}|png`]).toMatchObject({ outcome: 'truncated', group: 'tricky-en', usage: { inputTokens: 1900, outputTokens: 4000 } })
    expect(byKey[`${OPUS}|text`]).toMatchObject({ outcome: 'refused', usage: { inputTokens: 640, outputTokens: 25 } })
    expect(byKey[`${OPUS}|pdf`]).toMatchObject({ outcome: 'invalid' })
    expect(pilot).toMatchObject({ suiteVersion: PILOT_SUITE_VERSION, effort: 'low', maxOutputTokens: 4000, partialRun: false, failed: 0, skipped: 0, withoutUsage: 0 })
  })

  it('keeps the cache tokens', () => {
    const dir = freshDir()
    writePilotDir(dir, [{ model: SONNET, kind: 'text', group: 'g', input: 100, output: 10, cache: { read: 900, write: 50 } }])
    expect(readPilot(dir).samples[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 50 })
  })

  it('reads the effort, the cap and the suite version the pilot ran with', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS, { effort: 'high', maxOutputTokens: 8000, suiteVersion: 'v-then' })
    expect(readPilot(dir)).toMatchObject({ suiteVersion: 'v-then', effort: 'high', maxOutputTokens: 8000 })
  })

  it('counts failed and skipped tasks, which have no row, and flags a partial run', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS, {
      extraTasks: [
        fakeTask({ caseId: 'x:text', kind: 'text', model: HAIKU, status: 'failed', failureClass: 'rate_limit', usage: { inputTokens: 0, outputTokens: 0 } }),
        fakeTask({ caseId: 'y:text', kind: 'text', model: HAIKU, status: 'failed', failureClass: 'timeout', usage: { inputTokens: 800, outputTokens: 0 } }),
        fakeTask({ caseId: 'z:text', kind: 'text', model: SONNET, status: 'skipped' }),
      ],
      stop: 'budget',
    })
    const pilot = readPilot(dir)
    expect(pilot.samples).toHaveLength(6)
    expect(pilot).toMatchObject({ failed: 2, skipped: 1, partialRun: true })
  })

  it('ignores a row without usage and says so', () => {
    const dir = freshDir()
    writePilotDir(dir, [...ROWS, { model: SONNET, kind: 'pdf', group: 'q', input: 0, output: 0 }])
    const pilot = readPilot(dir)
    expect(pilot.samples).toHaveLength(6)
    expect(pilot.withoutUsage).toBe(1)
  })

  it('reads every variant folder, however many models there are', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    expect(new Set(readPilot(dir).samples.map((entry) => entry.model))).toEqual(new Set([HAIKU, SONNET, OPUS]))
  })
})

describe('readPilot: a directory that is not a usable results directory', () => {
  it('rejects a path that does not exist and a file', () => {
    const root = freshRoot()
    expect(() => readPilot(join(root, 'nope'))).toThrow(PilotDirError)
    expect(() => readPilot(join(root, 'nope'))).toThrow(/does not exist/)
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(() => readPilot(join(root, 'file.txt'))).toThrow(/is not a directory/)
  })

  it('rejects an empty directory and says what a results directory has', () => {
    const root = freshRoot()
    expect(() => readPilot(root)).toThrow(/is not a rill eval results directory: it has no run\.json/)
  })

  it('rejects a directory with run.json but no _state.json', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    rmSync(join(dir, '_state.json'))
    expect(() => readPilot(dir)).toThrow(/it has no _state\.json/)
  })

  it('rejects a run.json that is not JSON or not a run summary', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    writeFileSync(join(dir, 'run.json'), '{nope')
    expect(() => readPilot(dir)).toThrow(/run\.json is not valid JSON/)
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ hello: 'world' }))
    expect(() => readPilot(dir)).toThrow(/is not a rill eval run summary/)
    writeFileSync(join(dir, 'run.json'), '[]')
    expect(() => readPilot(dir)).toThrow(/is not a rill eval run summary/)
  })

  it('rejects the results of another suite', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ suite: 'planner', suite_version: '1' }))
    expect(() => readPilot(dir)).toThrow(/holds results of the suite "planner"; --reestimate supports "extract"/)
  })

  it('rejects a malformed row with its file and line', () => {
    for (const [line, message] of [
      ['{nope', /results\.jsonl line 2 is not valid JSON/],
      ['[]', /results\.jsonl line 2 is not a result row/],
      [JSON.stringify({ requested_model: SONNET }), /results\.jsonl line 2 has no requested_model or meta\.format/],
      [JSON.stringify({ requested_model: SONNET, meta: { format: 'text' }, usage: { input_tokens: 'x', output_tokens: 1 } }), /results\.jsonl line 2 has no valid usage/],
      [JSON.stringify({ requested_model: SONNET, meta: { format: 'text' }, usage: { input_tokens: 1, output_tokens: -1 } }), /results\.jsonl line 2 has no valid usage/],
    ] as const) {
      const dir = freshDir()
      writePilotDir(dir, [{ model: SONNET, kind: 'text', group: 'a', input: 10, output: 10 }])
      const path = join(dir, 'baseline', 'results.jsonl')
      writeFileSync(path, `${JSON.stringify({ requested_model: SONNET, meta: { format: 'text', seed: 'a' }, usage: { input_tokens: 10, output_tokens: 10 } })}\n${line}\n`)
      expect(() => readPilot(dir)).toThrow(message)
    }
  })

  it('rejects a results directory with no row that has usage, such as a baselines run or a run where every call failed', () => {
    const dir = freshDir()
    writePilotDir(dir, [{ model: SONNET, kind: 'text', group: 'a', input: 0, output: 0 }])
    expect(() => readPilot(dir)).toThrow(/no result row with token usage, so there is nothing to re-estimate from/)
    const failed = freshDir()
    writePilotDir(failed, [], { extraTasks: [fakeTask({ caseId: 'x:text', kind: 'text', model: SONNET, status: 'failed', failureClass: 'auth' })] })
    expect(() => readPilot(failed)).toThrow(/nothing to re-estimate from/)
  })

  it('ignores folders without a results.jsonl', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    mkdirSync(join(dir, 'scratch'))
    writeFileSync(join(dir, 'scratch', 'notes.txt'), 'x')
    expect(readPilot(dir).samples).toHaveLength(6)
  })
})

describe('readPilot: a run that crashed before the final write', () => {
  it('falls back to tasks.partial.jsonl and derives the kind and the seed from the case id', () => {
    const dir = freshDir()
    for (const task of [
      fakeTask({ caseId: 'easy-ko:text', group: 'easy-ko', kind: 'text', model: HAIKU, usage: { inputTokens: 700, outputTokens: 150 } }),
      fakeTask({ caseId: 'easy-ko:pdf', group: 'easy-ko', kind: 'pdf', model: SONNET, status: 'truncated', usage: { inputTokens: 2300, outputTokens: 4000 } }),
      fakeTask({ caseId: 'adv-en:png', group: 'adv-en', kind: 'png', model: OPUS, status: 'refused', usage: { inputTokens: 1900, outputTokens: 20 } }),
      fakeTask({ caseId: 'adv-en:text', group: 'adv-en', kind: 'text', model: OPUS, status: 'schema_failed', usage: { inputTokens: 600, outputTokens: 70 } }),
      fakeTask({ caseId: 'x:text', kind: 'text', model: OPUS, status: 'failed', failureClass: 'timeout', usage: { inputTokens: 600, outputTokens: 0 } }),
      fakeTask({ caseId: 'z:text', kind: 'text', model: OPUS, usage: { inputTokens: 0, outputTokens: 0 } }),
    ]) {
      appendPartial(dir, task)
    }
    const pilot = readPilot(dir)
    expect(pilot).toMatchObject({ source: 'partial', suiteVersion: null, effort: null, maxOutputTokens: null, failed: 1, withoutUsage: 1, partialRun: true })
    expect(pilot.samples.map((entry) => [entry.model, entry.kind, entry.group, entry.outcome, entry.usage.outputTokens])).toEqual([
      [HAIKU, 'text', 'easy-ko', 'ok', 150],
      [SONNET, 'pdf', 'easy-ko', 'truncated', 4000],
      [OPUS, 'png', 'adv-en', 'refused', 20],
      [OPUS, 'text', 'adv-en', 'invalid', 70],
    ])
  })

  it('prefers run.json when both exist and rejects a broken partial line', () => {
    const dir = freshDir()
    writePilotDir(dir, ROWS)
    appendPartial(dir, fakeTask({ caseId: 'q:text', kind: 'text', model: HAIKU }))
    expect(readPilot(dir).source).toBe('results')
    const crashed = freshDir()
    mkdirSync(crashed)
    writeFileSync(join(crashed, 'tasks.partial.jsonl'), '{"case_id": "a:text", "model": "m", "status": "ok", "usage": {"input_tokens": 1, "output_tokens": 1}}\n{broken\n')
    expect(() => readPilot(crashed)).toThrow(/tasks\.partial\.jsonl line 2 is not valid JSON/)
  })
})
