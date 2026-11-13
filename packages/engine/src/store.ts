import { randomUUID } from 'node:crypto'
import type { Workflow } from '@rill/dsl'
import type { Journal, JournalEntry } from '@rill/nodes-core'
import {
  AGENT_DEFAULT_ID,
  AGENT_MAX_ITEMS,
  HOOK_LOG_MAX_ROWS,
  HOOK_MAX_ITEMS,
  HOOK_RATE_LIMIT,
  HOOK_RATE_WINDOW_MS,
  AGENT_SKILLS_MAX_CHARS,
  MEMORY_MAX_ITEMS,
  RULE_MAX_ITEMS,
  SKILL_MAX_ITEMS,
  agentNameKey,
  hookKey,
  isReservedAgentName,
  skillNameKey,
  type Agent,
  type AgentFields,
  type AgentKind,
  type AgentSkillRule,
  type AttachmentRef,
  type Hook,
  type HookAction,
  type HookEvent,
  type HookFailureCode,
  type HookInput,
  type HookLogEntry,
  type HookOutcome,
  type MemoryItem,
  type PlanMeta,
  type PlanResultBody,
  type PlanSummary,
  type Rule,
  type RuleKind,
  type Skill,
  type SkillFields,
} from '@rill/protocol'
import {
  AgentBuiltinError,
  AgentDuplicateError,
  AgentFullError,
  AgentInvalidError,
  AgentNotAssistantError,
  AgentNotFoundError,
  builtinAgent,
  normaliseAgent,
} from './agents'
import type { Db } from './db'
import { HookFullError, HookInvalidError, HookNotFoundError } from './hooks'
import { MemoryDuplicateError, MemoryFullError, memoryKey, normaliseMemoryText } from './memory'
import { PlanDeployedError, PlanExistsError, PlanNotFoundError, type StoredPlan } from './plans'
import { RuleDuplicateError, RuleFullError } from './rules'
import { SkillDuplicateError, SkillFullError, SkillInvalidError, SkillNotFoundError, normaliseSkill } from './skills'

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

interface RawRule {
  id: string
  kind: RuleKind
  value: string
  created_at: number
}

interface RawMemory {
  id: string
  text: string
  created_at: number
  updated_at: number
}

interface RawAgent {
  id: string
  name: string
  description: string
  persona: string
  instructions: string
  kind: AgentKind
  skill_ids: string
  created_at: number
  updated_at: number
}

const AGENT_COLUMNS = 'id, name, description, persona, instructions, kind, skill_ids, created_at, updated_at'
const ACTIVE_AGENT_KEY = 'active_agent'

function toAgent(row: RawAgent): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    persona: row.persona,
    instructions: row.instructions,
    kind: row.kind,
    skillIds: JSON.parse(row.skill_ids) as string[],
    builtin: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface RawHook {
  id: string
  event: HookEvent
  scope_workflow_id: string | null
  action_type: HookAction['type']
  connection: string | null
  channel: string | null
  failure_count: number | null
  enabled: number
  created_at: number
  updated_at: number
}

interface RawSkill {
  id: string
  name: string
  description: string
  body: string
  created_at: number
  updated_at: number
}

const HOOK_COLUMNS = 'id, event, scope_workflow_id, action_type, connection, channel, failure_count, enabled, created_at, updated_at'

function toHookAction(row: RawHook): HookAction {
  switch (row.action_type) {
    case 'notify':
      return { type: 'notify', connection: row.connection ?? '', ...(row.channel === null ? {} : { channel: row.channel }) }
    case 'deactivateAfterFailures':
      return { type: 'deactivateAfterFailures', count: row.failure_count ?? 0 }
    case 'record':
      return { type: 'record' }
  }
}

