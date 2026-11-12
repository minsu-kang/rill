import { randomUUID } from 'node:crypto'
import type { Workflow } from '@rill/dsl'
import type { Journal, JournalEntry } from '@rill/nodes-core'
import { MEMORY_MAX_ITEMS, type AttachmentRef, type MemoryItem, type PlanMeta, type PlanResultBody, type PlanSummary } from '@rill/protocol'
import type { Db } from './db'
import { MemoryDuplicateError, MemoryFullError, memoryKey, normaliseMemoryText } from './memory'
import { PlanDeployedError, PlanExistsError, PlanNotFoundError, type StoredPlan } from './plans'

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'abandoned' | 'skipped' | 'continued'

export interface RunRow {
  id: string
  workflowId: string
  status: RunStatus
  payload: unknown
  dryRun: boolean
  error: string | null
}

export interface AttemptRow {
  runId: string
  nodeId: string
  attempt: number
  status: AttemptStatus
  input: unknown
  output: unknown
  error: string | null
  idempotencyKey: string
}

export interface TriggerState {
  nextFireAt: number | null
  lastFireAt: number | null
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export interface StoredWorkflow {
  id: string
  name: string
  active: boolean
  createdAt: number
  workflow: Workflow
}

export interface RunSummaryRow {
  id: string
  workflowId: string
  status: RunStatus
  dryRun: boolean
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface StepDetailRow {
  nodeId: string
  attempt: number
  status: AttemptStatus
  input: unknown
  output: unknown
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export class DuplicateFileError extends Error {
  constructor(path: string) {
    super(`file already delivered: ${path}`)
    this.name = 'DuplicateFileError'
  }
}

interface RawRunSummary {
  id: string
  workflow_id: string
  status: RunStatus
  dry_run: number
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface RawStepDetail {
  node_id: string
  attempt: number
  status: AttemptStatus
  input: string | null
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
}

const SUMMARY_COLUMNS = 'id, workflow_id, status, dry_run, error, created_at, started_at, finished_at'

function toRunSummary(row: RawRunSummary): RunSummaryRow {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    dryRun: row.dry_run === 1,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

interface RawRun {
  id: string
  workflow_id: string
  status: RunStatus
  trigger_payload: string
  dry_run: number
  error: string | null
}

interface RawAttempt {
  run_id: string
  node_id: string
  attempt: number
  status: AttemptStatus
  input: string | null
  output: string | null
  error: string | null
  idempotency_key: string
}

const RUN_COLUMNS = 'id, workflow_id, status, trigger_payload, dry_run, error'

function toRun(raw: RawRun): RunRow {
  return {
    id: raw.id,
    workflowId: raw.workflow_id,
    status: raw.status,
    payload: JSON.parse(raw.trigger_payload),
    dryRun: raw.dry_run === 1,
    error: raw.error,
  }
}

function parseJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text)
}

interface RawMemory {
  id: string
  text: string
  created_at: number
  updated_at: number
}

interface RawPlan {
  id: string
  created_at: number
  status: StoredPlan['status']
  effort: StoredPlan['effort']
  model: string | null
  request_text: string
  attachments: string
  result: string | null
  meta: string | null
  error: string | null
  workflow_hash: string | null
  flag_keys: string
  workflow_id: string | null
  confirmed: string | null
  memory_ids: string
}

const PLAN_COLUMNS =
  'id, created_at, status, effort, model, request_text, attachments, result, meta, error, workflow_hash, flag_keys, workflow_id, confirmed, memory_ids'

function toStoredPlan(row: RawPlan): StoredPlan {
  return {
    planId: row.id,
    createdAt: row.created_at,
    status: row.status,
    effort: row.effort,
    model: row.model,
    requestText: row.request_text,
    attachments: JSON.parse(row.attachments) as AttachmentRef[],
    result: parseJson(row.result) as PlanResultBody | null,
    meta: parseJson(row.meta) as PlanMeta | null,
    error: row.error,
    flagKeys: JSON.parse(row.flag_keys) as string[],
    workflowId: row.workflow_id,
    confirmed: parseJson(row.confirmed) as string[] | null,
    memoryIds: JSON.parse(row.memory_ids) as string[],
    workflowHash: row.workflow_hash,
  }
}

function toAttempt(raw: RawAttempt): AttemptRow {
  return {
    runId: raw.run_id,
    nodeId: raw.node_id,
    attempt: raw.attempt,
    status: raw.status,
    input: parseJson(raw.input),
    output: parseJson(raw.output),
    error: raw.error,
    idempotencyKey: raw.idempotency_key,
  }
}

export class Store {
  private readonly db: Db
  private readonly now: () => number

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  saveWorkflow(workflow: Workflow): string {
    const dsl = JSON.stringify(workflow)
    const existing = this.db.get<{ id: string }>(
      'SELECT id FROM workflows WHERE dsl = ? ORDER BY created_at, rowid LIMIT 1',
      dsl,
    )
    if (existing) return existing.id
    const id = randomUUID()
    this.db.run(
      'INSERT INTO workflows (id, name, dsl, active, created_at) VALUES (?, ?, ?, 0, ?)',
      id,
      workflow.name,
      dsl,
      this.now(),
    )
    return id
  }

  getWorkflow(id: string): Workflow {
    const row = this.db.get<{ dsl: string }>('SELECT dsl FROM workflows WHERE id = ?', id)
    if (!row) throw new NotFoundError(`workflow not found: ${id}`)
    return JSON.parse(row.dsl) as Workflow
  }

  createRun(input: { workflowId: string; payload: unknown; dryRun: boolean }): RunRow {
    const id = randomUUID()
    this.db.run(
      'INSERT INTO runs (id, workflow_id, status, trigger_payload, dry_run, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      input.workflowId,
      'queued',
      JSON.stringify(input.payload ?? null),
      input.dryRun ? 1 : 0,
      this.now(),
    )
    return this.getRun(id)
  }

  getRun(id: string): RunRow {
    const row = this.db.get<RawRun>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, id)
    if (!row) throw new NotFoundError(`run not found: ${id}`)
    return toRun(row)
  }

  listRunsByStatus(status: RunStatus): RunRow[] {
    return this.db
      .all<RawRun>(`SELECT ${RUN_COLUMNS} FROM runs WHERE status = ? ORDER BY created_at, rowid`, status)
      .map(toRun)
  }

  markRunRunning(id: string): void {
    this.db.run("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", this.now(), id)
  }

  finishRun(id: string, status: 'succeeded' | 'failed', error?: string): void {
    this.db.run('UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, error ?? null, this.now(), id)
  }

  startAttempt(input: { runId: string; nodeId: string; input: unknown; idempotencyKey: string }): number {
    return this.db.transaction(() => {
      const last =
        this.db.get<{ n: number | null }>(
          'SELECT MAX(attempt) AS n FROM step_attempts WHERE run_id = ? AND node_id = ?',
          input.runId,
          input.nodeId,
        )?.n ?? 0
      const attempt = last + 1
      this.db.run(
        'INSERT INTO step_attempts (run_id, node_id, attempt, status, input, idempotency_key, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        input.runId,
        input.nodeId,
        attempt,
        'running',
        JSON.stringify(input.input ?? null),
        input.idempotencyKey,
        this.now(),
      )
      return attempt
    })
  }

  finishAttempt(
    runId: string,
    nodeId: string,
    attempt: number,
    result: { status: 'succeeded' | 'failed'; output?: unknown; error?: string },
  ): void {
    this.db.run(
      'UPDATE step_attempts SET status = ?, output = ?, error = ?, finished_at = ? WHERE run_id = ? AND node_id = ? AND attempt = ?',
      result.status,
      result.status === 'succeeded' ? JSON.stringify(result.output ?? null) : null,
      result.error ?? null,
      this.now(),
      runId,
      nodeId,
      attempt,
    )
  }

  recordSkipped(runId: string, nodeId: string, idempotencyKey: string): void {
    this.db.transaction(() => {
      const last = this.db.get<{ attempt: number; status: AttemptStatus }>(
        'SELECT attempt, status FROM step_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1',
        runId,
        nodeId,
      )
      if (last?.status === 'skipped') return
      const now = this.now()
      this.db.run(
        "INSERT INTO step_attempts (run_id, node_id, attempt, status, idempotency_key, started_at, finished_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?)",
        runId,
        nodeId,
        (last?.attempt ?? 0) + 1,
        idempotencyKey,
        now,
        now,
      )
    })
  }

  markContinued(runId: string, nodeId: string, attempt: number): void {
    this.db.run(
      "UPDATE step_attempts SET status = 'continued' WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'failed'",
      runId,
      nodeId,
      attempt,
    )
  }

  isContinued(runId: string, nodeId: string): boolean {
    const row = this.db.get<{ status: AttemptStatus }>(
      'SELECT status FROM step_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1',
      runId,
      nodeId,
    )
    return row?.status === 'continued'
  }

  abandonRunningAttempts(runId: string): number {
    return this.db.run(
      "UPDATE step_attempts SET status = 'abandoned', finished_at = ? WHERE run_id = ? AND status = 'running'",
      this.now(),
      runId,
    )
  }

  latestSucceededOutput(runId: string, nodeId: string): { output: unknown } | undefined {
    const row = this.db.get<{ output: string }>(
      "SELECT output FROM step_attempts WHERE run_id = ? AND node_id = ? AND status = 'succeeded' ORDER BY attempt DESC LIMIT 1",
      runId,
      nodeId,
    )
    return row ? { output: JSON.parse(row.output) } : undefined
  }

  listAttempts(runId: string): AttemptRow[] {
    return this.db
      .all<RawAttempt>(
        'SELECT run_id, node_id, attempt, status, input, output, error, idempotency_key FROM step_attempts WHERE run_id = ? ORDER BY id',
        runId,
      )
      .map(toAttempt)
  }

  setWorkflowActive(id: string, active: boolean): void {
    this.db.run('UPDATE workflows SET active = ? WHERE id = ?', active ? 1 : 0, id)
  }

  listActiveWorkflowIds(): string[] {
    return this.db
      .all<{ id: string }>('SELECT id FROM workflows WHERE active = 1 ORDER BY created_at, rowid')
      .map((row) => row.id)
  }

  getTriggerState(workflowId: string): TriggerState | undefined {
    const row = this.db.get<{ next_fire_at: number | null; last_fire_at: number | null }>(
      'SELECT next_fire_at, last_fire_at FROM trigger_state WHERE workflow_id = ?',
      workflowId,
    )
    return row ? { nextFireAt: row.next_fire_at, lastFireAt: row.last_fire_at } : undefined
  }

  saveTriggerState(workflowId: string, state: TriggerState): void {
    this.db.run(
      'INSERT INTO trigger_state (workflow_id, next_fire_at, last_fire_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(workflow_id) DO UPDATE SET next_fire_at = excluded.next_fire_at, last_fire_at = excluded.last_fire_at',
      workflowId,
      state.nextFireAt,
      state.lastFireAt,
    )
  }

  clearNextFire(workflowId: string): void {
    this.db.run('UPDATE trigger_state SET next_fire_at = NULL WHERE workflow_id = ?', workflowId)
  }

  hasSeenFile(workflowId: string, fingerprint: string): boolean {
    const row = this.db.get<{ found: number }>(
      'SELECT 1 AS found FROM seen_files WHERE workflow_id = ? AND fingerprint = ?',
      workflowId,
      fingerprint,
    )
    return row !== undefined
  }

  markFileSeen(workflowId: string, fingerprint: string, path: string, runId: string | null): boolean {
    return (
      this.db.run(
        'INSERT OR IGNORE INTO seen_files (workflow_id, fingerprint, path, seen_at, run_id) VALUES (?, ?, ?, ?, ?)',
        workflowId,
        fingerprint,
        path,
        this.now(),
        runId,
      ) > 0
    )
  }

  hasActiveRun(workflowId: string): boolean {
    const row = this.db.get<{ found: number }>(
      "SELECT 1 AS found FROM runs WHERE workflow_id = ? AND status IN ('queued', 'running') LIMIT 1",
      workflowId,
    )
    return row !== undefined
  }

  createTriggeredRun(input: {
    workflowId: string
    payload: unknown
    fingerprint?: { value: string; path: string }
  }): RunRow {
    return this.db.transaction(() => {
      const run = this.createRun({ workflowId: input.workflowId, payload: input.payload, dryRun: false })
      if (input.fingerprint) {
        const added = this.markFileSeen(input.workflowId, input.fingerprint.value, input.fingerprint.path, run.id)
        if (!added) throw new DuplicateFileError(input.fingerprint.path)
      }
      return run
    })
  }

  listStoredWorkflows(): StoredWorkflow[] {
    return this.db
      .all<{ id: string; name: string; dsl: string; active: number; created_at: number }>(
        'SELECT id, name, dsl, active, created_at FROM workflows ORDER BY created_at, rowid',
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        active: row.active === 1,
        createdAt: row.created_at,
        workflow: JSON.parse(row.dsl) as Workflow,
      }))
  }

