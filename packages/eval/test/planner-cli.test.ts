import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@rill/llm'
import { PlanError } from '@rill/planner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USAGE, main, type CliIo } from '../src/cli'
import { formatUsdPlain, guardReserveUsd, worstCallUsd } from '../src/budget'
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK, EXIT_PARTIAL, EXIT_USAGE, suggestedBudgetUsd } from '../src/cli-shared'
import { PRICE_TABLE_AS_OF, estimateCallUsd } from '../src/pricing'
import { createEvalProvider, type EvalProviderOptions } from '../src/record'
import { buildSchedule, worstCaseCallUsd } from '../src/runner'
import { verifyAttachments } from '../src/suites/planner/attachments'
import { effortMaxTokens, plannerWorstCaseUsd, worstCaseCalls } from '../src/suites/planner/budget'
import {
  PLANNER_USAGE,
  parsePlannerCli,
  plannerCommandLine,
  plannerMain,
  type PlannerCliConfig,
} from '../src/suites/planner/cli'
import { ERROR_ISSUE, fakeResult, fakeRound, workflowBody } from '../src/suites/planner/fake-results'
import { copyingPlanner, oraclePlanner, throwingPlanner } from '../src/suites/planner/fakes'
import { createPlannerSuite, type PlannerFactory } from '../src/suites/planner/suite'
import { estimateRun } from '../src/runner'
import { offlineProvider } from './planner-helpers'

vi.mock('../src/suites/planner/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/suites/planner/attachments')>()
  return { ...actual, verifyAttachments: vi.fn(actual.verifyAttachments) }
})

vi.mock('../src/record', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/record')>()
  return { ...actual, createEvalProvider: vi.fn(actual.createEvalProvider) }
})

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/eval/src/cli.ts')
const KEY = 'sk-ant-api03-PLANNER-CLI-SECRET-24680'
const SONNET = 'claude-sonnet-5-5'
const NOW = Date.UTC(2026, 10, 12, 9, 30, 0)

let dir: string
let server: Server | undefined
let requests: { url: string; headers: Record<string, unknown>; body: { max_tokens?: number; model?: string; effort?: unknown } }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-planner-cli-'))
  requests = []
  vi.mocked(createEvalProvider).mockClear()
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
})

async function mockApi(): Promise<string> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as { max_tokens?: number; model?: string }
      requests.push({ url: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${requests.length}` })
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`
}

interface Harness {
  io: CliIo
  out: () => string
  err: () => string
  providers: EvalProviderOptions[]
}

function harness(env: Record<string, string | undefined> = {}, makePlanner?: PlannerFactory, extra: Partial<CliIo> = {}): Harness {
  const out: string[] = []
  const err: string[] = []
  const providers: EvalProviderOptions[] = []
  const io: CliIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    env,
    now: () => NOW,
    outRoot: join(dir, 'results'),
    planner: {
      ...(makePlanner === undefined ? {} : { makePlanner }),
      createProvider: (options) => {
        providers.push(options)
        return offlineProvider()
      },
    },
    ...extra,
  }
  return { io, out: () => out.join(''), err: () => err.join(''), providers }
}

const config = (...args: string[]): PlannerCliConfig => parsePlannerCli(args)

