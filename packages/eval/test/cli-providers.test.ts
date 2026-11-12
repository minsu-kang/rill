import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replyOf as openaiReply } from '../../llm/test/openai-wire'
import { createFakeTransport } from '../../llm/test/fake-transport'
import { UsageError, main, parseCli, type CliIo } from '../src/cli'
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli-shared'
import { PRICE_TABLE_AS_OF } from '../src/pricing'
import { plannerMain, parsePlannerCli, plannerPlanText, plannerCommandLine } from '../src/suites/planner/cli'
import { oraclePlanner } from '../src/suites/planner/fakes'
import { offlineProvider } from './planner-helpers'
import type { EvalProviderOptions } from '../src/record'

const SEED = 'easy-en-coffee-us'
const ANTHROPIC_KEY = 'sk-ant-api03-MIXED-RUN-SECRET-11111'
const OPENAI_KEY = 'sk-openai-MIXED-RUN-SECRET-22222'
const XAI_KEY = 'xai-MIXED-RUN-SECRET-33333'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-eval-cli-providers-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const quietIo = (overrides: Partial<CliIo> = {}): { io: CliIo; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, now: () => Date.UTC(2026, 10, 13, 9, 30, 15), ...overrides } }
}

const MIXED = 'claude-haiku-5-5,openai:gpt-6.1-sol,grok:grok-4.7'

describe('extract: model specs in --models', () => {
  it('accepts Claude ids and provider:model specs', () => {
    expect(parseCli(['extract', '--models', MIXED]).models).toEqual(['claude-haiku-5-5', 'openai:gpt-6.1-sol', 'grok:grok-4.7'])
  })

  it('refuses an unknown provider, an unknown model and a contributor model as usage errors', () => {
    expect(() => parseCli(['extract', '--models', 'mistral:large'])).toThrow(UsageError)
    expect(() => parseCli(['extract', '--models', 'openai:gpt-9'])).toThrow(/unknown model 'gpt-9' for OpenAI/)
    expect(() => parseCli(['extract', '--models', 'meta:muse-spark-1.3-contributor'])).toThrow(/contributor/)
  })

  it('keeps the old complaint about an odd bare id', () => {
    expect(() => parseCli(['extract', '--models', 'Not A Model'])).toThrow('--models must list model ids, got: Not A Model')
  })
})

