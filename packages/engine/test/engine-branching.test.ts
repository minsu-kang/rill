import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { createTestEngine, createTestRegistry } from './helpers'

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config })
const echo = (id: string, value: unknown) => node(id, 'test.echo@1', { value })

function branching(extraNodes: unknown[] = [], extraEdges: unknown[] = []): unknown {
  return {
    schemaVersion: 1,
    name: 'branching',
    nodes: [
      node('t1', 'trigger.manual@1'),
      node('c1', 'condition@1', { left: '{{t1.output.amount}}', operator: 'gt', right: 100 }),
      echo('big', 'big'),
      echo('small', 'small'),
      ...extraNodes,
    ],
    edges: [
      { from: 't1', to: 'c1' },
      { from: 'c1', to: 'big', when: 'true' },
      { from: 'c1', to: 'small', when: 'false' },
      ...extraEdges,
    ],
  }
}

const statuses = (engine: Pick<Engine, 'store'>, runId: string) =>
  Object.fromEntries(engine.store.listAttempts(runId).map((a) => [a.nodeId, a.status]))

describe('branching', () => {
  it('runs only the branch whose condition matched', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const result = await engine.startRun(engine.deploy(branching()), { amount: 150 })
    expect(result.status).toBe('succeeded')
    expect(calls).toEqual(['big'])
    expect(result.outputs).toHaveProperty('big')
    expect(result.outputs).not.toHaveProperty('small')
    expect(statuses(engine, result.runId)).toEqual({ c1: 'succeeded', big: 'succeeded', small: 'skipped' })
  })

  it('takes the other branch when the condition is false', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const result = await engine.startRun(engine.deploy(branching()), { amount: 50 })
    expect(calls).toEqual(['small'])
    expect(statuses(engine, result.runId)).toEqual({ c1: 'succeeded', big: 'skipped', small: 'succeeded' })
  })

  it('runs a joining node when any one incoming edge is active', async () => {
    const extraNodes = [echo('after', 'joined')]
    const extraEdges = [
      { from: 'big', to: 'after' },
      { from: 'small', to: 'after' },
    ]
    for (const amount of [150, 50]) {
      const calls: string[] = []
      const { engine } = createTestEngine({ calls })
      const result = await engine.startRun(engine.deploy(branching(extraNodes, extraEdges)), { amount })
      expect(result.status).toBe('succeeded')
      expect(calls.at(-1)).toBe('after')
      expect(calls).toHaveLength(2)
    }
  })

  it('skips everything that depends only on a skipped node', async () => {
    const { engine } = createTestEngine()
    const wf = branching([echo('small_next', 'x')], [{ from: 'small', to: 'small_next' }])
    const result = await engine.startRun(engine.deploy(wf), { amount: 150 })
    expect(statuses(engine, result.runId)).toMatchObject({ small: 'skipped', small_next: 'skipped' })
  })

  it('lets exists take the false branch when a payload field is missing', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const wf = {
      schemaVersion: 1,
      name: 'optional',
      nodes: [
        node('t1', 'trigger.manual@1'),
        node('c1', 'condition@1', { left: '{{t1.output.email}}', operator: 'exists' }),
        echo('has', 'has'),
        echo('none', 'none'),
      ],
      edges: [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'has', when: 'true' },
        { from: 'c1', to: 'none', when: 'false' },
      ],
    }
    const id = engine.deploy(wf)
    expect((await engine.startRun(id, { name: 'a' })).status).toBe('succeeded')
    expect((await engine.startRun(id, { email: 'a@b.c' })).status).toBe('succeeded')
    expect(calls).toEqual(['none', 'has'])
  })

  it('follows unconditional edges but not when edges after a tolerated failure', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const wf = {
      schemaVersion: 1,
      name: 'tolerated',
      nodes: [
        node('t1', 'trigger.manual@1'),
        { ...node('c1', 'condition@1', { left: 5, operator: 'gt', right: '3' }), onError: 'continue' },
        echo('a', 'a'),
        echo('b', 'b'),
      ],
      edges: [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'a' },
        { from: 'c1', to: 'b', when: 'true' },
      ],
    }
    const result = await engine.startRun(engine.deploy(wf))
    expect(result.status).toBe('succeeded')
    expect(result.outputs.c1).toBeNull()
    expect(calls).toEqual(['a'])
    expect(statuses(engine, result.runId)).toEqual({ c1: 'continued', a: 'succeeded', b: 'skipped' })
  })

  it('fails a node that reads the output of a skipped branch', async () => {
    const { engine } = createTestEngine()
    const wf = branching(
      [echo('after', '{{big.output.value}}')],
      [
        { from: 'big', to: 'after' },
        { from: 'small', to: 'after' },
      ],
    )
    const result = await engine.startRun(engine.deploy(wf), { amount: 50 })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('unresolved reference: big.output.value')
  })
})

