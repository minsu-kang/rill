import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workflow, WorkflowNode } from '@rill/dsl'
import { LlmError } from '@rill/llm'
import { FAILURE_SIGNALS, failureSignals, type FailureSignal } from '@rill/planner'
import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine, type EngineOptions } from '../src/engine'
import { ScriptedProvider } from './plan-helpers'

let dir: string
let server: Server
let base: string
let dead: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rill-signals-'))
  server = createServer((req, res) => {
    const status = /^\/status\/(\d+)$/.exec(req.url ?? '')
    if (status !== null) {
      res.statusCode = Number(status[1])
      if (res.statusCode === 302) res.setHeader('location', '/elsewhere')
      res.setHeader('content-type', 'text/plain')
      res.end(`answer ${status[1]}`)
      return
    }
    if (req.url === '/slow') return
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
  await new Promise<void>((resolve) => probe.close(() => resolve()))
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  mkdirSync(join(dir, 'folder'), { recursive: true })
})

const failing = defineAction({
  type: 'test.fail@1',
  title: 'Fail',
  description: 'Always throws a plain error.',
  sideEffect: 'none',
  configSchema: Type.Object({}, { additionalProperties: false }),
  outputSchema: Type.Object({}),
  execute: async () => {
    throw new Error('permanent')
  },
})

function registry() {
  return createCoreRegistry().register(failing)
}

const slackFor = (path: string) => `${base}${path}`

async function failureOf(node: WorkflowNode, engineOptions: Partial<EngineOptions> = {}, extra: WorkflowNode[] = []) {
  const reg = registry()
  const connections: Record<string, string> = { 'slack-404': slackFor('/status/404'), 'slack-429': slackFor('/status/429'), 'slack-503': slackFor('/status/503'), api: 'API-SECRET-1234' }
  const engine = new Engine({ db: Db.open(':memory:'), registry: reg, allowedRoots: [dir], connections: { get: (name) => connections[name] }, ...engineOptions })
  const workflow: Workflow = {
    schemaVersion: 1,
    name: 'signals',
    nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }, ...extra, node],
    edges: [...extra, node].map((entry, index, all) => ({ from: index === 0 ? 't1' : all[index - 1]!.id, to: entry.id })),
  }
  const workflowId = engine.store.saveWorkflow(workflow)
  const result = await engine.startRun(workflowId, {})
  const { steps } = engine.getRunDetail(result.runId)
  const failedStep = steps.filter((step) => step.nodeId === node.id).at(-1)
  return { result, steps, failedStep, signals: failureSignals(steps, reg, workflow) }
}

const http = (path: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id: 'n1', type: 'http.request@1', config: { url: `${base}${path}`, ...config } })
const read = (path: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id: 'n1', type: 'file.read@1', config: { path, ...config } })
const extract = (config: Record<string, unknown>): WorkflowNode => ({ id: 'n1', type: 'llm.extract@1', config: { fields: [{ name: 'amount', type: 'number' }], ...config } })
const slack = (connection: string): WorkflowNode => ({ id: 'n1', type: 'notify.slack@1', config: { connection, text: 'hello' } })

interface Row {
  name: string
  node: () => WorkflowNode
  expected: FailureSignal
  message: RegExp
  options?: () => Partial<EngineOptions>
}

const emptyFile = (): string => {
  const path = join(dir, 'empty.txt')
  writeFileSync(path, '')
  return path
}

