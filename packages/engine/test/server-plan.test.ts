import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanIssue } from '@rill/dsl'
import { LlmError } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { AttachmentError, PlanError } from '@rill/planner'
import { RillClient, RillError, SUBPROTOCOL, flagKey, tokenProtocol, type AttachmentRef, type MethodParams } from '@rill/protocol'
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
} from '../src/plans'
import { RillServer, type RillServerOptions } from '../src/server/server'
import { NotFoundError } from '../src/store'
import {
  FLAGGED_URL,
  ScriptedProvider,
  flaggedWorkflow,
  plainWorkflow,
  questionsReply,
  workflowReply,
  type Step,
} from './plan-helpers'

const TOKEN = 'plan-token-0123456789abcdef'
const MARKER = 'ATTACHMENT-BYTES-MARKER-91be'

let dir: string
let attachments: string
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-server-plan-'))
  attachments = join(dir, 'attachments')
  mkdirSync(attachments)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function startServer(engine: Engine, serverOptions: Omit<RillServerOptions, 'engine' | 'token'> = {}) {
  const logs: string[] = []
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line), ...serverOptions })
  const port = await server.listen()
  cleanups.push(() => server.close())
  return { server, logs, url: `ws://127.0.0.1:${port}/` }
}

async function start(steps: Step[] = [], engineOptions: Partial<EngineOptions> = {}, serverOptions: Omit<RillServerOptions, 'engine' | 'token'> = {}) {
  const provider = new ScriptedProvider(steps)
  const db = Db.open(':memory:')
  const engine = new Engine({
    db,
    registry: createCoreRegistry(),
    llm: provider,
    attachmentsRoot: attachments,
    allowedRoots: [dir],
    ...engineOptions,
  })
  cleanups.push(() => engine.shutdown())
  return { engine, db, provider, ...(await startServer(engine, serverOptions)) }
}

async function connect(url: string) {
  const frames: string[] = []
  const client = await RillClient.connect(url, TOKEN, {
    socketFactory: (target, protocols) => {
      const socket = new WebSocket(target, protocols)
      socket.addEventListener('message', (event) => frames.push(String(event.data)))
      return socket as never
    },
  })
  cleanups.push(() => client.close())
  return { client, frames }
}

