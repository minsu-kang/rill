import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkflowValidationError, computeBackoff } from '../src/engine'
import { createTestEngine, linearWorkflow } from './helpers'

const trigger = { id: 't1', type: 'trigger.manual@1' }

describe('computeBackoff', () => {
  it('doubles per failure, caps at 30s, and applies jitter', () => {
    expect(computeBackoff(1, 500, () => 1)).toBe(500)
    expect(computeBackoff(3, 500, () => 1)).toBe(2000)
    expect(computeBackoff(10, 500, () => 1)).toBe(30_000)
    expect(computeBackoff(2, 500, () => 0.5)).toBe(500)
    expect(computeBackoff(2, 500, () => 0)).toBe(0)
  })
})

describe('Engine.deploy', () => {
  it('rejects a malformed workflow', () => {
    const { engine } = createTestEngine()
    expect(() => engine.deploy({ nope: true })).toThrow(WorkflowValidationError)
  })

  it('rejects structural problems', () => {
    const { engine } = createTestEngine()
    const wf = linearWorkflow([{ id: 'a', type: 'test.echo@1', config: { value: 1 } }])
    expect(() => engine.deploy(wf)).toThrow('exactly 1 trigger')
  })

  it('rejects unknown node types and trigger/action mix-ups', () => {
    const { engine } = createTestEngine()
    expect(() => engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'nope.nothing@1' }]))).toThrow(
      'unknown node type: nope.nothing@1',
    )
    expect(() => engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'trigger.manual@1' }]))).toThrow()
  })

  it('stores a valid workflow and returns its id', () => {
    const { engine } = createTestEngine()
    const id = engine.deploy(linearWorkflow([trigger, { id: 'a', type: 'test.echo@1', config: { value: 1 } }]))
    expect(engine.store.getWorkflow(id).name).toBe('test')
  })
})

describe('Engine.startRun', () => {
  it('runs a chain, passing payload and outputs through templates', async () => {
    const { engine } = createTestEngine()
    const id = engine.deploy(
      linearWorkflow([
        trigger,
        { id: 'n1', type: 'test.echo@1', config: { value: '{{t1.output.amount}}' } },
        { id: 'n2', type: 'transform@1', config: { values: { doubled: '{{n1.output.value}}', label: 'x' } } },
      ]),
    )
    const result = await engine.startRun(id, { amount: 12 })
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ t1: { amount: 12 }, n1: { value: 12 }, n2: { doubled: 12, label: 'x' } })
    expect(engine.store.getRun(result.runId).status).toBe('succeeded')
    expect(engine.store.listAttempts(result.runId).map((a) => [a.nodeId, a.attempt, a.status])).toEqual([
      ['n1', 1, 'succeeded'],
      ['n2', 1, 'succeeded'],
    ])
  })

  it('retries retryable errors with backoff until success', async () => {
    const { engine, sleeps } = createTestEngine()
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'n1', type: 'test.flaky@1', config: { failTimes: 2 }, retry: { maxAttempts: 3 } }]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('succeeded')
    expect(sleeps).toEqual([500, 1000])
    expect(engine.store.listAttempts(result.runId).map((a) => a.status)).toEqual(['failed', 'failed', 'succeeded'])
  })

  it('fails the run when retries are exhausted', async () => {
    const { engine } = createTestEngine()
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'n1', type: 'test.flaky@1', config: { failTimes: 5 }, retry: { maxAttempts: 2 } }]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('node n1 failed: transient 2')
    expect(engine.store.getRun(result.runId)).toMatchObject({ status: 'failed' })
    expect(engine.store.listAttempts(result.runId)).toHaveLength(2)
  })

  it('does not retry plain errors', async () => {
    const calls: string[] = []
    const { engine, sleeps } = createTestEngine({ calls })
    const id = engine.deploy(linearWorkflow([trigger, { id: 'n1', type: 'test.fail@1', retry: { maxAttempts: 3 } }]))
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(calls).toEqual(['n1'])
    expect(sleeps).toEqual([])
  })

  it('fails a node with an invalid config without running it', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const id = engine.deploy(linearWorkflow([trigger, { id: 'n1', type: 'test.echo@1', config: {} }]))
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('invalid config')
    expect(calls).toEqual([])
    expect(engine.store.listAttempts(result.runId).map((a) => a.status)).toEqual(['failed'])
  })

  it('fails a node whose template cannot be resolved', async () => {
    const { engine } = createTestEngine()
    const id = engine.deploy(
      linearWorkflow([trigger, { id: 'n1', type: 'test.echo@1', config: { value: '{{ghost.output.x}}' } }]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('unresolved reference: ghost.output.x')
  })

  it('continues past a failed node when onError is continue', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const id = engine.deploy(
      linearWorkflow([
        trigger,
        { id: 'n1', type: 'test.fail@1', onError: 'continue' },
        { id: 'n2', type: 'test.echo@1', config: { value: 'after' } },
      ]),
    )
    const result = await engine.startRun(id)
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toBeNull()
    expect(calls).toEqual(['n1', 'n2'])
  })

  it('passes dryRun to nodes so side effects are skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rill-dry-'))
    const file = join(dir, 'out.csv')
    try {
      const { engine } = createTestEngine()
      const id = engine.deploy(linearWorkflow([trigger, { id: 'n1', type: 'csv.append@1', config: { file, row: ['a'] } }]))
      const result = await engine.startRun(id, {}, { dryRun: true })
      expect(result.status).toBe('succeeded')
      expect(result.outputs.n1).toEqual({ file, written: false })
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
