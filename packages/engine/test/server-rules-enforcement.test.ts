import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { RillClient, RillError, type EngineEvent } from '@rill/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { RillServer } from '../src/server/server'
import { ManualClock } from './manual-clock'
import { ScriptedProvider, flaggedWorkflow, workflowReply, type Step } from './plan-helpers'

const TOKEN = 'rules-enf-token-0123456789abcdef'
const MARKER = 'rule-marker-77e1'
const START = Date.UTC(2026, 10, 11, 10, 0, 30)

const cleanups: Array<() => Promise<void> | void> = []
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-rules-srv-'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function start(options: Partial<EngineOptions> & { steps?: Step[] } = {}) {
  const { steps, ...rest } = options
  const logs: string[] = []
  const clock = new ManualClock(START)
  const engine = new Engine({
    db: Db.open(':memory:'),
    registry: createCoreRegistry(),
    clock,
    sleep: async () => undefined,
    allowedRoots: [dir],
    webhookPort: 0,
    ...(steps === undefined ? {} : { llm: new ScriptedProvider(steps) }),
    ...rest,
  })
  cleanups.push(() => engine.shutdown())
  const server = new RillServer({ engine, token: TOKEN, log: (line) => logs.push(line) })
  const port = await server.listen()
  cleanups.push(() => server.close())
  const frames: string[] = []
  const events: EngineEvent[] = []
  const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN, {
    socketFactory: (target, protocols) => {
      const socket = new WebSocket(target, protocols)
      socket.addEventListener('message', (event) => frames.push(String(event.data)))
      return socket as never
    },
  })
  client.onEvent((event) => events.push(event))
  cleanups.push(() => client.close())
  return { client, engine, clock, logs, frames, events }
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

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config })
const flow = (name: string, nodes: unknown[]) => ({
  schemaVersion: 1,
  name,
  nodes,
  edges: (nodes as Array<{ id: string }>).slice(1).map((entry, index) => ({ from: (nodes as Array<{ id: string }>)[index]!.id, to: entry.id })),
})
const manual = node('t1', 'trigger.manual@1')
const cron = node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })
const call = (url: string) => node('n1', 'http.request@1', { url })

