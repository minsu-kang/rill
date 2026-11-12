import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANTHROPIC_CAPABILITIES, LlmError, MODEL_TABLE, type LlmCapabilities, type LlmProvider } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { PlanError, type PlanResult } from '@rill/planner'
import { PlanMetaSchema, RillClient, type PlanMeta, type PlanRecord } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { failedRecord, plannedRecord } from '../src/plans'
import { RillServer } from '../src/server/server'
import { Store } from '../src/store'
import { isolateKeyEnvironment } from './llm-env'
import { ScriptedProvider, planInput, plainWorkflow, workflowReply } from './plan-helpers'

isolateKeyEnvironment()

const TOKEN = 'meta-token-0123456789abcdef'
const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }

const LEGACY_META = {
  rounds: [],
  usage,
  costUsd: 0.25,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  fallbackUsed: false,
}

const geminiLike: LlmCapabilities = MODEL_TABLE.find((model) => model.provider === 'gemini')!.capabilities
const grokLike: LlmCapabilities = MODEL_TABLE.find((model) => model.provider === 'grok')!.capabilities

function named(name: string, capabilities: LlmCapabilities | undefined, scripted: ScriptedProvider): LlmProvider {
  return { name, ...(capabilities === undefined ? {} : { capabilities }), generate: (request, options) => scripted.generate(request, options) }
}

