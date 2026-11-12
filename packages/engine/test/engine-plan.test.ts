import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { PlanError } from '@rill/planner'
import { PlanRecordSchema, flagKey, type AttachmentRef } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, WorkflowValidationError, type EngineOptions } from '../src/engine'
import {
  LlmUnavailableError,
  PlanBusyError,
  PlanDeployedError,
  PlanExistsError,
  PlanNotConfirmedError,
  PlanNotFoundError,
  workflowHash,
} from '../src/plans'
import { NotFoundError } from '../src/store'
import {
  FLAGGED_URL,
  MODEL,
  ScriptedProvider,
  flaggedWorkflow,
  patchReply,
  plainWorkflow,
  planInput,
  questionsReply,
  unsupportedReply,
  workflowReply,
  type Step,
} from './plan-helpers'

let dir: string
let attachments: string
const engines: Engine[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-plan-'))
  attachments = join(dir, 'attachments')
  mkdirSync(attachments)
})

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

function setup(steps: Step[] = [], options: Partial<EngineOptions> = {}) {
  const provider = new ScriptedProvider(steps)
  const db = Db.open(':memory:')
  const engine = new Engine({
    db,
    registry: createCoreRegistry(),
    llm: provider,
    attachmentsRoot: attachments,
    allowedRoots: [dir],
    now: () => 1_000,
    ...options,
  })
  engines.push(engine)
  return { engine, db, provider }
}