describe('parsePlannerCli', () => {
  it('has the defaults: Sonnet, one rep, the case effort, the full set, a dry plan', () => {
    expect(config()).toEqual({
      models: ['claude-sonnet-5-5'],
      effort: undefined,
      group: undefined,
      only: undefined,
      dry: false,
      reps: 1,
      concurrency: 2,
      maxRepairRounds: 3,
      budgetUsd: undefined,
      maxCallSeconds: 300,
      maxAttempts: 2,
      seed: 1,
      out: undefined,
      allowBaseUrl: false,
      yes: false,
      help: false,
    })
  })

  it('reads the options of the brief: --model, --effort, --group, --only, --dry, --yes with --budget-usd', () => {
    expect(config('--model', 'claude-opus-5-5', '--effort', 'high', '--group', 'patch', '--dry')).toMatchObject({ models: ['claude-opus-5-5'], effort: 'high', group: 'patch', dry: true })
    expect(config('--only', 'easy-01')).toMatchObject({ only: 'easy-01' })
    expect(config('--yes', '--budget-usd', '2.5')).toMatchObject({ yes: true, budgetUsd: 2.5 })
  })

  it('takes comma lists, and --models as the same option as --model', () => {
    expect(config('--model', 'a,b').models).toEqual(['a', 'b'])
    expect(config('--models', 'a,b').models).toEqual(['a', 'b'])
    expect(config('--group', 'easy,patch').group).toEqual(['easy', 'patch'])
    expect(config('--only', 'easy-01-receipt-folder-to-csv,patch-01-change-schedule').only).toEqual(['easy-01-receipt-folder-to-csv', 'patch-01-change-schedule'])
  })

  it.each(['low', 'medium', 'high'])('accepts the effort %s', (effort) => {
    expect(config('--effort', effort).effort).toBe(effort)
  })

  it.each(['xhigh', 'max'])('refuses the effort %s up front: its reply streams and the usage cannot be read', (effort) => {
    expect(() => parsePlannerCli(['--effort', effort])).toThrow(`--effort ${effort}: effort ${effort} cannot be measured`)
    expect(() => parsePlannerCli(['--effort', effort])).toThrow('Use low, medium, high.')
  })

  it.each([
    [['--effort', 'ultra'], '--effort must be one of low, medium, high'],
    [['--model', 'a', '--models', 'b'], 'are the same option'],
    [['--model', 'Bad Model'], '--model must list model ids'],
    [['--model', 'a,,b'], 'without empty entries'],
    [['--model', 'a,a'], 'lists an entry twice'],
    [['--yes', '--dry', '--budget-usd', '1'], '--dry cannot be combined with --yes'],
    [['--yes'], '--yes needs --budget-usd'],
    [['--budget-usd', '0'], '--budget-usd must be a finite positive number'],
    [['--budget-usd=-1'], '--budget-usd must be a finite positive number'],
    [['--budget-usd', '1e3'], '--budget-usd must be a finite positive number'],
    [['--reps', '0'], '--reps must be an integer from 1 to 20'],
    [['--reps', '21'], '--reps must be an integer from 1 to 20'],
    [['--concurrency', '17'], '--concurrency must be an integer from 1 to 16'],
    [['--max-repair-rounds', '6'], '--max-repair-rounds must be an integer from 0 to 5'],
    [['--max-repair-rounds=-1'], '--max-repair-rounds must be an integer from 0 to 5'],
    [['--max-output-tokens', '8000'], '--max-output-tokens is not an option of the planner command: the planner sets max_tokens itself, by effort (low 8000, medium 12000, high 16000, xhigh 32000 (not measurable), max 32000 (not measurable))'],
    [['--max-output-tokens', '16001'], 'choose the effort with --effort'],
    [['--max-call-seconds', '1801'], '--max-call-seconds must be an integer from 1 to 1800'],
    [['--max-attempts', '11'], '--max-attempts must be an integer from 1 to 10'],
    [['--seed', '4294967296'], '--seed must be an integer from 0 to 4294967295'],
    [['--only', ' '], '--only must not be empty'],
    [['--nope'], "Unknown option '--nope'"],
    [['extract'], 'unexpected argument: extract'],
  ])('rejects %j', (args, message) => {
    expect(() => parsePlannerCli(args)).toThrow(message)
  })

  it('shows the help without checking anything else', () => {
    expect(config('--help').help).toBe(true)
    expect(config('-h', '--effort', 'ultra').help).toBe(true)
  })
})

describe('plannerCommandLine', () => {
  it('repeats every option that differs from its default, and nothing else', () => {
    const plain = plannerCommandLine(config(), 4.28)
    expect(plain).toBe('pnpm eval planner --yes --model claude-sonnet-5-5 --budget-usd 4.28')
    const busy = config('--model', 'a,b', '--effort', 'high', '--group', 'easy,patch', '--only', 'easy-0', '--reps', '2', '--concurrency', '3', '--max-repair-rounds', '1', '--max-call-seconds', '120', '--max-attempts', '3', '--seed', '9', '--out', '/tmp/x', '--allow-base-url')
    expect(plannerCommandLine(busy, 1)).toBe(
      'pnpm eval planner --yes --model a,b --effort high --group easy,patch --only easy-0 --reps 2 --concurrency 3 --max-repair-rounds 1 --max-call-seconds 120 --max-attempts 3 --seed 9 --out /tmp/x --allow-base-url --budget-usd 1.00',
    )
  })

  it('prints a command that parses back to the same plan', () => {
    for (const args of [[], ['--model', 'a,b', '--effort', 'high'], ['--group', 'patch', '--max-repair-rounds', '0'], ['--only', 'a,b', '--reps', '3']]) {
      const original = config(...args)
      const words = plannerCommandLine(original, 2.5).split(' ').slice(3)
      const again = parsePlannerCli(words)
      expect(again).toMatchObject({ ...original, yes: true, budgetUsd: 2.5 })
    }
  })
})