describe('rules over the websocket', () => {
  it('answers a refused startRun with RULE_VIOLATION and the issue codes, and creates no run', async () => {
    const { client } = await start()
    const { workflowId } = await client.request('deploy', { workflow: flow('a', [manual, call('https://api.example.com/x')]) })
    await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    const error = await failure(client.request('startRun', { workflowId }))
    expect(error.code).toBe('RULE_VIOLATION')
    expect(error.problems).toEqual(['rule_violation at /nodes/1/type'])
    expect(error.message).toBe('the workflow breaks a rule you set; remove the rule or change the workflow')
    expect((await failure(client.request('startRun', { workflowId, dryRun: true }))).code).toBe('RULE_VIOLATION')
    expect(await client.request('listRuns', {})).toEqual({ runs: [] })
  })

  it('starts the same run when the rule is deleted', async () => {
    const { client } = await start()
    const { workflowId } = await client.request('deploy', { workflow: flow('a', [manual, node('n1', 'delay@1', { ms: 1 })]) })
    const { rule } = await client.request('saveRule', { kind: 'forbidNode', value: 'delay' })
    expect((await failure(client.request('startRun', { workflowId }))).code).toBe('RULE_VIOLATION')
    await client.request('deleteRule', { id: rule.id })
    const { runId } = await client.request('startRun', { workflowId })
    expect(runId).toBeTypeOf('string')
  })

  it('answers a refused activate with ACTIVATION_FAILED and a plain message', async () => {
    const { client } = await start()
    const { workflowId } = await client.request('deploy', { workflow: flow('a', [cron, call('https://api.example.com/x')]) })
    await client.request('saveRule', { kind: 'allowHost', value: 'other.example.com' })
    const error = await failure(client.request('activate', { workflowId }))
    expect(error.code).toBe('ACTIVATION_FAILED')
    expect(error.message).toBe('the workflow breaks a rule you set; remove the rule or change the workflow')
    expect((await client.request('listWorkflows', {})).workflows[0]!.active).toBe(false)
  })

  it('answers a refused deploy with INVALID_WORKFLOW and the messages of the rule_violation issues', async () => {
    const { client } = await start()
    await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    const error = await failure(client.request('deploy', { workflow: flow('a', [manual, call('https://api.example.com/x')]) }))
    expect(error.code).toBe('INVALID_WORKFLOW')
    expect(error.problems?.[0]).toContain('http.request')
    expect((await client.request('listWorkflows', {})).workflows).toEqual([])
  })

  it('answers a refused deployPlan with INVALID_WORKFLOW and the issue codes only', async () => {
    const { client, engine } = await start({ steps: [{ data: workflowReply(flaggedWorkflow()) }] })
    await client.request('plan', { planId: 'p1', text: 'post out', turns: [], attachments: [], effort: 'low' })
    const flags = engine.getPlan('p1').flagKeys
    await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    const error = await failure(client.request('deployPlan', { planId: 'p1', confirmed: flags }))
    expect(error.code).toBe('INVALID_WORKFLOW')
    expect(error.problems).toEqual(['rule_violation at /nodes/1/type'])
  })

  it('answers a refused instantiateRecipe with RECIPE_INVALID and the issue code', async () => {
    const { client } = await start({ allowedRoots: ['/Users/demo'], planConnections: [{ name: 'slack-ops', kind: 'slack' }] })
    await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    const error = await failure(
      client.request('instantiateRecipe', { recipeId: 'daily-health-check', values: { schedule: '30 8 * * 1-5', url: 'https://example.test/health', slackConnection: 'slack-ops' } }),
    )
    expect(error.code).toBe('RECIPE_INVALID')
    expect(error.problems).toEqual(['rule_violation at /nodes/1/type'])
  })

  it('lists the stored workflows that break a rule with checkRules, and nothing when none does', async () => {
    const { client } = await start()
    expect(await client.request('checkRules', {})).toEqual({ violations: [] })
    const { workflowId } = await client.request('deploy', { workflow: flow('uses http', [manual, call('https://api.example.com/x')]) })
    await client.request('deploy', { workflow: flow('waits', [manual, node('n1', 'delay@1', { ms: 1 })]) })
    expect(await client.request('checkRules', {})).toEqual({ violations: [] })
    await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    const { violations } = await client.request('checkRules', {})
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ workflowId, name: 'uses http' })
    expect(violations[0]!.issues.map((issue) => issue.code)).toEqual(['rule_violation'])
  })

  it('sends a run.blocked event when a trigger fires for a workflow that breaks a rule', async () => {
    const { client, engine, clock, events } = await start()
    const { workflowId } = await client.request('deploy', { workflow: flow('cron', [cron, call('https://api.example.com/x')]) })
    await client.request('activate', { workflowId })
    await client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    clock.advance(30_000)
    await engine.idle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.filter((event) => event.type === 'run.blocked')).toEqual([{ type: 'run.blocked', at: expect.any(Number), workflowId, codes: ['rule_violation'] }])
  })

  it('never writes a rule value to the log or to an error frame of the new checks', async () => {
    const { client, logs, frames } = await start()
    const { workflowId } = await client.request('deploy', { workflow: flow('a', [manual, call(`https://${MARKER}.example.com/x`)]) })
    await client.request('saveRule', { kind: 'allowHost', value: `${MARKER}-allowed.example.com` })
    await client.request('saveRule', { kind: 'forbidNode', value: 'delay' })
    await failure(client.request('startRun', { workflowId }))
    await failure(client.request('activate', { workflowId }))
    await client.request('checkRules', {})
    const errorFrames = frames.filter((frame) => frame.includes('"ok":false'))
    expect(errorFrames).toHaveLength(2)
    expect(errorFrames.join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain(MARKER)
    expect(logs).toEqual([])
  })
})
