import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MODELS,
  EXIT_INTERRUPTED,
  EXIT_PARTIAL,
  DEFAULT_OUT_ROOT,
  PILOT_MAX_OUTPUT_TOKENS,
  PILOT_SEEDS,
  USAGE,
  UsageError,
  SUGGESTED_BUDGET_FACTOR,
  commandLine,
  effectiveEndpoint,
  formatUsdPlain,
  main,
  suggestedBudgetUsd,
  parseCli,
  type CliIo,
} from '../src/cli'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { PARTIAL_FILE, writeResults } from '../src/results'
import { worstCaseCallUsd } from '../src/runner'
import { createExtractSuite } from '../src/suites/extract/suite'

vi.mock('../src/results', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/results')>()
  return { ...actual, writeResults: vi.fn(actual.writeResults) }
})

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/eval/src/cli.ts')
const KEY = 'sk-ant-api03-CLI-TEST-SECRET-98765'
const DECOY = 'sk-ant-DECOY-ENV-SECRET-55555'
const SEED = 'easy-en-coffee-us'

interface Seen {
  url: string
  headers: IncomingHttpHeaders
  body: { model: string; messages: unknown; system?: string; fallbacks?: unknown; max_tokens?: number }
}

const ALLOW = '--allow-base-url'

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