describe('the dry run', () => {
  const plan = async (...args: string[]): Promise<string> => {
    const h = harness()
    expect(await plannerMain(['--dry', ...args], h.io)).toBe(EXIT_OK)
    return h.out()
  }

  it('lists the cases, the planned calls, the typical and the worst-case cost and the formula', async () => {
    const text = await plan()
    expect(text).toContain('rill eval: planner (suite version ')
    expect(text).toContain('cases: 48 cases (easy 20, ambiguous 10, unsupported 8, attachment 6, patch 4)')
    expect(text).toContain('tasks: 48 (48 cases x 1 rep x 1 model)')
    expect(text).toContain('provider calls: 48 planned at one call per task if no plan needs repair; at most 336 (7 per task)')
    expect(text).toContain('effort: each case sets its own (low 18, medium 18, high 12)')
    expect(text).toContain(
      'planner: up to 3 repair rounds; worst case 7 calls per case = 1 first call + 3 repair rounds x up to 2 calls (a repair round re-asks once, or repairs up to 2 nodes with one call each)',
    )
    expect(text).toContain(`estimate (prices as of ${PRICE_TABLE_AS_OF}):`)
    expect(text).toMatch(/claude-sonnet-5-5: typical \$\d+\.\d+ \(one call per case, no repair\), worst case \$\d+\.\d+ \(7 calls per case, every call at the max_tokens of its effort\)/u)
    expect(text).toContain("guard formula: the budget guard reserves, for every case in flight, 7 calls x (input + the max_tokens of the case's effort as output tokens)")
    expect(text).toContain("for each of the 3 repair rounds, the max_tokens of the case's effort for the previous answer and 3000 tokens for the issue list")
    expect(text).toContain('7 = 1 + 3 repair rounds x 2 calls')
    expect(text).toContain('the planner sets max_tokens from it: low 8000, medium 12000, high 16000')
    expect(text).toContain('Nothing was sent.')
    for (const testCase of createPlannerSuite().cases()) expect(text).toContain(testCase.id)
    expect(text).toMatch(/attach-03-pdf-injection-http-exfil\s+attachment\s+high\s+workflow\s+1\s+hard,injection/u)
  })

  it('prices the worst case with the number of calls of the planner settings', async () => {
    const suite = createPlannerSuite()
    const expected = suite.cases().reduce((sum, testCase) => sum + (worstCaseCallUsd(suite, testCase, SONNET, 16_000) ?? 0), 0)
    expect(await plan()).toContain(`worst case $${expected.toFixed(2)} (7 calls`)
    const lean = createPlannerSuite({ maxRepairRounds: 0 })
    const leanTotal = lean.cases().reduce((sum, testCase) => sum + (worstCaseCallUsd(lean, testCase, SONNET, 16_000) ?? 0), 0)
    const leanText = await plan('--max-repair-rounds', '0')
    expect(leanText).toContain(`worst case $${leanTotal.toFixed(2)} (1 call per case`)
    expect(leanText).toContain('at most 48 (1 per task)')
    expect(leanText).toContain('worst case 1 call per case = 1 first call + 0 repair rounds x up to 2 calls')
    expect(leanTotal).toBeLessThan(expected)
  })

  it('computes the typical cost from one call per case at 3000 output tokens', async () => {
    const suite = createPlannerSuite()
    const expected = suite.cases().reduce((sum, testCase) => sum + (estimateCallUsd(SONNET, suite.estimateInputTokens?.(testCase) ?? 0, 3000) ?? 0), 0)
    const text = await plan()
    expect(text).toContain(`typical $${expected.toFixed(2)} (one call per case`)
    expect(text).toContain('typical output is 3000 tokens per call')
    expect(text).toContain(`total: typical $${expected.toFixed(2)}, worst case $`)
  })

  it('narrows to a group or ids, scales with reps and models, and shows an effort override', async () => {
    const patch = await plan('--group', 'patch', '--reps', '2', '--model', 'claude-sonnet-5-5,claude-opus-5-5', '--effort', 'high')
    expect(patch).toContain('cases: 4 cases (patch 4)')
    expect(patch).toContain('tasks: 16 (4 cases x 2 reps x 2 models)')
    expect(patch).toContain('effort: high (override)')
    expect(patch).toMatch(/patch-01-change-schedule\s+patch\s+high\s+workflow/u)
    expect(patch).toContain('claude-opus-5-5: typical')
    expect(await plan('--only', 'easy-01-receipt-folder-to-csv')).toContain('cases: 1 case (easy 1)')
  })

  it('says so when a model has no price, and gives no budget for it', async () => {
    const text = await plan('--model', 'some-other-model')
    expect(text).toContain('some-other-model: 48 cases, no price in the price table')
    expect(text).toContain('no price for: some-other-model; the budget guard needs one, so --yes would refuse this run')
    expect(text).toContain('budget: n/a (needs a price for every model)')
  })

  it('warns when the budget is below the worst case of one case', async () => {
    const text = await plan('--budget-usd', '0.01')
    expect(text).toContain('budget: $0.01 (from --budget-usd)')
    expect(text).toContain('note: this budget is below the worst case of one case')
    expect(text).toContain('--budget-usd 0.01')
    expect(await plan('--budget-usd', '5')).not.toContain('note: this budget is below')
  })

  it('suggests the larger of twice the typical cost and the typical cost plus the reserve of the cases in flight', async () => {
    for (const args of [[], ['--concurrency', '8'], ['--group', 'patch', '--concurrency', '1'], ['--group', 'patch', '--concurrency', '16']]) {
      const parsed = config(...args)
      const suite = createPlannerSuite({ ...(parsed.group === undefined ? {} : { group: parsed.group }) })
      const typical = estimateRun({ suite, models: parsed.models, reps: 1, outputTokens: 3000 })
      const worst = worstCallUsd(suite, parsed.models, 16_000) ?? 0
      const expected = suggestedBudgetUsd(typical.totalUsd ?? 0, guardReserveUsd(worst, parsed.concurrency, typical.calls))
      const text = await plan(...args)
      expect(text, args.join(' ')).toContain(`suggested budget: $${formatUsdPlain(expected)} (`)
      expect(text).toContain(`--budget-usd ${formatUsdPlain(expected)}`)
      expect(expected).toBeGreaterThan(2 * (typical.totalUsd ?? 0) - 1e-9)
    }
  })
})

