import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmUsage } from '@rill/llm'
import { isValidTokenCount } from './record'
import { PARTIAL_FILE } from './results'
import type { PilotData, PilotSample, SampleOutcome } from './reestimate'

export class PilotDirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PilotDirError'
  }
}

const RUN_FILE = 'run.json'
const STATE_FILE = '_state.json'
const ROWS_FILE = 'results.jsonl'
const SUPPORTED_SUITE = 'extract'

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PilotDirError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readLines(path: string): { line: number; value: unknown }[] {
  const lines: { line: number; value: unknown }[] = []
  const text = readFileSync(path, 'utf8').split('\n')
  for (const [index, raw] of text.entries()) {
    if (raw.trim() === '') continue
    try {
      lines.push({ line: index + 1, value: JSON.parse(raw) })
    } catch {
      throw new PilotDirError(`${path} line ${index + 1} is not valid JSON`)
    }
  }
  return lines
}

function usageOf(value: unknown): LlmUsage | undefined {
  if (!isRecord(value)) return undefined
  const optional = (key: string): number | undefined => (value[key] === undefined || value[key] === null ? 0 : isValidTokenCount(value[key]) ? value[key] : undefined)
  const inputTokens = value['input_tokens']
  const outputTokens = value['output_tokens']
  const cacheRead = optional('cache_read_input_tokens')
  const cacheCreation = optional('cache_creation_input_tokens')
  if (!isValidTokenCount(inputTokens) || !isValidTokenCount(outputTokens) || cacheRead === undefined || cacheCreation === undefined) return undefined
  return { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation }
}

function hasUsage(usage: LlmUsage): boolean {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens > 0
}

function gradeFlag(grade: unknown, key: string): number | undefined {
  return isRecord(grade) && typeof grade[key] === 'number' ? grade[key] : undefined
}

function rowSample(row: unknown, where: string): { sample: PilotSample | undefined; withoutUsage: boolean } {
  if (!isRecord(row)) throw new PilotDirError(`${where} is not a result row`)
  const model = row['requested_model']
  const meta = row['meta']
  const kind = isRecord(meta) ? meta['format'] : undefined
  const seed = isRecord(meta) ? meta['seed'] : undefined
  const usage = usageOf(row['usage'])
  if (typeof model !== 'string' || typeof kind !== 'string') throw new PilotDirError(`${where} has no requested_model or meta.format`)
  if (usage === undefined) throw new PilotDirError(`${where} has no valid usage`)
  if (!hasUsage(usage)) return { sample: undefined, withoutUsage: true }
  const grade = row['grade']
  let outcome: SampleOutcome = 'ok'
  if (row['status'] === 'truncated') outcome = 'truncated'
  else if (gradeFlag(grade, 'refused') === 1) outcome = 'refused'
  else if (gradeFlag(grade, 'schema_ok') === 0) outcome = 'invalid'
  return { sample: { model, kind, group: typeof seed === 'string' ? seed : String(row['prompt_id'] ?? ''), outcome, usage }, withoutUsage: false }
}

const PARTIAL_OUTCOMES: Readonly<Record<string, SampleOutcome | undefined>> = { ok: 'ok', truncated: 'truncated', refused: 'refused', schema_failed: 'invalid' }

function readPartial(dir: string): PilotData {
  const path = join(dir, PARTIAL_FILE)
  const samples: PilotSample[] = []
  let failed = 0
  let withoutUsage = 0
  for (const { line, value } of readLines(path)) {
    const where = `${path} line ${line}`
    if (!isRecord(value)) throw new PilotDirError(`${where} is not a task line`)
    const caseId = value['case_id']
    const model = value['model']
    const status = value['status']
    if (typeof caseId !== 'string' || typeof model !== 'string' || typeof status !== 'string') throw new PilotDirError(`${where} has no case_id, model or status`)
    if (status === 'failed') {
      failed += 1
      continue
    }
    const outcome = PARTIAL_OUTCOMES[status]
    if (outcome === undefined) continue
    const usage = usageOf(value['usage'])
    if (usage === undefined) throw new PilotDirError(`${where} has no valid usage`)
    if (!hasUsage(usage)) {
      withoutUsage += 1
      continue
    }
    const cut = caseId.lastIndexOf(':')
    samples.push({ model, kind: caseId.slice(cut + 1), group: cut < 0 ? caseId : caseId.slice(0, cut), outcome, usage })
  }
  return { source: 'partial', suiteVersion: null, effort: null, maxOutputTokens: null, partialRun: true, failed, skipped: 0, withoutUsage, samples }
}

export function readPilot(dir: string): PilotData {
  const pilot = readPilotDir(dir)
  if (pilot.samples.length === 0) {
    throw new PilotDirError(`${dir} has no result row with token usage, so there is nothing to re-estimate from (a baselines run, or a run in which every call failed, has none)`)
  }
  return pilot
}

function readPilotDir(dir: string): PilotData {
  let stat
  try {
    stat = statSync(dir)
  } catch {
    throw new PilotDirError(`${dir} does not exist`)
  }
  if (!stat.isDirectory()) throw new PilotDirError(`${dir} is not a directory`)
  const runPath = join(dir, RUN_FILE)
  if (!existsSync(runPath)) {
    if (existsSync(join(dir, PARTIAL_FILE))) return readPartial(dir)
    throw new PilotDirError(`${dir} is not a rill eval results directory: it has no ${RUN_FILE} (a finished run has ${RUN_FILE}, ${STATE_FILE} and one folder per model)`)
  }
  if (!existsSync(join(dir, STATE_FILE))) throw new PilotDirError(`${dir} is not a rill eval results directory: it has no ${STATE_FILE}`)
  const run = readJson(runPath, runPath)
  if (!isRecord(run) || typeof run['suite'] !== 'string' || typeof run['suite_version'] !== 'string') {
    throw new PilotDirError(`${runPath} is not a rill eval run summary (no suite and suite_version)`)
  }
  if (run['suite'] !== SUPPORTED_SUITE) throw new PilotDirError(`${dir} holds results of the suite "${run['suite']}"; --reestimate supports "${SUPPORTED_SUITE}"`)
  const samples: PilotSample[] = []
  let withoutUsage = 0
  const variants = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, ROWS_FILE)))
    .map((entry) => entry.name)
    .sort()
  for (const variant of variants) {
    const path = join(dir, variant, ROWS_FILE)
    for (const { line, value } of readLines(path)) {
      const found = rowSample(value, `${path} line ${line}`)
      if (found.sample !== undefined) samples.push(found.sample)
      if (found.withoutUsage) withoutUsage += 1
    }
  }
  const maxOutput = run['max_output_tokens']
  const skipped = run['skipped']
  const failed = run['failed']
  return {
    source: 'results',
    suiteVersion: run['suite_version'],
    effort: typeof run['effort'] === 'string' ? run['effort'] : null,
    maxOutputTokens: typeof maxOutput === 'number' ? maxOutput : null,
    partialRun: run['partial'] === true,
    failed: typeof failed === 'number' ? failed : 0,
    skipped: Array.isArray(skipped) ? skipped.length : 0,
    withoutUsage,
    samples,
  }
}
