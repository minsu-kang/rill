import { mkdirSync, readdirSync } from 'node:fs'
import type { WorkflowNode } from '@rill/dsl'
import { join } from 'node:path'
import { ExplainError } from '@rill/planner'
import { RillClient } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine'
import { RillServer } from '../src/server/server'
import { CONNECTION_SECRET, GOOD, LITERAL_SECRET, RUN_MARKER, TOKEN, allTables, failure, http, startEnv, useCleanups, useTempDir } from './explain-helpers'
import { isolateKeyEnvironment } from './llm-env'
import { plainWorkflow, workflowReply, type Step } from './plan-helpers'

const dirOf = useTempDir()
useCleanups()
isolateKeyEnvironment()

const start = (steps: Step[] = [], engineOptions = {}, options: { llm?: boolean } = {}) => startEnv(dirOf.get(), steps, engineOptions, options)

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

function userText(request: { messages: Array<{ content: unknown }> }): string {
  const content = request.messages[0]!.content
  return typeof content === 'string' ? content : (content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n')
}

describe('explainRun is read-only', () => {
  it('leaves every table, every file and the event stream as they were', async () => {
    const dir = dirOf.get()
    mkdirSync(join(dir, 'in'))
    const env = await start([{ data: workflowReply(plainWorkflow()) }, { data: GOOD }, { data: GOOD }])
    await env.client.request('saveMemory', { text: 'My receipts live in the Receipts folder' })
    await env.client.request('plan', { planId: 'plan-1', text: 'Wait a little', turns: [], attachments: [], effort: 'medium' })
    const runId = await env.run([{ id: 'n0', type: 'csv.append@1', config: { file: join(dir, 'in', 'ledger.csv'), row: ['a', 'b'] } }, http(env.base, '/status/404')])
    expect((await env.client.request('getRun', { runId })).run.status).toBe('failed')

    const tables = allTables(env.db)
    for (const name of ['plans', 'memory_items', 'idempotency_journal', 'runs', 'step_attempts', 'workflows']) expect(JSON.parse(tables[name]!), name).not.toHaveLength(0)
    const files = listing(dir)
    const events: unknown[] = []
    env.engine.on((event) => events.push(event))
    const frames = env.frames.length

    await env.client.request('explainRun', { runId })
    await env.client.request('explainRun', { runId, effort: 'medium' })

    expect(allTables(env.db)).toEqual(tables)
    expect(listing(dir)).toEqual(files)
    expect(events).toEqual([])
    expect(env.frames.slice(frames).every((frame) => !frame.includes('"type":"event"'))).toBe(true)
  })

  it('leaves getRun and listRuns as they were', async () => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    const before = [await env.client.request('getRun', { runId }), await env.client.request('listRuns', {})]
    await env.client.request('explainRun', { runId })
    expect([await env.client.request('getRun', { runId }), await env.client.request('listRuns', {})]).toEqual(before)
  })

  it('does not start a run, retry a step or call a node', async () => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/503', { retry: { maxAttempts: 2, baseDelayMs: 0 } })])
    let hits = 0
    env.engine.on(() => void (hits += 1))
    const steps = (await env.client.request('getRun', { runId })).steps.length
    await env.client.request('explainRun', { runId })
    expect(hits).toBe(0)
    expect((await env.client.request('getRun', { runId })).steps).toHaveLength(steps)
    expect((await env.client.request('listRuns', {})).runs).toHaveLength(1)
  })
})

