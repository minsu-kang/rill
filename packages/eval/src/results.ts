import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPassingOutcome, type FieldOutcome } from './score'
import { priceFor } from './pricing'
import type { SentRequest } from './sent'
import type { FailedAttempt, RunResult, TaskResult } from './runner'
import type { EvalCase } from './suite'

export interface ResultCase extends EvalCase {
  file?: string
  expected?: unknown
}

export interface ResultsMeta<O> {
  suiteName: string
  suiteVersion: string
  createdAt: string
  seed: number
  reps: number
  effort: string
  fields: readonly string[]
  models: readonly string[]
  cases: readonly ResultCase[]
  refRoot?: string
  sentRequestOf?: (output: O) => SentRequest | undefined
  secrets?: readonly string[]
  runnerSha?: string
}

export interface VariantFiles {
  variant: string
  model: string
  dir: string
  rows: number
  errors: number
}

export interface WrittenResults {
  dir: string
  variants: VariantFiles[]
}

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const PROMPT_ID_UNSAFE = /[^A-Za-z0-9_.-]/gu
const REDACTED = '[redacted]'
const BASELINE_VARIANT = 'baseline'
const SHIPPED_MODEL = 'claude-opus-5-5'
const GOLD_SOURCE = 'seed'

interface MetricDef {
  id: string
  kind: 'binary' | 'float'
  label?: string
  better?: 'lower'
  scale?: number
}

export function promptId(caseId: string): string {
  return caseId.replace(PROMPT_ID_UNSAFE, '-')
}

export function variantNames(models: readonly string[]): { variant: string; model: string }[] {
  const base = models.includes(SHIPPED_MODEL) ? SHIPPED_MODEL : models[0]
  let next = 1
  return models.map((model) => ({ model, variant: model === base ? BASELINE_VARIANT : `v${next++}` }))
}

export function assertWritableDir(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`output directory is not empty: ${dir}`)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

function refOf(file: string, root: string): string {
  const ref = posix(relative(root, file))
  return ref.startsWith('/') || /^[A-Za-z]:/u.test(ref) ? (file.split(/[\\/]/u).pop() ?? file) : ref
}

function isScorable(task: TaskResult<unknown>): boolean {
  return task.status === 'ok' || task.status === 'refused' || task.status === 'schema_failed' || task.status === 'truncated'
}

function gradeOf(task: TaskResult<unknown>, fields: readonly string[]): Record<string, number> {
  const score = task.score
  if (score === undefined || task.status === 'truncated') return {}
  const grade: Record<string, number> = {}
  const outcomes = score.outcomes
  const passed = (field: string): boolean => {
    const outcome: FieldOutcome | undefined = outcomes[field]
    return outcome !== undefined && isPassingOutcome(outcome)
  }
  const answered = task.status === 'ok'
  const okFields = fields.filter(passed).length
  grade['case_pass'] = answered && okFields === fields.length ? 1 : 0
  grade['field_acc'] = answered && fields.length > 0 ? round(okFields / fields.length, 4) : 0
  for (const field of fields) grade[`${field}_ok`] = answered && passed(field) ? 1 : 0
  if (answered) {
    grade['halluc_any'] = fields.some((field) => outcomes[field] === 'HALLUC') ? 1 : 0
    grade['miss_any'] = fields.some((field) => outcomes[field] === 'MISS') ? 1 : 0
  }
  if (task.status !== 'refused') grade['schema_ok'] = answered ? 1 : 0
  grade['refused'] = task.status === 'refused' ? 1 : 0
  for (const [key, value] of Object.entries(score.extra)) grade[key] = value
  return grade
}

function metricDefs(tasks: readonly TaskResult<unknown>[], fields: readonly string[]): MetricDef[] {
  const defs: MetricDef[] = [
    { id: 'case_pass', kind: 'binary', label: 'case pass' },
    { id: 'field_acc', kind: 'float', label: 'field acc', scale: 1 },
    ...fields.map((field): MetricDef => ({ id: `${field}_ok`, kind: 'binary' })),
    { id: 'halluc_any', kind: 'binary', better: 'lower', label: 'hallucinated' },
    { id: 'miss_any', kind: 'binary', better: 'lower', label: 'missed' },
    { id: 'schema_ok', kind: 'binary' },
    { id: 'refused', kind: 'binary', better: 'lower' },
  ]
  const extras = new Map<string, boolean>()
  for (const task of tasks) {
    for (const [key, value] of Object.entries(task.score?.extra ?? {})) {
      extras.set(key, (extras.get(key) ?? true) && (value === 0 || value === 1))
    }
  }
  for (const [id, binary] of extras) {
    defs.push(id === 'inject_ok' ? { id, kind: 'binary', label: 'inject resist' } : { id, kind: binary ? 'binary' : 'float' })
  }
  return defs
}