async function failure(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

function planParams(overrides: Partial<MethodParams<'plan'>> = {}): MethodParams<'plan'> {
  return { planId: 'plan-1', text: 'Wait a little', turns: [], attachments: [], effort: 'medium', ...overrides }
}

describe('planner methods over the websocket', () => {
  it('plans, reads the record, lists, deploys an unflagged plan and does not activate it', async () => {
    const { url } = await start([{ data: workflowReply(plainWorkflow()) }])
    const { client } = await connect(url)
    const planned = await client.request('plan', planParams({ effort: 'high' }))
    expect(planned.planId).toBe('plan-1')
    expect(planned.result).toMatchObject({ kind: 'workflow', flags: [], needsConfirmation: false })
    expect(planned.meta).toMatchObject({ effort: 'high', fallbackUsed: false })

    const { plan } = await client.request('getPlan', { planId: 'plan-1' })
    expect(plan).toMatchObject({ planId: 'plan-1', status: 'planned', effort: 'high', requestText: 'Wait a little', workflowId: null })
    expect(plan.result).toEqual(planned.result)

    const { plans } = await client.request('listPlans', {})
    expect(plans).toEqual([expect.objectContaining({ planId: 'plan-1', kind: 'workflow', flagCount: 0, workflowId: null })])

    const { workflowId } = await client.request('deployPlan', { planId: 'plan-1', confirmed: [] })
    expect((await client.request('getWorkflow', { workflowId })).workflow).toEqual(plainWorkflow())
    expect((await client.request('listWorkflows', {})).workflows[0]).toMatchObject({ id: workflowId, active: false })
    expect((await client.request('getPlan', { planId: 'plan-1' })).plan).toMatchObject({ workflowId, confirmed: [] })
    expect((await client.request('listPlans', {})).plans[0]).toMatchObject({ workflowId })
    expect((await client.request('listRuns', {})).runs).toEqual([])
  })

  it('makes the client confirm every flag, and keeps deploy from bypassing it', async () => {
    const { url } = await start([{ data: workflowReply(flaggedWorkflow()) }])
    const { client } = await connect(url)
    const planned = await client.request('plan', planParams({ text: 'Post something out' }))
    if (planned.result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(planned.result.needsConfirmation).toBe(true)
    const keys = [...new Set(planned.result.flags.map(flagKey))]
    expect(keys.length).toBeGreaterThan(0)

    const early = await failure(client.request('deployPlan', { planId: 'plan-1', confirmed: [] }))
    expect(early.code).toBe('PLAN_NOT_CONFIRMED')
    expect(early.message).not.toContain(FLAGGED_URL)
    const bypass = await failure(client.request('deploy', { workflow: flaggedWorkflow() }))
    expect(bypass.code).toBe('PLAN_NOT_CONFIRMED')
    expect(bypass.message).toContain('plan-1')

    const { workflowId } = await client.request('deployPlan', { planId: 'plan-1', confirmed: keys })
    expect(typeof workflowId).toBe('string')
    expect((await failure(client.request('deployPlan', { planId: 'plan-1', confirmed: keys }))).code).toBe('PLAN_DEPLOYED')
    expect((await client.request('deploy', { workflow: flaggedWorkflow() })).workflowId).toBe(workflowId)
  })

  it('stores a plan that asked questions and cannot deploy it', async () => {
    const { url } = await start([{ data: questionsReply() }])
    const { client } = await connect(url)
    const planned = await client.request('plan', planParams())
    expect(planned.result.kind).toBe('questions')
    expect((await failure(client.request('deployPlan', { planId: 'plan-1', confirmed: [] }))).code).toBe('PLAN_DEPLOYED')
  })

  it('answers other clients while a slow plan is running, and lists the plan afterwards', async () => {
    const gate = deferred()
    const { url, provider } = await start([{ data: workflowReply(plainWorkflow()) }, { gate: gate.promise, data: workflowReply(plainWorkflow('slow')) }])
    const first = await connect(url)
    const second = await connect(url)
    await first.client.request('plan', planParams({ planId: 'done' }))
    const slow = first.client.request('plan', planParams({ planId: 'slow' }))
    await provider.calls(2)

    expect((await second.client.request('ping', {})).time).toBeGreaterThan(0)
    expect((await second.client.request('getPlan', { planId: 'done' })).plan.status).toBe('planned')
    expect((await failure(second.client.request('getPlan', { planId: 'slow' }))).code).toBe('NOT_FOUND')
    expect((await second.client.request('listPlans', {})).plans.map((p) => p.planId)).toEqual(['done'])

    gate.release()
    expect((await slow).planId).toBe('slow')
    expect((await second.client.request('listPlans', {})).plans.map((p) => p.planId).sort()).toEqual(['done', 'slow'])
  })

  it('cancels a running plan from another message and from another client', async () => {
    const { url, provider } = await start([{ wait: true }, { wait: true }])
    const first = await connect(url)
    const second = await connect(url)
    const own = failure(first.client.request('plan', planParams({ planId: 'own' })))
    const foreign = failure(first.client.request('plan', planParams({ planId: 'foreign' })))
    await provider.calls(2)
    expect(await first.client.request('cancelPlan', { planId: 'own' })).toEqual({ cancelled: true })
    expect(await second.client.request('cancelPlan', { planId: 'foreign' })).toEqual({ cancelled: true })
    expect((await own).code).toBe('PLAN_CANCELLED')
    expect((await foreign).code).toBe('PLAN_CANCELLED')
    expect((await first.client.request('getPlan', { planId: 'own' })).plan).toMatchObject({ status: 'cancelled', error: 'planning was cancelled' })
    expect(await first.client.request('cancelPlan', { planId: 'own' })).toEqual({ cancelled: false })
    expect(await first.client.request('cancelPlan', { planId: 'nope' })).toEqual({ cancelled: false })
  })

  it('keeps planning when the client disconnects, and the record stays readable', async () => {
    const gate = deferred()
    const { url, provider } = await start([{ gate: gate.promise, data: workflowReply(plainWorkflow()) }])
    const leaving = await connect(url)
    const reader = await connect(url)
    const lost = leaving.client.request('plan', planParams()).catch((error: unknown) => error)
    await provider.calls(1)
    leaving.client.close()
    expect(await lost).toBeInstanceOf(Error)
    expect(provider.signals[0]?.aborted).toBe(false)
    gate.release()
    await eventually(async () => (await reader.client.request('listPlans', {})).plans.length > 0)
    expect((await reader.client.request('getPlan', { planId: 'plan-1' })).plan.status).toBe('planned')
  })

  it('rejects an oversized plan request with the existing payload limit', async () => {
    const { url, provider, db } = await start([], {}, { maxMessageBytes: 4096 })
    const healthy = await connect(url)
    const socket = new WebSocket(url, [SUBPROTOCOL, tokenProtocol(TOKEN)])
    cleanups.push(() => socket.close())
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('could not connect')))
    })
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))
    socket.send(JSON.stringify({ type: 'request', id: '1', method: 'plan', params: planParams({ text: 'x'.repeat(8000) }) }))
    expect(await closed).toBe(1009)
    expect(provider.requests).toHaveLength(0)
    expect(db.all('SELECT id FROM plans')).toEqual([])
    expect((await healthy.client.request('ping', {})).time).toBeGreaterThan(0)
  })

  it('rejects invalid plan params with INVALID_PARAMS before the engine sees them', async () => {
    const { url, provider } = await start([])
    const { client } = await connect(url)
    const bad = [
      planParams({ text: '' }),
      planParams({ effort: 'ultra' as never }),
      planParams({ attachments: Array.from({ length: 6 }, (_, i) => ({ id: `att0000${i}`, mediaType: 'text/plain', name: 'a.txt', bytes: 1 }) as AttachmentRef) }),
      { ...planParams(), extra: true } as never,
    ]
    for (const params of bad) expect((await failure(client.request('plan', params))).code).toBe('INVALID_PARAMS')
    expect(provider.requests).toHaveLength(0)
  })

  it('reports LLM_UNAVAILABLE when the engine has no model provider', async () => {
    const { url } = await start([], { llm: undefined })
    const { client } = await connect(url)
    const error = await failure(client.request('plan', planParams()))
    expect(error.code).toBe('LLM_UNAVAILABLE')
    expect((await client.request('listPlans', {})).plans).toEqual([])
  })
})

