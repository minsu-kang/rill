import type { Workflow } from '@rill/dsl'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { MIGRATIONS } from '../src/migrations'
import { DuplicateFileError, Store } from '../src/store'

const workflow: Workflow = {
  schemaVersion: 1,
  name: 'wf',
  nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
  edges: [],
}

let store: Store
let workflowId: string

beforeEach(() => {
  store = new Store(Db.open(':memory:'))
  workflowId = store.saveWorkflow(workflow)
})

describe('saveWorkflow', () => {
  it('returns the existing id for an identical workflow and a new id otherwise', () => {
    expect(store.saveWorkflow(workflow)).toBe(workflowId)
    expect(store.saveWorkflow({ ...workflow, name: 'other' })).not.toBe(workflowId)
  })
})

describe('activation', () => {
  it('stores the active flag and lists active workflows in creation order', () => {
    const second = store.saveWorkflow({ ...workflow, name: 'second' })
    expect(store.listActiveWorkflowIds()).toEqual([])
    store.setWorkflowActive(second, true)
    store.setWorkflowActive(workflowId, true)
    expect(store.listActiveWorkflowIds()).toEqual([workflowId, second])
    store.setWorkflowActive(workflowId, false)
    expect(store.listActiveWorkflowIds()).toEqual([second])
  })
})

describe('trigger state', () => {
  it('is empty until saved, then upserts', () => {
    expect(store.getTriggerState(workflowId)).toBeUndefined()
    store.saveTriggerState(workflowId, { nextFireAt: 100, lastFireAt: null })
    expect(store.getTriggerState(workflowId)).toEqual({ nextFireAt: 100, lastFireAt: null })
    store.saveTriggerState(workflowId, { nextFireAt: 200, lastFireAt: 100 })
    expect(store.getTriggerState(workflowId)).toEqual({ nextFireAt: 200, lastFireAt: 100 })
  })

  it('clears only the next fire time', () => {
    store.saveTriggerState(workflowId, { nextFireAt: 100, lastFireAt: 50 })
    store.clearNextFire(workflowId)
    expect(store.getTriggerState(workflowId)).toEqual({ nextFireAt: null, lastFireAt: 50 })
    store.clearNextFire('unknown')
  })
})

describe('seen files and triggered runs', () => {
  it('records fingerprints once and says whether it added one', () => {
    expect(store.hasSeenFile(workflowId, 'fp')).toBe(false)
    expect(store.markFileSeen(workflowId, 'fp', '/a.pdf', null)).toBe(true)
    expect(store.markFileSeen(workflowId, 'fp', '/a.pdf', null)).toBe(false)
    expect(store.hasSeenFile(workflowId, 'fp')).toBe(true)
    expect(store.hasSeenFile(workflowId, 'other')).toBe(false)
  })

  it('creates the run and the seen record together', () => {
    const run = store.createTriggeredRun({
      workflowId,
      payload: { file: '/a.pdf' },
      fingerprint: { value: 'fp', path: '/a.pdf' },
    })
    expect(run).toMatchObject({ workflowId, status: 'queued', payload: { file: '/a.pdf' } })
    expect(store.hasSeenFile(workflowId, 'fp')).toBe(true)
  })

  it('refuses to create a second run for a file that was already delivered', () => {
    const fingerprint = { value: 'fp', path: '/a.pdf' }
    store.createTriggeredRun({ workflowId, payload: {}, fingerprint })
    expect(() => store.createTriggeredRun({ workflowId, payload: {}, fingerprint })).toThrow(DuplicateFileError)
    expect(store.listRunsByStatus('queued')).toHaveLength(1)
  })

  it('creates a plain triggered run without a fingerprint', () => {
    const run = store.createTriggeredRun({ workflowId, payload: { a: 1 } })
    expect(run.status).toBe('queued')
  })

  it('rolls back the run when the fingerprint cannot be stored', () => {
    expect(() =>
      store.createTriggeredRun({ workflowId: 'missing-workflow', payload: {}, fingerprint: { value: 'fp', path: '/x' } }),
    ).toThrow()
    expect(store.listRunsByStatus('queued')).toEqual([])
  })
})

describe('hasActiveRun', () => {
  it('is true while a run is queued or running and false once it finishes', () => {
    expect(store.hasActiveRun(workflowId)).toBe(false)
    const run = store.createRun({ workflowId, payload: {}, dryRun: false })
    expect(store.hasActiveRun(workflowId)).toBe(true)
    store.markRunRunning(run.id)
    expect(store.hasActiveRun(workflowId)).toBe(true)
    store.finishRun(run.id, 'succeeded')
    expect(store.hasActiveRun(workflowId)).toBe(false)
  })
})

describe('migration 3', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rill-mig3-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('upgrades a v2 database in place and keeps its data', () => {
    const path = join(dir, 'v2.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
    raw.exec(MIGRATIONS[0]!)
    raw.exec(MIGRATIONS[1]!)
    raw.exec('INSERT INTO schema_migrations (version) VALUES (1), (2)')
    raw.exec("INSERT INTO workflows (id, name, dsl, active, created_at) VALUES ('w', 'wf', '{}', 1, 1)")
    raw.close()

    const db = Db.open(path)
    const versions = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6])
    const upgraded = new Store(db)
    expect(upgraded.listActiveWorkflowIds()).toEqual(['w'])
    upgraded.saveTriggerState('w', { nextFireAt: 5, lastFireAt: null })
    expect(upgraded.getTriggerState('w')).toEqual({ nextFireAt: 5, lastFireAt: null })
    db.close()
  })

  it('keeps the foreign keys to workflows', () => {
    const db = Db.open(':memory:')
    expect(() =>
      db.run("INSERT INTO trigger_state (workflow_id, next_fire_at, last_fire_at) VALUES ('missing', 1, NULL)"),
    ).toThrow()
    expect(() =>
      db.run("INSERT INTO seen_files (workflow_id, fingerprint, path, seen_at) VALUES ('missing', 'f', '/p', 1)"),
    ).toThrow()
    db.close()
  })
})
