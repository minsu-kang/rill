import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUDGET_FACTOR,
  DEFAULT_MODELS,
  DEFAULT_OUT_ROOT,
  PILOT_SEEDS,
  USAGE,
  UsageError,
  commandLine,
  defaultBudgetUsd,
  main,
  parseCli,
  type CliIo,
} from '../src/cli'
import { PRICE_TABLE_AS_OF } from '../src/pricing'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/eval/src/cli.ts')
const KEY = 'sk-ant-api03-CLI-TEST-SECRET-98765'
const DECOY = 'sk-ant-DECOY-ENV-SECRET-55555'
const SEED = 'easy-en-coffee-us'

interface Seen {
  url: string
  headers: IncomingHttpHeaders
  body: { model: string; messages: unknown; system?: string; fallbacks?: unknown }
}

let dir: string
let server: Server | undefined
let seen: Seen[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-eval-cli-'))
  seen = []
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
})

async function mockApi(usage = { input_tokens: 700, output_tokens: 40 }): Promise<string> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Seen['body']
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${seen.length}` })
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify({ amount: 12.5, date: '2026-01-02', vendor: 'Mock Cafe' }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`
}

function runCli(args: string[], env: Record<string, string | undefined>) {
  const full: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ...env }
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, env: full, stdio: ['ignore', 'pipe', 'pipe'] })
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

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function allText(path: string): string {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n')
}