  listRunSummaries(options: { workflowId?: string; limit: number }): RunSummaryRow[] {
    const where = options.workflowId === undefined ? '' : 'WHERE workflow_id = ?'
    const params = options.workflowId === undefined ? [options.limit] : [options.workflowId, options.limit]
    return this.db
      .all<RawRunSummary>(
        `SELECT ${SUMMARY_COLUMNS} FROM runs ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ...params,
      )
      .map(toRunSummary)
  }

  getRunSummary(id: string): RunSummaryRow {
    const row = this.db.get<RawRunSummary>(`SELECT ${SUMMARY_COLUMNS} FROM runs WHERE id = ?`, id)
    if (!row) throw new NotFoundError(`run not found: ${id}`)
    return toRunSummary(row)
  }

  listStepDetails(runId: string): StepDetailRow[] {
    return this.db
      .all<RawStepDetail>(
        'SELECT node_id, attempt, status, input, output, error, started_at, finished_at FROM step_attempts WHERE run_id = ? ORDER BY id',
        runId,
      )
      .map((row) => ({
        nodeId: row.node_id,
        attempt: row.attempt,
        status: row.status,
        input: parseJson(row.input),
        output: parseJson(row.output),
        error: row.error,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }))
  }

  savePlan(record: StoredPlan): void {
    const refs = record.attachments.map(({ id, mediaType, name, bytes }) => ({ id, mediaType, name, bytes }))
    const added = this.db.run(
      `INSERT INTO plans (${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      record.planId,
      record.createdAt,
      record.status,
      record.effort,
      record.model,
      record.requestText,
      JSON.stringify(refs),
      record.result === null ? null : JSON.stringify(record.result),
      record.meta === null ? null : JSON.stringify(record.meta),
      record.error,
      record.workflowHash,
      JSON.stringify(record.flagKeys),
      record.workflowId,
      record.confirmed === null ? null : JSON.stringify(record.confirmed),
      JSON.stringify(record.memoryIds ?? []),
    )
    if (added === 0) throw new PlanExistsError(record.planId)
  }

  getPlan(id: string): StoredPlan {
    const row = this.db.get<RawPlan>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`, id)
    if (!row) throw new PlanNotFoundError(id)
    return toStoredPlan(row)
  }

  hasPlan(id: string): boolean {
    return this.db.get<{ found: number }>('SELECT 1 AS found FROM plans WHERE id = ?', id) !== undefined
  }

  listPlanSummaries(limit: number): PlanSummary[] {
    return this.db
      .all<{
        id: string
        created_at: number
        status: PlanSummary['status']
        kind: PlanSummary['kind']
        summary: string | null
        flag_count: number
        workflow_id: string | null
      }>(
        "SELECT id, created_at, status, json_extract(result, '$.kind') AS kind, json_extract(result, '$.summary') AS summary, " +
          'json_array_length(flag_keys) AS flag_count, workflow_id ' +
          'FROM plans ORDER BY created_at DESC, rowid DESC LIMIT ?',
        limit,
      )
      .map((row) => ({
        planId: row.id,
        createdAt: row.created_at,
        status: row.status,
        kind: row.kind,
        summary: row.summary,
        flagCount: row.flag_count,
        workflowId: row.workflow_id,
      }))
  }

  markPlanDeployed(id: string, workflowId: string, confirmed: string[]): void {
    const changed = this.db.run(
      'UPDATE plans SET workflow_id = ?, confirmed = ? WHERE id = ? AND workflow_id IS NULL',
      workflowId,
      JSON.stringify(confirmed),
      id,
    )
    if (changed > 0) return
    if (!this.hasPlan(id)) throw new PlanNotFoundError(id)
    throw new PlanDeployedError(id)
  }

  findOpenPlanByHash(hash: string): { id: string } | undefined {
    return this.db.get<{ id: string }>(
      "SELECT id FROM plans WHERE workflow_hash = ? AND flag_keys != '[]' AND workflow_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      hash,
    )
  }

  listMemory(): MemoryItem[] {
    return this.db
      .all<RawMemory>('SELECT id, text, created_at, updated_at FROM memory_items ORDER BY created_at, rowid')
      .map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  saveMemory(input: { id?: string; text: string }): MemoryItem {
    const text = normaliseMemoryText(input.text)
    const key = memoryKey(text)
    return this.db.transaction(() => {
      const at = this.now()
      if (input.id !== undefined) {
        const row = this.db.get<RawMemory>('SELECT id, text, created_at, updated_at FROM memory_items WHERE id = ?', input.id)
        if (!row) throw new NotFoundError('memory note not found')
        if (this.db.get('SELECT 1 AS found FROM memory_items WHERE text_key = ? AND id != ?', key, input.id) !== undefined) throw new MemoryDuplicateError()
        this.db.run('UPDATE memory_items SET text = ?, text_key = ?, updated_at = ? WHERE id = ?', text, key, at, input.id)
        return { id: input.id, text, createdAt: row.created_at, updatedAt: at }
      }
      if (this.db.get('SELECT 1 AS found FROM memory_items WHERE text_key = ?', key) !== undefined) throw new MemoryDuplicateError()
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_items')?.n ?? 0
      if (count >= MEMORY_MAX_ITEMS) throw new MemoryFullError()
      const id = randomUUID()
      this.db.run('INSERT INTO memory_items (id, text, text_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, text, key, at, at)
      return { id, text, createdAt: at, updatedAt: at }
    })
  }

  deleteMemory(id: string): boolean {
    return this.db.run('DELETE FROM memory_items WHERE id = ?', id) > 0
  }

  journal(): Journal {
    return {
      get: (key) => {
        const row = this.db.get<{ state: JournalEntry['state']; data: string | null }>(
          'SELECT state, data FROM idempotency_journal WHERE key = ?',
          key,
        )
        return row ? { state: row.state, data: row.data } : undefined
      },
      put: (key, state, data) => {
        this.db.run(
          'INSERT INTO idempotency_journal (key, state, data, updated_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET state = excluded.state, ' +
            'data = COALESCE(excluded.data, idempotency_journal.data), updated_at = excluded.updated_at',
          key,
          state,
          data ?? null,
          this.now(),
        )
      },
    }
  }
}