async function mockApi(
  usage = { input_tokens: 700, output_tokens: 40 },
  fail?: { status: number; message: string },
  hold?: (count: number) => number | undefined,
): Promise<string> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Seen['body']
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      const delay = hold?.(seen.length)
      if (delay === Number.POSITIVE_INFINITY) return
      const answer = (): void => {
        if (res.destroyed) return
      if (fail !== undefined) {
        res.writeHead(fail.status, { 'content-type': 'application/json', 'request-id': `req_${seen.length}` })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: fail.message } }))
        return
      }
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
      }
      if (delay === undefined) answer()
      else setTimeout(answer, delay)
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`
}

function runCli(args: string[], env: Record<string, string | undefined>, control?: (child: ReturnType<typeof spawn>, output: () => string) => void) {
  const full: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_CUSTOM_HEADERS: undefined, ...env }
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
    control?.(child, () => stdout + stderr)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function oneCallWorstCase(model: string, maxOutputTokens: number): number {
  const suite = createExtractSuite({ only: SEED, kinds: ['text'] })
  return worstCaseCallUsd(suite, suite.cases()[0] as Parameters<typeof worstCaseCallUsd>[1], model, maxOutputTokens) as number
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
    const suggested = /suggested budget: \$(\d+\.\d+) \(the larger of 2 x the estimate and the estimate plus the guard's reserve for 4 calls in flight, rounded up to the next cent\)/u.exec(result.stdout)
    expect(Number(suggested?.[1])).toBeGreaterThanOrEqual(1.3)
    expect(result.stdout).not.toContain('note: this budget is below the worst case')
    expect(result.stdout).toContain('output: 200 tokens per call')
    expect(result.stdout).toMatch(/break-even: at this budget the run can afford an average of about \d+ output tokens per call/u)
    expect(result.stdout).toContain('thinking tokens are billed as output tokens')
    expect(result.stdout).toContain('max_tokens: 16000 per request')
    expect(result.stdout).toContain('Nothing was sent.')
    expect(result.stdout).toContain(`pnpm eval extract --yes --only ${SEED} --reps 3 --kinds text --models ${DEFAULT_MODELS.join(',')} --out ${out} --budget-usd ${suggested?.[1]}`)
    expect(existsSync(out)).toBe(false)
    expect(result.stdout + result.stderr).not.toContain(KEY)
  })

  it('refuses --yes without a key: exit 1, a message, no request and no secret in the output', async () => {
    const baseURL = await mockApi()
    const result = await runCli(['extract', '--yes', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', ALLOW, '--out', join(dir, 'out')], {
      ANTHROPIC_BASE_URL: baseURL,
      ANTHROPIC_AUTH_TOKEN: DECOY,
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ANTHROPIC_API_KEY is not set')
    expect(seen).toHaveLength(0)
    expect(result.stdout + result.stderr).not.toContain(DECOY)
    expect(existsSync(join(dir, 'out'))).toBe(false)
    for (const blank of ['', '   ', '\t\n']) {
      const empty = await runCli(['extract', '--yes', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', ALLOW], { ANTHROPIC_API_KEY: blank, ANTHROPIC_BASE_URL: baseURL })
      expect(empty.code).toBe(1)
      expect(empty.stderr).toContain('ANTHROPIC_API_KEY is not set')
    }
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
    for (const [variant, rows] of [['baseline', 6], ['v1', 6], ['v2', 2]] as const) {
      expect(readdirSync(join(out, variant)).sort()).toEqual(['change.md', 'errors.jsonl', 'results.jsonl', 'traces'])
      expect(readJsonl(join(out, variant, 'results.jsonl'))).toHaveLength(rows)
      expect(readdirSync(join(out, variant, 'traces'))).toHaveLength(rows)
    }
    expect(readFileSync(join(out, 'v1', 'change.md'), 'utf8')).toBe('# model: oracle\n')
    expect(readFileSync(join(out, 'v2', 'change.md'), 'utf8')).toBe('# model: regex\n')
    expect(readJsonl(join(out, 'v2', 'results.jsonl')).every((row) => (row['tags'] as string[]).includes('text'))).toBe(true)
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('| oracle (baseline) | 100.0% (6/6) |')
    expect(report).toContain('| all-null (baseline) |')
    expect(report).toMatch(/\| regex \(text only\) \| [\d.]+% \(\d\/2\) \|/u)
    expect(result.stdout).toContain('regex (text only)')
    expect(report).toContain('- Models: (none, baselines only)')
    expect(result.stdout).toContain(`report: ${join(out, 'report.md')}`)
  })

  it('runs one real-shaped call against the mock API, writes everything and reports the cost', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'out')
    const result = await runCli(
      ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '0.01', ALLOW, '--out', out],
      { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL },
    )
    expect(result.stderr).toBe('progress: 1/1\n')
    expect(result.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toContain('/v1/messages')
    expect(seen[0]?.body.model).toBe('claude-haiku-5-5')
    expect(seen[0]?.body).not.toHaveProperty('fallbacks')
    expect(seen[0]?.headers['authorization'] ?? seen[0]?.headers['x-api-key']).toContain(KEY)
    const host = new URL(baseURL).host
    expect(result.stdout).toContain(`API host: ${host} (from ANTHROPIC_BASE_URL: ${baseURL})`)
    expect(result.stdout).toContain(`WARNING: --allow-base-url is set: your API key will be sent to ${host}`)
    expect(result.stdout).toContain(`notice: the synthetic fixture documents (receipts as text, PDF and PNG) are sent to ${host} for claude-haiku-5-5`)
    expect(result.stdout.indexOf('API host:')).toBeLessThan(result.stdout.indexOf('notice:'))
    expect(result.stdout).toContain('total cost: $0.00009 of a $0.01 budget')
    expect(seen[0]?.body.max_tokens).toBe(16_000)
    expect(existsSync(join(out, PARTIAL_FILE))).toBe(false)
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

  it('stops at the first task it cannot afford, marks the run partial and exits 3', async () => {
    const baseURL = await mockApi({ input_tokens: 5_000_000, output_tokens: 10 })
    const out = join(dir, 'out')
    const result = await runCli(
      ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--reps', '1', '--concurrency', '1', '--budget-usd', '0.01', ALLOW, '--out', out],
      { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL },
    )
    expect(EXIT_PARTIAL).toBe(3)
    expect(result.code).toBe(3)
    expect(seen).toHaveLength(1)
    expect(result.stdout).toContain('PARTIAL RUN: the budget ran out; 2 of 3 tasks were skipped')
    expect(result.stdout).toContain('of a $0.01 budget')
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report.split('\n')[2]).toContain('**PARTIAL RUN**')
    expect(report).toContain('claude-haiku-5-5 1 completed, 2 skipped')
    expect(report).toContain('- Tasks skipped because of the budget: 2.')
    expect(readJsonl(join(out, 'baseline', 'results.jsonl'))).toHaveLength(1)
    const skipped = readJsonl(join(out, 'baseline', 'errors.jsonl')).filter((line) => line['failure_class'] === 'budget_skipped')
    expect(skipped).toHaveLength(2)
    expect(skipped.every((line) => line['scope'] === 'task' && line['attempts'] === 0)).toBe(true)
    expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({ partial: true, stop_reason: 'budget' })
  })

  it('reserves exactly the max_tokens the mock server receives', async () => {
    const baseURL = await mockApi()
    const exact = oneCallWorstCase('claude-haiku-5-5', 3000)
    const args = ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--max-output-tokens', '3000', ALLOW]
    const fits = await runCli([...args, '--budget-usd', formatUsdPlain(exact), '--out', join(dir, 'fits')], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
    expect(fits.code).toBe(0)
    expect(seen.map((entry) => entry.body.max_tokens)).toEqual([3000])
    const short = await runCli([...args, '--budget-usd', formatUsdPlain(exact * 0.999), '--out', join(dir, 'short')], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
    expect(short.code).toBe(3)
    expect(seen).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'fits', 'run.json'), 'utf8'))).toMatchObject({ max_output_tokens: 3000 })
  })

  it('refuses a non-default base URL without --allow-base-url, before any request', async () => {
    const baseURL = await mockApi()
    const host = new URL(baseURL).host
    const result = await runCli(['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', '--out', join(dir, 'out')], {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: baseURL,
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`API host: ${host}`)
    expect(result.stderr).toContain(`ANTHROPIC_BASE_URL points to ${host}`)
    expect(result.stderr).toContain('--allow-base-url')
    expect(seen).toHaveLength(0)
    expect(existsSync(join(dir, 'out'))).toBe(false)
  })

  it('stops at the first authentication failure, sends nothing more and exits 1', async () => {
    const baseURL = await mockApi(undefined, { status: 401, message: 'invalid x-api-key' })
    const out = join(dir, 'out')
    const result = await runCli(['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--reps', '2', '--concurrency', '1', '--budget-usd', '1', ALLOW, '--out', out], {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: baseURL,
    })
    expect(result.code).toBe(1)
    expect(seen).toHaveLength(1)
    expect(result.stderr).toContain('the API rejected the credentials')
    const errors = readJsonl(join(out, 'baseline', 'errors.jsonl'))
    expect(errors.filter((line) => line['failure_class'] === 'auth_skipped')).toHaveLength(5)
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('**PARTIAL RUN**')
  })

  it('writes what is done and a partial report on SIGINT, and exits 130', async () => {
    const baseURL = await mockApi(undefined, undefined, (count) => (count <= 3 ? 20 : Number.POSITIVE_INFINITY))
    const out = join(dir, 'out')
    const args = ['extract', '--yes', '--models', 'claude-haiku-5-5', '--reps', '1', '--concurrency', '2', '--max-call-seconds', '2', '--budget-usd', '5', ALLOW, '--out', out]
    let sent = false
    const result = await runCli(args, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL }, (child) => {
      const timer = setInterval(() => {
        if (!sent && seen.length >= 5) {
          sent = true
          child.kill('SIGINT')
          clearInterval(timer)
        }
      }, 10)
      child.on('close', () => clearInterval(timer))
    })
    expect(sent).toBe(true)
    expect(EXIT_INTERRUPTED).toBe(130)
    expect(result.code).toBe(130)
    expect(result.stderr).toContain('SIGINT: no new calls')
    expect(seen.length).toBeLessThanOrEqual(6)
    expect(readJsonl(join(out, 'baseline', 'results.jsonl')).length).toBeGreaterThanOrEqual(3)
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('**PARTIAL RUN**: the run was interrupted')
    expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({ partial: true, stop_reason: 'interrupted' })
    expect(readJsonl(join(out, 'baseline', 'errors.jsonl')).some((line) => line['failure_class'] === 'interrupted_skipped')).toBe(true)
    expect(existsSync(join(out, PARTIAL_FILE))).toBe(false)
  }, 20_000)

  it('aborts the calls in flight on a second SIGINT', async () => {
    const baseURL = await mockApi(undefined, undefined, (count) => (count <= 2 ? 20 : Number.POSITIVE_INFINITY))
    const out = join(dir, 'out')
    const args = ['extract', '--yes', '--models', 'claude-haiku-5-5', '--reps', '1', '--concurrency', '2', '--max-call-seconds', '60', '--budget-usd', '5', ALLOW, '--out', out]
    let signals = 0
    const started = Date.now()
    const result = await runCli(args, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL }, (child, output) => {
      const timer = setInterval(() => {
        if (signals === 0 && seen.length >= 4) {
          signals = 1
          child.kill('SIGINT')
        } else if (signals === 1 && output().includes('SIGINT: no new calls')) {
          signals = 2
          child.kill('SIGINT')
          clearInterval(timer)
        }
      }, 10)
      child.on('close', () => clearInterval(timer))
    })
    expect(signals).toBe(2)
    expect(result.code).toBe(130)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.stderr).toContain('SIGINT: aborting the calls in flight')
    const errors = readJsonl(join(out, 'baseline', 'errors.jsonl'))
    expect(errors.some((line) => line['failure_class'] === 'aborted')).toBe(true)
  }, 20_000)

  it('records an authentication failure as an error row and never writes the key', async () => {
    const baseURL = await mockApi(undefined, { status: 401, message: `invalid x-api-key ${KEY}` })
    const out = join(dir, 'out')
    const result = await runCli(['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', ALLOW, '--out', out], {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: baseURL,
    })
    expect(result.code).toBe(1)
    expect(seen).toHaveLength(1)
    const errors = readJsonl(join(out, 'baseline', 'errors.jsonl'))
    expect(errors.map((line) => [line['scope'], line['failure_class']])).toEqual([['attempt', 'auth'], ['task', 'auth']])
    expect(String(errors[0]?.['message'])).toContain('rejected the credentials')
    expect(readJsonl(join(out, 'baseline', 'results.jsonl'))).toEqual([])
    for (const text of [result.stdout, result.stderr, allText(out)]) expect(text).not.toContain(KEY)
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('| auth | 1 |')
  })

  it('refuses --yes into a directory that already has files before any request', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'out')
    const first = await runCli(['extract', '--baselines', '--only', SEED, '--kinds', 'text', '--out', out], {})
    expect(first.code).toBe(0)
    const result = await runCli(['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', ALLOW, '--out', out], {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: baseURL,
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('output directory is not empty')
    expect(seen).toHaveLength(0)
  })

  it('refuses a model without a price before any request', async () => {
    const baseURL = await mockApi()
    const result = await runCli(['extract', '--yes', '--models', 'claude-mystery-9', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', ALLOW, '--out', join(dir, 'out')], {
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
    for (const args of [
      ['extract', '--reps', 'abc'],
      ['extract', '--bogus'],
      ['extract', '--effort', 'turbo'],
      ['nope'],
      [],
      ['extract', '--kinds', 'gif'],
      ['extract', '--only', 'zzz-nothing'],
      ['extract', '--yes'],
      ['extract', '--max-call-seconds', '3000000'],
    ]) {
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
      fields: 'default',
      budgetUsd: undefined,
      maxOutputTokens: 16_000,
      maxCallSeconds: 60,
      maxAttempts: 3,
      seed: 1,
      out: undefined,
      allowBaseUrl: false,
      baselines: false,
      yes: false,
      help: false,
    })
    expect(DEFAULT_MODELS).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  it('reads every option', () => {
    const config = parseCli([
      'extract', '--models', 'claude-haiku-5-5,claude-opus-5-5', '--reps', '2', '--concurrency', '8', '--kinds', 'png,text', '--only', 'adv-',
      '--effort', 'high', '--budget-usd', '2.5', '--max-output-tokens', '4000', '--max-call-seconds', '30', '--max-attempts', '5', '--seed', '9', '--out', '/x/y',
      '--allow-base-url', '--yes',
    ])
    expect(config).toMatchObject({
      models: ['claude-haiku-5-5', 'claude-opus-5-5'], reps: 2, concurrency: 8, kinds: ['png', 'text'], only: 'adv-', effort: 'high', budgetUsd: 2.5,
      maxOutputTokens: 4000, maxCallSeconds: 30, maxAttempts: 5, seed: 9, out: '/x/y', allowBaseUrl: true, yes: true, baselines: false,
    })
    expect(parseCli(['extract', '--reps', '20', '--concurrency', '16', '--max-call-seconds', '600', '--seed', '4294967295', '--max-output-tokens', '64000'])).toMatchObject({
      reps: 20, concurrency: 16, maxCallSeconds: 600, seed: 4_294_967_295, maxOutputTokens: 64_000,
    })
    expect(parseCli(['extract', '--seed', '0', '--budget-usd', '0.004']).budgetUsd).toBe(0.004)
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
    [['extract', '--seed', '4294967296']],
    [['extract', '--seed', '-1']],
    [['extract', '--reps', '21']],
    [['extract', '--concurrency', '17']],
    [['extract', '--max-call-seconds', '601']],
    [['extract', '--max-call-seconds', '3000000']],
    [['extract', '--max-attempts', '11']],
    [['extract', '--max-output-tokens', '0']],
    [['extract', '--max-output-tokens', '64001']],
    [['extract', '--max-output-tokens', '1.5']],
    [['extract', '--budget-usd', '1e3']],
    [['extract', '--budget-usd', 'Infinity']],
    [['extract', '--budget-usd', '0.000']],
    [['extract', '--yes']],
    [['extract', '--yes', '--pilot']],
    [['extract', '--baselines', '--max-output-tokens', '100']],
    [['extract', '--baselines', '--allow-base-url']],
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

describe('suggestedBudgetUsd, formatUsdPlain and commandLine', () => {
  it('suggests twice the estimate rounded up to the next cent, with more digits below a cent', () => {
    expect(SUGGESTED_BUDGET_FACTOR).toBe(2)
    expect(suggestedBudgetUsd(1.55)).toBe(3.1)
    expect(suggestedBudgetUsd(2)).toBe(4)
    expect(suggestedBudgetUsd(0.0275)).toBe(0.06)
    expect(suggestedBudgetUsd(5.241)).toBe(10.49)
    expect(suggestedBudgetUsd(0.001)).toBe(0.002)
    expect(suggestedBudgetUsd(0.000154)).toBe(0.00031)
    expect(suggestedBudgetUsd(0.1454, 1.3184)).toBe(1.47)
    expect(suggestedBudgetUsd(5.24, 1.3)).toBe(10.48)
    expect(suggestedBudgetUsd(0.1454, 0)).toBe(0.3)
    for (const estimate of [0.000154, 0.0012, 0.004, 0.0275, 5.241]) expect(suggestedBudgetUsd(estimate)).toBeGreaterThanOrEqual(estimate * 2)
  })

  it('prints a budget without losing precision', () => {
    expect(formatUsdPlain(0.004)).toBe('0.004')
    expect(formatUsdPlain(0.016)).toBe('0.016')
    expect(formatUsdPlain(0.00031)).toBe('0.00031')
    expect(formatUsdPlain(1e-7)).toBe('0.0000001')
    expect(formatUsdPlain(3.21)).toBe('3.21')
    expect(formatUsdPlain(0.3)).toBe('0.30')
    for (const value of [0.004, 0.016, 0.00031, 1e-7, 3.21, 10.49]) expect(Number(formatUsdPlain(value))).toBe(value)
  })

  it('prints a command that parses back to the same run, with --yes and the budget', () => {
    for (const args of [
      ['extract'],
      ['extract', '--pilot'],
      ['extract', '--only', 'adv-', '--kinds', 'text,pdf', '--reps', '2', '--models', 'claude-haiku-5-5'],
      ['extract', '--only', 'a-b,c-d', '--effort', 'medium', '--concurrency', '2', '--max-call-seconds', '20', '--max-attempts', '2', '--seed', '7', '--out', 'somewhere'],
      ['extract', '--kinds', 'pdf,text,png', '--max-output-tokens', '3000', '--seed', '0', '--allow-base-url'],
      ['extract', '--kinds', 'png', '--only', 'adv-', '--effort', 'low', '--seed', '4294967295'],
    ]) {
      for (const budget of [3.21, 0.004, 0.00031]) {
        const config = parseCli(args)
        const line = commandLine(config, budget)
        expect(line.startsWith('pnpm eval extract --yes ')).toBe(true)
        expect(line.endsWith(` --budget-usd ${formatUsdPlain(budget)}`)).toBe(true)
        const again = parseCli(line.replace('pnpm eval ', '').split(' ').filter((part) => part !== ''))
        expect(again).toEqual({ ...config, yes: true, budgetUsd: budget })
      }
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

  it('suggests a budget that can always run: at least the worst case of the calls in flight, with exact digits below a cent and never 0.00', async () => {
    const { io, out } = quietIo()
    expect(await main(['extract', '--only', SEED, '--kinds', 'text', '--reps', '1', '--models', 'claude-haiku-5-5'], io)).toBe(0)
    const text = out.join('')
    expect(text).toMatch(/total: \$0\.0002/u)
    const suggested = /suggested budget: \$(\d\.\d+) \(the larger of 2 x the estimate and the estimate plus the guard's reserve for 4 calls in flight, rounded up; below a cent, so shown with more digits\)/u.exec(text)
    const worst = /worst case of one call: \$(\d\.\d+)/u.exec(text)
    expect(Number(suggested?.[1])).toBeGreaterThanOrEqual(Number(worst?.[1]))
    expect(Number(suggested?.[1])).toBeLessThan(0.01)
    expect(text).toContain(`--budget-usd ${suggested?.[1]}`)
    expect(text).not.toContain('--budget-usd 0.00 ')
    expect(text).not.toContain('note: this budget is below the worst case of one call')
  })

  it('gives the pilot a 4000 token default and a budget that covers the guard reserve', async () => {
    expect(parseCli(['extract', '--pilot']).maxOutputTokens).toBe(PILOT_MAX_OUTPUT_TOKENS)
    expect(parseCli(['extract', '--pilot', '--max-output-tokens', '16000']).maxOutputTokens).toBe(16000)
    const { io, out } = quietIo()
    expect(await main(['extract', '--pilot'], io)).toBe(0)
    const text = out.join('')
    expect(text).toContain('max_tokens: 4000 per request')
    expect(text).toContain('--max-output-tokens 4000')
    expect(text).not.toContain('note: this budget is below')
    const budget = /--budget-usd (\d+\.\d+)/u.exec(text)
    const worst = /worst case of one call: \$(\d\.\d+)/u.exec(text)
    expect(Number(budget?.[1])).toBeGreaterThanOrEqual(Number(worst?.[1]) * 4)
    const breakEven = /about (\d+) output tokens per call/u.exec(text)
    expect(Number(breakEven?.[1])).toBeGreaterThan(0)
  })

  it('uses --budget-usd as given and says so', async () => {
    const { io, out } = quietIo()
    await main(['extract', '--only', SEED, '--kinds', 'text', '--reps', '1', '--models', 'claude-haiku-5-5', '--budget-usd', '0.016'], io)
    expect(out.join('')).toContain('budget: $0.016 (from --budget-usd)')
    expect(out.join('')).toContain('--budget-usd 0.016')
  })

  it('reads the effective base URL and refuses custom headers without --allow-base-url, sending nothing', async () => {
    expect(effectiveEndpoint({})).toEqual({ baseURL: 'https://api.anthropic.com', host: 'api.anthropic.com', isDefault: true })
    expect(effectiveEndpoint({ ANTHROPIC_BASE_URL: ' https://api.anthropic.com/ ' }).isDefault).toBe(true)
    expect(effectiveEndpoint({ ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1' })).toMatchObject({ host: 'proxy.example.com', isDefault: false })
    expect(() => effectiveEndpoint({ ANTHROPIC_BASE_URL: 'not a url' })).toThrow(/not a valid URL/)
    const network = vi.fn(() => Promise.reject(new Error('no network in tests')))
    vi.stubGlobal('fetch', network)
    try {
      const { io, out, err } = quietIo({ env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_CUSTOM_HEADERS: 'x-leak: 1' } })
      const args = ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', '--out', join(dir, 'headers')]
      expect(await main(args, io)).toBe(1)
      expect(out.join('')).toContain('API host: api.anthropic.com')
      expect(err.join('')).toContain('ANTHROPIC_CUSTOM_HEADERS is set')
      expect(network).not.toHaveBeenCalled()
      expect(existsSync(join(dir, 'headers'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
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
    expect(await main(['extract', '--yes', '--models', 'claude-mystery-9', '--only', SEED, '--kinds', 'text', '--budget-usd', '1'], io)).toBe(1)
    expect(err.join('')).not.toContain(KEY)
  })

  it('hands the key to the results writer as a secret to scrub, and no secret for the baselines', async () => {
    const baseURL = await mockApi()
    try {
      vi.mocked(writeResults).mockClear()
      const real = quietIo({ env: { ANTHROPIC_API_KEY: ` ${KEY} `, ANTHROPIC_BASE_URL: baseURL } })
      const args = ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', ALLOW]
      expect(await main([...args, '--out', join(dir, 'real')], real.io)).toBe(0)
      expect(seen).toHaveLength(1)
      expect(vi.mocked(writeResults).mock.calls.map((call) => call[2].secrets)).toEqual([[KEY]])
      vi.mocked(writeResults).mockClear()
      const fake = quietIo({ env: { ANTHROPIC_API_KEY: KEY } })
      expect(await main(['extract', '--baselines', '--only', SEED, '--kinds', 'text', '--out', join(dir, 'fake')], fake.io)).toBe(0)
      expect(vi.mocked(writeResults).mock.calls.map((call) => call[2].secrets)).toEqual([[]])
      expect(seen[0]?.headers['authorization'] ?? seen[0]?.headers['x-api-key']).toContain(KEY)
      expect(String(seen[0]?.headers['authorization'] ?? seen[0]?.headers['x-api-key'])).not.toContain(` ${KEY} `)
    } finally {
      vi.mocked(writeResults).mockClear()
    }
  })

  it('keeps every finished task in tasks.partial.jsonl when the final write fails', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'crash')
    vi.mocked(writeResults).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    const { io, err } = quietIo({ env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL } })
    const args = ['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '2', '--budget-usd', '1', ALLOW, '--out', out]
    expect(await main(args, io)).toBe(1)
    expect(err.join('')).toContain('ENOSPC')
    const lines = readJsonl(join(out, PARTIAL_FILE))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ model: 'claude-haiku-5-5', status: 'ok', case_id: `${SEED}:text` })
    expect(readFileSync(join(out, PARTIAL_FILE), 'utf8')).not.toContain(KEY)
    expect(readFileSync(join(out, PARTIAL_FILE), 'utf8')).not.toContain('<document')
  })

  it('redacts the key from an error message that happens to contain it', async () => {
    const withKey = join(dir, KEY)
    mkdirSync(withKey)
    writeFileSync(join(withKey, 'x'), 'x')
    const { io, err } = quietIo({ env: { ANTHROPIC_API_KEY: KEY } })
    expect(await main(['extract', '--yes', '--models', 'claude-haiku-5-5', '--only', SEED, '--kinds', 'text', '--reps', '1', '--budget-usd', '1', '--out', withKey], io)).toBe(1)
    expect(err.join('')).toContain('output directory is not empty: ')
    expect(err.join('')).toContain('[redacted]')
    expect(err.join('')).not.toContain(KEY)
  })
})