function toHook(row: RawHook): Hook {
  return {
    id: row.id,
    event: row.event,
    scope: row.scope_workflow_id === null ? { type: 'all' } : { type: 'workflow', workflowId: row.scope_workflow_id },
    action: toHookAction(row),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface RawHookLog {
  id: number
  hook_id: string
  at: number
  event: HookEvent
  workflow_id: string
  outcome: HookOutcome
  code: HookFailureCode | null
}

export type HookLogInput = Omit<HookLogEntry, 'id'>

const SKILL_COLUMNS = 'id, name, description, body, created_at, updated_at'

function toSkill(row: RawSkill): Skill {
  return { id: row.id, name: row.name, description: row.description, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at }
}

function textLength(text: string): number {
  return [...text].length
}

export type AgentSaveInput = AgentFields & { id?: string; kind?: AgentKind; skillIds?: readonly string[] }

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
  agent_id: string | null
}

const PLAN_COLUMNS =
  'id, created_at, status, effort, model, request_text, attachments, result, meta, error, workflow_hash, flag_keys, workflow_id, confirmed, memory_ids, agent_id'

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
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
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
  private hookChanges = 0

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  get hooksRevision(): number {
    return this.hookChanges
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

  hasWorkflow(id: string): boolean {
    return this.db.get<{ found: number }>('SELECT 1 AS found FROM workflows WHERE id = ?', id) !== undefined
  }

  deleteWorkflow(id: string): void {
    const hooksDeleted = this.db.transaction(() => {
      const ownRuns = 'SELECT id FROM runs WHERE workflow_id = ?'
      this.db.run('UPDATE plans SET workflow_id = NULL WHERE workflow_id = ?', id)
      const ownHooks = this.db.run('DELETE FROM hooks WHERE scope_workflow_id = ?', id)
      this.db.run(
        `DELETE FROM idempotency_journal WHERE key IN (SELECT idempotency_key FROM step_attempts WHERE run_id IN (${ownRuns}))`,
        id,
      )
      this.db.run(`DELETE FROM step_attempts WHERE run_id IN (${ownRuns})`, id)
      this.db.run('DELETE FROM runs WHERE workflow_id = ?', id)
      this.db.run('DELETE FROM trigger_state WHERE workflow_id = ?', id)
      this.db.run('DELETE FROM seen_files WHERE workflow_id = ?', id)
      if (this.db.run('DELETE FROM workflows WHERE id = ?', id) === 0) throw new NotFoundError(`workflow not found: ${id}`)
      return ownHooks
    })
    if (hooksDeleted > 0) this.hookChanges += 1
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
      `INSERT INTO plans (${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
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
      record.agentId ?? null,
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

  listRules(): Rule[] {
    return this.db
      .all<RawRule>('SELECT id, kind, value, created_at FROM rules ORDER BY created_at, rowid')
      .map((row) => ({ id: row.id, kind: row.kind, value: row.value, createdAt: row.created_at }))
  }

  saveRule(input: { kind: RuleKind; value: string }): Rule {
    return this.db.transaction(() => {
      if (input.kind === 'maxPlanEffort') {
        const existing = this.db.get<RawRule>("SELECT id, kind, value, created_at FROM rules WHERE kind = 'maxPlanEffort'")
        if (existing !== undefined) {
          this.db.run('UPDATE rules SET value = ? WHERE id = ?', input.value, existing.id)
          return { id: existing.id, kind: input.kind, value: input.value, createdAt: existing.created_at }
        }
      }
      if (this.db.get('SELECT 1 AS found FROM rules WHERE kind = ? AND value = ?', input.kind, input.value) !== undefined) throw new RuleDuplicateError()
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rules')?.n ?? 0
      if (count >= RULE_MAX_ITEMS) throw new RuleFullError()
      const id = randomUUID()
      const at = this.now()
      this.db.run('INSERT INTO rules (id, kind, value, created_at) VALUES (?, ?, ?, ?)', id, input.kind, input.value, at)
      return { id, kind: input.kind, value: input.value, createdAt: at }
    })
  }

  deleteRule(id: string): boolean {
    return this.db.run('DELETE FROM rules WHERE id = ?', id) > 0
  }

  listAgents(): { agents: Agent[]; activeId: string } {
    const rows = this.db.all<RawAgent>(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY name_key, rowid`).map(toAgent)
    return { agents: [builtinAgent(), ...rows], activeId: this.activeAgentId() }
  }

  getAgent(id: string): Agent | undefined {
    if (id === AGENT_DEFAULT_ID) return builtinAgent()
    const row = this.db.get<RawAgent>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, id)
    return row === undefined ? undefined : toAgent(row)
  }

  saveAgent(input: AgentSaveInput): Agent {
    if (input.id === AGENT_DEFAULT_ID) throw new AgentBuiltinError()
    const fields = normaliseAgent(input)
    if (isReservedAgentName(fields.name)) throw new AgentDuplicateError()
    const key = agentNameKey(fields.name)
    return this.db.transaction(() => {
      const at = this.now()
      if (input.skillIds !== undefined) {
        const problem = this.skillListProblem(input.skillIds)
        if (problem !== undefined) throw new AgentInvalidError([], [problem])
      }
      if (input.id !== undefined) {
        const row = this.db.get<RawAgent>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, input.id)
        if (!row) throw new AgentNotFoundError()
        if (input.kind === 'reviewer' && this.storedActiveAgentId() === input.id) throw new AgentNotAssistantError()
        if (this.db.get('SELECT 1 AS found FROM agents WHERE name_key = ? AND id != ?', key, input.id) !== undefined) throw new AgentDuplicateError()
        const kind = input.kind ?? row.kind
        const skillIds = input.skillIds === undefined ? (JSON.parse(row.skill_ids) as string[]) : [...input.skillIds]
        this.db.run(
          'UPDATE agents SET name = ?, name_key = ?, description = ?, persona = ?, instructions = ?, kind = ?, skill_ids = ?, updated_at = ? WHERE id = ?',
          fields.name,
          key,
          fields.description,
          fields.persona,
          fields.instructions,
          kind,
          JSON.stringify(skillIds),
          at,
          input.id,
        )
        return { ...toAgent(row), ...fields, kind, skillIds, updatedAt: at }
      }
      if (this.db.get('SELECT 1 AS found FROM agents WHERE name_key = ?', key) !== undefined) throw new AgentDuplicateError()
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents')?.n ?? 0
      if (count >= AGENT_MAX_ITEMS) throw new AgentFullError(AGENT_MAX_ITEMS)
      const id = randomUUID()
      const kind = input.kind ?? 'assistant'
      const skillIds = [...(input.skillIds ?? [])]
      this.db.run(
        'INSERT INTO agents (id, name, name_key, description, persona, instructions, kind, skill_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        fields.name,
        key,
        fields.description,
        fields.persona,
        fields.instructions,
        kind,
        JSON.stringify(skillIds),
        at,
        at,
      )
      return { id, ...fields, kind, skillIds, builtin: false, createdAt: at, updatedAt: at }
    })
  }

  private skillListProblem(ids: readonly string[]): AgentSkillRule | undefined {
    const rows = this.skillsOf(ids)
    if (rows.length < new Set(ids).size) return 'unknown'
    return rows.reduce((total, skill) => total + textLength(skill.body), 0) > AGENT_SKILLS_MAX_CHARS ? 'too_large' : undefined
  }

  deleteAgent(id: string): boolean {
    if (id === AGENT_DEFAULT_ID) throw new AgentBuiltinError()
    return this.db.transaction(() => {
      const deleted = this.db.run('DELETE FROM agents WHERE id = ?', id) > 0
      if (deleted && this.storedActiveAgentId() === id) this.db.run('DELETE FROM app_state WHERE key = ?', ACTIVE_AGENT_KEY)
      return deleted
    })
  }

  setActiveAgent(id: string): void {
    this.db.transaction(() => {
      if (id === AGENT_DEFAULT_ID) {
        this.db.run('DELETE FROM app_state WHERE key = ?', ACTIVE_AGENT_KEY)
        return
      }
      const row = this.db.get<{ kind: AgentKind }>('SELECT kind FROM agents WHERE id = ?', id)
      if (row === undefined) throw new AgentNotFoundError()
      if (row.kind === 'reviewer') throw new AgentNotAssistantError()
      this.db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ACTIVE_AGENT_KEY, id)
    })
  }

  private storedActiveAgentId(): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM app_state WHERE key = ?', ACTIVE_AGENT_KEY)?.value
  }

  private activeAgentId(): string {
    const stored = this.storedActiveAgentId()
    if (stored === undefined || this.db.get('SELECT 1 AS found FROM agents WHERE id = ?', stored) === undefined) return AGENT_DEFAULT_ID
    return stored
  }

  listHooks(): Hook[] {
    return this.db.all<RawHook>(`SELECT ${HOOK_COLUMNS} FROM hooks ORDER BY created_at, rowid`).map(toHook)
  }

  saveHook(input: HookInput & { id?: string }): Hook {
    const key = hookKey(input)
    const { action } = input
    const columns = [
      input.event,
      input.scope.type === 'all' ? null : input.scope.workflowId,
      action.type,
      action.type === 'notify' ? action.connection : null,
      action.type === 'notify' ? (action.channel ?? null) : null,
      action.type === 'deactivateAfterFailures' ? action.count : null,
      input.enabled ? 1 : 0,
      key,
    ]
    const saved = this.db.transaction(() => {
      const at = this.now()
      if (input.id !== undefined) {
        const row = this.db.get<RawHook>(`SELECT ${HOOK_COLUMNS} FROM hooks WHERE id = ?`, input.id)
        if (!row) throw new HookNotFoundError()
        if (this.db.get('SELECT 1 AS found FROM hooks WHERE dedupe_key = ? AND id != ?', key, input.id) !== undefined) {
          throw new HookInvalidError([{ field: 'hook', rule: 'duplicate' }])
        }
        this.db.run(
          'UPDATE hooks SET event = ?, scope_workflow_id = ?, action_type = ?, connection = ?, channel = ?, failure_count = ?, enabled = ?, dedupe_key = ?, updated_at = ? WHERE id = ?',
          ...columns,
          at,
          input.id,
        )
        return this.db.get<RawHook>(`SELECT ${HOOK_COLUMNS} FROM hooks WHERE id = ?`, input.id)!
      }
      if (this.db.get('SELECT 1 AS found FROM hooks WHERE dedupe_key = ?', key) !== undefined) throw new HookInvalidError([{ field: 'hook', rule: 'duplicate' }])
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM hooks')?.n ?? 0
      if (count >= HOOK_MAX_ITEMS) throw new HookFullError()
      const id = randomUUID()
      this.db.run(
        'INSERT INTO hooks (id, event, scope_workflow_id, action_type, connection, channel, failure_count, enabled, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        ...columns,
        at,
        at,
      )
      return this.db.get<RawHook>(`SELECT ${HOOK_COLUMNS} FROM hooks WHERE id = ?`, id)!
    })
    this.hookChanges += 1
    return toHook(saved)
  }

  deleteHook(id: string): boolean {
    const deleted = this.db.run('DELETE FROM hooks WHERE id = ?', id) > 0
    if (deleted) this.hookChanges += 1
    return deleted
  }

  appendHookLog(entry: HookLogInput): void {
    this.db.run(
      'INSERT INTO hook_log (hook_id, at, event, workflow_id, outcome, code) VALUES (?, ?, ?, ?, ?, ?)',
      entry.hookId,
      entry.at,
      entry.event,
      entry.workflowId,
      entry.outcome,
      entry.code,
    )
    const readByLimits = "SELECT id FROM hook_log WHERE outcome IN ('ok', 'failed') AND at > ? ORDER BY id DESC LIMIT ?"
    this.db.run(
      `DELETE FROM hook_log WHERE id NOT IN (SELECT id FROM hook_log ORDER BY id DESC LIMIT ?) AND id NOT IN (${readByLimits})`,
      HOOK_LOG_MAX_ROWS,
      entry.at - HOOK_RATE_WINDOW_MS,
      HOOK_RATE_LIMIT,
    )
  }

  listHookLog(options: { limit: number; hookId?: string }): HookLogEntry[] {
    const where = options.hookId === undefined ? '' : 'WHERE hook_id = ?'
    const params = options.hookId === undefined ? [options.limit] : [options.hookId, options.limit]
    return this.db
      .all<RawHookLog>(`SELECT id, hook_id, at, event, workflow_id, outcome, code FROM hook_log ${where} ORDER BY id DESC LIMIT ?`, ...params)
      .map((row) => ({ id: row.id, hookId: row.hook_id, at: row.at, event: row.event, workflowId: row.workflow_id, outcome: row.outcome, code: row.code }))
  }

  workflowName(id: string): string | undefined {
    return this.db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', id)?.name
  }

  isWorkflowActive(id: string): boolean {
    return this.db.get<{ active: number }>('SELECT active FROM workflows WHERE id = ?', id)?.active === 1
  }

  recentFinishedRuns(workflowId: string, limit: number): Array<{ id: string; status: RunStatus }> {
    return this.db.all<{ id: string; status: RunStatus }>(
      "SELECT id, status FROM runs WHERE workflow_id = ? AND dry_run = 0 AND status IN ('succeeded', 'failed', 'cancelled') ORDER BY finished_at DESC, rowid DESC LIMIT ?",
      workflowId,
      limit,
    )
  }

  lastHookExecution(hookId: string): number | undefined {
    return this.db.get<{ at: number | null }>("SELECT MAX(at) AS at FROM hook_log WHERE hook_id = ? AND outcome IN ('ok', 'failed')", hookId)?.at ?? undefined
  }

  hookExecutionsSince(at: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM hook_log WHERE outcome IN ('ok', 'failed') AND at > ?", at)?.n ?? 0
  }

  listSkills(): Skill[] {
    return this.db.all<RawSkill>(`SELECT ${SKILL_COLUMNS} FROM skills ORDER BY name_key, rowid`).map(toSkill)
  }

  skillsOf(ids: readonly string[]): Skill[] {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const marks = unique.map(() => '?').join(', ')
    return this.db.all<RawSkill>(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id IN (${marks}) ORDER BY name_key, rowid`, ...unique).map(toSkill)
  }

  saveSkill(input: SkillFields & { id?: string }): Skill {
    const fields = normaliseSkill(input)
    const key = skillNameKey(fields.name)
    return this.db.transaction(() => {
      const at = this.now()
      if (input.id !== undefined) {
        const row = this.db.get<RawSkill>(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ?`, input.id)
        if (!row) throw new SkillNotFoundError()
        if (this.db.get('SELECT 1 AS found FROM skills WHERE name_key = ? AND id != ?', key, input.id) !== undefined) throw new SkillDuplicateError()
        const broken = this.agentsBrokenBy(input.id, textLength(fields.body))
        if (broken > 0) throw new SkillInvalidError([{ field: 'body', rule: 'too_large_for_agent', agents: broken }])
        this.db.run('UPDATE skills SET name = ?, name_key = ?, description = ?, body = ?, updated_at = ? WHERE id = ?', fields.name, key, fields.description, fields.body, at, input.id)
        return { ...toSkill(row), ...fields, updatedAt: at }
      }
      if (this.db.get('SELECT 1 AS found FROM skills WHERE name_key = ?', key) !== undefined) throw new SkillDuplicateError()
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM skills')?.n ?? 0
      if (count >= SKILL_MAX_ITEMS) throw new SkillFullError()
      const id = randomUUID()
      this.db.run('INSERT INTO skills (id, name, name_key, description, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, fields.name, key, fields.description, fields.body, at, at)
      return { id, ...fields, createdAt: at, updatedAt: at }
    })
  }

  private agentsBrokenBy(skillId: string, newLength: number): number {
    let broken = 0
    for (const { skillIds } of this.agentSkillLists()) {
      if (!skillIds.includes(skillId)) continue
      const lengths = new Map(this.skillsOf(skillIds).map((skill) => [skill.id, textLength(skill.body)]))
      lengths.set(skillId, newLength)
      if ([...lengths.values()].reduce((total, length) => total + length, 0) > AGENT_SKILLS_MAX_CHARS) broken += 1
    }
    return broken
  }

  private agentSkillLists(): Array<{ id: string; skillIds: string[] }> {
    return this.db
      .all<{ id: string; skill_ids: string }>("SELECT id, skill_ids FROM agents WHERE skill_ids != '[]' ORDER BY rowid")
      .map((row) => ({ id: row.id, skillIds: JSON.parse(row.skill_ids) as string[] }))
  }

  deleteSkill(id: string): boolean {
    return this.db.transaction(() => {
      if (this.db.run('DELETE FROM skills WHERE id = ?', id) === 0) return false
      for (const agent of this.agentSkillLists()) {
        if (!agent.skillIds.includes(id)) continue
        this.db.run('UPDATE agents SET skill_ids = ? WHERE id = ?', JSON.stringify(agent.skillIds.filter((skillId) => skillId !== id)), agent.id)
      }
      return true
    })
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