const ROWS: Row[] = [
  { name: 'a connection that is not configured', node: () => http('/status/200', { auth: { connection: 'missing' } }), expected: 'unknown_connection', message: /^unknown connection: missing$/ },
  { name: 'a slack connection that is not configured', node: () => slack('missing'), expected: 'unknown_connection', message: /^unknown connection: missing$/ },
  { name: 'a path outside the allowed folder', node: () => read('/etc/hosts'), expected: 'path_not_allowed', message: /^path is outside the allowed folders: \/etc\/hosts$/ },
  { name: 'a relative path', node: () => read('notes.txt'), expected: 'path_not_allowed', message: /^path must be absolute or start with ~\/: notes\.txt$/ },
  { name: 'a path with ..', node: () => read(`${dir}/folder/../x.txt`), expected: 'path_not_allowed', message: /^path must not contain '\.\.': / },
  { name: 'a config that fails its schema', node: () => ({ id: 'n1', type: 'http.request@1', config: { url: 'ftp://host/file' } }), expected: 'invalid_config', message: /^invalid config: \/url: / },
  { name: 'a config with an unknown key', node: () => ({ id: 'n1', type: 'delay@1', config: { ms: 1, extra: true } }), expected: 'invalid_config', message: /^invalid config: / },
  { name: 'a GET with a body', node: () => http('/status/200', { method: 'GET', body: { a: 1 } }), expected: 'invalid_config', message: /^GET requests cannot have a body$/ },
  { name: 'a reference to a field that does not exist', node: () => ({ id: 'n1', type: 'transform@1', config: { values: { a: '{{t1.output.missing}}' } } }), expected: 'unresolved_reference', message: /^unresolved reference: t1\.output\.missing$/ },
  { name: 'an HTTP 401', node: () => http('/status/401'), expected: 'http_status_401_403', message: /^HTTP 401: answer 401$/ },
  { name: 'an HTTP 403', node: () => http('/status/403'), expected: 'http_status_401_403', message: /^HTTP 403: / },
  { name: 'an HTTP 404', node: () => http('/status/404'), expected: 'http_status_404', message: /^HTTP 404: / },
  { name: 'an HTTP 400', node: () => http('/status/400'), expected: 'http_status_4xx', message: /^HTTP 400: / },
  { name: 'an HTTP 429', node: () => http('/status/429'), expected: 'http_status_429', message: /^HTTP 429$/ },
  { name: 'an HTTP 500', node: () => http('/status/500'), expected: 'http_status_5xx', message: /^HTTP 500$/ },
  { name: 'an HTTP 503', node: () => http('/status/503'), expected: 'http_status_5xx', message: /^HTTP 503$/ },
  { name: 'a redirect', node: () => http('/status/302'), expected: 'unknown', message: /^HTTP 302: redirects are not followed$/ },
  { name: 'a server that is not there', node: () => ({ id: 'n1', type: 'http.request@1', config: { url: `${dead}/anything` } }), expected: 'network_error', message: /^network error: ECONNREFUSED$/ },
  { name: 'a slow endpoint with a short timeout', node: () => http('/slow', { timeoutMs: 100 }), expected: 'timeout', message: /^network error: TimeoutError$/ },
  { name: 'a file that is not there', node: () => read(join(dir, 'folder', 'gone.txt')), expected: 'file_missing', message: /^ENOENT: no such file or directory, stat / },
  { name: 'a folder where a file is expected', node: () => read(join(dir, 'folder')), expected: 'file_unreadable', message: /^not a file: / },
  { name: 'a file over the size limit', node: () => read(join(dir, 'big.txt'), { maxBytes: 1 }), expected: 'file_unreadable', message: /^file is larger than maxBytes \(\d+ > 1\): / },
  { name: 'an llm.extract of a file that is not there', node: () => extract({ file: join(dir, 'folder', 'gone.pdf') }), expected: 'file_missing', message: /^ENOENT: no such file or directory, open /, options: () => ({ llm: new ScriptedProvider([]) }) },
  { name: 'an llm.extract of an empty file', node: () => extract({ file: emptyFile() }), expected: 'file_unreadable', message: /^file is empty: /, options: () => ({ llm: new ScriptedProvider([]) }) },
  { name: 'an llm.extract of a file type it cannot read', node: () => extract({ file: join(dir, 'archive.xyz') }), expected: 'file_unreadable', message: /^unsupported file type for llm\.extract: \.xyz$/, options: () => ({ llm: new ScriptedProvider([]) }) },
  { name: 'an llm.extract without a provider', node: () => extract({ text: 'hello' }), expected: 'llm_unavailable', message: /^llm\.extract needs an LLM provider/ },
  {
    name: 'an llm.extract whose provider rejects the credentials',
    node: () => extract({ text: 'hello' }),
    expected: 'llm_unavailable',
    message: /credentials/,
    options: () => ({ llm: new ScriptedProvider([{ error: new LlmError('auth', 'the model provider rejected the credentials (401)', { status: 401 }) }]) }),
  },
  {
    name: 'an llm.extract whose answer has the wrong shape',
    node: () => extract({ text: 'hello' }),
    expected: 'llm_extract_failed',
    message: /^the model returned an unexpected shape/,
    options: () => ({ llm: new ScriptedProvider([{ data: { amount: 'not a number' } }]) }),
  },
  {
    name: 'an llm.extract whose provider is overloaded',
    node: () => extract({ text: 'hello' }),
    expected: 'llm_extract_failed',
    message: /overloaded/,
    options: () => ({ llm: new ScriptedProvider([{ error: new LlmError('overloaded', 'the provider is overloaded', { status: 529 }) }]) }),
  },
  { name: 'a slack webhook that is gone', node: () => slack('slack-404'), expected: 'slack_error', message: /^HTTP 404: answer 404$/ },
  { name: 'a slack webhook that is limited', node: () => slack('slack-429'), expected: 'http_status_429', message: /^HTTP 429$/ },
  { name: 'a slack webhook that is down', node: () => slack('slack-503'), expected: 'http_status_5xx', message: /^HTTP 503$/ },
  { name: 'a csv file that is a folder', node: () => ({ id: 'n1', type: 'csv.append@1', config: { file: join(dir, 'folder'), row: ['a'] } }), expected: 'csv_error', message: /^EISDIR: illegal operation on a directory, open / },
  { name: 'a comparison of a string with a number', node: () => ({ id: 'n1', type: 'condition@1', config: { operator: 'gt', left: 'abc', right: 1 } }), expected: 'condition_error', message: /^comparison needs two numbers or two strings$/ },
  { name: 'a condition without its right value', node: () => ({ id: 'n1', type: 'condition@1', config: { operator: 'eq' } }), expected: 'condition_error', message: /^operator eq needs a right value$/ },
  { name: 'a failure of a node that has no pattern', node: () => ({ id: 'n1', type: 'test.fail@1', config: {} }), expected: 'unknown', message: /^permanent$/ },
]