describe('error mapping over the websocket with the real engine', () => {
  it('maps a provider authentication failure to LLM_UNAVAILABLE and other provider failures to PLAN_PROVIDER', async () => {
    const secret = 'UPSTREAM-SECRET-TEXT'
    const { url, logs } = await start([
      { error: new LlmError('auth', `invalid x-api-key ${secret}`) },
      { error: new LlmError('overloaded', `overloaded ${secret}`) },
    ])
    const { client, frames } = await connect(url)
    expect((await failure(client.request('plan', planParams({ planId: 'a' })))).code).toBe('LLM_UNAVAILABLE')
    const provider = await failure(client.request('plan', planParams({ planId: 'b' })))
    expect(provider).toMatchObject({ code: 'PLAN_PROVIDER', message: 'the model provider failed' })
    expect(frames.join('\n')).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(secret)
  })

  it('maps a plan that stays invalid to PLAN_INVALID with code-at-pointer problems and no model text', async () => {
    const summary = 'MODEL-SUMMARY-MARKER'
    const invalid = { schemaVersion: 1, name: 'broken', nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }], edges: [{ from: 't1', to: 'ghost' }] }
    const { url } = await start([{ data: workflowReply(invalid as never, summary) }, { data: workflowReply(invalid as never, summary) }], { maxRepairRounds: 1 })
    const { client, frames } = await connect(url)
    const error = await failure(client.request('plan', planParams()))
    expect(error.code).toBe('PLAN_INVALID')
    expect(error.problems.length).toBeGreaterThan(0)
    for (const problem of error.problems) expect(problem).toMatch(/^[a-z_0-9]+ at \//)
    expect(error.problems.some((problem) => problem.startsWith('edge_unknown_node at '))).toBe(true)
    expect(frames.join('\n')).not.toContain(summary)
  })

  it('maps an invalid selection to INVALID_PARAMS', async () => {
    const { url, provider } = await start([])
    const { client } = await connect(url)
    const error = await failure(client.request('plan', planParams({ selection: { nodeId: 'n1' } })))
    expect(error.code).toBe('INVALID_PARAMS')
    expect(error.problems).toEqual(['selection_without_workflow at /selection/nodeId'])
    expect(provider.requests).toHaveLength(0)
  })

  it('maps a missing attachment to ATTACHMENT_REJECTED with a sanitised name and no path', async () => {
    const { url } = await start([])
    const { client } = await connect(url)
    const ref: AttachmentRef = { id: 'missing01', mediaType: 'text/plain', name: 'evil<script>\u0007.txt', bytes: 3 }
    const error = await failure(client.request('plan', planParams({ attachments: [ref] })))
    expect(error.code).toBe('ATTACHMENT_REJECTED')
    expect(error.message).toContain('evilscript.txt')
    expect(error.message).not.toContain('<')
    expect(error.message).not.toContain(dir)
  })

  it('maps a busy engine and a reused id to PLAN_BUSY and PLAN_EXISTS', async () => {
    const { url, provider } = await start([{ wait: true }, { data: workflowReply(plainWorkflow()) }], { maxConcurrentPlans: 1 })
    const { client } = await connect(url)
    const running = failure(client.request('plan', planParams({ planId: 'a' })))
    await provider.calls(1)
    expect((await failure(client.request('plan', planParams({ planId: 'b' })))).code).toBe('PLAN_BUSY')
    expect((await failure(client.request('plan', planParams({ planId: 'a' })))).code).toBe('PLAN_EXISTS')
    await client.request('cancelPlan', { planId: 'a' })
    await running
    await client.request('plan', planParams({ planId: 'c' }))
    expect((await failure(client.request('plan', planParams({ planId: 'c' })))).code).toBe('PLAN_EXISTS')
  })

  it('maps unknown plans and an unknown workflow to NOT_FOUND', async () => {
    const { url } = await start([])
    const { client } = await connect(url)
    expect((await failure(client.request('getPlan', { planId: 'nope' }))).code).toBe('NOT_FOUND')
    expect((await failure(client.request('deployPlan', { planId: 'nope', confirmed: [] }))).code).toBe('NOT_FOUND')
    expect((await failure(client.request('plan', planParams({ workflowId: 'nope' })))).code).toBe('NOT_FOUND')
  })

  it('reports a planned workflow that no longer validates without echoing its values', async () => {
    const LITERAL = 'SECRET-LITERAL-IN-CONFIG'
    const { url, engine, db } = await start([{ data: workflowReply(plainWorkflow()) }])
    const { client, frames } = await connect(url)
    await client.request('plan', planParams())
    const stored = engine.getPlan('plan-1')
    const broken = { ...plainWorkflow(), nodes: [plainWorkflow().nodes[0], { id: 'n1', type: 'delay@1', config: { ms: LITERAL } }] }
    db.run('UPDATE plans SET result = ? WHERE id = ?', JSON.stringify({ ...stored.result, workflow: broken }), 'plan-1')
    const error = await failure(client.request('deployPlan', { planId: 'plan-1', confirmed: [] }))
    expect(error.code).toBe('INVALID_WORKFLOW')
    expect(error.problems.length).toBeGreaterThan(0)
    for (const problem of error.problems) expect(problem).toMatch(/^[a-z_0-9]+ at \//)
    expect(frames.join('\n')).not.toContain(LITERAL)
  })
})