describe('extract --dry plan across providers', () => {
  const plan = async (models = MIXED, env: Record<string, string> = {}) => {
    const { io, out, err } = quietIo({ env })
    const code = await main(['extract', '--only', SEED, '--kinds', 'text,pdf', '--reps', '1', '--models', models], io)
    return { code, out: out.join(''), err: err.join('') }
  }

  it('prints the providers, the keys they need and the hosts, without sending anything', async () => {
    const network = vi.fn(() => Promise.reject(new Error('no network in tests')))
    vi.stubGlobal('fetch', network)
    const { code, out } = await plan(MIXED, { OPENAI_API_KEY: OPENAI_KEY })
    expect(code).toBe(EXIT_OK)
    expect(out).toContain('OpenAI: OPENAI_API_KEY set, api.openai.com')
    expect(out).toContain('xAI Grok: XAI_API_KEY not set, api.x.ai')
    expect(out).toContain('Anthropic: ANTHROPIC_API_KEY not set, api.anthropic.com')
    expect(out).toContain('Nothing was sent.')
    expect(network).not.toHaveBeenCalled()
  })

  it('shows calls, typical and worst-case cost per model and marks the soft cap', async () => {
    const { out } = await plan()
    expect(out).toMatch(/openai:gpt-6\.1-sol: 2 calls, typical \$[\d.]+, worst case \$[\d.]+/)
    expect(out).toMatch(/claude-haiku-5-5: 2 calls, typical \$[\d.]+, worst case \$[\d.]+/)
    expect(out).toMatch(/grok:grok-4\.7: 1 call, typical \$[\d.]+, worst case \$[\d.]+ \(soft cap/)
    expect(out).toContain('prices as of ' + PRICE_TABLE_AS_OF)
  })

  it('says which cases a model cannot take, and counts them out of the calls', async () => {
    const { out } = await plan()
    expect(out).toContain('grok:grok-4.7 reads no PDF files: 1 case not run (n/a)')
    expect(out).toMatch(/calls: 5 \(.*minus 1 not run/)
  })

  it('asks for every key in the command it prints, and keeps the specs in --models', async () => {
    const { out } = await plan()
    expect(out).toContain('needs ANTHROPIC_API_KEY, OPENAI_API_KEY and XAI_API_KEY in the environment')
    expect(out).toContain(`--models ${MIXED}`)
  })

  it('stays as it was for Claude models alone: no provider block and the single-key sentence', async () => {
    const { out } = await plan('claude-haiku-5-5')
    expect(out).not.toContain('providers (')
    expect(out).not.toContain('capability notes')
    expect(out).toContain('(needs ANTHROPIC_API_KEY in the environment;')
  })
})

describe('extract --yes across providers', () => {
  const args = (models: string, ...extra: string[]) => ['extract', '--yes', '--only', SEED, '--kinds', 'text,pdf', '--reps', '1', '--budget-usd', '1', '--models', models, ...extra]

  it('names every missing key before anything is sent, and creates no output directory', async () => {
    const network = vi.fn(() => Promise.reject(new Error('no network in tests')))
    vi.stubGlobal('fetch', network)
    const out = join(dir, 'out')
    const { io, err } = quietIo({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } })
    expect(await main(args(MIXED, '--out', out), io)).toBe(EXIT_ERROR)
    const text = err.join('')
    expect(text).toContain('OPENAI_API_KEY')
    expect(text).toContain('XAI_API_KEY')
    expect(text).toContain('openai:gpt-6.1-sol')
    expect(text).not.toContain(ANTHROPIC_KEY)
    expect(network).not.toHaveBeenCalled()
    expect(existsSync(out)).toBe(false)
  })

  it('names the right variable when one provider is the whole run', async () => {
    const { io, err } = quietIo({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } })
    expect(await main(args('openai:gpt-6.1-sol'), io)).toBe(EXIT_ERROR)
    expect(err.join('')).toContain('OPENAI_API_KEY is not set; --yes needs it in the environment')
  })

  it('runs an OpenAI-only run with the OpenAI key alone, sends to the OpenAI host, and scrubs the key', async () => {
    const transport = createFakeTransport()
    transport.script(openaiReply(false, 'completed', JSON.stringify({ amount: 12.5, date: '2026-01-02', vendor: 'Cafe' })))
    vi.stubGlobal('fetch', transport.fetch)
    const out = join(dir, 'run')
    const { io, out: stdout } = quietIo({ env: { OPENAI_API_KEY: OPENAI_KEY } })
    const code = await main(args('openai:gpt-6.1-sol', '--out', out), io)
    expect(code).toBe(EXIT_OK)
    expect(transport.requests.length).toBe(2)
    expect(transport.requests.every((request) => request.url.startsWith('https://api.openai.com/'))).toBe(true)
    expect(transport.requests.every((request) => request.headers['authorization'] === `Bearer ${OPENAI_KEY}`)).toBe(true)
    const text = stdout.join('')
    expect(text).toContain('api.openai.com')
    expect(text).not.toContain(OPENAI_KEY)
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    for (const file of files) expect(readFileSync(join(file.parentPath, file.name), 'utf8')).not.toContain(OPENAI_KEY)
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('- Providers: openai (gpt-6.1-sol)')
    const state = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { providers: Record<string, string> }
    expect(state.providers).toEqual({ 'openai:gpt-6.1-sol': 'openai' })
  })

  it('does not send the PDF case to a model that reads none', async () => {
    const transport = createFakeTransport()
    transport.script(openaiReply(false, 'completed', JSON.stringify({ amount: 12.5, date: '2026-01-02', vendor: 'Cafe' })))
    vi.stubGlobal('fetch', transport.fetch)
    const out = join(dir, 'grok')
    const { io, out: stdout } = quietIo({ env: { XAI_API_KEY: XAI_KEY } })
    await main(args('grok:grok-4.7', '--out', out), io)
    expect(transport.requests.length).toBeLessThanOrEqual(1)
    expect(stdout.join('')).not.toContain(XAI_KEY)
    const report = existsSync(join(out, 'report.md')) ? readFileSync(join(out, 'report.md'), 'utf8') : ''
    expect(report).toContain('Not run (n/a)')
  })
})