describe('failureSignals on failures made by the real executor and nodes', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(2048))
    writeFileSync(join(dir, 'archive.xyz'), 'data')
  })

  it.each(ROWS)('classifies $name as $expected', async (row) => {
    const { result, failedStep, signals } = await failureOf(row.node(), row.options?.() ?? {})
    expect(result.status).toBe('failed')
    expect(failedStep?.status).toBe('failed')
    expect(failedStep?.error ?? '').toMatch(row.message)
    expect(signals).toEqual([{ nodeId: 'n1', signal: row.expected }])
  })

  it('covers every signal of the list', () => {
    const covered = new Set<string>(ROWS.map((row) => row.expected))
    for (const signal of FAILURE_SIGNALS) expect(covered.has(signal), signal).toBe(true)
  })

  it('classifies the node that failed, not the nodes that succeeded before it', async () => {
    const before: WorkflowNode = { id: 'a1', type: 'transform@1', config: { values: { ok: true } } }
    const { signals, steps } = await failureOf(http('/status/404'), {}, [before])
    expect(steps.map((step) => [step.nodeId, step.status])).toEqual([['a1', 'succeeded'], ['n1', 'failed']])
    expect(signals).toEqual([{ nodeId: 'n1', signal: 'http_status_404' }])
  })

  it('classifies the last attempt after retries', async () => {
    const node: WorkflowNode = { id: 'n1', type: 'http.request@1', config: { url: `${base}/status/503` }, retry: { maxAttempts: 3, baseDelayMs: 0 } }
    const { steps, signals } = await failureOf(node, { sleep: async () => undefined })
    expect(steps.filter((step) => step.nodeId === 'n1')).toHaveLength(3)
    expect(signals).toEqual([{ nodeId: 'n1', signal: 'http_status_5xx' }])
  })

  it('classifies a continued step', async () => {
    const node: WorkflowNode = { id: 'n1', type: 'http.request@1', config: { url: `${base}/status/404` }, onError: 'continue' }
    const { result, steps, signals } = await failureOf(node)
    expect(result.status).toBe('succeeded')
    expect(steps.at(-1)?.status).toBe('continued')
    expect(signals).toEqual([{ nodeId: 'n1', signal: 'http_status_404' }])
  })
})
