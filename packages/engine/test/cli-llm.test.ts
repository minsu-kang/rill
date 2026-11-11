import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')

let dir: string
let server: Server | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-cli-llm-'))
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

async function mockApi(reply: unknown) {
  const bodies: Array<Record<string, unknown>> = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: JSON.stringify(reply) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  return { bodies, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

function runCli(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const workflow = (csv: string) => ({
  schemaVersion: 1,
  name: 'extract',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    {
      id: 'ex',
      type: 'llm.extract@1',
      config: { text: '{{t1.output.body}}', fields: [{ name: 'amount', type: 'number' }, { name: 'vendor', type: 'string' }] },
    },
    { id: 'out', type: 'csv.append@1', config: { file: csv, row: ['{{ex.output.vendor}}', '{{ex.output.amount}}'] } },
  ],
  edges: [
    { from: 't1', to: 'ex' },
    { from: 'ex', to: 'out' },
  ],
})

describe('rill-engine run with llm.extract', () => {
  it('calls the Anthropic API with the chosen model and writes the extracted row', async () => {
    const { bodies, baseURL } = await mockApi({ amount: 12.5, vendor: 'Cafe' })
    const file = join(dir, 'wf.json')
    const csv = join(dir, 'out.csv')
    writeFileSync(file, JSON.stringify(workflow(csv)))
    const result = await runCli(
      ['run', file, '--db', join(dir, 'x.db'), '--allow', dir, '--llm-model', 'claude-haiku-5-5', '--payload', '{"body":"Cafe 12.50"}'],
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: baseURL },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ status: 'succeeded' })
    expect(readFileSync(csv, 'utf8')).toBe('Cafe,12.5\n')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ model: 'claude-haiku-5-5' })
    expect(bodies[0]).not.toHaveProperty('fallbacks')
    expect(JSON.stringify(bodies[0])).toContain('Cafe 12.50')
    expect(result.stderr).not.toContain('test-key')
    expect(result.stdout).not.toContain('test-key')
  })

  it('uses claude-opus-5-5 by default', async () => {
    const { bodies, baseURL } = await mockApi({ amount: 1, vendor: 'v' })
    const file = join(dir, 'wf.json')
    writeFileSync(file, JSON.stringify(workflow(join(dir, 'out.csv'))))
    const result = await runCli(['run', file, '--db', join(dir, 'x.db'), '--allow', dir, '--payload', '{"body":"x"}'], {
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: baseURL,
    })
    expect(result.code).toBe(0)
    expect(bodies[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' })
  })

  it('sends no fallbacks with --llm-no-fallback', async () => {
    const { bodies, baseURL } = await mockApi({ amount: 1, vendor: 'v' })
    const file = join(dir, 'wf.json')
    writeFileSync(file, JSON.stringify(workflow(join(dir, 'out.csv'))))
    const result = await runCli(
      ['run', file, '--db', join(dir, 'x.db'), '--allow', dir, '--llm-no-fallback', '--payload', '{"body":"x"}'],
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: baseURL },
    )
    expect(result.code).toBe(0)
    expect(bodies[0]).toMatchObject({ model: 'claude-opus-5-5' })
    expect(bodies[0]).not.toHaveProperty('fallbacks')
  })

  it('rejects a malformed model id with the usage and exit 2', async () => {
    const result = await runCli(['run', join(dir, 'wf.json'), '--db', join(dir, 'x.db'), '--llm-model', 'Bad Model!'], {})
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--llm-model must be a model id')
    expect(result.stderr).toContain('usage:')
  })
})