describe('eval extract: process level', () => {
  it('prints the plan and the estimate and sends nothing, even with a key and a reachable API', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'out')
    const result = await runCli(['extract', '--only', SEED, '--kinds', 'text', '--out', out], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
    expect(result.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(result.stdout).toContain('cases: 1 seed x 1 kind (text) = 1 case')
    expect(result.stdout).toContain('calls: 9 (1 case x 3 reps x 3 models)')
    expect(result.stdout).toContain(`estimate (prices as of ${PRICE_TABLE_AS_OF}):`)
    for (const model of DEFAULT_MODELS) expect(result.stdout).toContain(`  ${model}: 3 calls, $`)
    expect(result.stdout).toContain('  total: $')
    expect(result.stdout).toMatch(/budget: \$\d+\.\d+ \(1\.5 x the estimate, rounded up to a cent\)/u)
    expect(result.stdout).toContain('Nothing was sent.')
    expect(result.stdout).toContain(`pnpm eval extract --yes --only ${SEED} --reps 3 --kinds text --models ${DEFAULT_MODELS.join(',')} --out ${out} --budget-usd 0.05`)
    expect(existsSync(out)).toBe(false)
    expect(result.stdout + result.stderr).not.toContain(KEY)
  })

  it('refuses --yes without a key: exit 1, a message, no request and no secret in the output', async () => {
    const baseURL = await mockApi()
    const result = await runCli(['extract', '--yes', '--only', SEED, '--kinds', 'text', '--reps', '1', '--out', join(dir, 'out')], {
      ANTHROPIC_BASE_URL: baseURL,
      ANTHROPIC_AUTH_TOKEN: DECOY,
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ANTHROPIC_API_KEY is not set')
    expect(seen).toHaveLength(0)
    expect(result.stdout + result.stderr).not.toContain(DECOY)
    expect(existsSync(join(dir, 'out'))).toBe(false)
    const empty = await runCli(['extract', '--yes', '--only', SEED, '--kinds', 'text', '--reps', '1'], { ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: baseURL })
    expect(empty.code).toBe(1)
    expect(seen).toHaveLength(0)
  })

  it('runs the baselines end to end with no key and no network', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'out')
    const result = await runCli(['extract', '--baselines', '--only', 'adv-en-fake-json,easy-en-coffee-us', '--out', out], { ANTHROPIC_BASE_URL: baseURL })
    expect(result.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(result.stdout).toContain('no API call, no cost')
    expect(result.stdout).toMatch(/oracle\s+100\.0% \(6\/6\)/u)
    expect(readdirSync(out).sort()).toEqual(['_state.json', 'baseline', 'report.md', 'run.json', 'v1', 'v2'])
    for (const variant of ['baseline', 'v1', 'v2']) {
      expect(readdirSync(join(out, variant)).sort()).toEqual(['change.md', 'errors.jsonl', 'results.jsonl', 'traces'])
      expect(readJsonl(join(out, variant, 'results.jsonl'))).toHaveLength(6)
      expect(readdirSync(join(out, variant, 'traces'))).toHaveLength(6)
    }
    expect(readFileSync(join(out, 'v1', 'change.md'), 'utf8')).toBe('# model: oracle\n')
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('| oracle (baseline) | 100.0% (6/6) |')
    expect(report).toContain('| all-null (baseline) |')
    expect(report).toContain('| regex (baseline) |')
    expect(report).toContain('- Models: (none, baselines only)')
    expect(result.stdout).toContain(`report: ${join(out, 'report.md')}`)
  })

  it('runs one real-shaped call against the mock API, writes everything and reports the cost', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'out')
    const result = await runCli(
      ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--out', out],
      { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL },
    )
    expect(result.stderr).toBe('progress: 1/1\n')
    expect(result.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toContain('/v1/messages')
    expect(seen[0]?.body.model).toBe('claude-haiku-5-5')
    expect(seen[0]?.body).not.toHaveProperty('fallbacks')
    expect(seen[0]?.headers['authorization'] ?? seen[0]?.headers['x-api-key']).toContain(KEY)
    expect(result.stdout).toContain('notice: the synthetic fixture documents')
    expect(result.stdout).toContain('sent to the Anthropic API')
    expect(result.stdout).toContain('total cost: $0.0001 of a $0.0100 budget')
    expect(result.stdout).toContain(`report: ${join(out, 'report.md')}`)
    expect(result.stdout).not.toContain('skipped because of the budget')
    expect(readdirSync(out).sort()).toEqual(['_state.json', 'baseline', 'report.md', 'run.json'])
    const [row] = readJsonl(join(out, 'baseline', 'results.jsonl'))
    expect(row).toMatchObject({ prompt_id: `${SEED}-text`, rep: 0, status: 'ok', model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 700, output_tokens: 40 } })
    expect(readdirSync(join(out, 'baseline', 'traces'))).toEqual([`${SEED}-text_rep0.json`])
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('## Latency, tokens and cost')
    expect(report).toMatch(/\| claude-haiku-5-5 \| [\d.]+ \| [\d.]+ \| 700 \| 40 \| \$0\.0001 \| \$0\.0090 \|/u)
    expect(report).toContain('| oracle (baseline) |')
    expect(report).toContain('- Effort: low (as the node ships)')
    for (const text of [result.stdout, result.stderr, allText(out)]) expect(text).not.toContain(KEY)
  })

  it('skips the tasks it cannot afford, tells the user and sends fewer requests than tasks', async () => {
    const baseURL = await mockApi({ input_tokens: 5_000_000, output_tokens: 10 })
    const out = join(dir, 'out')
    const result = await runCli(
      ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--reps', '1', '--concurrency', '1', '--budget-usd', '0.01', '--out', out],
      { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL },
    )
    expect(result.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(result.stdout).toContain('notice: 2 of 3 tasks were skipped because of the budget')
    expect(result.stdout).toContain('of a $0.0100 budget')
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('- Tasks skipped because of the budget: 2.')
    expect(readJsonl(join(out, 'baseline', 'results.jsonl'))).toHaveLength(1)
  })

  it('refuses a model without a price before any request', async () => {
    const baseURL = await mockApi()
    const result = await runCli(['extract', '--yes', '--models', 'claude-mystery-9', '--only', SEED, '--kinds', 'text', '--reps', '1', '--out', join(dir, 'out')], {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: baseURL,
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no price for model claude-mystery-9; the budget guard needs one')
    expect(seen).toHaveLength(0)
    expect(existsSync(join(dir, 'out'))).toBe(false)
    expect(result.stdout + result.stderr).not.toContain(KEY)
  })

  it('shows the plan for an unpriced model without refusing, and says why --yes would', async () => {
    const result = await runCli(['extract', '--models', 'claude-mystery-9', '--only', SEED, '--kinds', 'text', '--reps', '1'], {})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('claude-mystery-9: 1 call, no price in the price table')
    expect(result.stdout).toContain('--yes would refuse this run')
    expect(result.stdout).toContain('budget: n/a')
  })

  it('exits 2 and prints the usage for a malformed option', async () => {
    for (const args of [['extract', '--reps', 'abc'], ['extract', '--bogus'], ['extract', '--effort', 'turbo'], ['nope'], [], ['extract', '--kinds', 'gif'], ['extract', '--only', 'zzz-nothing']]) {
      const result = await runCli(args, {})
      expect(result.code, args.join(' ')).toBe(2)
      expect(result.stderr, args.join(' ')).toContain('usage: pnpm eval extract [options]')
      expect(result.stdout, args.join(' ')).toBe('')
    }
  })
})

const quietIo = (overrides: Partial<CliIo> = {}): { io: CliIo; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, now: () => Date.UTC(2026, 10, 11, 9, 30, 15), ...overrides } }
}