function usageOf(task: TaskResult<unknown>) {
  return {
    input_tokens: task.usage.inputTokens,
    output_tokens: task.usage.outputTokens,
    cache_read_input_tokens: task.usage.cacheReadInputTokens,
    cache_creation_input_tokens: task.usage.cacheCreationInputTokens,
  }
}

function describeOutcome(field: string, outcome: FieldOutcome, expected: unknown, output: unknown): string {
  if (outcome === 'WRONG' || outcome === 'MISS' || outcome === 'HALLUC') {
    const want = isRecordLike(expected) ? expected[field] : undefined
    const got = isRecordLike(output) ? output[field] : undefined
    return `${outcome} expected ${JSON.stringify(want ?? null)} got ${JSON.stringify(got ?? null)}`
  }
  return outcome
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface TraceTurn {
  role: 'system' | 'user' | 'assistant' | 'tool_result'
  content: string
  name?: string
  attachments?: { kind: string; ref: string }[]
}

function traceOf<O>(task: TaskResult<O>, testCase: ResultCase | undefined, meta: ResultsMeta<O>, attachments: { kind: string; ref: string }[]): TraceTurn[] {
  const sent = task.output === undefined ? undefined : meta.sentRequestOf?.(task.output)
  const turns: TraceTurn[] = []
  if (sent?.system !== undefined && sent.system !== null) turns.push({ role: 'system', content: sent.system })
  const user = sent?.messages.find((message) => message.role === 'user')
  const text = user?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
  turns.push({
    role: 'user',
    content: text ?? '(the request text was not captured for this call)',
    ...(attachments.length > 0 ? { attachments } : {}),
  })
  if (task.output !== undefined) turns.push({ role: 'assistant', content: JSON.stringify(task.output, null, 2) })
  const outcomes = task.score?.outcomes ?? {}
  const grader: Record<string, string> = {}
  for (const [field, outcome] of Object.entries(outcomes)) {
    grader[field] = describeOutcome(field, outcome, testCase?.expected, task.output)
  }
  const detail =
    task.status === 'ok' ? grader : { status: task.status, ...(task.failureClass === undefined ? {} : { failure_class: task.failureClass }), ...grader }
  turns.push({ role: 'tool_result', name: 'grader', content: JSON.stringify(detail, null, 2) })
  return turns
}

function rowOf<O>(task: TaskResult<O>, testCase: ResultCase | undefined, meta: ResultsMeta<O>, id: string): Record<string, unknown> {
  const served = task.exchanges.findLast((exchange) => exchange.status !== null && exchange.status >= 200 && exchange.status < 300)
  const file = testCase?.file
  const attachments = file === undefined ? [] : [{ kind: task.kind, ref: refOf(file, meta.refRoot ?? PACKAGE_ROOT) }]
  const tags = [task.category, task.kind, ...(testCase?.tags ?? [])]
  const outcomes = task.score?.outcomes ?? {}
  return {
    prompt_id: id,
    rep: task.rep,
    prompt: attachments.length === 0 ? '' : `[${task.kind}: ${attachments[0]?.ref}]`,
    tags: [...new Set(tags)],
    status: task.status === 'truncated' ? 'truncated' : 'ok',
    ...(served?.stopReason === undefined || served.stopReason === null ? {} : { stop_reason: served.stopReason }),
    grade: gradeOf(task, meta.fields),
    model: served?.model ?? task.model,
    requested_model: task.model,
    fallback_used: task.exchanges.some((exchange) => exchange.fallbackBlocks > 0),
    usage: usageOf(task),
    ...(task.latencyMs === undefined ? {} : { latency_s: round(task.latencyMs / 1000, 3) }),
    wall_s: round(task.wallMs / 1000, 3),
    attempts: task.attempts,
    attachments: attachments.map((attachment) => ({ ...attachment, alt: `${task.caseId}` })),
    meta: {
      seed: task.group,
      format: task.kind,
      category: task.category,
      gold_source: GOLD_SOURCE,
      ...(testCase?.expected === undefined ? {} : { expected: testCase.expected }),
      ...(task.output === undefined ? {} : { output: task.output }),
      field_outcome: outcomes,
      effort: meta.effort,
      suite_version: meta.suiteVersion,
      ...(meta.runnerSha === undefined ? {} : { runner_sha: meta.runnerSha }),
    },
  }
}

function errorLines(task: TaskResult<unknown>, id: string, ts: string): Record<string, unknown>[] {
  const base = { prompt_id: id, rep: task.rep, requested_model: task.model, ts }
  const lines: Record<string, unknown>[] = task.failedAttempts.map((attempt: FailedAttempt) => ({
    ...base,
    scope: 'attempt',
    attempt: attempt.attempt,
    failure_class: attempt.failureClass,
    model: null,
    message: attempt.message,
    usage:
      attempt.usage === undefined
        ? null
        : {
            input_tokens: attempt.usage.inputTokens,
            output_tokens: attempt.usage.outputTokens,
            cache_read_input_tokens: attempt.usage.cacheReadInputTokens,
            cache_creation_input_tokens: attempt.usage.cacheCreationInputTokens,
          },
  }))
  if (task.status === 'failed') {
    lines.push({ ...base, scope: 'task', attempts: task.attempts, failure_class: task.failureClass ?? 'harness', model: null, wall_s: round(task.wallMs / 1000, 3) })
  }
  return lines
}

function scrubber(secrets: readonly string[] | undefined): (text: string) => string {
  const keys = (secrets ?? []).filter((secret) => secret.length >= 4)
  return (text) => keys.reduce((current, key) => current.split(key).join(REDACTED), text)
}

function jsonl(lines: readonly unknown[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('')
}

export function writeResults<O>(dir: string, run: RunResult<O>, meta: ResultsMeta<O>): WrittenResults {
  assertWritableDir(dir)
  const scrub = scrubber(meta.secrets)
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, scrub(content))
  }
  const byId = new Map(meta.cases.map((testCase) => [testCase.id, testCase]))
  const variants = variantNames(meta.models)
  for (const task of run.tasks) {
    if (!meta.models.includes(task.model)) throw new Error(`task for a model that is not in meta.models: ${task.model}`)
  }
  const prices = Object.fromEntries(
    meta.models.flatMap((model) => {
      const price = priceFor(model)
      return price === undefined ? [] : [[model, { in: price.input, out: price.output }]]
    }),
  )
  write(
    join(dir, '_state.json'),
    `${JSON.stringify({ metrics: metricDefs(run.tasks, meta.fields), perf_fields: [{ id: 'latency_s', unit: 's' }, { id: 'cost_usd', unit: '$' }], prices }, null, 2)}\n`,
  )
  const written: VariantFiles[] = []
  for (const { variant, model } of variants) {
    const variantDir = join(dir, variant)
    const tasks = run.tasks.filter((task) => task.model === model)
    const rows: unknown[] = []
    const errors: unknown[] = []
    const seen = new Set<string>()
    for (const task of tasks) {
      const id = promptId(task.caseId)
      for (const line of errorLines(task, id, meta.createdAt)) errors.push(line)
      if (!isScorable(task)) continue
      const key = `${id}_rep${task.rep}`
      if (seen.has(key)) throw new Error(`two rows would share the trace name ${key}`)
      seen.add(key)
      const testCase = byId.get(task.caseId)
      const row = rowOf(task, testCase, meta, id)
      rows.push(row)
      const attachments = (row['attachments'] as { kind: string; ref: string }[]).map(({ kind, ref }) => ({ kind, ref }))
      write(join(variantDir, 'traces', `${key}.json`), `${JSON.stringify(traceOf(task, testCase, meta, attachments), null, 2)}\n`)
    }
    write(join(variantDir, 'results.jsonl'), jsonl(rows))
    write(join(variantDir, 'errors.jsonl'), jsonl(errors))
    write(join(variantDir, 'change.md'), `# model: ${model}\n`)
    written.push({ variant, model, dir: variantDir, rows: rows.length, errors: errors.length })
  }
  const skipped = run.tasks.filter((task) => task.status === 'skipped')
  write(
    join(dir, 'run.json'),
    `${JSON.stringify(
      {
        suite: meta.suiteName,
        suite_version: meta.suiteVersion,
        created_at: meta.createdAt,
        seed: meta.seed,
        reps: meta.reps,
        effort: meta.effort,
        models: meta.models,
        budget_usd: run.budgetUsd ?? null,
        spent_usd: run.spentUsd,
        tasks: run.tasks.length,
        failed: run.tasks.filter((task) => task.status === 'failed').length,
        skipped: skipped.map((task) => ({ prompt_id: promptId(task.caseId), rep: task.rep, model: task.model })),
      },
      null,
      2,
    )}\n`,
  )
  return { dir, variants: written }
}