describe('what the provider receives', () => {
  it('has neither the secret of a connection that a response echoes nor a literal authorization header', async () => {
    const env = await start([{ data: GOOD }])
    const node = http(env.base, '/echo-token', {}, {
      headers: { Authorization: `Bearer ${LITERAL_SECRET}`, 'X-Trace': 'trace-1' },
      auth: { connection: 'api', header: 'X-Api-Token', scheme: 'None' },
    })
    const runId = await env.run([node])
    const detail = await env.client.request('getRun', { runId })
    expect(detail.steps[0]!.error).toContain(CONNECTION_SECRET)
    expect(JSON.stringify(detail.steps[0]!.input)).toContain(LITERAL_SECRET)

    const mark = env.frames.length
    const result = await env.client.request('explainRun', { runId })
    const sent = JSON.stringify(env.provider.requests[0])
    expect(sent).not.toContain(CONNECTION_SECRET)
    expect(sent).not.toContain(LITERAL_SECRET)
    expect(sent).toContain('<secret>')
    expect(sent).toContain('<redacted>')
    expect(result.signals).toEqual([{ nodeId: 'n1', signal: 'http_status_401_403' }])
    const everything = [...env.frames.slice(mark), ...env.logs, JSON.stringify(result)].join('\n')
    expect(everything).not.toContain(CONNECTION_SECRET)
    expect(everything).not.toContain(LITERAL_SECRET)
  })

  it('has the secret of a connection that only a templated name reaches', async () => {
    const env = await start([{ data: GOOD }])
    const node = http(env.base, '/echo-token', {}, { auth: { connection: '{{t1.output.name}}', header: 'X-Api-Token', scheme: 'None' } })
    const runId = await env.run([node], { name: 'api' })
    await env.client.request('explainRun', { runId })
    expect(JSON.stringify(env.provider.requests[0])).not.toContain(CONNECTION_SECRET)
  })

  it('sends only the rules, one message, the schema and the limits: nothing that could carry a key rides along', async () => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    await env.client.request('explainRun', { runId })
    const request = env.provider.requests[0]!
    expect(Object.keys(request).sort()).toEqual(['effort', 'maxTokens', 'messages', 'schema', 'system'])
    expect(request.messages).toHaveLength(1)
    expect(request.system).toHaveLength(1)
    expect(Object.keys(request.system![0]!)).toEqual(['text'])
  })

  it('stays within 12,000 characters, and fast, for 50 steps with 1 MB of output each', async () => {
    const env = await start([{ data: GOOD }])
    const nodes = Array.from({ length: 50 }, (_, index) => ({ id: `s${index}`, type: 'transform@1', config: { values: { index } } }))
    const workflowId = env.workflow(nodes)
    const run = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    env.engine.store.markRunRunning(run.id)
    const big = 'lorem ipsum '.repeat(87_400)
    nodes.forEach((node, index) => {
      const attempt = env.engine.store.startAttempt({ runId: run.id, nodeId: node.id, input: { text: big }, idempotencyKey: `k${index}` })
      if (index === 49) env.engine.store.finishAttempt(run.id, node.id, attempt, { status: 'failed', error: `boom ${big}` })
      else env.engine.store.finishAttempt(run.id, node.id, attempt, { status: 'succeeded', output: { text: big, more: [big, big] } })
    })
    env.engine.store.finishRun(run.id, 'failed', `node s49 failed: boom ${big}`)

    const started = Date.now()
    const result = await env.client.request('explainRun', { runId: run.id })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.meta.truncated).toBe(true)
    expect(result.meta.digestChars).toBeLessThanOrEqual(12_000)
    const text = userText(env.provider.requests[0]!)
    expect(text.length).toBeLessThan(12_000 + 800)
    expect(text).toMatch(/omitted: \d+ steps/)
    expect(text).toMatch(/STEP s49 .*failed/)
  })
})

describe('a secret that no node role points at', () => {
  function recorded(env: Awaited<ReturnType<typeof start>>, node: WorkflowNode, input: unknown, error: string): string {
    const workflowId = env.engine.store.saveWorkflow({
      schemaVersion: 1,
      name: 'old',
      nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }, node],
      edges: [{ from: 't1', to: node.id }],
    })
    const run = env.engine.store.createRun({ workflowId, payload: {}, dryRun: false })
    env.engine.store.markRunRunning(run.id)
    const attempt = env.engine.store.startAttempt({ runId: run.id, nodeId: node.id, input, idempotencyKey: 'k1' })
    env.engine.store.finishAttempt(run.id, node.id, attempt, { status: 'failed', error })
    env.engine.store.finishRun(run.id, 'failed', `node ${node.id} failed: ${error}`)
    return run.id
  }

  it('is replaced for a node whose type the registry no longer has', async () => {
    const env = await start([{ data: GOOD }])
    const node = { id: 'n1', type: 'removed.http@1', config: { url: 'https://api.example.com', auth: { connection: 'api' } } }
    const runId = recorded(env, node, { url: 'https://api.example.com', auth: { connection: 'api' } }, `HTTP 401: {"received":"${CONNECTION_SECRET}"}`)
    await env.client.request('explainRun', { runId })
    const sent = JSON.stringify(env.provider.requests[0])
    expect(sent).not.toContain(CONNECTION_SECRET)
    expect(sent).toContain('<secret>')
  })

  it('is replaced for every connection the engine was told about, used by the workflow or not', async () => {
    const env = await start([{ data: GOOD }], { planConnections: [{ name: 'api', kind: 'http' }, { name: 'not-configured', kind: 'http' }] })
    const runId = recorded(env, { id: 'n1', type: 'transform@1', config: { values: { a: 1 } } }, {}, `boom ${CONNECTION_SECRET}`)
    await env.client.request('explainRun', { runId })
    expect(JSON.stringify(env.provider.requests[0])).not.toContain(CONNECTION_SECRET)
  })
})