describe('parseCli', () => {
  it('has the documented defaults', () => {
    expect(parseCli(['extract'])).toEqual({
      models: [...DEFAULT_MODELS],
      reps: 3,
      concurrency: 4,
      kinds: ['text', 'pdf', 'png'],
      only: undefined,
      pilot: false,
      effort: undefined,
      budgetUsd: undefined,
      maxCallSeconds: 60,
      maxAttempts: 3,
      seed: 1,
      out: undefined,
      baselines: false,
      yes: false,
      help: false,
    })
    expect(DEFAULT_MODELS).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  it('reads every option', () => {
    const config = parseCli([
      'extract', '--models', 'claude-haiku-5-5,claude-opus-5-5', '--reps', '2', '--concurrency', '8', '--kinds', 'png,text', '--only', 'adv-',
      '--effort', 'high', '--budget-usd', '2.5', '--max-call-seconds', '30', '--max-attempts', '5', '--seed', '9', '--out', '/x/y', '--yes',
    ])
    expect(config).toMatchObject({
      models: ['claude-haiku-5-5', 'claude-opus-5-5'], reps: 2, concurrency: 8, kinds: ['png', 'text'], only: 'adv-', effort: 'high', budgetUsd: 2.5,
      maxCallSeconds: 30, maxAttempts: 5, seed: 9, out: '/x/y', yes: true, baselines: false,
    })
    expect(parseCli(['extract', '--only', 'a-b,c-d']).only).toEqual(['a-b', 'c-d'])
  })

  it('turns --pilot into three fixed seeds, all kinds and one rep', () => {
    expect(PILOT_SEEDS).toEqual(['easy-ko-cafe-yeonnam', 'tricky-en-card-approval-vs-total', 'adv-en-ignore-instructions'])
    expect(parseCli(['extract', '--pilot'])).toMatchObject({ pilot: true, only: [...PILOT_SEEDS], reps: 1, kinds: ['text', 'pdf', 'png'] })
  })

  it.each([
    [['extract', '--reps', '0']],
    [['extract', '--reps', '-1']],
    [['extract', '--reps', '1.5']],
    [['extract', '--concurrency', '0']],
    [['extract', '--budget-usd', '0']],
    [['extract', '--budget-usd', 'abc']],
    [['extract', '--budget-usd', '-1']],
    [['extract', '--max-call-seconds', '0']],
    [['extract', '--max-attempts', '0']],
    [['extract', '--seed', 'x']],
    [['extract', '--models', 'Bad Model!']],
    [['extract', '--models', 'a,,b']],
    [['extract', '--models', 'claude-haiku-5-5,claude-haiku-5-5']],
    [['extract', '--kinds', 'text,text']],
    [['extract', '--effort', 'max']],
    [['extract', '--only', '']],
    [['extract', 'extra']],
    [['extract', '--pilot', '--only', 'x']],
    [['extract', '--pilot', '--reps', '2']],
    [['extract', '--pilot', '--kinds', 'text']],
    [['extract', '--baselines', '--yes']],
    [['extract', '--baselines', '--models', 'claude-haiku-5-5']],
    [['extract', '--baselines', '--budget-usd', '1']],
    [['extract', '--baselines', '--effort', 'low']],
    [['extract', '--baselines', '--reps', '2']],
    [['bogus']],
    [[]],
  ] as const)('rejects %j with a usage error', (args) => {
    expect(() => parseCli(args)).toThrow(UsageError)
  })

  it('treats --help as a request for the usage text', () => {
    expect(parseCli(['--help']).help).toBe(true)
    expect(parseCli(['extract', '-h']).help).toBe(true)
  })
})

describe('defaultBudgetUsd and commandLine', () => {
  it('is 1.5 times the estimate rounded up to a cent', () => {
    expect(BUDGET_FACTOR).toBe(1.5)
    expect(defaultBudgetUsd(1.55)).toBe(2.33)
    expect(defaultBudgetUsd(2)).toBe(3)
    expect(defaultBudgetUsd(0.0275)).toBe(0.05)
    expect(defaultBudgetUsd(0.001)).toBe(0.01)
    expect(defaultBudgetUsd(1.4)).toBe(2.1)
    expect(defaultBudgetUsd(5.24)).toBe(7.86)
  })

  it('prints a command that parses back to the same run, with --yes and the budget', () => {
    for (const args of [
      ['extract'],
      ['extract', '--pilot'],
      ['extract', '--only', 'adv-', '--kinds', 'text,pdf', '--reps', '2', '--models', 'claude-haiku-5-5'],
      ['extract', '--only', 'a-b,c-d', '--effort', 'medium', '--concurrency', '2', '--max-call-seconds', '20', '--max-attempts', '2', '--seed', '7', '--out', 'somewhere'],
    ]) {
      const config = parseCli(args)
      const line = commandLine(config, 3.21)
      expect(line.startsWith('pnpm eval extract --yes ')).toBe(true)
      expect(line.endsWith(' --budget-usd 3.21')).toBe(true)
      const again = parseCli(line.replace('pnpm eval ', '').split(' ').filter((part) => part !== ''))
      expect(again).toEqual({ ...config, yes: true, budgetUsd: 3.21 })
    }
    expect(commandLine(parseCli(['extract']), undefined)).not.toContain('--budget-usd')
  })
})

describe('main', () => {
  it('prints the usage for --help and exits 0', async () => {
    const { io, out } = quietIo()
    expect(await main(['--help'], io)).toBe(0)
    expect(out.join('')).toBe(USAGE)
  })

  it('names the default budget in the plan as 1.5 x the estimate', async () => {
    const { io, out } = quietIo()
    expect(await main(['extract', '--only', SEED, '--kinds', 'text', '--reps', '1', '--models', 'claude-haiku-5-5'], io)).toBe(0)
    const text = out.join('')
    expect(text).toMatch(/total: \$0\.0002/u)
    expect(text).toContain('budget: $0.0100 (1.5 x the estimate, rounded up to a cent)')
    expect(text).toContain('--budget-usd 0.01')
  })

  it('uses --budget-usd as given and says so', async () => {
    const { io, out } = quietIo()
    await main(['extract', '--only', SEED, '--kinds', 'text', '--reps', '1', '--models', 'claude-haiku-5-5', '--budget-usd', '0.5'], io)
    expect(out.join('')).toContain('budget: $0.5000 (from --budget-usd)')
    expect(out.join('')).toContain('--budget-usd 0.50')
  })

  it('writes the baselines into a timestamped default directory from the injected clock', async () => {
    const outRoot = join(dir, 'results')
    const { io, out } = quietIo({ outRoot })
    expect(await main(['extract', '--baselines', '--only', SEED, '--kinds', 'text'], io)).toBe(0)
    expect(readdirSync(outRoot)).toEqual(['extract-20261111T093015Z'])
    expect(readFileSync(join(outRoot, 'extract-20261111T093015Z', 'report.md'), 'utf8')).toContain('- Date: 2026-11-11T09:30:15.000Z')
    expect(DEFAULT_OUT_ROOT.endsWith(join('packages', 'eval', 'results'))).toBe(true)
    expect(out.join('')).toContain('results: ')
  })

  it('refuses an output directory that already has files and exits 1', async () => {
    const outRoot = join(dir, 'results')
    const first = quietIo({ outRoot })
    await main(['extract', '--baselines', '--only', SEED, '--kinds', 'text'], first.io)
    const second = quietIo({ outRoot })
    expect(await main(['extract', '--baselines', '--only', SEED, '--kinds', 'text'], second.io)).toBe(1)
    expect(second.err.join('')).toContain('output directory is not empty')
  })

  it('reports a bad --only as a usage error', async () => {
    const { io, err } = quietIo()
    expect(await main(['extract', '--only', 'zzz-nothing'], io)).toBe(2)
    expect(err.join('')).toContain('--only: no seed id contains "zzz-nothing"')
  })

  it('never prints the key from the environment when something fails', async () => {
    const { io, err } = quietIo({ env: { ANTHROPIC_API_KEY: KEY } })
    expect(await main(['extract', '--yes', '--models', 'claude-mystery-9', '--only', SEED, '--kinds', 'text'], io)).toBe(1)
    expect(err.join('')).not.toContain(KEY)
  })
})
