import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MODEL, PROVIDER_IDS, providerDescriptor, type ProviderId } from '@rill/llm'
import { RillClient, RillError, type MethodParams } from '@rill/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageError, chooseLlm } from '../src/cli-config'
import { MARKER_KEYS, MARKER_VALUES, childEnvironment, isolateKeyEnvironment, mentionsAny } from './llm-env'
import { waitFor } from './process'

isolateKeyEnvironment()

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')
const TOKEN = 'cli-llm-token-0123456789abcdef'

const OTHER_PROVIDERS = [
  { id: 'openai', model: 'gpt-6.1-sol', keyEnv: 'OPENAI_API_KEY' },
  { id: 'gemini', model: 'gemini-3.8-flash', keyEnv: 'GEMINI_API_KEY' },
  { id: 'grok', model: 'grok-4.7', keyEnv: 'XAI_API_KEY' },
  { id: 'meta', model: 'muse-spark-1.3', keyEnv: 'META_API_KEY' },
] as const

describe('chooseLlm', () => {
  it('defaults to Anthropic and its default model, and builds the provider even without a key', () => {
    const chosen = chooseLlm({ env: {} })
    expect(chosen.llm?.name).toBe('anthropic')
    expect(chosen.info).toEqual({ configured: [], active: { provider: 'anthropic', model: DEFAULT_MODEL } })
  })

  it('uses the Anthropic model that was asked for, and accepts an id the model table does not list', () => {
    expect(chooseLlm({ model: 'claude-haiku-5-5', env: {} }).info.active).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' })
    expect(chooseLlm({ provider: 'anthropic', model: 'claude-future-9-9', env: {} }).info.active).toEqual({ provider: 'anthropic', model: 'claude-future-9-9' })
  })

  it('reports which providers have a key in the environment it is given', () => {
    const chosen = chooseLlm({ env: { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' } })
    expect(chosen.info.configured).toEqual(['anthropic', 'gemini'])
  })

  it.each(OTHER_PROVIDERS)('builds the $id provider from the variable $keyEnv', ({ id, model, keyEnv }) => {
    const chosen = chooseLlm({ provider: id, model, env: { [keyEnv]: 'a-key-value' } })
    expect(chosen.llm?.name).toBe(id)
    expect(chosen.llm?.capabilities).toBeDefined()
    expect(chosen.info).toEqual({ configured: [id], active: { provider: id, model } })
  })

  it.each(OTHER_PROVIDERS)('leaves the LLM unconfigured when $id has no key, without an error', ({ id, model }) => {
    for (const env of [{}, { [providerDescriptor(id).keyEnv]: '' }, { [providerDescriptor(id).keyEnv]: '  ' }]) {
      const chosen = chooseLlm({ provider: id, model, env })
      expect(chosen.llm).toBeUndefined()
      expect(chosen.info).toEqual({ configured: [], active: null })
    }
  })

  it('does not use another provider key for the chosen provider', () => {
    const chosen = chooseLlm({ provider: 'openai', model: 'gpt-6.1-sol', env: { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' } })
    expect(chosen.llm).toBeUndefined()
    expect(chosen.info).toEqual({ configured: ['anthropic', 'gemini'], active: null })
  })

  it('needs a model for a provider other than Anthropic, and lists the known models', () => {
    for (const { id, model } of OTHER_PROVIDERS) {
      const act = () => chooseLlm({ provider: id, env: {} })
      expect(act).toThrow(UsageError)
      expect(act).toThrow(`--llm-provider ${id} needs --llm-model`)
      expect(act).toThrow(model)
    }
  })

  it('rejects an unknown provider with the list of known ones', () => {
    for (const bad of ['ollama', 'OpenAI', '', 'openai:gpt-6.1-sol', 'meta ']) {
      const act = () => chooseLlm({ provider: bad, model: 'x', env: {} })
      expect(act, bad).toThrow(UsageError)
      expect(act, bad).toThrow('--llm-provider must be one of anthropic, openai, gemini, grok, meta')
    }
  })

  it('rejects an unknown model of a known provider with the list of known models, even without a key', () => {
    for (const env of [{}, { OPENAI_API_KEY: 'a-key-value' }]) {
      const act = () => chooseLlm({ provider: 'openai', model: 'gpt-9-nope', env })
      expect(act).toThrow(UsageError)
      expect(act).toThrow(/unknown model 'gpt-9-nope'/)
      expect(act).toThrow('gpt-6.1-sol')
    }
  })

  it.each(['meta:muse-spark-1.3-contributor', 'openai:gpt-6.1-sol-contributor', 'anthropic:claude-opus-5-5-contributor'])('refuses the contributor model %s', (spec) => {
    const [provider, model] = spec.split(':') as [string, string]
    for (const env of [{}, { ...MARKER_KEYS }]) {
      const act = () => chooseLlm({ provider, model, env })
      expect(act).toThrow(UsageError)
      expect(act).toThrow(/contributor/)
    }
  })

  it('ignores --llm-no-fallback for a provider that has no fallback', () => {
    const chosen = chooseLlm({ provider: 'grok', model: 'grok-4.7', noFallback: true, env: { XAI_API_KEY: 'a-key-value' } })
    expect(chosen.llm?.name).toBe('grok')
    expect(chooseLlm({ noFallback: true, env: {} }).llm?.name).toBe('anthropic')
  })

  it('never puts a key in an error message or in the result', () => {
    const results = [
      () => chooseLlm({ provider: 'openai', model: 'gpt-9-nope', env: { ...MARKER_KEYS } }),
      () => chooseLlm({ provider: 'nope', model: 'x', env: { ...MARKER_KEYS } }),
      () => chooseLlm({ provider: 'meta', env: { ...MARKER_KEYS } }),
      () => chooseLlm({ provider: 'meta', model: 'muse-spark-1.3-contributor', env: { ...MARKER_KEYS } }),
    ]
    for (const act of results) {
      try {
        act()
      } catch (error) {
        expect(mentionsAny(String((error as Error).message), [...MARKER_VALUES, 'MARKER'])).toBeUndefined()
      }
    }
    const info = JSON.stringify(chooseLlm({ provider: 'gemini', model: 'gemini-3.8-flash', env: { ...MARKER_KEYS } }).info)
    expect(mentionsAny(info, [...MARKER_VALUES, 'MARKER'])).toBeUndefined()
  })

  it('does not read the process environment', () => {
    process.env.OPENAI_API_KEY = 'would-be-a-real-key'
    expect(chooseLlm({ provider: 'openai', model: 'gpt-6.1-sol', env: {} }).llm).toBeUndefined()
  })
})

let dir: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-cli-llm-provider-'))
})

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

function runSync(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, encoding: 'utf8', env: childEnvironment(env) })
}

async function startServe(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'serve', '--db', join(dir, 'serve.db'), '--allow', dir, ...args], {
    cwd: root,
    env: childEnvironment({ RILL_TOKEN: TOKEN, ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  await waitFor(() => stdout.includes('\n') || child.exitCode !== null)
  const listening = JSON.parse(stdout.split('\n')[0]!) as { port: number }
  const frames: string[] = []
  const client = await RillClient.connect(`ws://127.0.0.1:${listening.port}/`, TOKEN, {
    socketFactory: (target, protocols) => {
      const socket = new WebSocket(target, protocols)
      socket.addEventListener('message', (event) => frames.push(String(event.data)))
      return socket as never
    },
  })
  return { child, client, frames, output: () => `${stdout}\n${stderr}` }
}

const planParams = (): MethodParams<'plan'> => ({ planId: 'p-1', text: 'Wait a little', turns: [], attachments: [], effort: 'low' })

describe('rill-engine help text and flag errors', () => {
  it('lists --llm-provider, the five providers and the variable that holds each key', () => {
    const result = runSync(['--db', join(dir, 'h.db')])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--llm-provider')
    for (const id of PROVIDER_IDS) {
      const line = result.stderr.split('\n').find((text) => text.trimStart().startsWith(`${id} `))
      expect(line, id).toBeDefined()
      expect(line, id).toContain(providerDescriptor(id).keyEnv)
    }
    expect(result.stderr).toContain('defaults to claude-opus-5-5')
  })

  it.each([
    [['--llm-provider', 'ollama'], '--llm-provider must be one of anthropic, openai, gemini, grok, meta'],
    [['--llm-provider', 'openai'], '--llm-provider openai needs --llm-model'],
    [['--llm-provider', 'openai', '--llm-model', 'gpt-9-nope'], "unknown model 'gpt-9-nope'"],
    [['--llm-provider', 'meta', '--llm-model', 'muse-spark-1.3-contributor'], 'contributor'],
    [['--llm-provider', 'anthropic', '--llm-model', 'claude-opus-5-5-contributor'], 'contributor'],
  ])('exits 2 with the usage for %j', (flags, text) => {
    const result = runSync(['recover', '--db', join(dir, 'x.db'), ...flags], { OPENAI_API_KEY: MARKER_KEYS.OPENAI_API_KEY })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(text)
    expect(result.stderr).toContain('usage:')
    expect(mentionsAny(result.stderr, [...MARKER_VALUES])).toBeUndefined()
  })
})

describe('rill-engine serve with a chosen provider', () => {
  it('starts with no model provider when the key of a non-Anthropic provider is missing: llmModels says so and plan is LLM_UNAVAILABLE', async () => {
    const { client, output } = await startServe(['--llm-provider', 'grok', '--llm-model', 'grok-4.7'], { ANTHROPIC_API_KEY: MARKER_KEYS.ANTHROPIC_API_KEY })
    const models = await client.request('llmModels', {})
    expect(models.active).toBeNull()
    expect(models.providers.filter((entry) => entry.configured).map((entry) => entry.id)).toEqual(['anthropic'])
    const error = await client.request('plan', planParams()).then(
      () => undefined,
      (caught: unknown) => caught as RillError,
    )
    expect(error?.code).toBe('LLM_UNAVAILABLE')
    expect(mentionsAny(output(), [...MARKER_VALUES])).toBeUndefined()
  })

  it('keeps the Anthropic behaviour without a key: the provider exists, the model is active, nothing is configured', async () => {
    const { client } = await startServe([])
    const models = await client.request('llmModels', {})
    expect(models.active).toEqual({ provider: 'anthropic', model: DEFAULT_MODEL })
    expect(models.providers.every((entry) => !entry.configured)).toBe(true)
  })

  it.each(OTHER_PROVIDERS)('serves $id with its key: active model and flags, and no key anywhere in the output', async ({ id, model, keyEnv }) => {
    const { client, frames, output } = await startServe(['--llm-provider', id, '--llm-model', model], { ...MARKER_KEYS, ANTHROPIC_AUTH_TOKEN: 'sk-ant-MARKER-token-77' })
    const models = await client.request('llmModels', {})
    expect(models.active).toEqual({ provider: id as ProviderId, model })
    expect(models.providers.every((entry) => entry.configured)).toBe(true)
    expect(models.models.some((entry) => entry.provider === id && entry.id === model)).toBe(true)
    expect(providerDescriptor(id).keyEnv).toBe(keyEnv)
    client.close()
    expect(mentionsAny([...frames, output()].join('\n'), [...MARKER_VALUES, 'MARKER'])).toBeUndefined()
  })
})

describe('rill-engine run with llm.extract and a provider without a key', () => {
  it('fails the step with the provider-neutral message', () => {
    const file = join(dir, 'wf.json')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        name: 'extract',
        nodes: [
          { id: 't1', type: 'trigger.manual@1', config: {} },
          { id: 'ex', type: 'llm.extract@1', config: { text: 'Cafe 12.50', fields: [{ name: 'amount', type: 'number' }] } },
        ],
        edges: [{ from: 't1', to: 'ex' }],
      }),
    )
    const result = runSync(['run', file, '--db', join(dir, 'r.db'), '--allow', dir, '--llm-provider', 'grok', '--llm-model', 'grok-4.7'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('llm.extract needs an LLM provider; start the engine with --llm-provider and its key variable')
  })
})