describe('plannerMain without --yes', () => {
  it('prints the plan and exits 0 without a provider, a planner or any output file', async () => {
    const makePlanner = vi.fn(oraclePlanner)
    const h = harness({ ANTHROPIC_API_KEY: KEY }, makePlanner)
    expect(await main(['planner'], h.io)).toBe(EXIT_OK)
    expect(await main(['planner', '--dry'], h.io)).toBe(EXIT_OK)
    expect(h.out()).toContain('Nothing was sent.')
    expect(h.err()).toBe('')
    expect(h.providers).toHaveLength(0)
    expect(createEvalProvider).not.toHaveBeenCalled()
    expect(makePlanner).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'results'))).toBe(false)
    expect(h.out()).not.toContain(KEY)
  })

  it('never constructs a provider for any dry run, whatever the other options', async () => {
    for (const args of [['--dry'], ['--dry', '--model', 'a,b', '--effort', 'high'], ['--group', 'patch'], ['--only', 'easy-01'], ['--budget-usd', '5'], ['--dry', '--allow-base-url']]) {
      const h = harness({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://example.invalid' })
      expect(await main(['planner', ...args], h.io), args.join(' ')).toBe(EXIT_OK)
      expect(h.providers).toHaveLength(0)
    }
    expect(createEvalProvider).not.toHaveBeenCalled()
  })

  it('shows the help of the planner command, and leaves the extract usage as it was', async () => {
    const h = harness()
    expect(await main(['planner', '--help'], h.io)).toBe(EXIT_OK)
    expect(h.out()).toBe(PLANNER_USAGE)
    const e = harness()
    expect(await main(['--help'], e.io)).toBe(EXIT_OK)
    expect(e.out()).toBe(USAGE)
    expect(USAGE).not.toContain('planner')
  })

  it('exits 2 with the usage for a bad option, an unknown group and an unknown id', async () => {
    for (const [args, message] of [
      [['--effort', 'ultra'], '--effort must be one of'],
      [['--group', 'nope'], '--group: unknown group: nope'],
      [['--only', 'zzz'], '--only: no case id contains "zzz"'],
      [['--only', 'a-1,b-2'], '--only: unknown case id'],
      [['--yes'], '--yes needs --budget-usd'],
    ] as const) {
      const h = harness()
      expect(await plannerMain(args, h.io), args.join(' ')).toBe(EXIT_USAGE)
      expect(h.err()).toContain(`error: ${message}`)
      expect(h.err()).toContain('usage: pnpm eval planner [options]')
      expect(h.providers).toHaveLength(0)
    }
  })

  it('refuses to start when an attachment fixture is not usable, before it plans or sends anything', async () => {
    vi.mocked(verifyAttachments).mockReturnValueOnce(['attach-03-pdf-injection-http-exfil attachment 0: differs from the manifest (regenerate the attachments)'])
    const h = harness({ ANTHROPIC_API_KEY: KEY })
    expect(await plannerMain(['--dry'], h.io)).toBe(EXIT_ERROR)
    expect(h.err()).toContain('error: the attachments are not usable:\n  attach-03-pdf-injection-http-exfil attachment 0: differs from the manifest')
    expect(h.out()).toBe('')
    expect(h.providers).toHaveLength(0)
  })
})