let dir: string
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-plan-meta-'))
  mkdirSync(join(dir, 'attachments'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

function makeEngine(llm: LlmProvider, db = Db.open(':memory:'), options: Partial<EngineOptions> = {}) {
  const engine = new Engine({ db, registry: createCoreRegistry(), llm, allowedRoots: [dir], ...options })
  cleanups.push(() => engine.shutdown())
  return { engine, db }
}

async function serve(engine: Engine) {
  const server = new RillServer({ engine, token: TOKEN, log: () => undefined })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN)
  cleanups.push(() => client.close())
  return client
}

const planned = (meta: PlanResult['meta']): PlanResult => ({
  kind: 'questions',
  questions: [],
  summary: 's',
  rounds: [],
  usage,
  costUsd: 0.1,
  model: 'm',
  effort: 'high',
  fallbackUsed: false,
  meta,
})

describe('plannedRecord and the provider meta', () => {
  it('stores the provider, the effort detail and the cap flag from planned.meta, in the record and in the outcome', () => {
    const meta: PlanResult['meta'] = {
      provider: 'gemini',
      effort: { requested: 'max', effective: 'high', native: 'high', collapsed: true },
      reasoningCapped: true,
    }
    const { record, outcome } = plannedRecord({ planId: 'p', text: 't', attachments: [], effort: 'max' }, planned(meta), 5)
    const expected = { provider: 'gemini', effortDetail: { requested: 'max', effective: 'high', native: 'high', collapsed: true }, reasoningCapped: true }
    expect(record.meta).toMatchObject(expected)
    expect(outcome.meta).toMatchObject(expected)
    expect(record.meta).not.toHaveProperty('costNote')
    expect(Value.Check(PlanMetaSchema, record.meta)).toBe(true)
  })

  it('stores the cost note when there is one, and nothing when there is none', () => {
    const soft: PlanResult['meta'] = {
      provider: 'grok',
      effort: { requested: 'high', effective: 'high', native: 'high', collapsed: false },
      reasoningCapped: false,
      costNote: 'soft cap',
    }
    expect(plannedRecord({ planId: 'p', text: 't', attachments: [], effort: 'high' }, planned(soft), 5).record.meta?.costNote).toBe('soft cap')
    expect(Object.keys(plannedRecord({ planId: 'p', text: 't', attachments: [], effort: 'high' }, planned({ ...soft, costNote: undefined } as never), 5).record.meta!)).not.toContain('costNote')
  })

  it('keeps the requested effort as before next to the new detail', () => {
    const meta: PlanResult['meta'] = { provider: 'anthropic', effort: { requested: 'max', effective: 'max', native: 'max', collapsed: false }, reasoningCapped: true }
    const { record } = plannedRecord({ planId: 'p', text: 't', attachments: [], effort: 'max' }, { ...planned(meta), effort: 'max' }, 5)
    expect(record.meta?.effort).toBe('max')
    expect(record.meta?.effortDetail?.requested).toBe('max')
  })

  it('leaves a failed record valid, with no provider fields', () => {
    const round = { index: 0, issues: [], usage, durationMs: 3, targeted: [] }
    const record = failedRecord({ planId: 'p', text: 't', attachments: [], effort: 'low' }, new PlanError('invalid_after_repair', 'x', [round], []), 9)
    expect(record.meta).not.toBeNull()
    expect(Value.Check(PlanMetaSchema, record.meta)).toBe(true)
    expect(record.meta).not.toHaveProperty('provider')
    expect(failedRecord({ planId: 'p', text: 't', attachments: [], effort: 'low' }, new Error('boom'), 9).meta).toBeNull()
  })
})

describe('the provider meta through the engine and the store', () => {
  it('plans with the Anthropic defaults and records the provider, an unchanged effort and a hard cap', async () => {
    const { engine } = makeEngine(named('anthropic', undefined, new ScriptedProvider([{ data: workflowReply(plainWorkflow()) }])))
    const outcome = await engine.plan(planInput({ effort: 'xhigh' }))
    expect(outcome.meta).toMatchObject({
      provider: 'anthropic',
      effort: 'xhigh',
      effortDetail: { requested: 'xhigh', effective: 'xhigh', native: ANTHROPIC_CAPABILITIES.effortMap.xhigh, collapsed: false },
      reasoningCapped: true,
    })
    expect(outcome.meta).not.toHaveProperty('costNote')
  })

  it('records a collapsed effort for a provider with fewer levels', async () => {
    const { engine } = makeEngine(named('gemini', geminiLike, new ScriptedProvider([{ data: workflowReply(plainWorkflow()) }])))
    const outcome = await engine.plan(planInput({ effort: 'max' }))
    expect(outcome.meta.effort).toBe('max')
    expect(outcome.meta.provider).toBe('gemini')
    expect(outcome.meta.effortDetail).toEqual({ requested: 'max', effective: 'high', native: geminiLike.effortMap.high, collapsed: true })
  })

  it('records the soft cap and its cost note for a provider whose hidden reasoning is not capped', async () => {
    const { engine } = makeEngine(named('grok', grokLike, new ScriptedProvider([{ data: workflowReply(plainWorkflow()) }])))
    const outcome = await engine.plan(planInput({ effort: 'medium' }))
    expect(outcome.meta.reasoningCapped).toBe(false)
    expect(outcome.meta.costNote).toMatch(/soft/)
  })

  it('round-trips the fields through the store: getPlan returns what plan returned', async () => {
    const { engine } = makeEngine(named('gemini', geminiLike, new ScriptedProvider([{ data: workflowReply(plainWorkflow()) }])))
    const outcome = await engine.plan(planInput({ effort: 'max' }))
    expect(engine.getPlan('plan-1').meta).toEqual(outcome.meta)
  })

  it('round-trips the fields over the websocket, where the client checks the result against the schema', async () => {
    const { engine } = makeEngine(named('grok', grokLike, new ScriptedProvider([{ data: workflowReply(plainWorkflow()) }])))
    const client = await serve(engine)
    const outcome = await client.request('plan', { planId: 'ws-1', text: 'Wait a little', turns: [], attachments: [], effort: 'low' })
    expect(outcome.meta).toMatchObject({ provider: 'grok', reasoningCapped: false })
    const fetched = (await client.request('getPlan', { planId: 'ws-1' })).plan
    expect(fetched.meta).toEqual(outcome.meta)
    expect((await client.request('listPlans', {})).plans.map((entry) => entry.planId)).toEqual(['ws-1'])
  })

  it('stores a plan that failed before any round with no meta, as before', async () => {
    const scripted = new ScriptedProvider([{ error: new LlmError('overloaded', 'busy') }])
    const { engine } = makeEngine(named('openai', undefined, scripted))
    await expect(engine.plan(planInput({ planId: 'failing' }))).rejects.toBeInstanceOf(PlanError)
    const record = engine.getPlan('failing')
    expect(record.status).toBe('failed')
    expect(record.meta).toBeNull()
  })
})

describe('a plan row stored before the provider fields existed', () => {
  function insertLegacy(db: Db, id: string, meta: string | null, createdAt: number) {
    db.run(
      'INSERT INTO plans (id, created_at, status, effort, model, request_text, attachments, result, meta, error, workflow_hash, flag_keys, workflow_id, confirmed) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      createdAt,
      'planned',
      'medium',
      'claude-sonnet-5-5',
      'old request',
      '[]',
      JSON.stringify({ kind: 'questions', questions: [], summary: 'old summary' }),
      meta,
      null,
      null,
      '[]',
      null,
      null,
    )
  }

  it('reads through getPlan, listPlans and the websocket with the old meta unchanged', async () => {
    const db = Db.open(':memory:')
    new Store(db)
    insertLegacy(db, 'legacy-1', JSON.stringify(LEGACY_META), 100)
    insertLegacy(db, 'legacy-2', null, 200)
    const { engine } = makeEngine(new ScriptedProvider([]), db)
    const record: PlanRecord = engine.getPlan('legacy-1')
    expect(record.meta).toEqual(LEGACY_META)
    expect(record.meta).not.toHaveProperty('provider')
    expect(Value.Check(PlanMetaSchema, record.meta)).toBe(true)
    expect(engine.getPlan('legacy-2').meta).toBeNull()
    expect(engine.listPlans().map((entry) => entry.planId)).toEqual(['legacy-2', 'legacy-1'])
    const client = await serve(engine)
    expect((await client.request('getPlan', { planId: 'legacy-1' })).plan.meta).toEqual(LEGACY_META)
    expect((await client.request('listPlans', {})).plans).toHaveLength(2)
  })

  it('accepts a new plan next to the old rows, in the same table, with no migration', async () => {
    const db = Db.open(':memory:')
    new Store(db)
    insertLegacy(db, 'legacy-1', JSON.stringify(LEGACY_META), 100)
    const { engine } = makeEngine(named('gemini', geminiLike, new ScriptedProvider([{ data: workflowReply(plainWorkflow()) }])), db)
    await engine.plan(planInput({ planId: 'fresh' }))
    const columns = db.all<{ name: string }>('PRAGMA table_info(plans)').map((column) => column.name)
    expect(columns).toEqual(['id', 'created_at', 'status', 'effort', 'model', 'request_text', 'attachments', 'result', 'meta', 'error', 'workflow_hash', 'flag_keys', 'workflow_id', 'confirmed'])
    const stored = JSON.parse(db.get<{ meta: string }>('SELECT meta FROM plans WHERE id = ?', 'fresh')!.meta) as PlanMeta
    expect(stored.provider).toBe('gemini')
    expect(engine.getPlan('legacy-1').meta).toEqual(LEGACY_META)
  })
})