function dump(db: Db): string {
  return JSON.stringify(db.all('SELECT * FROM plans'))
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('Engine.plan', () => {
  it('stores a planned record for a workflow result and returns the result and the meta', async () => {
    const { engine, db, provider } = setup([{ data: workflowReply(plainWorkflow()), usage: { inputTokens: 700, outputTokens: 80 } }])
    const outcome = await engine.plan(planInput({ effort: 'high', text: 'Wait a little' }))
    expect(outcome.planId).toBe('plan-1')
    expect(outcome.result).toMatchObject({ kind: 'workflow', summary: 'Does the thing', flags: [], needsConfirmation: false })
    expect(outcome.result.kind === 'workflow' && outcome.result.workflow).toEqual(plainWorkflow())
    expect(outcome.meta).toMatchObject({ model: MODEL, effort: 'high', fallbackUsed: false })
    expect(outcome.meta.usage.inputTokens).toBe(700)
    expect(outcome.meta.rounds).toHaveLength(1)
    expect(provider.requests).toHaveLength(1)

    const record = engine.getPlan('plan-1')
    expect(record).toEqual({
      planId: 'plan-1',
      createdAt: 1_000,
      status: 'planned',
      effort: 'high',
      model: MODEL,
      requestText: 'Wait a little',
      attachments: [],
      result: outcome.result,
      meta: outcome.meta,
      error: null,
      flagKeys: [],
      workflowId: null,
      confirmed: null,
    })
    const raw = db.get<{ workflow_hash: string; flag_keys: string }>('SELECT workflow_hash, flag_keys FROM plans')!
    expect(raw.workflow_hash).toBe(workflowHash(plainWorkflow()))
    expect(raw.flag_keys).toBe('[]')
  })

  it('serves records that pass the closed protocol schema, without the workflow hash', async () => {
    const { engine } = setup([{ data: workflowReply(flaggedWorkflow()) }, { data: questionsReply() }])
    await engine.plan(planInput({ planId: 'flagged', text: 'Post something out' }))
    await engine.plan(planInput({ planId: 'asks', text: 'Wait' }))
    for (const id of ['flagged', 'asks']) {
      const record = engine.getPlan(id)
      expect(Value.Check(PlanRecordSchema, record), id).toBe(true)
      expect(Object.keys(record)).not.toContain('workflowHash')
    }
  })

  it('records the flag keys and the hash of a flagged workflow', async () => {
    const { engine, db } = setup([{ data: workflowReply(flaggedWorkflow()) }])
    const outcome = await engine.plan(planInput({ text: 'Post something out' }))
    if (outcome.result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(outcome.result.needsConfirmation).toBe(true)
    expect(outcome.result.flags.length).toBeGreaterThan(0)
    const keys = engine.getPlan('plan-1').flagKeys
    expect(keys).toEqual([...new Set(outcome.result.flags.map(flagKey))])
    expect(db.get<{ workflow_hash: string }>('SELECT workflow_hash FROM plans')?.workflow_hash).toBe(workflowHash(flaggedWorkflow()))
  })

  it('stores question and unsupported results with no flags and no hash', async () => {
    const { engine, db } = setup([{ data: questionsReply() }, { data: unsupportedReply() }])
    const asks = await engine.plan(planInput({ planId: 'asks' }))
    const cannot = await engine.plan(planInput({ planId: 'cannot', text: 'Send an email' }))
    expect(asks.result.kind).toBe('questions')
    expect(cannot.result.kind).toBe('unsupported')
    expect(engine.getPlan('asks')).toMatchObject({ status: 'planned', flagKeys: [], workflowId: null })
    expect(engine.getPlan('cannot').result).toEqual(cannot.result)
    expect(db.all('SELECT workflow_hash FROM plans WHERE workflow_hash IS NOT NULL')).toEqual([])
  })

  it('refuses to plan without a model provider and stores nothing', async () => {
    const { engine, db } = setup([], { llm: undefined })
    await expect(engine.plan(planInput())).rejects.toBeInstanceOf(LlmUnavailableError)
    expect(db.all('SELECT id FROM plans')).toEqual([])
  })

  it('refuses a plan id that is already stored', async () => {
    const { engine, provider } = setup([{ data: workflowReply(plainWorkflow()) }, { data: workflowReply(plainWorkflow()) }])
    await engine.plan(planInput())
    await expect(engine.plan(planInput())).rejects.toBeInstanceOf(PlanExistsError)
    expect(provider.requests).toHaveLength(1)
  })

  it('refuses a plan id that is already running, even when both start in the same tick', async () => {
    const { engine, provider } = setup([{ wait: true }])
    const first = engine.plan(planInput())
    const second = engine.plan(planInput())
    await expect(second).rejects.toBeInstanceOf(PlanExistsError)
    await provider.calls(1)
    expect(engine.cancelPlan('plan-1')).toBe(true)
    await expect(first).rejects.toBeInstanceOf(PlanError)
    expect(provider.requests).toHaveLength(1)
  })

  it('refuses more plans than maxConcurrentPlans and accepts new ones once a slot frees up', async () => {
    const { engine, provider } = setup([{ wait: true }, { wait: true }, { data: workflowReply(plainWorkflow()) }])
    const a = engine.plan(planInput({ planId: 'a' }))
    const b = engine.plan(planInput({ planId: 'b' }))
    await provider.calls(2)
    await expect(engine.plan(planInput({ planId: 'c' }))).rejects.toBeInstanceOf(PlanBusyError)
    expect(engine.cancelPlan('a')).toBe(true)
    await expect(a).rejects.toBeInstanceOf(PlanError)
    await expect(engine.plan(planInput({ planId: 'c' }))).resolves.toMatchObject({ planId: 'c' })
    expect(engine.cancelPlan('b')).toBe(true)
    await expect(b).rejects.toBeInstanceOf(PlanError)
    expect(engine.getPlan('c').status).toBe('planned')
  })

  it('honours a custom maxConcurrentPlans', async () => {
    const { engine, provider } = setup([{ wait: true }], { maxConcurrentPlans: 1 })
    const a = engine.plan(planInput({ planId: 'a' }))
    await provider.calls(1)
    await expect(engine.plan(planInput({ planId: 'b' }))).rejects.toBeInstanceOf(PlanBusyError)
    engine.cancelPlan('a')
    await expect(a).rejects.toBeInstanceOf(PlanError)
  })

  it('does not store a busy or duplicate attempt', async () => {
    const { engine, db, provider } = setup([{ wait: true }], { maxConcurrentPlans: 1 })
    const a = engine.plan(planInput({ planId: 'a' }))
    await provider.calls(1)
    await rejection(engine.plan(planInput({ planId: 'b' })))
    engine.cancelPlan('a')
    await rejection(a)
    expect(db.all<{ id: string }>('SELECT id FROM plans').map((row) => row.id)).toEqual(['a'])
  })
})

describe('Engine.cancelPlan', () => {
  it('aborts the provider call in flight and stores a cancelled record', async () => {
    const { engine, provider } = setup([{ wait: true }])
    const pending = engine.plan(planInput({ effort: 'low' }))
    await provider.calls(1)
    expect(provider.signals[0]?.aborted).toBe(false)
    expect(engine.cancelPlan('plan-1')).toBe(true)
    const error = await rejection(pending)
    expect(error).toBeInstanceOf(PlanError)
    expect((error as PlanError).kind).toBe('aborted')
    expect(provider.signals[0]?.aborted).toBe(true)
    expect(engine.getPlan('plan-1')).toMatchObject({
      status: 'cancelled',
      effort: 'low',
      model: null,
      result: null,
      error: 'planning was cancelled',
      flagKeys: [],
      workflowId: null,
    })
  })

  it('returns false for an unknown plan and for a plan that already finished', async () => {
    const { engine } = setup([{ data: workflowReply(plainWorkflow()) }])
    expect(engine.cancelPlan('nope')).toBe(false)
    await engine.plan(planInput())
    expect(engine.cancelPlan('plan-1')).toBe(false)
    expect(engine.getPlan('plan-1').status).toBe('planned')
  })
})

describe('failed plans', () => {
  it('stores a failed record with a fixed error and no model text, and rethrows the planner error', async () => {
    const MARKER = 'MODEL-SUMMARY-MARKER'
    const invalid = {
      schemaVersion: 1,
      name: 'broken',
      nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
      edges: [{ from: 't1', to: 'ghost' }],
    }
    const { engine, db, provider } = setup(
      [
        { data: workflowReply(invalid as never, MARKER) },
        { data: workflowReply(invalid as never, MARKER) },
      ],
      { maxRepairRounds: 1 },
    )
    const error = await rejection(engine.plan(planInput()))
    expect(error).toBeInstanceOf(PlanError)
    expect((error as PlanError).kind).toBe('invalid_after_repair')
    expect(provider.requests).toHaveLength(2)
    const record = engine.getPlan('plan-1')
    expect(record).toMatchObject({
      status: 'failed',
      model: null,
      result: null,
      error: 'the plan was not valid after the repair rounds',
      flagKeys: [],
      workflowId: null,
    })
    expect(record.meta?.rounds).toHaveLength(2)
    expect(record.meta?.rounds[0]?.issues.length).toBeGreaterThan(0)
    expect(Value.Check(PlanRecordSchema, record)).toBe(true)
    expect(JSON.stringify(record)).not.toContain(MARKER)
    expect(dump(db)).not.toContain(MARKER)
    expect(db.all('SELECT workflow_hash FROM plans WHERE workflow_hash IS NOT NULL')).toEqual([])
  })

  it('stores a failed record for a provider failure without the provider text', async () => {
    const MARKER = 'UPSTREAM-DETAIL-MARKER'
    const failure = new LlmError('connection', `socket hang up ${MARKER}`)
    const { engine, db } = setup([{ error: failure }])
    const error = await rejection(engine.plan(planInput()))
    expect(error).toBeInstanceOf(PlanError)
    expect((error as PlanError).kind).toBe('provider')
    expect((error as PlanError).cause).toBe(failure)
    const record = engine.getPlan('plan-1')
    expect(record).toMatchObject({ status: 'failed', error: 'the model provider failed' })
    expect(JSON.stringify(record)).not.toContain(MARKER)
    expect(dump(db)).not.toContain(MARKER)
  })

  it('stores a failed record for an invalid request and never calls the model', async () => {
    const { engine, provider } = setup([])
    const error = await rejection(engine.plan(planInput({ selection: { nodeId: 'n1' } })))
    expect((error as PlanError).kind).toBe('invalid_request')
    expect(provider.requests).toHaveLength(0)
    expect(engine.getPlan('plan-1')).toMatchObject({ status: 'failed', error: 'the request could not be planned' })
  })

  it('stores an unexpected error as a failed record with a fixed message', async () => {
    const MARKER = 'UNEXPECTED-MARKER'
    const { engine, db } = setup([{ error: new Error(`boom ${MARKER}`) }])
    const error = await rejection(engine.plan(planInput()))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(MARKER)
    expect(engine.getPlan('plan-1')).toMatchObject({ status: 'failed', error: 'planning failed unexpectedly' })
    expect(dump(db)).not.toContain(MARKER)
  })

  it('lets a failed plan id be read but not reused', async () => {
    const { engine } = setup([{ error: new LlmError('auth', 'bad key') }])
    await rejection(engine.plan(planInput()))
    await expect(engine.plan(planInput())).rejects.toBeInstanceOf(PlanExistsError)
  })
})

describe('context', () => {
  it('sends the configured connections and allowed folders to the planner', async () => {
    const { engine, provider } = setup([{ data: workflowReply(plainWorkflow()) }], {
      planConnections: [
        { name: 'team-slack', kind: 'slack' },
        { name: 'api-key', kind: 'http' },
      ],
    })
    await engine.plan(planInput())
    const sent = JSON.stringify(provider.requests[0]!.messages)
    expect(sent).toContain('team-slack')
    expect(sent).toContain('api-key')
    expect(sent).toContain(JSON.stringify(dir).slice(1, -1))
  })

  it('sends no connections and no folders when none are configured', async () => {
    const { engine, provider } = setup([{ data: workflowReply(plainWorkflow()) }], { allowedRoots: undefined, attachmentsRoot: undefined })
    await engine.plan(planInput())
    expect(provider.requests[0]!.messages[0]!.content).toContain('{"allowedFolders":[],"connections":[]}')
  })

  it('loads the existing workflow for patch mode', async () => {
    const { engine, provider } = setup([{ data: patchReply([{ op: 'set_config', nodeId: 'n1', config: { ms: 10 } }]) }])
    const workflowId = engine.deploy(plainWorkflow())
    const outcome = await engine.plan(planInput({ workflowId, selection: { nodeId: 'n1' }, text: 'Wait longer' }))
    expect(provider.requests[0]!.messages[0]!.content).toContain('"config":{"ms":5}')
    if (outcome.result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(outcome.result.workflow.nodes[1]?.config).toEqual({ ms: 10 })
    expect(outcome.result.patch).toEqual([{ op: 'set_config', nodeId: 'n1', config: { ms: 10 } }])
  })

  it('rejects an unknown workflow id with NotFoundError and stores nothing', async () => {
    const { engine, db, provider } = setup([{ data: workflowReply(plainWorkflow()) }])
    await expect(engine.plan(planInput({ workflowId: 'missing' }))).rejects.toBeInstanceOf(NotFoundError)
    expect(db.all('SELECT id FROM plans')).toEqual([])
    await engine.plan(planInput())
    expect(provider.requests).toHaveLength(1)
  })

  it('rejects a selection of a node that is not in the existing workflow', async () => {
    const { engine } = setup([])
    const workflowId = engine.deploy(plainWorkflow())
    const error = await rejection(engine.plan(planInput({ workflowId, selection: { nodeId: 'zzz' } })))
    expect((error as PlanError).kind).toBe('invalid_request')
  })
})

describe('attachments', () => {
  const MARKER = 'ATTACHMENT-BYTES-MARKER-5d1c'
  const ref: AttachmentRef = { id: 'note0001', mediaType: 'text/plain', name: 'note.txt', bytes: 40 }

  it('reads attachments through the store and keeps only refs in the record', async () => {
    writeFileSync(join(attachments, 'note0001.txt'), `Invoice text ${MARKER}`)
    const { engine, db, provider } = setup([{ data: workflowReply(plainWorkflow()) }])
    const outcome = await engine.plan(planInput({ attachments: [ref], text: 'Use the attached note' }))
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain(MARKER)
    expect(engine.getPlan('plan-1').attachments).toEqual([ref])
    for (const text of [JSON.stringify(outcome), JSON.stringify(engine.getPlan('plan-1')), JSON.stringify(engine.listPlans()), dump(db)]) {
      expect(text).not.toContain(MARKER)
    }
  })

  it('stores only the four ref fields even when the caller hands over more', async () => {
    writeFileSync(join(attachments, 'note0001.txt'), `Invoice text ${MARKER}`)
    const { engine, db } = setup([{ data: workflowReply(plainWorkflow()) }])
    const dirty = { ...ref, text: `${MARKER} copy`, data: MARKER } as unknown as AttachmentRef
    await engine.plan(planInput({ attachments: [dirty] }))
    expect(engine.getPlan('plan-1').attachments).toEqual([ref])
    expect(dump(db)).not.toContain(MARKER)
  })

  it('fails the plan with an attachment error when the file is missing', async () => {
    const { engine, provider, db } = setup([])
    const error = await rejection(engine.plan(planInput({ attachments: [ref] })))
    expect(error).toBeInstanceOf(PlanError)
    expect((error as PlanError).kind).toBe('attachment')
    expect(provider.requests).toHaveLength(0)
    expect(engine.getPlan('plan-1')).toMatchObject({ status: 'failed', error: 'an attachment could not be used', attachments: [ref] })
    expect(dump(db)).not.toContain(dir)
  })

  it('fails the plan with an attachment error when there is no attachments folder', async () => {
    writeFileSync(join(attachments, 'note0001.txt'), `Invoice text ${MARKER}`)
    const { engine, provider } = setup([], { attachmentsRoot: undefined })
    const error = await rejection(engine.plan(planInput({ attachments: [ref] })))
    expect((error as PlanError).kind).toBe('attachment')
    expect(provider.requests).toHaveLength(0)
    expect(JSON.stringify(engine.getPlan('plan-1'))).not.toContain(MARKER)
  })

  it('keeps the attachment text out of the error message of a rejected attachment', async () => {
    writeFileSync(join(attachments, 'note0001.png'), `not an image ${MARKER}`)
    const { engine, db } = setup([])
    const error = await rejection(engine.plan(planInput({ attachments: [{ ...ref, mediaType: 'image/png', name: 'photo.png' }] })))
    expect((error as PlanError).kind).toBe('attachment')
    expect((error as PlanError).message).not.toContain(MARKER)
    expect(dump(db)).not.toContain(MARKER)
  })
})

describe('attachment text the model repeats', () => {
  const WORDS = 'Quokkaplatypus Fennecwombat'
  const RECEIPT = `Receipt from ${WORDS}\nInvoice INV-2024-0042\nTotal 12.50\nZebrafinch\n`
  const ref: AttachmentRef = { id: 'receipt1', mediaType: 'text/plain', name: 'receipt.txt', bytes: 70 }
  const everything = (engine: Engine, db: Db, outcome: unknown) =>
    [JSON.stringify(outcome), JSON.stringify(engine.getPlan('plan-1')), JSON.stringify(engine.listPlans()), dump(db)].join('\n')

  beforeEach(() => {
    writeFileSync(join(attachments, 'receipt1.txt'), RECEIPT)
  })

  it('keeps it out of the summary of a workflow result in the response, the record and the listing', async () => {
    const { engine, db } = setup([{ data: workflowReply(plainWorkflow(), `Waits after receipts from ${WORDS}, file INV-2024-0042`) }])
    const outcome = await engine.plan(planInput({ attachments: [ref], text: 'Wait after my receipts' }))
    const text = everything(engine, db, outcome)
    expect(text).not.toMatch(/quokkaplatypus|fennecwombat|inv-2024-0042/i)
    expect(outcome.result.summary).toContain('receipts')
    expect(engine.getPlan('plan-1').result).toEqual(outcome.result)
  })

  it('keeps it out of the questions of a questions result', async () => {
    const reply = questionsReply([{ id: 'q1', text: `Is ${WORDS} the vendor?`, options: ['Quokkaplatypus', 'someone else'], default: 'Quokkaplatypus' }])
    const { engine, db } = setup([{ data: reply }])
    const outcome = await engine.plan(planInput({ attachments: [ref] }))
    expect(everything(engine, db, outcome)).not.toMatch(/quokkaplatypus|fennecwombat/i)
    if (outcome.result.kind !== 'questions') throw new Error('kind')
    expect(outcome.result.questions[0]!.id).toBe('q1')
    expect(outcome.result.questions[0]!.options).toHaveLength(2)
  })

  it('keeps it out of an unsupported result', async () => {
    const { engine, db } = setup([{ data: unsupportedReply({ summary: `No mail for ${WORDS}`, reason: `${WORDS} wants mail` }) }])
    const outcome = await engine.plan(planInput({ attachments: [ref] }))
    expect(everything(engine, db, outcome)).not.toMatch(/quokkaplatypus|fennecwombat/i)
  })

  it('also covers a file that was attached in an earlier turn', async () => {
    const { engine, db } = setup([{ data: workflowReply(plainWorkflow(), `Waits for ${WORDS}`) }])
    const turns = [{ role: 'user' as const, text: 'Here is a receipt', attachments: [ref] }, { role: 'assistant' as const, text: 'Noted' }]
    const outcome = await engine.plan(planInput({ turns, text: 'Now wait' }))
    expect(everything(engine, db, outcome)).not.toMatch(/quokkaplatypus|fennecwombat/i)
  })

  it('keeps the words that the user wrote or that the existing workflow has', async () => {
    const { engine, provider } = setup([{ data: workflowReply(plainWorkflow(), `Waits for ${WORDS} and Zebrafinch`) }])
    const workflowId = engine.deploy(plainWorkflow('Zebrafinch ledger'))
    const outcome = await engine.plan(planInput({ attachments: [ref], workflowId, text: 'Wait for Fennecwombat' }))
    expect(provider.requests).toHaveLength(1)
    expect(outcome.result.summary).toBe(`Waits for <hidden> Fennecwombat and Zebrafinch`)
  })

  it('does not look for words in a PDF, which cannot be searched offline', async () => {
    writeFileSync(join(attachments, 'receipt2.pdf'), `%PDF-1.4 ${WORDS}`)
    const pdf: AttachmentRef = { id: 'receipt2', mediaType: 'application/pdf', name: 'receipt.pdf', bytes: 30 }
    const { engine } = setup([{ data: workflowReply(plainWorkflow(), `Waits for ${WORDS}`) }])
    const outcome = await engine.plan(planInput({ attachments: [pdf] }))
    expect(outcome.result.summary).toBe(`Waits for ${WORDS}`)
  })

  it('leaves the summary alone when no attachment text is involved', async () => {
    const { engine } = setup([{ data: workflowReply(plainWorkflow(), `Waits for ${WORDS}`) }])
    const outcome = await engine.plan(planInput())
    expect(outcome.result.summary).toBe(`Waits for ${WORDS}`)
  })
})

describe('Engine.getPlan and Engine.listPlans', () => {
  it('throws PlanNotFoundError for an unknown plan', () => {
    const { engine } = setup()
    expect(() => engine.getPlan('nope')).toThrow(PlanNotFoundError)
  })

  it('lists plans newest first with a clamped limit', async () => {
    let clock = 0
    const { engine } = setup([{ data: workflowReply(plainWorkflow()) }, { data: questionsReply() }, { data: unsupportedReply() }], { now: () => ++clock })
    await engine.plan(planInput({ planId: 'a' }))
    await engine.plan(planInput({ planId: 'b' }))
    await engine.plan(planInput({ planId: 'c' }))
    expect(engine.listPlans().map((p) => p.planId)).toEqual(['c', 'b', 'a'])
    expect(engine.listPlans({ limit: 2 }).map((p) => p.planId)).toEqual(['c', 'b'])
    expect(engine.listPlans({ limit: 0 }).map((p) => p.planId)).toEqual(['c'])
    expect(engine.listPlans({ limit: 5000 })).toHaveLength(3)
    expect(engine.listPlans({ limit: Number.NaN })).toHaveLength(3)
    expect(engine.listPlans()[2]).toMatchObject({ kind: 'workflow', summary: 'Does the thing', flagCount: 0, workflowId: null, status: 'planned' })
    expect(engine.listPlans()[0]).toMatchObject({ kind: 'unsupported' })
  })

  it('returns 50 plans by default and never more than 200', () => {
    const { engine } = setup()
    for (let index = 0; index < 205; index++) {
      engine.store.savePlan({
        planId: `stored-${index}`,
        createdAt: index,
        status: 'failed',
        effort: 'medium',
        model: null,
        requestText: 'x',
        attachments: [],
        result: null,
        meta: null,
        error: 'e',
        flagKeys: [],
        workflowId: null,
        confirmed: null,
        workflowHash: null,
      })
    }
    expect(engine.listPlans()).toHaveLength(50)
    expect(engine.listPlans({ limit: 199 })).toHaveLength(199)
    expect(engine.listPlans({ limit: 200 })).toHaveLength(200)
    expect(engine.listPlans({ limit: 201 })).toHaveLength(200)
    expect(engine.listPlans({ limit: 100000 })).toHaveLength(200)
  })
})

describe('Engine.deployPlan', () => {
  async function flagged() {
    const ctx = setup([{ data: workflowReply(flaggedWorkflow()) }])
    await ctx.engine.plan(planInput({ text: 'Post something out' }))
    return { ...ctx, keys: ctx.engine.getPlan('plan-1').flagKeys }
  }

  it('refuses a flagged plan without the keys and names the flags without their values', async () => {
    const { engine, keys } = await flagged()
    expect(keys.length).toBeGreaterThan(0)
    const error = await rejection(Promise.resolve().then(() => engine.deployPlan('plan-1', [])))
    expect(error).toBeInstanceOf(PlanNotConfirmedError)
    const message = (error as Error).message
    const [nodeId, pointer] = JSON.parse(keys[0]!) as [string, string]
    expect(message).toContain(nodeId)
    expect(message).toContain(pointer)
    expect(message).not.toContain(FLAGGED_URL)
    expect(message).not.toContain('hooks.invalid')
    expect(engine.getPlan('plan-1')).toMatchObject({ workflowId: null, confirmed: null })
    expect(engine.listWorkflows()).toEqual([])
  })

  it('refuses when only some keys are confirmed', async () => {
    const twoTargets = flaggedWorkflow()
    twoTargets.nodes.push({ id: 'n2', type: 'http.request@1', config: { url: 'https://other.invalid/two', method: 'POST' } })
    twoTargets.edges.push({ from: 'n1', to: 'n2' })
    const { engine } = setup([{ data: workflowReply(twoTargets) }])
    await engine.plan(planInput({ text: 'Post something out twice' }))
    const keys = engine.getPlan('plan-1').flagKeys
    expect(keys.length).toBeGreaterThanOrEqual(2)
    for (const missing of keys) {
      const error = await rejection(Promise.resolve().then(() => engine.deployPlan('plan-1', keys.filter((key) => key !== missing))))
      expect(error).toBeInstanceOf(PlanNotConfirmedError)
      const [nodeId, pointer] = JSON.parse(missing) as [string, string]
      expect((error as Error).message).toContain(`${nodeId} at ${pointer}`)
    }
    expect(engine.deployPlan('plan-1', keys)).toBeTypeOf('string')
  })

  it('refuses a wrong key, and a key the plan does not have even next to the right ones', async () => {
    const { engine, keys } = await flagged()
    const wrong = flagKey({ nodeId: 'zzz', pointer: '/nope', code: 'untrusted_flow' })
    expect(() => engine.deployPlan('plan-1', [wrong])).toThrow(PlanNotConfirmedError)
    expect(() => engine.deployPlan('plan-1', [...keys, wrong])).toThrow(PlanNotConfirmedError)
    expect(() => engine.deployPlan('plan-1', ['not a key'])).toThrow(PlanNotConfirmedError)
    expect(engine.getPlan('plan-1').workflowId).toBeNull()
  })

  it('deploys once with every key, records the confirmation and then refuses a second call', async () => {
    const { engine, keys } = await flagged()
    const workflowId = engine.deployPlan('plan-1', [...keys, ...keys])
    expect(engine.getWorkflow(workflowId)).toEqual(flaggedWorkflow())
    expect(engine.getPlan('plan-1')).toMatchObject({ workflowId, confirmed: keys })
    expect(engine.listPlans()[0]).toMatchObject({ workflowId })
    expect(() => engine.deployPlan('plan-1', keys)).toThrow(PlanDeployedError)
    expect(() => engine.deployPlan('plan-1', [])).toThrow(PlanDeployedError)
    expect(engine.listWorkflows()).toHaveLength(1)
    expect(Value.Check(PlanRecordSchema, engine.getPlan('plan-1'))).toBe(true)
  })

  it('deploys an unflagged workflow with an empty confirmation, and refuses extra keys for it', async () => {
    const { engine } = setup([{ data: workflowReply(plainWorkflow()) }])
    await engine.plan(planInput())
    expect(() => engine.deployPlan('plan-1', ['extra'])).toThrow(PlanNotConfirmedError)
    const workflowId = engine.deployPlan('plan-1', [])
    expect(engine.getWorkflow(workflowId)).toEqual(plainWorkflow())
    expect(engine.getPlan('plan-1').confirmed).toEqual([])
  })

  it('does not activate or run what it deploys', async () => {
    const { engine } = setup([{ data: workflowReply(plainWorkflow()) }])
    await engine.plan(planInput())
    const workflowId = engine.deployPlan('plan-1', [])
    expect(engine.listWorkflows()[0]).toMatchObject({ id: workflowId, active: false })
    expect(engine.listRuns()).toEqual([])
  })

  it('cannot deploy question, unsupported, failed or cancelled plans', async () => {
    const { engine, provider } = setup([
      { data: questionsReply() },
      { data: unsupportedReply() },
      { error: new LlmError('auth', 'bad key') },
      { wait: true },
    ])
    await engine.plan(planInput({ planId: 'asks' }))
    await engine.plan(planInput({ planId: 'cannot' }))
    await rejection(engine.plan(planInput({ planId: 'failed' })))
    const pending = engine.plan(planInput({ planId: 'cancelled' }))
    await provider.calls(4)
    engine.cancelPlan('cancelled')
    await rejection(pending)
    for (const id of ['asks', 'cannot', 'failed', 'cancelled']) {
      expect(() => engine.deployPlan(id, []), id).toThrow(PlanDeployedError)
    }
    expect(engine.listWorkflows()).toEqual([])
  })

  it('throws PlanNotFoundError for an unknown plan', () => {
    const { engine } = setup()
    expect(() => engine.deployPlan('nope', [])).toThrow(PlanNotFoundError)
  })

  it('re-validates the workflow like deploy and leaves the plan open when it fails', async () => {
    const { engine, db } = setup([{ data: workflowReply(plainWorkflow()) }])
    await engine.plan(planInput())
    const stored = engine.store.getPlan('plan-1')
    const broken = { ...plainWorkflow(), nodes: [{ id: 't1', type: 'trigger.manual@1', config: { stray: 1 } }], edges: [] }
    db.run('UPDATE plans SET result = ? WHERE id = ?', JSON.stringify({ ...stored.result, workflow: broken }), 'plan-1')
    expect(() => engine.deployPlan('plan-1', [])).toThrow(WorkflowValidationError)
    expect(engine.getPlan('plan-1').workflowId).toBeNull()
    expect(engine.listWorkflows()).toEqual([])
  })
})

describe('shutdown', () => {
  it('aborts pending plans and waits for them to settle', async () => {
    const { engine, provider } = setup([{ wait: true }, { wait: true }])
    const a = engine.plan(planInput({ planId: 'a' }))
    const b = engine.plan(planInput({ planId: 'b' }))
    await provider.calls(2)
    const settled = Promise.allSettled([a, b])
    await engine.shutdown()
    const results = await settled
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(provider.signals.every((signal) => signal?.aborted === true)).toBe(true)
    expect(engine.getPlan('a').status).toBe('cancelled')
    expect(engine.getPlan('b').status).toBe('cancelled')
    await engine.shutdown()
  })

  it('does not return before a plan that is slow to stop has stored its record', async () => {
    const { engine, provider } = setup([{ wait: true, abortDelayMs: 40 }])
    const plan = engine.plan(planInput({ planId: 'slow' })).catch(() => undefined)
    await provider.calls(1)
    await engine.shutdown()
    expect(engine.getPlan('slow').status).toBe('cancelled')
    await plan
  })

  it('has nothing to wait for when no plan is running', async () => {
    const { engine } = setup()
    await engine.shutdown()
    await engine.shutdown()
  })
})

describe('construction', () => {
  it('rejects an attachments folder outside the allowed folders', () => {
    const outside = mkdtempSync(join(tmpdir(), 'rill-outside-'))
    try {
      expect(() => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: [dir], attachmentsRoot: outside })).toThrow(
        'the attachments folder must be inside an allowed folder',
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('accepts an attachments folder inside an allowed folder, even one that does not exist yet', () => {
    expect(() => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: [dir], attachmentsRoot: attachments })).not.toThrow()
    expect(() => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: [dir], attachmentsRoot: join(dir, 'later') })).not.toThrow()
  })

  it('accepts any attachments folder when no folder is restricted', () => {
    expect(() => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), attachmentsRoot: tmpdir() })).not.toThrow()
  })

  it('rejects a relative attachments folder when folders are restricted', () => {
    expect(() => new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry(), allowedRoots: [dir], attachmentsRoot: 'relative/dir' })).toThrow(
      'the attachments folder must be inside an allowed folder',
    )
  })
})