describe('error mapping table', () => {
  const issues = (count: number): PlanIssue[] =>
    Array.from({ length: count }, (_, i) => ({ stage: 3, pointer: `/nodes/${i}/config`, code: 'config_required', message: `secret message ${i}` }))
  const ref: AttachmentRef = { id: 'att00001', mediaType: 'text/plain', name: 'a.txt', bytes: 1 }

  async function mapped(thrown: unknown, method: 'plan' | 'getPlan' | 'deployPlan' | 'cancelPlan' | 'deploy' = 'plan'): Promise<RillError> {
    const fail = () => {
      throw thrown
    }
    const engine = { on: () => () => undefined, plan: fail, cancelPlan: fail, getPlan: fail, listPlans: fail, deployPlan: fail, deploy: fail } as unknown as Engine
    const { url } = await startServer(engine)
    const { client } = await connect(url)
    const params = {
      plan: planParams(),
      getPlan: { planId: 'p' },
      deployPlan: { planId: 'p', confirmed: [] },
      cancelPlan: { planId: 'p' },
      deploy: { workflow: {} },
    }[method]
    return failure(client.request(method, params as never))
  }

  it('maps LlmUnavailableError and a provider authentication failure to LLM_UNAVAILABLE', async () => {
    const none = await mapped(new LlmUnavailableError())
    expect(none).toMatchObject({ code: 'LLM_UNAVAILABLE', message: new LlmUnavailableError().message })
    const auth = await mapped(new PlanError('provider', 'the model provider failed: invalid key sk-123', [], [], { cause: new LlmError('auth', 'invalid key sk-123') }))
    expect(auth.code).toBe('LLM_UNAVAILABLE')
    expect(auth.message).not.toContain('sk-123')
  })

  it('maps other provider failures to PLAN_PROVIDER with a fixed message', async () => {
    for (const cause of [new LlmError('rate_limit', 'slow down TEXT-A'), new LlmError('unknown', 'weird TEXT-A'), new Error('plain TEXT-A'), undefined]) {
      const error = await mapped(new PlanError('provider', 'the model provider failed: TEXT-A', [], [], cause === undefined ? undefined : { cause }))
      expect(error).toMatchObject({ code: 'PLAN_PROVIDER', message: 'the model provider failed' })
      expect(JSON.stringify(error)).not.toContain('TEXT-A')
    }
  })

  it('maps invalid_after_repair to PLAN_INVALID and lists at most 20 problems as code at pointer', async () => {
    const error = await mapped(new PlanError('invalid_after_repair', 'no valid answer after 3 repair rounds', [], issues(25)))
    expect(error.code).toBe('PLAN_INVALID')
    expect(error.problems).toHaveLength(20)
    expect(error.problems[0]).toBe('config_required at /nodes/0/config')
    expect(error.problems[19]).toBe('config_required at /nodes/19/config')
    expect(error.problems.join(' ')).not.toContain('secret message')
    const few = await mapped(new PlanError('invalid_after_repair', 'x', [], [{ stage: 1, pointer: '', code: 'invalid_output', message: 'm' }]))
    expect(few.problems).toEqual(['invalid_output at /'])
    expect((await mapped(new PlanError('invalid_after_repair', 'x', [], []))).problems).toEqual([])
  })

  it('maps invalid_request to INVALID_PARAMS', async () => {
    const error = await mapped(new PlanError('invalid_request', 'a selection needs context.existingWorkflow', [], issues(1)))
    expect(error.code).toBe('INVALID_PARAMS')
    expect(error.problems).toEqual(['config_required at /nodes/0/config'])
  })

  it('maps aborted to PLAN_CANCELLED', async () => {
    expect(await mapped(new PlanError('aborted', 'planning was aborted', [], []))).toMatchObject({ code: 'PLAN_CANCELLED', message: 'planning was cancelled' })
  })

  it('maps PlanError attachment and AttachmentError to ATTACHMENT_REJECTED with their own message', async () => {
    const message = 'attachment "a.txt" is empty'
    expect(await mapped(new PlanError('attachment', message, [], []))).toMatchObject({ code: 'ATTACHMENT_REJECTED', message })
    expect(await mapped(new AttachmentError('empty', ref, message))).toMatchObject({ code: 'ATTACHMENT_REJECTED', message })
  })

  it('maps the plan state errors to their codes and keeps their messages', async () => {
    const rows: Array<[Error, string]> = [
      [new PlanBusyError(2), 'PLAN_BUSY'],
      [new PlanExistsError('p'), 'PLAN_EXISTS'],
      [new PlanNotConfirmedError('confirm every flag before deploying; not confirmed: n1 at /url'), 'PLAN_NOT_CONFIRMED'],
      [new PlanDeployedError('p'), 'PLAN_DEPLOYED'],
      [new PlanNotFoundError('p'), 'NOT_FOUND'],
      [new NotFoundError('workflow not found: w'), 'NOT_FOUND'],
    ]
    for (const [thrown, code] of rows) {
      const error = await mapped(thrown)
      expect(error, thrown.name).toMatchObject({ code, message: thrown.message })
    }
  })

  it('maps plan errors thrown by every planner method and by deploy', async () => {
    for (const method of ['plan', 'getPlan', 'deployPlan', 'cancelPlan', 'deploy'] as const) {
      expect((await mapped(new PlanNotConfirmedError('x'), method)).code, method).toBe('PLAN_NOT_CONFIRMED')
    }
  })

  it('keeps the INVALID_WORKFLOW mapping and lists only codes and pointers for deployPlan', async () => {
    const thrown = new WorkflowValidationError(['node n1: ms must be number, got LEAK'], [{ stage: 3, pointer: '/nodes/1/config/ms', code: 'config_type', message: 'node n1: ms must be number, got LEAK' }])
    const forDeploy = await mapped(thrown, 'deploy')
    expect(forDeploy).toMatchObject({ code: 'INVALID_WORKFLOW', message: 'the workflow is not valid', problems: ['node n1: ms must be number, got LEAK'] })
    const forPlan = await mapped(thrown, 'deployPlan')
    expect(forPlan.code).toBe('INVALID_WORKFLOW')
    expect(forPlan.problems).toEqual(['config_type at /nodes/1/config/ms'])
    expect(JSON.stringify(forPlan)).not.toContain('LEAK')
  })

  it('maps anything else to INTERNAL and logs only the error name for planner methods', async () => {
    const logs: string[] = []
    const fail = () => {
      throw new TypeError(`broke on ${MARKER}`)
    }
    const engine = { on: () => () => undefined, plan: fail, deployPlan: fail } as unknown as Engine
    const { url } = await startServer(engine, { log: (line) => logs.push(line) })
    const { client, frames } = await connect(url)
    expect(await failure(client.request('plan', planParams()))).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
    expect(await failure(client.request('deployPlan', { planId: 'p', confirmed: [] }))).toMatchObject({ code: 'INTERNAL' })
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', method: 'plan', name: 'TypeError' },
      { type: 'error', method: 'deployPlan', name: 'TypeError' },
    ])
    expect(frames.join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })
})

