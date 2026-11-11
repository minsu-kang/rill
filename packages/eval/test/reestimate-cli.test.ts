import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { roundUpBudget } from '../src/budget'
import { USAGE, UsageError, main, parseCli, type CliIo } from '../src/cli'
import { worstCaseCallUsd } from '../src/runner'
import { createExtractSuite } from '../src/suites/extract/suite'
import { HAIKU, OPUS, SONNET } from './fake-run'
import { writePilotDir, type PilotRow } from './pilot-dir'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/eval/src/cli.ts')
const KEY = 'sk-ant-api03-REESTIMATE-TEST-SECRET-24680'
const SEED = 'easy-en-coffee-us'
const SUITE_VERSION = createExtractSuite({ only: SEED, kinds: ['text'] }).version

let dir: string
let server: Server | undefined
let requests = 0
let connections = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-eval-reestimate-'))
  requests = 0
  connections = 0
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
})

async function countingApi(): Promise<string> {
  server = createServer((_req, res) => {
    requests += 1
    res.writeHead(500)
    res.end()
  })
  server.on('connection', () => {
    connections += 1
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`
}

function runCli(args: string[], env: Record<string, string | undefined>) {
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
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function snapshot(target: string): string {
  const lines = readdirSync(target, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name)
    const stat = statSync(path)
    const digest = entry.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'dir'
    return `${relative(target, path)}|${stat.size}|${stat.mtimeMs}|${digest}`
  })
  return [`root|${statSync(target).mtimeMs}`, ...lines.sort()].join('\n')
}

function quietIo(overrides: Partial<CliIo> = {}): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, now: () => Date.UTC(2026, 10, 11, 9, 30, 15), ...overrides } }
}

const SMALL_ROWS: PilotRow[] = [
  { model: HAIKU, kind: 'text', group: 'a', input: 1000, output: 100 },
  { model: HAIKU, kind: 'text', group: 'b', input: 2000, output: 300 },
]

const SMALL_PLAN = ['extract', '--only', SEED, '--kinds', 'text', '--models', HAIKU, '--reps', '1']

function commandIn(text: string): string[] {
  const line = text.split('\n').find((entry) => entry.startsWith('  pnpm eval extract --yes'))
  if (line === undefined) throw new Error(`no command in:\n${text}`)
  return line.trim().replace('pnpm eval ', '').split(' ')
}

function printedBudget(text: string): number {
  const match = /SUGGESTED BUDGET: \$(\d+(?:\.\d+)?)/u.exec(text)
  if (match === null) throw new Error(`no budget in:\n${text}`)
  return Number(match[1])
}

describe('eval extract --reestimate: process level', () => {
  it('prints the projection and sends nothing, even with a key and a reachable API, and writes nothing into the results directory', async () => {
    const baseURL = await countingApi()
    const results = join(dir, 'pilot')
    writePilotDir(results, SMALL_ROWS, { suiteVersion: SUITE_VERSION })
    const before = snapshot(results)
    const result = await runCli([...SMALL_PLAN, '--reestimate', results], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(requests).toBe(0)
    expect(connections).toBe(0)
    expect(result.stdout).not.toContain(KEY)
    expect(result.stdout).toContain(`pilot: ${results}`)
    expect(result.stdout).toContain('SUGGESTED BUDGET: $')
    expect(result.stdout).toContain('Nothing was sent and nothing was written.')
    expect(snapshot(results)).toBe(before)
    expect(readdirSync(dir)).toEqual(['pilot'])
  })

  it('needs no key and no network', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(results, SMALL_ROWS, { suiteVersion: SUITE_VERSION })
    const result = await runCli([...SMALL_PLAN, '--reestimate', results], { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('SUGGESTED BUDGET: $')
  })

  it('exits 2 with a message and the usage text when the directory is not a results directory, and sends nothing', async () => {
    const baseURL = await countingApi()
    const empty = join(dir, 'empty')
    writeFileSync(join(dir, 'file.txt'), 'x')
    for (const target of [empty, join(dir, 'file.txt'), join(dir, 'missing')]) {
      const result = await runCli([...SMALL_PLAN, '--reestimate', target], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL })
      expect(result.code, target).toBe(2)
      expect(result.stderr, target).toContain('usage: pnpm eval extract [options]')
      expect(result.stderr, target).toMatch(/error: .*(does not exist|is not a directory|is not a rill eval results directory)/u)
      expect(result.stdout, target).toBe('')
    }
    expect(requests).toBe(0)
    expect(connections).toBe(0)
  })
})

describe('eval extract --reestimate: arguments', () => {
  it('is documented in the usage text', () => {
    expect(USAGE).toContain('--reestimate <dir>')
    expect(USAGE).toContain('no key, no network, writes nothing')
  })

  it('reads the directory and keeps the plan flags', () => {
    expect(parseCli(['extract', '--reestimate', 'some/dir'])).toMatchObject({
      reestimate: 'some/dir',
      yes: false,
      pilot: false,
      reps: 3,
      concurrency: 4,
      maxOutputTokens: 16_000,
    })
    expect(parseCli(['extract', '--reestimate', 'd', '--models', HAIKU, '--reps', '2', '--kinds', 'text,pdf', '--only', 'adv-', '--max-output-tokens', '4000', '--concurrency', '2'])).toMatchObject({
      models: [HAIKU],
      reps: 2,
      kinds: ['text', 'pdf'],
      only: 'adv-',
      maxOutputTokens: 4000,
      concurrency: 2,
    })
    expect(parseCli(['extract']).reestimate).toBeUndefined()
  })

  it.each([
    ['yes', ['--yes']],
    ['pilot', ['--pilot']],
    ['baselines', ['--baselines']],
    ['budget-usd', ['--budget-usd', '1']],
    ['effort', ['--effort', 'low']],
    ['max-call-seconds', ['--max-call-seconds', '30']],
    ['max-attempts', ['--max-attempts', '2']],
    ['seed', ['--seed', '3']],
    ['out', ['--out', 'x']],
    ['allow-base-url', ['--allow-base-url']],
  ] as const)('names --%s as an option that cannot be combined with --reestimate', (name, extra) => {
    expect(() => parseCli(['extract', '--reestimate', 'd', ...extra])).toThrow(`--reestimate cannot be combined with --${name}`)
  })

  it.each([
    [['extract', '--reestimate', 'd', '--yes']],
    [['extract', '--reestimate', 'd', '--pilot']],
    [['extract', '--reestimate', 'd', '--baselines']],
    [['extract', '--reestimate', 'd', '--budget-usd', '1']],
    [['extract', '--reestimate', 'd', '--effort', 'low']],
    [['extract', '--reestimate', 'd', '--max-call-seconds', '30']],
    [['extract', '--reestimate', 'd', '--max-attempts', '2']],
    [['extract', '--reestimate', 'd', '--seed', '3']],
    [['extract', '--reestimate', 'd', '--out', 'x']],
    [['extract', '--reestimate', 'd', '--allow-base-url']],
    [['extract', '--reestimate', '']],
    [['extract', '--reestimate', '  ']],
    [['extract', '--reestimate']],
    [['extract', '--reestimate', 'd', '--reps', '0']],
  ] as const)('rejects %j with a usage error', (args) => {
    expect(() => parseCli(args)).toThrow(UsageError)
  })
})

describe('eval extract --reestimate: output', () => {
  it('prints the per-model tables, the totals, the suggested budget and a command that runs the same plan', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(
      results,
      [
        { model: HAIKU, kind: 'text', group: 'a', input: 600, output: 100 },
        { model: HAIKU, kind: 'text', group: 'b', input: 800, output: 300 },
        { model: HAIKU, kind: 'pdf', group: 'a', input: 2400, output: 500 },
      ],
      { suiteVersion: SUITE_VERSION },
    )
    const { io, out, err } = quietIo()
    const args = ['extract', '--reestimate', results, '--models', `${HAIKU},${SONNET}`, '--reps', '2', '--kinds', 'text,pdf', '--only', 'easy-en-coffee-us,adv-en-ignore-instructions', '--max-output-tokens', '4000', '--concurrency', '2']
    expect(await main(args, io)).toBe(0)
    expect(err.join('')).toBe('')
    const text = out.join('')
    expect(text).toContain('2 seeds x 2 kinds (text, pdf) = 4 cases, 2 reps, 2 models: 16 calls')
    expect(text).toMatch(/^claude-haiku-5-5\n {2}kind {3}calls {2}pilot n {2}input tokens mean \/ p90/mu)
    expect(text).toContain('measured')
    expect(text).toContain('FALLBACK: pilot mean of the model across kinds')
    expect(text).toContain('FALLBACK: first assumption, no pilot data')
    expect(text).toContain(`${SONNET} has no usage rows in the pilot, so it cannot be projected`)
    expect(text).toContain('output tokens per call in the pilot, thinking included: mean 300')
    expect(text).toContain('(1.5 x the 200 the first estimate assumed)')
    expect(text).toContain('pilot calls: 3 (ok 3, truncated 0, refused 0, invalid 0)')
    expect(text).not.toContain('The pilot ran suite version')
    const config = parseCli(commandIn(text))
    expect(config).toMatchObject({ yes: true, models: [HAIKU, SONNET], reps: 2, kinds: ['text', 'pdf'], only: ['easy-en-coffee-us', 'adv-en-ignore-instructions'], maxOutputTokens: 4000, concurrency: 2, pilot: false, effort: undefined })
    expect(config.budgetUsd).toBe(printedBudget(text))
    expect(text.trimEnd().split('\n').at(-1)?.trim()).toMatch(/^pnpm eval extract --yes /u)
  })

  it('prints the budget the formula gives for a plan small enough to check by hand', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(results, SMALL_ROWS, { suiteVersion: SUITE_VERSION })
    const { io, out } = quietIo()
    expect(await main([...SMALL_PLAN, '--reestimate', results], io)).toBe(0)
    const suite = createExtractSuite({ only: SEED, kinds: ['text'] })
    const worst = worstCaseCallUsd(suite, suite.cases()[0] as Parameters<typeof worstCaseCallUsd>[1], HAIKU, 16_000) as number
    const mean = (150 + 350) / 2 / 1e6
    const p90 = (1900 * 0.1 + 280 * 0.5) / 1e6
    expect(printedBudget(out.join(''))).toBe(roundUpBudget(Math.max(1.3 * p90, mean + worst)))
  })

  it('repeats the effort the pilot ran with and leaves out the default one', async () => {
    const high = join(dir, 'high')
    writePilotDir(high, SMALL_ROWS, { suiteVersion: SUITE_VERSION, effort: 'high' })
    const first = quietIo()
    await main([...SMALL_PLAN, '--reestimate', high], first.io)
    expect(commandIn(first.out.join(''))).toContain('--effort')
    expect(parseCli(commandIn(first.out.join(''))).effort).toBe('high')
    const low = join(dir, 'low')
    writePilotDir(low, SMALL_ROWS, { suiteVersion: SUITE_VERSION, effort: 'low' })
    const second = quietIo()
    await main([...SMALL_PLAN, '--reestimate', low], second.io)
    expect(commandIn(second.out.join(''))).not.toContain('--effort')
  })

  it('suggests a lower --max-output-tokens with the consequence and a second command that parses back', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(
      results,
      [
        { model: OPUS, kind: 'text', group: 'a', input: 600, output: 300 },
        { model: OPUS, kind: 'text', group: 'b', input: 600, output: 400 },
        { model: OPUS, kind: 'text', group: 'c', input: 600, output: 500 },
      ],
      { suiteVersion: SUITE_VERSION },
    )
    const { io, out } = quietIo()
    expect(await main(['extract', '--only', SEED, '--kinds', 'text', '--models', OPUS, '--reps', '1', '--reestimate', results], io)).toBe(0)
    const text = out.join('')
    expect(text).toContain('At --max-output-tokens 16000 the budget guard holds back')
    expect(text).toContain('a call that needs more than 2000 output tokens is cut off and recorded as truncated')
    expect(text).toContain('with the lower cap of --max-output-tokens 2000 instead:')
    const lines = text.split('\n').filter((entry) => entry.startsWith('  pnpm eval extract --yes'))
    expect(lines).toHaveLength(2)
    const [full, lower] = lines.map((line) => parseCli(line.trim().replace('pnpm eval ', '').split(' ')))
    expect(full).toMatchObject({ maxOutputTokens: 16_000, models: [OPUS] })
    expect(lower).toMatchObject({ maxOutputTokens: 2000, models: [OPUS] })
    expect((lower?.budgetUsd ?? 0) < (full?.budgetUsd ?? 0)).toBe(true)
  })

  it('warns when the suite version of the pilot differs from this checkout', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(results, SMALL_ROWS)
    const { io, out } = quietIo()
    expect(await main([...SMALL_PLAN, '--reestimate', results], io)).toBe(0)
    expect(out.join('')).toContain(`The pilot ran suite version 1.1.2.2-p20261103-aaaaaaaaaaaa-bbbbbbbbbbbb; this checkout has ${SUITE_VERSION}.`)
  })

  it('shows n/a and no command for a model without a price, and still exits 0 like the plan mode', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(
      results,
      [
        { model: 'claude-mystery-9', kind: 'text', group: 'a', input: 600, output: 100 },
        { model: 'claude-mystery-9', kind: 'text', group: 'b', input: 600, output: 100 },
      ],
      { suiteVersion: SUITE_VERSION },
    )
    const { io, out } = quietIo()
    expect(await main(['extract', '--only', SEED, '--kinds', 'text', '--models', 'claude-mystery-9', '--reps', '1', '--reestimate', results], io)).toBe(0)
    const text = out.join('')
    expect(text).toContain('SUGGESTED BUDGET: n/a (needs a price for every model)')
    expect(text).toContain('No price in the price table for claude-mystery-9')
    expect(text).toContain('There is no command to print without a budget')
    expect(text).not.toContain('pnpm eval extract --yes')
  })

  it('resolves a relative directory from the directory pnpm was started in', async () => {
    const results = join(dir, 'pilot')
    writePilotDir(results, SMALL_ROWS, { suiteVersion: SUITE_VERSION })
    const found = quietIo({ env: { INIT_CWD: dir } })
    expect(await main([...SMALL_PLAN, '--reestimate', 'pilot'], found.io)).toBe(0)
    expect(found.out.join('')).toContain(`pilot: ${results}`)
    const missing = quietIo({ env: { INIT_CWD: join(dir, 'elsewhere') } })
    expect(await main([...SMALL_PLAN, '--reestimate', 'pilot'], missing.io)).toBe(2)
    expect(missing.err.join('')).toContain(`${join(dir, 'elsewhere', 'pilot')} does not exist`)
  })

  it('exits 2 for a directory that is not a results directory, and for an unusable one', async () => {
    const empty = join(dir, 'empty')
    const failedOnly = join(dir, 'nothing')
    writePilotDir(failedOnly, [{ model: HAIKU, kind: 'text', group: 'a', input: 0, output: 0 }], { suiteVersion: SUITE_VERSION })
    for (const target of [empty, dir, failedOnly]) {
      const { io, out, err } = quietIo()
      expect(await main([...SMALL_PLAN, '--reestimate', target], io), target).toBe(2)
      expect(out.join('')).toBe('')
      expect(err.join('')).toMatch(/error: /u)
    }
  })

  it('stays a usage error for a bad plan flag and reads no file for it', async () => {
    const { io, err } = quietIo()
    expect(await main(['extract', '--reestimate', join(dir, 'x'), '--only', 'zzz-nothing'], io)).toBe(2)
    expect(err.join('')).toContain('--only: no seed id contains "zzz-nothing"')
  })
})
