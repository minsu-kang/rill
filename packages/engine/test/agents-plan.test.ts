import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { PlanRecordSchema, RillClient, RillError, type AgentFields, type MethodParams } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentNotFoundError } from '../src/agents'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'
import { GOOD, http, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { ScriptedProvider, plainWorkflow, workflowReply, type Step } from './plan-helpers'

const TOKEN = 'agents-plan-token-0123456789abcdef'
const MARKER = 'AGENT-MARKER-9d3e'

let dir: string
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-agents-plan-'))
  mkdirSync(join(dir, 'attachments'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function start(steps: Step[] = []) {
  const provider = new ScriptedProvider(steps)
  const db = Db.open(':memory:')
  const engine = new Engine({ db, registry: createCoreRegistry(), llm: provider, attachmentsRoot: join(dir, 'attachments'), allowedRoots: [dir], now: () => 1_000 })
  cleanups.push(() => engine.shutdown())
  const logs: string[] = []
  const frames: string[] = []
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN, {
    socketFactory: (target, protocol) => {
      const socket = new WebSocket(target, protocol)
      socket.addEventListener('message', (event) => frames.push(String(event.data)))
      return socket as never
    },
  })
  cleanups.push(() => client.close())
  return { engine, db, provider, client, logs, frames }
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

const fields: AgentFields = { name: 'Reviewer', description: `${MARKER} description`, persona: `${MARKER} persona`, instructions: `${MARKER} instructions` }

describe('plan with an agentId', () => {
  it('fails with AGENT_NOT_FOUND before any model call, saves no plan and frees the plan id', async () => {
    const { client, provider, engine, db } = await start([{ data: workflowReply(plainWorkflow()) }])
    const error = await failure(client.request('plan', planParams({ agentId: 'missing' })))
    expect(error.code).toBe('AGENT_NOT_FOUND')
    expect(provider.requests).toHaveLength(0)
    expect(engine.listPlans()).toEqual([])
    expect(db.all('SELECT id FROM plans')).toEqual([])
    await client.request('plan', planParams())
    expect(provider.requests).toHaveLength(1)
  })

  it('throws AgentNotFoundError from the engine', async () => {
    const { engine } = await start()
    await expect(engine.plan({ planId: 'p', text: 't', turns: [], attachments: [], effort: 'low', agentId: 'missing' })).rejects.toBeInstanceOf(AgentNotFoundError)
  })

  it('treats an absent agentId and the id default as the built-in agent, whatever the active agent is', async () => {
    const { client, engine, provider } = await start([{ data: workflowReply(plainWorkflow()) }, { data: workflowReply(plainWorkflow()) }])
    const agent = (await client.request('saveAgent', fields)).agent
    await client.request('setActiveAgent', { id: agent.id })
    await client.request('plan', planParams({ planId: 'absent' }))
    await client.request('plan', planParams({ planId: 'explicit', agentId: 'default' }))
    expect(provider.requests).toHaveLength(2)
    for (const id of ['absent', 'explicit']) {
      const record = engine.getPlan(id)
      expect(record.agentId).toBeUndefined()
      expect(Object.keys(record)).not.toContain('agentId')
    }
  })

  it('records the id of a saved agent on the plan and in the column agent_id', async () => {
    const { client, engine, db } = await start([{ data: workflowReply(plainWorkflow()) }])
    const agent = (await client.request('saveAgent', fields)).agent
    await client.request('plan', planParams({ agentId: agent.id }))
    expect(engine.getPlan('plan-1').agentId).toBe(agent.id)
    expect((await client.request('getPlan', { planId: 'plan-1' })).plan.agentId).toBe(agent.id)
    expect(db.get<{ agent_id: string | null }>('SELECT agent_id FROM plans')?.agent_id).toBe(agent.id)
    expect(Value.Check(PlanRecordSchema, engine.getPlan('plan-1'))).toBe(true)
  })

  it('records the agent on a failed plan too, and no agent text anywhere in the record', async () => {
    const { client, engine, db } = await start([{ error: new LlmError('overloaded', 'busy') }])
    const agent = (await client.request('saveAgent', fields)).agent
    await failure(client.request('plan', planParams({ agentId: agent.id })))
    const record = engine.getPlan('plan-1')
    expect(record.status).toBe('failed')
    expect(record.agentId).toBe(agent.id)
    expect(JSON.stringify(record)).not.toContain(MARKER)
    expect(JSON.stringify(db.all('SELECT * FROM plans'))).not.toContain(MARKER)
  })

  it('keeps the id on the plan after the agent is deleted', async () => {
    const { client, engine } = await start([{ data: workflowReply(plainWorkflow()) }])
    const agent = (await client.request('saveAgent', fields)).agent
    await client.request('plan', planParams({ agentId: agent.id }))
    await client.request('deleteAgent', { id: agent.id })
    expect(engine.getPlan('plan-1').agentId).toBe(agent.id)
  })

  it('refuses agent text in the plan params, so a client cannot send a profile of its own', async () => {
    const { client, provider } = await start()
    for (const extra of [{ agent: { persona: 'x' } }, { persona: 'x' }, { instructions: 'x' }, { agentName: 'x' }]) {
      expect((await failure(client.request('plan', { ...planParams(), ...extra } as never))).code).toBe('INVALID_PARAMS')
    }
    expect(provider.requests).toHaveLength(0)
  })

  it('never echoes an agent id that does not exist in the error', async () => {
    const { client, frames, logs } = await start()
    await failure(client.request('plan', planParams({ agentId: MARKER })))
    expect(frames.filter((frame) => frame.includes('"ok":false')).join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
  })
})

describe('explainRun with an agentId', () => {
  const dirOf = useTempDir()
  useCleanups()

  it('fails with AGENT_NOT_FOUND before any model call', async () => {
    const env = await startEnv(dirOf.get(), [{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    expect((await failure(env.client.request('explainRun', { runId, agentId: 'missing' }))).code).toBe('AGENT_NOT_FOUND')
    expect(env.provider.requests).toHaveLength(0)
    const result = await env.client.request('explainRun', { runId })
    expect(result.runId).toBe(runId)
    expect(env.provider.requests).toHaveLength(1)
  })

  it('accepts the id default and the id of a saved agent', async () => {
    const env = await startEnv(dirOf.get(), [{ data: GOOD }, { data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    const agent = (await env.client.request('saveAgent', fields)).agent
    await env.client.request('explainRun', { runId, agentId: 'default' })
    await env.client.request('explainRun', { runId, agentId: agent.id })
    expect(env.provider.requests).toHaveLength(2)
  })

  it('refuses agent text in the params', async () => {
    const env = await startEnv(dirOf.get(), [{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    expect((await failure(env.client.request('explainRun', { runId, persona: 'x' } as never))).code).toBe('INVALID_PARAMS')
    expect(env.provider.requests).toHaveLength(0)
  })
})