describe('simultaneous explanations', () => {
  it('lets two calls on the same run both complete with their own answer', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const env = await start([
      { gate, data: { ...GOOD, explanation: 'First.' } },
      { gate, data: { ...GOOD, explanation: 'Second.' } },
    ])
    const runId = await env.run([http(env.base, '/status/404')])
    const a = env.client.request('explainRun', { runId })
    const b = env.client.request('explainRun', { runId })
    await env.provider.calls(2)
    release()
    expect([(await a).explanation, (await b).explanation].sort()).toEqual(['First.', 'Second.'])
  })

  it('aborts a pending explanation when the engine shuts down, without waiting for the provider', async () => {
    const env = await start([{ wait: true }])
    const runId = await env.run([http(env.base, '/status/404')])
    const pending = env.engine.explainRun({ runId }).catch((error: unknown) => error)
    await env.provider.calls(1)
    const started = Date.now()
    await env.engine.shutdown()
    const error = await pending
    expect(error).toBeInstanceOf(ExplainError)
    expect((error as ExplainError).kind).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('waits for the explanation to settle before shutdown returns', async () => {
    const env = await start([{ wait: true, abortDelayMs: 150 }])
    const runId = await env.run([http(env.base, '/status/404')])
    let settled = false
    const pending = env.engine.explainRun({ runId }).then(
      () => undefined,
      () => {
        settled = true
      },
    )
    await env.provider.calls(1)
    await env.engine.shutdown()
    expect(settled).toBe(true)
    await pending
  })

  it('honours the signal of a direct caller', async () => {
    const env = await start([{ wait: true }])
    const runId = await env.run([http(env.base, '/status/404')])
    const controller = new AbortController()
    const pending = env.engine.explainRun({ runId, signal: controller.signal }).catch((error: unknown) => error)
    await env.provider.calls(1)
    controller.abort()
    expect(((await pending) as ExplainError).kind).toBe('aborted')
  })
})

describe('the engine without a server', () => {
  it('answers the result of the explainer and leaves the limits of the options to the caller', async () => {
    const env = await start([{ data: GOOD }, { data: GOOD }, { data: GOOD }], { maxConcurrentExplains: 1 })
    const runId = await env.run([http(env.base, '/status/404')])
    expect((await env.engine.explainRun({ runId, effort: 'high' })).meta.effort.requested).toBe('high')
    expect((await env.engine.explainRun({ runId })).signals).toEqual([{ nodeId: 'n1', signal: 'http_status_404' }])
  })

  it('refuses the effort levels that the protocol refuses', async () => {
    const env = await start([{ data: GOOD }])
    const runId = await env.run([http(env.base, '/status/404')])
    await expect(env.engine.explainRun({ runId, effort: 'xhigh' as never })).rejects.toThrow(RangeError)
  })
})

describe('the log of a failed explainRun', () => {
  it('names the error and carries no text of it', async () => {
    const thrown = { on: () => () => undefined, explainRun: () => Promise.reject(new Error(`secret ${RUN_MARKER} ${LITERAL_SECRET}`)) } as unknown as Engine
    const logs: string[] = []
    const server = new RillServer({ engine: thrown, token: TOKEN, log: (line) => logs.push(line) })
    const port = await server.listen()
    const client = await RillClient.connect(`ws://127.0.0.1:${port}/`, TOKEN)
    try {
      const error = await failure(client.request('explainRun', { runId: 'run-1' }))
      expect(error).toMatchObject({ code: 'INTERNAL', message: 'internal error' })
      expect(logs).toEqual([JSON.stringify({ type: 'error', method: 'explainRun', name: 'Error' })])
      expect(JSON.stringify(error)).not.toContain(RUN_MARKER)
    } finally {
      client.close()
      await server.close()
    }
  })
})