describe('providerPlanLines', () => {
  it('notes the effort a model collapses, from the capabilities of the model', async () => {
    const { resolveModelSpecs } = await import('../src/providers')
    const { providerPlanLines } = await import('../src/cli-providers')
    const { estimateRun } = await import('../src/runner')
    const { createExtractSuite } = await import('../src/suites/extract/suite')
    const infos = resolveModelSpecs('--models', ['openai:gpt-6.1-sol', 'gemini:gemini-3.8-flash', 'grok:grok-4.5'])
    const suite = createExtractSuite({ only: SEED, kinds: ['text'] })
    const estimate = estimateRun({ suite, models: infos.map((info) => info.spec), reps: 1 })
    const lines = providerPlanLines({ infos, env: {}, suite, estimate, reps: 1, maxOutputTokens: 16_000, efforts: ['xhigh'], anthropicHost: 'api.anthropic.com' }).join('\n')
    expect(lines).toContain('gemini:gemini-3.8-flash: effort xhigh runs as high')
    expect(lines).toContain('grok:grok-4.5: effort xhigh runs as high')
    expect(lines).not.toContain('openai:gpt-6.1-sol: effort')
  })
})

describe('planner CLI across providers', () => {
  const NOW = Date.UTC(2026, 10, 13, 9, 30, 0)
  const harness = (env: Record<string, string>) => {
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
        makePlanner: oraclePlanner,
        createProvider: (options) => {
          providers.push(options)
          return offlineProvider()
        },
      },
    }
    return { io, out: () => out.join(''), err: () => err.join(''), providers }
  }

  it('accepts specs in --model and refuses unknown ones as usage errors', () => {
    expect(parsePlannerCli(['--model', 'claude-sonnet-5-5,grok:grok-4.7']).models).toEqual(['claude-sonnet-5-5', 'grok:grok-4.7'])
    expect(() => parsePlannerCli(['--model', 'mistral:large'])).toThrow(UsageError)
    expect(() => parsePlannerCli(['--model', 'gemini:gemini-9'])).toThrow(/unknown model 'gemini-9' for Google Gemini/)
  })

  it('prints per provider and model, leaves the PDF cases out for Grok and sends nothing', async () => {
    const h = harness({})
    expect(await plannerMain(['--model', 'claude-sonnet-5-5,grok:grok-4.7'], h.io)).toBe(EXIT_OK)
    const text = h.out()
    expect(text).toContain('xAI Grok: XAI_API_KEY not set, api.x.ai')
    expect(text).toMatch(/grok:grok-4\.7: 45 calls, typical \$[\d.]+, worst case \$[\d.]+ \(soft cap/)
    expect(text).toContain('grok:grok-4.7 reads no PDF files: 3 cases not run (n/a)')
    expect(text).toContain('needs ANTHROPIC_API_KEY and XAI_API_KEY in the environment')
    expect(h.providers).toHaveLength(0)
  })

  it('needs every key, and says which are missing before it builds a provider', async () => {
    const h = harness({ ANTHROPIC_API_KEY: ANTHROPIC_KEY })
    expect(await plannerMain(['--yes', '--budget-usd', '50', '--model', 'claude-sonnet-5-5,grok:grok-4.7'], h.io)).toBe(EXIT_ERROR)
    expect(h.err()).toContain('XAI_API_KEY')
    expect(h.err()).not.toContain('ANTHROPIC_API_KEY (')
    expect(h.providers).toHaveLength(0)
  })

  it('hands each provider its own key and its spec, and runs only the cases a model can take', async () => {
    const h = harness({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, XAI_API_KEY: XAI_KEY })
    const out = join(dir, 'run')
    expect(await plannerMain(['--yes', '--budget-usd', '500', '--model', 'claude-sonnet-5-5,grok:grok-4.7', '--out', out], h.io)).toBe(EXIT_OK)
    expect(h.providers).toHaveLength(93)
    expect(new Set(h.providers.filter((options) => options.model === 'grok:grok-4.7').map((options) => options.apiKey))).toEqual(new Set([XAI_KEY]))
    expect(new Set(h.providers.filter((options) => options.model === 'claude-sonnet-5-5').map((options) => options.apiKey))).toEqual(new Set([ANTHROPIC_KEY]))
    expect(h.out()).toContain('93 tasks planned')
    expect(h.out()).not.toContain(XAI_KEY)
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('- Providers: anthropic (claude-sonnet-5-5), grok (grok-4.7)')
    expect(report).toContain('Not run (n/a)')
  })

  it('prints a command that parses back to the same models', () => {
    const config = parsePlannerCli(['--model', 'claude-sonnet-5-5,grok:grok-4.7'])
    const line = plannerCommandLine(config, 1.5)
    expect(line).toContain('--model claude-sonnet-5-5,grok:grok-4.7')
    expect(plannerPlanText).toBeTypeOf('function')
  })

  it('keeps a usage error for a spec it cannot read', async () => {
    const h = harness({})
    expect(await plannerMain(['--model', 'mistral:large'], h.io)).toBe(EXIT_USAGE)
  })
})