describe('plannerMain --yes: the guards', () => {
  const yes = (...extra: string[]): string[] => ['--yes', '--budget-usd', '50', '--only', 'easy-03-webhook-to-slack', ...extra]

  it('needs ANTHROPIC_API_KEY, blank counts as missing, and constructs no provider', async () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '  \t' }]) {
      const h = harness(env)
      expect(await plannerMain(yes(), h.io)).toBe(EXIT_ERROR)
      expect(h.err()).toContain('ANTHROPIC_API_KEY is not set')
      expect(h.providers).toHaveLength(0)
    }
    expect(createEvalProvider).not.toHaveBeenCalled()
  })

  it('refuses a model without a price, since the budget guard needs one', async () => {
    const h = harness({ ANTHROPIC_API_KEY: KEY })
    expect(await plannerMain(yes('--model', 'some-other-model'), h.io)).toBe(EXIT_ERROR)
    expect(h.err()).toContain('no price for model some-other-model')
    expect(h.providers).toHaveLength(0)
  })

  it('refuses another base URL or custom headers without --allow-base-url, before any provider', async () => {
    const other = harness({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://proxy.example.test' })
    expect(await plannerMain(yes(), other.io)).toBe(EXIT_ERROR)
    expect(other.err()).toContain('ANTHROPIC_BASE_URL points to proxy.example.test, not https://api.anthropic.com')
    expect(other.out()).toContain('API host: proxy.example.test')
    const headers = harness({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_CUSTOM_HEADERS: 'x-team: a' })
    expect(await plannerMain(yes(), headers.io)).toBe(EXIT_ERROR)
    expect(headers.err()).toContain('ANTHROPIC_CUSTOM_HEADERS is set; unset it')
    expect(other.providers).toHaveLength(0)
    expect(headers.providers).toHaveLength(0)
    expect(createEvalProvider).not.toHaveBeenCalled()
  })

  it('goes ahead with --allow-base-url and prints a warning that the key goes to that host', async () => {
    const h = harness({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://proxy.example.test' }, oraclePlanner)
    expect(await plannerMain(yes('--allow-base-url', '--out', join(dir, 'o')), h.io)).toBe(EXIT_OK)
    expect(h.out()).toContain('WARNING: --allow-base-url is set: your API key will be sent to proxy.example.test')
    expect(h.providers[0]?.baseURL).toBe('https://proxy.example.test')
  })

  it('refuses an invalid ANTHROPIC_BASE_URL and a results directory that is not empty', async () => {
    const bad = harness({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'not a url' })
    expect(await plannerMain(yes(), bad.io)).toBe(EXIT_ERROR)
    expect(bad.err()).toContain('ANTHROPIC_BASE_URL is not a valid URL')
    const out = join(dir, 'full')
    mkdirSync(out)
    writeFileSync(join(out, 'keep.txt'), 'x')
    const h = harness({ ANTHROPIC_API_KEY: KEY })
    expect(await plannerMain(yes('--out', out), h.io)).toBe(EXIT_ERROR)
    expect(h.err()).toContain('output directory is not empty')
    expect(h.providers).toHaveLength(0)
  })

  it('redacts the key from an error message', async () => {
    const h = harness({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `bad ${KEY}` })
    expect(await plannerMain(yes(), h.io)).toBe(EXIT_ERROR)
    expect(h.err()).not.toContain(KEY)
    expect(h.err()).toContain('[redacted]')
  })
})

describe('plannerMain --yes: a run', () => {
  const env = { ANTHROPIC_API_KEY: KEY }

  it('runs every case through the planner, writes the results and the report, and exits 0', async () => {
    const h = harness(env, oraclePlanner)
    const out = join(dir, 'run')
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--out', out], h.io)).toBe(EXIT_OK)
    expect(h.out()).toContain('notice: the case prompts')
    expect(h.out()).toContain('48 tasks planned')
    expect(h.out()).toMatch(/claude-sonnet-5-5\s+100\.0% \(48\/48\)/u)
    expect(h.out()).toContain('total cost: $0.0000 of a $50.00 budget')
    expect(h.err()).toContain('progress: 48/48')
    expect(h.providers).toHaveLength(48)
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('# Eval report: planner')
    expect(report).toContain('100.0% (100.0% to 100.0%), 48/48')
    const names = readdirSync(out).sort()
    expect(names).toEqual(['_state.json', 'baseline', 'report.md', 'run.json'])
    const rows = readFileSync(join(out, 'baseline', 'results.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(48)
    expect(rows[0]).toMatchObject({ requested_model: SONNET, prompt: expect.any(String) })
    expect(rows.every((row) => (row['prompt'] as string).length > 0)).toBe(true)
    expect(rows.every((row) => (row['grade'] as Record<string, number>)['case_pass'] === 1)).toBe(true)
    const runJson = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as Record<string, unknown>
    expect(runJson).toMatchObject({ suite: 'planner', partial: false, max_output_tokens: 16_000, versions: { max_repair_rounds: '3', effort: 'per case' } })
  })

  it('builds a provider per attempt with the model, the key, the largest measurable max_tokens and a timeout above the call ceiling, and no effort', async () => {
    const h = harness(env, oraclePlanner)
    await plannerMain(['--yes', '--budget-usd', '50', '--only', 'easy-03-webhook-to-slack', '--effort', 'high', '--max-call-seconds', '120', '--out', join(dir, 'o')], h.io)
    expect(h.providers).toHaveLength(1)
    expect(h.providers[0]).toMatchObject({ model: SONNET, apiKey: KEY, baseURL: 'https://api.anthropic.com', maxTokens: 16_000, timeoutMs: 125_000 })
    expect(h.providers[0]).not.toHaveProperty('effort')
  })

  it('applies --effort to every request and --max-repair-rounds to the planner', async () => {
    const seen: { effort: string; rounds: number | undefined }[] = []
    const factory: PlannerFactory = ({ deps, testCase }) => ({
      plan: (request) => {
        seen.push({ effort: request.effort, rounds: deps.maxRepairRounds })
        return Promise.resolve(fakeResult(workflowBody(structuredClone(testCase.references[0]!))))
      },
    })
    const h = harness(env, factory)
    await plannerMain(['--yes', '--budget-usd', '50', '--group', 'patch', '--effort', 'high', '--max-repair-rounds', '1', '--out', join(dir, 'o')], h.io)
    expect(seen).toHaveLength(4)
    expect(seen.every((entry) => entry.effort === 'high' && entry.rounds === 1)).toBe(true)
  })

  it('runs a model list and repetitions, and keeps a partial file out of the final directory', async () => {
    const h = harness(env, oraclePlanner)
    const out = join(dir, 'multi')
    await plannerMain(['--yes', '--budget-usd', '50', '--model', 'claude-sonnet-5-5,claude-haiku-5-5', '--reps', '2', '--group', 'patch', '--out', out], h.io)
    expect(h.providers).toHaveLength(16)
    expect(readdirSync(out)).not.toContain('tasks.partial.jsonl')
    expect(readdirSync(out).sort()).toEqual(['_state.json', 'baseline', 'report.md', 'run.json', 'v1'])
  })

  it('stops at the budget with exit 3 and marks the report PARTIAL', async () => {
    const h = harness(env, oraclePlanner)
    const out = join(dir, 'partial')
    expect(await plannerMain(['--yes', '--budget-usd', '0.5', '--group', 'patch', '--out', out], h.io)).toBe(EXIT_PARTIAL)
    expect(h.out()).toContain('PARTIAL RUN: the budget ran out; 4 of 4 tasks were skipped')
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('**PARTIAL RUN**')
    expect(h.providers).toHaveLength(0)
  })

  it('runs a case only when the budget covers the whole case, not just one call', async () => {
    const suite = createPlannerSuite({ only: 'easy-03-webhook-to-slack' })
    const [testCase] = suite.cases()
    const worst = plannerWorstCaseUsd(SONNET, suite.estimateInputTokens?.(testCase!) ?? 0, 3, effortMaxTokens(testCase!.spec.effort)) ?? 0
    expect(worstCaseCalls(3)).toBe(7)
    const tight = harness(env, oraclePlanner)
    expect(await plannerMain(['--yes', '--budget-usd', String(worst * 0.9), '--only', 'easy-03-webhook-to-slack', '--out', join(dir, 'a')], tight.io)).toBe(EXIT_PARTIAL)
    expect(tight.providers).toHaveLength(0)
    const enough = harness(env, oraclePlanner)
    expect(await plannerMain(['--yes', '--budget-usd', String(Math.ceil(worst * 1.5 * 100) / 100), '--only', 'easy-03-webhook-to-slack', '--out', join(dir, 'b')], enough.io)).toBe(EXIT_OK)
    expect(enough.providers).toHaveLength(1)
  })

  it('grades a plan that stays invalid as a failed case and still exits 0', async () => {
    const failing = throwingPlanner(() => new PlanError('invalid_after_repair', 'x', [fakeRound(0, [ERROR_ISSUE])], [ERROR_ISSUE]))
    const h = harness(env, failing)
    const out = join(dir, 'bad')
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--only', 'easy-03-webhook-to-slack', '--out', out], h.io)).toBe(EXIT_OK)
    expect(h.out()).toMatch(/claude-sonnet-5-5\s+0\.0% \(0\/1\)/u)
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('invalid_after_repair')
  })

  it('stops at the first authentication failure with exit 1', async () => {
    const auth = throwingPlanner(() => new PlanError('provider', 'x', [], [], { cause: new LlmError('auth', 'bad key', { status: 401 }) }))
    const h = harness(env, auth)
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--group', 'patch', '--concurrency', '1', '--out', join(dir, 'auth')], h.io)).toBe(EXIT_ERROR)
    expect(h.err()).toContain('the API rejected the credentials')
    expect(h.err()).toMatch(/3 of 4 tasks were not run/u)
  })

  it('writes a partial report and exits 130 when interrupted, and a second signal aborts the calls in flight', async () => {
    let handler: (signal: string) => void = () => undefined
    const disposed = vi.fn()
    let sent = 0
    const factory: PlannerFactory = ({ testCase }) => ({
      plan: (request) => {
        sent += 1
        if (sent === 1) handler('SIGINT')
        return Promise.resolve(fakeResult(workflowBody(structuredClone(testCase.references[0]!)), [fakeRound(0)])).then((result) => {
          void request
          return result
        })
      },
    })
    const h = harness(env, factory, {
      onSignal: (listener) => {
        handler = listener
        return disposed
      },
    })
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--group', 'patch', '--concurrency', '1', '--out', join(dir, 'sig')], h.io)).toBe(EXIT_INTERRUPTED)
    expect(h.err()).toContain('SIGINT: no new calls')
    expect(h.out()).toContain('PARTIAL RUN: interrupted; 3 of 4 tasks were not run')
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('scrubs the key from the files it writes', async () => {
    const leaky: PlannerFactory = ({ testCase }) => ({
      plan: () => Promise.resolve(fakeResult({ ...workflowBody(structuredClone(testCase.references[0]!)), summary: `the key is ${KEY}` })),
    })
    const h = harness(env, leaky)
    const out = join(dir, 'leak')
    await plannerMain(['--yes', '--budget-usd', '50', '--only', 'easy-03-webhook-to-slack', '--out', out], h.io)
    const all = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
      .join('\n')
    expect(all).not.toContain(KEY)
    expect(all).toContain('[redacted]')
    expect(h.out() + h.err()).not.toContain(KEY)
  })

  it('puts the results of a run without --out under packages/eval/results/planner-<timestamp>', async () => {
    const h = harness(env, oraclePlanner)
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--only', 'easy-03-webhook-to-slack'], h.io)).toBe(EXIT_OK)
    expect(readdirSync(join(dir, 'results'))).toEqual(['planner-20261112T093000Z'])
    expect(h.out()).toContain(`results: ${join(dir, 'results', 'planner-20261112T093000Z')}`)
  })

  it('keeps what was finished when the run crashes, in tasks.partial.jsonl', async () => {
    const baseURL = await mockApi()
    const ids = ['easy-03-webhook-to-slack', 'easy-05-delay-then-slack']
    const schedule = buildSchedule({ cases: createPlannerSuite({ only: ids }).cases(), models: [SONNET], reps: 1, seed: 1 })
    const [firstUp, secondUp] = schedule.map((entry) => entry.testCase.id)
    const greedy: PlannerFactory = ({ deps, testCase }) => ({
      plan: async () => {
        const request = { messages: [{ role: 'user' as const, content: 'hello' }], schema: { type: 'object' }, ...(testCase.id === secondUp ? { maxTokens: 20_000 } : {}) }
        await deps.provider.generate(request).catch(() => undefined)
        return fakeResult(workflowBody(structuredClone(testCase.references[0]!)))
      },
    })
    const out = join(dir, 'crash')
    const err: string[] = []
    const io: CliIo = { stdout: () => undefined, stderr: (text) => void err.push(text), env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL }, now: () => NOW, planner: { makePlanner: greedy } }
    const code = await plannerMain(['--yes', '--budget-usd', '50', '--allow-base-url', '--concurrency', '1', '--only', ids.join(','), '--out', out], io)
    expect(code).toBe(EXIT_ERROR)
    expect(err.join('')).toContain('a request asked for max_tokens 20000 but the budget reserves 16000; stopping the run')
    const lines = readFileSync(join(out, 'tasks.partial.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ case_id: firstUp, status: 'ok' })
    expect(existsSync(join(out, 'report.md'))).toBe(false)
  })

  it('records an injection that was copied without a flag in the report', async () => {
    const h = harness(env, copyingPlanner({ flag: false }))
    const out = join(dir, 'inject')
    await plannerMain(['--yes', '--budget-usd', '50', '--only', 'attach-03-pdf-injection-http-exfil,attach-04-text-injection-outside-path', '--out', out], h.io)
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('| claude-sonnet-5-5 | 2 | 0 | 0 | 2 | 0.0% (0/2) |')
    expect(report).toContain('| claude-sonnet-5-5 | hasNodeCount | 2 |')
  })

  it('sends the real requests through the real provider to a server, with the budget guard and the recorder in the loop', async () => {
    const baseURL = await mockApi()
    const asking: PlannerFactory = ({ deps, testCase }) => ({
      plan: async () => {
        await deps.provider.generate({ system: 'rules', messages: [{ role: 'user', content: 'hello' }], schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } })
        return fakeResult(workflowBody(structuredClone(testCase.references[0]!)))
      },
    })
    const out = join(dir, 'real')
    const io: CliIo = {
      stdout: () => undefined,
      stderr: () => undefined,
      env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL },
      now: () => NOW,
      planner: { makePlanner: asking },
    }
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--allow-base-url', '--only', 'easy-03-webhook-to-slack', '--out', out], io)).toBe(EXIT_OK)
    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.headers['authorization'] ?? requests[0]?.headers['x-api-key'])).toContain(KEY)
    expect(requests[0]?.body).toMatchObject({ model: SONNET, max_tokens: 16_000 })
    expect(createEvalProvider).toHaveBeenCalledTimes(1)
    const row = JSON.parse(readFileSync(join(out, 'baseline', 'results.jsonl'), 'utf8').trim()) as { usage: Record<string, number>; model: string }
    expect(row.usage).toMatchObject({ input_tokens: 1000, output_tokens: 500 })
    const cost = estimateCallUsd(SONNET, 1000, 500) ?? 0
    expect(JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))).toMatchObject({ spent_usd: cost })
    expect(readFileSync(join(out, 'baseline', 'traces', 'easy-03-webhook-to-slack_rep0.json'), 'utf8')).toContain('hello')
  })
})

describe('eval planner: process level', () => {
  function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const full: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_CUSTOM_HEADERS: undefined, ...env }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, env: full, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  it('prints the plan and sends nothing, even with a key and a reachable API', async () => {
    const baseURL = await mockApi()
    const out = join(dir, 'out')
    const result = await runCli(['planner', '--dry', '--group', 'patch', '--out', out], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
    expect(result.code).toBe(0)
    expect(requests).toHaveLength(0)
    expect(result.stdout).toContain('cases: 4 cases (patch 4)')
    expect(result.stdout).toContain('Nothing was sent.')
    expect(result.stdout).toContain(`pnpm eval planner --yes --model claude-sonnet-5-5 --group patch --out ${out} --budget-usd `)
    expect(result.stdout + result.stderr).not.toContain(KEY)
    expect(existsSync(out)).toBe(false)
  })

  it('refuses --yes without a key and --yes without a budget, and sends nothing', async () => {
    const baseURL = await mockApi()
    const noKey = await runCli(['planner', '--yes', '--budget-usd', '1', '--allow-base-url', '--only', 'patch-01'], { ANTHROPIC_BASE_URL: baseURL })
    expect(noKey.code).toBe(EXIT_ERROR)
    expect(noKey.stderr).toContain('ANTHROPIC_API_KEY is not set')
    const noBudget = await runCli(['planner', '--yes'], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
    expect(noBudget.code).toBe(EXIT_USAGE)
    expect(noBudget.stderr).toContain('--yes needs --budget-usd')
    expect(requests).toHaveLength(0)
  })
})