describe('deploy checks', () => {
  it('rejects a reference to a node on a sibling branch', () => {
    const { engine } = createTestEngine()
    const wf = branching([echo('bad', '{{big.output.value}}')], [{ from: 'small', to: 'bad' }])
    expect(() => engine.deploy(wf)).toThrow('bad: reference to big which does not run before it')
  })

  it('rejects a malformed template', () => {
    const { engine } = createTestEngine()
    const wf = {
      schemaVersion: 1,
      name: 'typo',
      nodes: [node('t1', 'trigger.manual@1'), echo('x', '{{t1.outputs.amount}}')],
      edges: [{ from: 't1', to: 'x' }],
    }
    expect(() => engine.deploy(wf)).toThrow('x: malformed template {{t1.outputs.amount}}')
  })

  it('rejects a when edge from a node that never produces a branch', () => {
    const { engine } = createTestEngine()
    const wf = {
      schemaVersion: 1,
      name: 'no-branch',
      nodes: [node('t1', 'trigger.manual@1'), echo('e1', 1), echo('x', 2)],
      edges: [
        { from: 't1', to: 'e1' },
        { from: 'e1', to: 'x', when: 'true' },
      ],
    }
    expect(() => engine.deploy(wf)).toThrow('e1 never produces a branch')
  })

  it('rejects a when label the source cannot produce', () => {
    const { engine } = createTestEngine()
    const wf = {
      schemaVersion: 1,
      name: 'typo-label',
      nodes: [
        node('t1', 'trigger.manual@1'),
        node('c1', 'condition@1', { left: 1, operator: 'eq', right: 1 }),
        echo('a', 'a'),
      ],
      edges: [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'a', when: 'True' },
      ],
    }
    expect(() => engine.deploy(wf)).toThrow('"True" is not one of true, false')
  })
})

describe('resuming a branching run', () => {
  it('does not run the skipped branch or record its skip twice', async () => {
    const calls: string[] = []
    const { engine } = createTestEngine({ calls })
    const workflowId = engine.deploy(branching())
    const store = engine.store
    const run = store.createRun({ workflowId, payload: { amount: 150 }, dryRun: false })
    store.markRunRunning(run.id)
    const first = store.startAttempt({ runId: run.id, nodeId: 'c1', input: {}, idempotencyKey: `${run.id}:c1` })
    store.finishAttempt(run.id, 'c1', first, { status: 'succeeded', output: { result: true, branch: 'true' } })
    store.recordSkipped(run.id, 'small', `${run.id}:small`)
    store.startAttempt({ runId: run.id, nodeId: 'big', input: { value: 'big' }, idempotencyKey: `${run.id}:big` })

    const [result] = await engine.recover()

    expect(result?.status).toBe('succeeded')
    expect(calls).toEqual(['big'])
    expect(store.listAttempts(run.id).filter((a) => a.nodeId === 'small')).toHaveLength(1)
    expect(statuses(engine, run.id)).toEqual({ c1: 'succeeded', big: 'succeeded', small: 'skipped' })
  })

  it('does not run a tolerated failure again or flip a branch that was already skipped', async () => {
    const calls: string[] = []
    const db = Db.open(':memory:')
    const flip = defineAction({
      type: 'test.flip@1',
      title: 'Flip',
      description: 'Fails on its first attempt only.',
      sideEffect: 'external',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ branch: Type.Union([Type.Literal('yes'), Type.Literal('no')]) }),
      execute: async (_config, ctx) => {
        calls.push(`${ctx.nodeId}#${ctx.attempt}`)
        if (ctx.attempt === 1) throw new Error('first attempt fails')
        return { branch: 'yes' as const }
      },
    })
    const engine = new Engine({ db, registry: createTestRegistry(calls).register(flip), sleep: async () => {} })
    const wf = {
      schemaVersion: 1,
      name: 'flip',
      nodes: [
        node('t1', 'trigger.manual@1'),
        { ...node('x', 'test.flip@1'), onError: 'continue' },
        echo('y', 'y'),
        echo('z', 'z'),
      ],
      edges: [
        { from: 't1', to: 'x' },
        { from: 'x', to: 'y', when: 'yes' },
        { from: 'x', to: 'z' },
      ],
    }
    const first = await engine.startRun(engine.deploy(wf))
    expect(first.status).toBe('succeeded')
    expect(calls).toEqual(['x#1', 'z'])

    db.run("UPDATE runs SET status = 'running' WHERE id = ?", first.runId)
    const [second] = await engine.recover()

    expect(second?.status).toBe('succeeded')
    expect(calls).toEqual(['x#1', 'z'])
    expect(statuses(engine, first.runId)).toEqual({ x: 'continued', y: 'skipped', z: 'succeeded' })
  })
})

describe('services', () => {
  it('waits through the engine sleep in a delay node', async () => {
    const { engine, sleeps } = createTestEngine()
    const wf = {
      schemaVersion: 1,
      name: 'delay',
      nodes: [node('t1', 'trigger.manual@1'), node('d1', 'delay@1', { ms: 5000 })],
      edges: [{ from: 't1', to: 'd1' }],
    }
    const result = await engine.startRun(engine.deploy(wf))
    expect(result.status).toBe('succeeded')
    expect(sleeps).toEqual([5000])
  })

  it('confines file nodes to the allowed roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rill-roots-'))
    const allowed = join(dir, 'allowed')
    const other = join(dir, 'other')
    mkdirSync(allowed)
    mkdirSync(other)
    try {
      const engine = new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: [allowed] })
      const workflow = (file: string) => ({
        schemaVersion: 1,
        name: 'csv',
        nodes: [node('t1', 'trigger.manual@1'), node('n1', 'csv.append@1', { file, row: ['a'] })],
        edges: [{ from: 't1', to: 'n1' }],
      })
      const ok = await engine.startRun(engine.deploy(workflow(join(allowed, 'ok.csv'))))
      expect(ok.status).toBe('succeeded')
      expect(readFileSync(join(allowed, 'ok.csv'), 'utf8')).toBe('a\n')

      const denied = await engine.startRun(engine.deploy(workflow(join(other, 'no.csv'))))
      expect(denied.status).toBe('failed')
      expect(denied.error).toContain('outside the allowed folders')
      expect(existsSync(join(other, 'no.csv'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