describe('attachment bytes never leave the engine', () => {
  it('keeps the marker out of every frame, every stored record and every log line', async () => {
    writeFileSync(join(attachments, 'receipt1.txt'), `Receipt\nTotal 12.50\n${MARKER}\n`)
    writeFileSync(join(attachments, 'receipt2.csv'), `a,b\n${MARKER},2\n`)
    const refs: AttachmentRef[] = [
      { id: 'receipt1', mediaType: 'text/plain', name: 'receipt.txt', bytes: 40 },
      { id: 'receipt2', mediaType: 'text/csv', name: 'receipt.csv', bytes: 20 },
    ]
    const { url, db, engine, provider, logs } = await start([
      { data: workflowReply(plainWorkflow(), `Waits after the receipts ${MARKER}`) },
      { error: new LlmError('overloaded', 'busy') },
      { error: new Error(`raw failure with ${MARKER}`) },
    ])
    const { client, frames } = await connect(url)
    await client.request('plan', planParams({ planId: 'ok', attachments: refs, text: 'Use the receipts' }))
    await failure(client.request('plan', planParams({ planId: 'provider', attachments: refs })))
    await failure(client.request('plan', planParams({ planId: 'raw', attachments: refs })))
    await failure(client.request('plan', planParams({ planId: 'missing', attachments: [{ ...refs[0]!, id: 'gone0001' }] })))
    await client.request('getPlan', { planId: 'ok' })
    await client.request('listPlans', {})

    expect(provider.requests[0] === undefined ? '' : JSON.stringify(provider.requests[0])).toContain(MARKER)
    const everything = {
      frames: frames.join('\n'),
      records: JSON.stringify(['ok', 'provider', 'raw', 'missing'].map((id) => engine.getPlan(id))),
      table: JSON.stringify(db.all('SELECT * FROM plans')),
      logs: logs.join('\n'),
    }
    for (const [name, text] of Object.entries(everything)) expect(text, name).not.toContain(MARKER)
    expect(logs.length).toBe(1)
    expect(engine.getPlan('ok').attachments).toEqual(refs)
    expect(db.all<{ n: number }>('SELECT COUNT(*) AS n FROM plans')[0]?.n).toBe(4)
  })

  it('does not put the flagged literal into a not-confirmed error', async () => {
    const { url } = await start([{ data: workflowReply(flaggedWorkflow()) }])
    const { client, frames } = await connect(url)
    await client.request('plan', planParams())
    await failure(client.request('deployPlan', { planId: 'plan-1', confirmed: [] }))
    const errorFrames = frames.filter((frame) => frame.includes('PLAN_NOT_CONFIRMED')).join('\n')
    expect(errorFrames).not.toContain('hooks.invalid')
  })
})
