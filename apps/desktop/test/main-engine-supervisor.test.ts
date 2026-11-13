// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/main/config-store'
import {
  createEngineSupervisor,
  type ChildLike,
  type ClockLike,
  type EngineSupervisor,
  type ForkLike,
} from '../src/main/engine-supervisor'
import type { SecretStore, StoredConnection } from '../src/main/secret-store'
import type { EngineStatus, ProviderId } from '../src/shared/host-api'

const MARKER = 'SUPERVISOR-MARKER'
const KEY = `sk-ant-${MARKER}-key`
const OTHER_KEY = `sk-oai-${MARKER}-key`
const HOOK = `https://hooks.example.test/${MARKER}`
const USER_DATA = '/data/Rill'

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid: number
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killCalls = 0
  exited = false
  exitOnKill = true
  readonly posted: unknown[] = []
  postFails = false

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  postMessage(message: unknown): void {
    if (this.postFails) throw new Error(`post failed with ${KEY}`)
    this.posted.push(message)
  }

  kill(): boolean {
    this.killCalls++
    if (this.exitOnKill) queueMicrotask(() => this.exit(0))
    return true
  }

  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
  }

  listen(port: number, extra: Record<string, unknown> = {}): void {
    this.stdout.write(`${JSON.stringify({ type: 'listening', host: '127.0.0.1', port, protocol: 1, ...extra })}\n`)
  }
}

class ManualClock implements ClockLike {
  private time = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(run: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, run })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  pending(): number {
    return this.timers.size
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    await settle()
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.time = Math.max(this.time, due[1].at)
      due[1].run()
      await settle()
    }
    this.time = target
    await settle()
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface Fork {
  path: string
  args: string[]
  options: { env: Record<string, string>; cwd: string; stdio: string; serviceName: string }
  child: FakeChild
}

interface Setup {
  config?: Partial<AppConfig>
  providerKeys?: Partial<Record<ProviderId, string>>
  connections?: StoredConnection[]
  available?: boolean
  forkFails?: number
  processEnv?: Record<string, string | undefined>
  oauthConnections?: Array<{ name: 'google' | 'microsoft'; kind: 'google' | 'microsoft'; secret: string }>
}

function setup(options: Setup = {}) {
  const clock = new ManualClock()
  const forks: Fork[] = []
  const forceKills: ChildLike[] = []
  const statuses: EngineStatus[] = []
  const logs: string[] = []
  const config: AppConfig = { allowedFolders: [], provider: 'anthropic', model: undefined, openAtLogin: false, language: 'system', ...options.config }
  const keychain = { available: options.available ?? true }
  let failures = options.forkFails ?? 0
  const secrets = {
    encryptionAvailable: () => keychain.available,
    getProviderKey: async (provider: ProviderId) => options.providerKeys?.[provider],
    getConnections: async () => options.connections ?? [],
  } as unknown as SecretStore
  const fork: ForkLike = (path, args, forkOptions) => {
    if (failures > 0) {
      failures--
      throw new Error(`cannot fork with ${KEY}`)
    }
    const child = new FakeChild(1000 + forks.length)
    forks.push({ path, args, options: forkOptions as Fork['options'], child })
    return child
  }
  let tokenCounter = 0
  const supervisor: EngineSupervisor = createEngineSupervisor({
    fork,
    bundlePath: '/app/resources/engine/rill-engine.mjs',
    userData: USER_DATA,
    secrets,
    config: { get: async () => ({ ...config, allowedFolders: [...config.allowedFolders] }), update: async () => ({ before: config, after: config }) },
    clock,
    randomToken: () => `token-${String(++tokenCounter).padStart(16, '0')}`,
    forceKill: (child) => forceKills.push(child),
    ...(options.oauthConnections === undefined ? {} : { oauthConnections: () => options.oauthConnections! }),
    env: options.processEnv ?? { PATH: '/usr/bin', HOME: '/Users/test', LANG: 'en_US.UTF-8', ANTHROPIC_API_KEY: 'LEAK', OPENAI_API_KEY: 'LEAK', AWS_SECRET_ACCESS_KEY: 'LEAK', RILL_TOKEN: 'LEAK', RILL_CONNECTIONS: 'LEAK', USER: 'LEAK', SHELL: 'LEAK', TMPDIR: 'LEAK', NODE_OPTIONS: 'LEAK' },
    log: (message) => logs.push(message),
  })
  supervisor.onStatus((status) => statuses.push(status))
  return { supervisor, clock, forks, forceKills, statuses, logs, config, keychain, secrets }
}

const stoppers: EngineSupervisor[] = []

afterEach(async () => {
  for (const supervisor of stoppers.splice(0)) {
    await Promise.race([supervisor.stop(), new Promise((resolve) => setTimeout(resolve, 50))])
  }
})

async function started(options: Setup = {}) {
  const harness = setup(options)
  stoppers.push(harness.supervisor)
  const start = harness.supervisor.start()
  await settle()
  return { ...harness, start }
}

async function running(options: Setup = {}, port = 41000) {
  const harness = await started(options)
  harness.forks[0]!.child.listen(port)
  await harness.start
  return harness
}

describe('engine supervisor: arguments and environment', () => {
  it('forks the bundle with the exact arguments, the attachment folder allowed first, and a private folder as working directory', async () => {
    const { forks } = await started({ config: { allowedFolders: ['/Users/test/Docs', '/Users/test/Receipts'], provider: 'anthropic', model: 'claude-haiku-5-5' } })
    expect(forks).toHaveLength(1)
    expect(forks[0]!.path).toBe('/app/resources/engine/rill-engine.mjs')
    expect(forks[0]!.args).toEqual([
      'serve', '--db', `${USER_DATA}/rill.db`, '--port', '0', '--attachments-dir', `${USER_DATA}/attachments`, '--shutdown-timeout', '8000',
      '--llm-provider', 'anthropic', '--llm-model', 'claude-haiku-5-5',
      '--allow', `${USER_DATA}/attachments`, '--allow', '/Users/test/Docs', '--allow', '/Users/test/Receipts',
    ])
    expect(forks[0]!.options).toMatchObject({ cwd: USER_DATA, stdio: 'pipe', serviceName: 'rill-engine' })
  })

  it('leaves out --llm-model when there is none, and allows only attachments without chosen folders', async () => {
    const { forks } = await started()
    expect(forks[0]!.args).toEqual([
      'serve', '--db', `${USER_DATA}/rill.db`, '--port', '0', '--attachments-dir', `${USER_DATA}/attachments`, '--shutdown-timeout', '8000',
      '--llm-provider', 'anthropic', '--allow', `${USER_DATA}/attachments`,
    ])
  })

  it('passes the token, the key of the chosen provider only, the connections and three variables of the main process, nothing else', async () => {
    const connections: StoredConnection[] = [
      { name: 'team', kind: 'slack', secret: HOOK },
      { name: 'api', kind: 'http', secret: OTHER_KEY },
    ]
    const { forks } = await started({ providerKeys: { anthropic: KEY, openai: OTHER_KEY }, connections })
    const env = forks[0]!.options.env
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      LANG: 'en_US.UTF-8',
      RILL_TOKEN: 'token-0000000000000001',
      ANTHROPIC_API_KEY: KEY,
      RILL_CONNECTIONS: JSON.stringify({ team: { secret: HOOK, kind: 'slack' }, api: { secret: OTHER_KEY, kind: 'http' } }),
    })
    expect(Object.values(env)).not.toContain('LEAK')
    expect(forks[0]!.args.join(' ')).not.toContain(MARKER)
    expect(forks[0]!.args.join(' ')).not.toContain('token-')
  })

  it('hands a custom connection to the engine as an http connection with its structured secret, and nothing in the arguments', async () => {
    const secret = JSON.stringify({ rillAuth: 1, type: 'bearer', token: `custom-${MARKER}` })
    const { forks } = await started({ connections: [{ name: 'My API', kind: 'http', secret, authType: 'bearer' }] })
    expect(JSON.parse(forks[0]!.options.env.RILL_CONNECTIONS!)).toEqual({ 'My API': { secret, kind: 'http' } })
    expect(forks[0]!.args.join(' ')).not.toContain(MARKER)
  })

  it('uses the variable of the chosen provider, and no key variable when the provider has no key', async () => {
    const openai = await started({ config: { provider: 'openai', model: 'gpt-6.1-sol' }, providerKeys: { anthropic: KEY, openai: OTHER_KEY } })
    expect(openai.forks[0]!.options.env.OPENAI_API_KEY).toBe(OTHER_KEY)
    expect(openai.forks[0]!.options.env.ANTHROPIC_API_KEY).toBeUndefined()
    const grok = await started({ config: { provider: 'grok', model: 'grok-4.7' }, providerKeys: { anthropic: KEY } })
    expect(Object.keys(grok.forks[0]!.options.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'RILL_TOKEN'])
  })

  it('omits a variable of the main process that is not set, and omits RILL_CONNECTIONS without connections', async () => {
    const { forks } = await started({ processEnv: { PATH: '/bin' } })
    expect(forks[0]!.options.env).toEqual({ PATH: '/bin', RILL_TOKEN: 'token-0000000000000001' })
  })

  it('gives every start a new token', async () => {
    const { supervisor, forks } = await running()
    const restart = supervisor.restart()
    await settle()
    forks[1]!.child.listen(41001)
    await restart
    expect(forks[0]!.options.env.RILL_TOKEN).not.toBe(forks[1]!.options.env.RILL_TOKEN)
  })
})

describe('engine supervisor: start', () => {
  it('reads the listening line split across chunks and after other lines, and reports starting then running', async () => {
    const { forks, statuses, supervisor, start } = await started()
    const child = forks[0]!.child
    expect(statuses).toEqual([{ state: 'starting', restarts: 0 }])
    child.stdout.write('warming up\n{"type":"log"}\nnot json at all\n')
    const line = `${JSON.stringify({ type: 'listening', host: '127.0.0.1', port: 43210, protocol: 1 })}\n`
    child.stdout.write(line.slice(0, 17))
    await settle()
    expect(supervisor.status().state).toBe('starting')
    child.stdout.write(line.slice(17))
    await start
    expect(statuses).toEqual([{ state: 'starting', restarts: 0 }, { state: 'running', restarts: 0 }])
    expect(await supervisor.info()).toEqual({ url: 'ws://127.0.0.1:43210/', token: 'token-0000000000000001', protocol: 1 })
  })

  it('ignores a listening line with a wrong host, port or type', async () => {
    const { forks, supervisor } = await started()
    const child = forks[0]!.child
    for (const bad of [{ type: 'listening', host: '0.0.0.0', port: 1, protocol: 1 }, { type: 'listening', host: '127.0.0.1', port: 70000, protocol: 1 }, { type: 'listening', host: '127.0.0.1', port: 65536, protocol: 1 }, { type: 'listening', host: '127.0.0.1', port: 0, protocol: 1 }, { type: 'listening', host: '127.0.0.1', port: -1, protocol: 1 }, { type: 'listening', host: '127.0.0.1', port: 1.5, protocol: 1 }, { type: 'listening', host: '127.0.0.1', port: 'x', protocol: 1 }, { type: 'ready', host: '127.0.0.1', port: 5, protocol: 1 }]) {
      child.stdout.write(`${JSON.stringify(bad)}\n`)
    }
    await settle()
    expect(supervisor.status().state).toBe('starting')
  })

  it.each([[1], [65_535]])('accepts the port %i at the ends of the range', async (port) => {
    const { forks, supervisor, start } = await started()
    forks[0]!.child.listen(port)
    await start
    expect((await supervisor.info()).url).toBe(`ws://127.0.0.1:${port}/`)
  })

  it('drops an over-long line without a newline, so the line after it still counts', async () => {
    const { forks, supervisor, start } = await started()
    const child = forks[0]!.child
    child.stdout.write('x'.repeat(70_000))
    await settle()
    child.stdout.write(`${JSON.stringify({ type: 'listening', host: '127.0.0.1', port: 41000, protocol: 1 })}\n`)
    await start
    expect(supervisor.status().state).toBe('running')
  })

  it('makes info() wait for the engine and reject when it stops', async () => {
    const { supervisor, forks } = await started()
    let settled: string | undefined
    const pending = supervisor.info().then(() => (settled = 'info'), () => (settled = 'rejected'))
    await settle()
    expect(settled).toBeUndefined()
    forks[0]!.child.listen(41000)
    await pending
    expect(settled).toBe('info')
    await supervisor.stop()
    await expect(supervisor.info()).rejects.toThrow('ENGINE_UNAVAILABLE')
  })

  it('fails a start that does not print the listening line within 20 seconds, then retries', async () => {
    const { clock, forks, statuses } = await started()
    await clock.advance(19_999)
    expect(forks[0]!.child.killCalls).toBe(0)
    await clock.advance(1)
    expect(forks[0]!.child.killCalls).toBe(1)
    expect(statuses.at(-1)).toEqual({ state: 'restarting', restarts: 1 })
    await clock.advance(1000)
    expect(forks).toHaveLength(2)
  })

  it('ends in stopped with start_timeout when every try times out', async () => {
    const { clock, forks, supervisor } = await started()
    for (let i = 0; i < 6; i++) {
      await clock.advance(20_000)
      await clock.advance(4_000)
    }
    expect(forks.length).toBeLessThanOrEqual(6)
    expect(supervisor.status()).toMatchObject({ state: 'stopped', error: 'start_timeout' })
  })

  it('treats an exit before the listening line as a failure and retries', async () => {
    const { clock, forks, statuses } = await started()
    forks[0]!.child.exit(1)
    await settle()
    expect(statuses.at(-1)).toEqual({ state: 'restarting', restarts: 1 })
    await clock.advance(1000)
    expect(forks).toHaveLength(2)
  })

  it('treats a fork that throws as a failure, never leaking the message', async () => {
    const { clock, forks, statuses, logs } = await started({ forkFails: 1 })
    expect(statuses.at(-1)).toEqual({ state: 'restarting', restarts: 1 })
    await clock.advance(1000)
    expect(forks).toHaveLength(1)
    forks[0]!.child.listen(41000)
    await settle()
    expect(statuses.at(-1)).toEqual({ state: 'running', restarts: 1 })
    expect(JSON.stringify(statuses) + logs.join('\n')).not.toContain(MARKER)
  })

  it('does not start without a keychain, and says why', async () => {
    const { forks, supervisor, start } = await started({ available: false })
    await start
    expect(forks).toHaveLength(0)
    expect(supervisor.status()).toEqual({ state: 'stopped', error: 'no_keychain', restarts: 0 })
    await expect(supervisor.info()).rejects.toThrow('ENGINE_UNAVAILABLE')
  })

  it('stops for good on a usage error exit code, without retrying', async () => {
    const { clock, forks, supervisor } = await started()
    forks[0]!.child.exit(2)
    await settle()
    await clock.advance(60_000)
    expect(forks).toHaveLength(1)
    expect(supervisor.status()).toEqual({ state: 'stopped', error: 'crashed', restarts: 0 })
  })
})

describe('engine supervisor: restart', () => {
  it('stops the old engine gracefully, waits for its exit, then starts a new one with the new settings', async () => {
    const harness = await running({ config: { allowedFolders: ['/old'] } })
    const { supervisor, forks, statuses, config } = harness
    forks[0]!.child.exitOnKill = false
    config.allowedFolders = ['/new']
    const restart = supervisor.restart()
    await settle()
    expect(forks[0]!.child.killCalls).toBe(1)
    expect(forks).toHaveLength(1)
    forks[0]!.child.exit(0)
    await settle()
    expect(forks).toHaveLength(2)
    expect(forks[1]!.args).toContain('/new')
    forks[1]!.child.listen(41001)
    await restart
    expect(statuses).toEqual([
      { state: 'starting', restarts: 0 },
      { state: 'running', restarts: 0 },
      { state: 'restarting', restarts: 1 },
      { state: 'running', restarts: 1 },
    ])
    expect((await supervisor.info()).url).toBe('ws://127.0.0.1:41001/')
  })

  it('kills the old engine after 10 seconds when it does not exit', async () => {
    const harness = await running()
    const { supervisor, forks, clock, forceKills } = harness
    forks[0]!.child.exitOnKill = false
    const restart = supervisor.restart()
    await settle()
    await clock.advance(9_999)
    expect(forceKills).toHaveLength(0)
    await clock.advance(1)
    expect(forceKills).toEqual([forks[0]!.child])
    expect(forks).toHaveLength(1)
    forks[0]!.child.exit(null)
    await settle()
    expect(forks).toHaveLength(2)
    forks[1]!.child.listen(41001)
    await restart
  })

  it('moves on 2 seconds after the kill even when the exit event never arrives', async () => {
    const harness = await running()
    const { supervisor, forks, clock } = harness
    forks[0]!.child.exitOnKill = false
    void supervisor.restart()
    await settle()
    await clock.advance(12_000)
    expect(forks).toHaveLength(2)
  })

  it('makes two quick restart() calls one restart', async () => {
    const { supervisor, forks, statuses } = await running()
    const first = supervisor.restart()
    const second = supervisor.restart()
    expect(second).toBe(first)
    await settle()
    expect(forks).toHaveLength(2)
    forks[1]!.child.listen(41001)
    await first
    expect(forks).toHaveLength(2)
    expect(statuses.filter((status) => status.state === 'restarting')).toHaveLength(1)
    expect(supervisor.status().restarts).toBe(1)
  })

  it('runs one more restart when settings change after the first restart read them, so the new settings apply', async () => {
    const { supervisor, forks, config, statuses } = await running({ config: { allowedFolders: ['/old'] } })
    const first = supervisor.restart()
    await settle()
    expect(forks).toHaveLength(2)
    expect(forks[1]!.args).toContain('/old')
    config.allowedFolders = []
    const second = supervisor.restart()
    expect(second).toBe(first)
    forks[1]!.child.listen(41001)
    await settle()
    expect(forks[1]!.child.killCalls).toBe(1)
    expect(forks).toHaveLength(3)
    expect(forks[2]!.args).not.toContain('/old')
    forks[2]!.child.listen(41002)
    await first
    expect((await supervisor.info()).url).toBe('ws://127.0.0.1:41002/')
    expect(statuses.filter((status) => status.state === 'restarting').map((status) => status.restarts)).toEqual([1, 2])
    expect(supervisor.status()).toEqual({ state: 'running', restarts: 2 })
  })

  it('runs one more restart even when the engine of the first one has not printed its address yet', async () => {
    const { supervisor, forks, config } = await running({ config: { allowedFolders: ['/old'] } })
    const first = supervisor.restart()
    await settle()
    config.allowedFolders = ['/new']
    void supervisor.restart()
    await settle()
    forks[1]!.child.listen(41001)
    await settle()
    expect(forks).toHaveLength(3)
    expect(forks[2]!.args).toContain('/new')
    expect(forks[2]!.args).not.toContain('/old')
    forks[2]!.child.listen(41002)
    await first
  })

  it('does not start an engine after stop() when one more restart was waiting', async () => {
    const { supervisor, forks } = await running()
    const first = supervisor.restart()
    await settle()
    void supervisor.restart()
    const stopped = supervisor.stop()
    await Promise.all([first, stopped])
    await settle()
    expect(forks).toHaveLength(2)
    expect(supervisor.status().state).toBe('stopped')
  })

  it('makes a second restart() one restart with the first while the old engine is still stopping, and reads the settings once', async () => {
    const { supervisor, forks, config } = await running({ config: { allowedFolders: ['/old'] } })
    forks[0]!.child.exitOnKill = false
    const first = supervisor.restart()
    await settle()
    config.allowedFolders = ['/new']
    const second = supervisor.restart()
    expect(second).toBe(first)
    forks[0]!.child.exit(0)
    await settle()
    expect(forks).toHaveLength(2)
    expect(forks[1]!.args).toContain('/new')
    forks[1]!.child.listen(41001)
    await first
    expect(forks).toHaveLength(2)
    expect(supervisor.status()).toEqual({ state: 'running', restarts: 1 })
  })

  it('can restart again after a restart finished', async () => {
    const { supervisor, forks } = await running()
    const first = supervisor.restart()
    await settle()
    forks[1]!.child.listen(41001)
    await first
    const second = supervisor.restart()
    await settle()
    forks[2]!.child.listen(41002)
    await second
    expect(forks).toHaveLength(3)
    expect(supervisor.status()).toEqual({ state: 'running', restarts: 2 })
  })

  it('cancels a pending automatic restart and starts at once', async () => {
    const { supervisor, forks, clock } = await running()
    forks[0]!.child.exit(1)
    await settle()
    expect(supervisor.status().state).toBe('restarting')
    const restart = supervisor.restart()
    await settle()
    expect(forks).toHaveLength(2)
    forks[1]!.child.listen(41001)
    await restart
    await clock.advance(10_000)
    expect(forks).toHaveLength(2)
  })

  it('starts an engine again with restart() after it stopped for good', async () => {
    const { supervisor, forks } = await started()
    forks[0]!.child.exit(2)
    await settle()
    expect(supervisor.status().state).toBe('stopped')
    const restart = supervisor.restart()
    await settle()
    expect(forks).toHaveLength(2)
    forks[1]!.child.listen(41001)
    await restart
    expect(supervisor.status().state).toBe('running')
  })
})

describe('engine supervisor: crash back-off', () => {
  async function crashAndRecover(harness: Awaited<ReturnType<typeof running>>, index: number, delay: number) {
    const { forks, clock, supervisor } = harness
    forks[index]!.child.exit(1)
    await settle()
    expect(supervisor.status()).toEqual({ state: 'restarting', restarts: index + 1 })
    await clock.advance(delay - 1)
    expect(forks).toHaveLength(index + 1)
    await clock.advance(1)
    expect(forks).toHaveLength(index + 2)
    forks[index + 1]!.child.listen(41001 + index)
    await settle()
  }

  it('waits 1, 2, 4, 4 and 4 seconds, then stops with crashed on the sixth crash within a minute', async () => {
    const harness = await running()
    const delays = [1000, 2000, 4000, 4000, 4000]
    for (const [index, delay] of delays.entries()) await crashAndRecover(harness, index, delay)
    expect(harness.supervisor.status()).toEqual({ state: 'running', restarts: 5 })
    harness.forks[5]!.child.exit(1)
    await settle()
    await harness.clock.advance(60_000)
    expect(harness.forks).toHaveLength(6)
    expect(harness.supervisor.status()).toEqual({ state: 'stopped', error: 'crashed', restarts: 5 })
    await expect(harness.supervisor.info()).rejects.toThrow('ENGINE_UNAVAILABLE')
  })

  it('forgets crashes older than a minute', async () => {
    const harness = await running()
    for (let index = 0; index < 8; index++) {
      await crashAndRecover(harness, index, 1000)
      await harness.clock.advance(61_000)
    }
    expect(harness.supervisor.status()).toEqual({ state: 'running', restarts: 8 })
  })

  it('forgets a crash that is exactly one minute old, and keeps one that is a second younger', async () => {
    const harness = await running()
    for (let index = 0; index < 3; index++) {
      await crashAndRecover(harness, index, 1000)
      await harness.clock.advance(59_000)
    }
    expect(harness.supervisor.status()).toEqual({ state: 'running', restarts: 3 })
    const young = await running()
    await crashAndRecover(young, 0, 1000)
    await young.clock.advance(58_000)
    young.forks[1]!.child.exit(1)
    await settle()
    await young.clock.advance(1_999)
    expect(young.forks).toHaveLength(2)
    await young.clock.advance(1)
    expect(young.forks).toHaveLength(3)
  })

  it('counts failed starts afresh after a restart that follows a stop for good', async () => {
    const { supervisor, forks, clock } = await started()
    for (const [index, delay] of [1000, 2000, 4000, 4000, 4000].entries()) {
      forks[index]!.child.exit(1)
      await settle()
      await clock.advance(delay)
    }
    forks[5]!.child.exit(1)
    await settle()
    expect(supervisor.status()).toEqual({ state: 'stopped', error: 'crashed', restarts: 5 })
    const restart = supervisor.restart()
    await settle()
    expect(forks).toHaveLength(7)
    forks[6]!.child.exit(1)
    await settle()
    expect(supervisor.status().state).toBe('restarting')
    await clock.advance(1000)
    expect(forks).toHaveLength(8)
    forks[7]!.child.listen(41000)
    await restart
    expect(supervisor.status().state).toBe('running')
  })

  it('shows no error while restarting, only when stopped', async () => {
    const { forks, statuses } = await running()
    forks[0]!.child.exit(1)
    await settle()
    expect(statuses.filter((status) => status.state === 'restarting').every((status) => status.error === undefined)).toBe(true)
  })
})

describe('engine supervisor: stop', () => {
  it('stops gracefully once, is idempotent and does not restart afterwards', async () => {
    const { supervisor, forks, clock, statuses } = await running()
    const first = supervisor.stop()
    const second = supervisor.stop()
    await Promise.all([first, second])
    expect(forks[0]!.child.killCalls).toBe(1)
    expect(supervisor.status()).toEqual({ state: 'stopped', restarts: 0 })
    await supervisor.stop()
    await clock.advance(60_000)
    expect(forks).toHaveLength(1)
    expect(statuses.filter((status) => status.state === 'stopped')).toHaveLength(1)
  })

  it('kills the engine after 10 seconds when it ignores the stop', async () => {
    const { supervisor, forks, clock, forceKills } = await running()
    forks[0]!.child.exitOnKill = false
    const stop = supervisor.stop()
    await settle()
    await clock.advance(10_000)
    expect(forceKills).toEqual([forks[0]!.child])
    forks[0]!.child.exit(null)
    await stop
    expect(supervisor.status().state).toBe('stopped')
  })

  it('cancels a pending automatic restart', async () => {
    const { supervisor, forks, clock } = await running()
    forks[0]!.child.exit(1)
    await settle()
    await supervisor.stop()
    await clock.advance(60_000)
    expect(forks).toHaveLength(1)
    expect(supervisor.status().state).toBe('stopped')
  })

  it('stops an engine that has not printed its listening line yet, without counting a failure', async () => {
    const { supervisor, forks, clock } = await started()
    await supervisor.stop()
    await clock.advance(60_000)
    expect(forks).toHaveLength(1)
    expect(supervisor.status()).toEqual({ state: 'stopped', restarts: 0 })
  })

  it('resolves at once when nothing was started', async () => {
    const harness = setup()
    await harness.supervisor.stop()
    expect(harness.supervisor.status()).toEqual({ state: 'stopped', restarts: 0 })
  })

  it('does not start again from start() while it is running', async () => {
    const { supervisor, forks } = await running()
    await supervisor.start()
    expect(forks).toHaveLength(1)
  })
})

describe('engine supervisor: secrets stay out of everything it reports', () => {
  it('never forwards stdout or stderr text, in status events, logs or info', async () => {
    const { supervisor, forks, statuses, logs, start } = await started({ providerKeys: { anthropic: KEY }, connections: [{ name: 'team', kind: 'slack', secret: HOOK }] })
    const child = forks[0]!.child
    child.stderr.write(`engine failed with ${KEY} and ${HOOK}\n`)
    child.stdout.write(`log line with ${KEY}\n`)
    child.listen(41000, { note: KEY })
    child.stdout.write(`more with ${HOOK}\n`)
    await start
    child.stderr.write(`late ${KEY}\n`)
    child.exit(1)
    await settle()
    const seen = JSON.stringify(statuses) + logs.join('\n') + JSON.stringify(supervisor.status())
    for (const text of [KEY, HOOK, MARKER]) expect(seen, text).not.toContain(text)
    expect(Object.keys(statuses[0]!).sort()).toEqual(['restarts', 'state'])
    for (const status of statuses) expect(Object.keys(status).every((key) => ['state', 'error', 'restarts'].includes(key))).toBe(true)
  })

  it('drains the output of the engine so a full pipe cannot block it', async () => {
    const { forks, start } = await started()
    const child = forks[0]!.child
    for (let i = 0; i < 2000; i++) child.stderr.write('x'.repeat(1024))
    child.listen(41000)
    child.stdout.write(`${'y'.repeat(200_000)}\n`)
    await start
    expect(child.stderr.readableLength).toBe(0)
    expect(child.stdout.readableLength).toBe(0)
  })

  it('removes a status listener when asked', async () => {
    const harness = setup()
    stoppers.push(harness.supervisor)
    const seen: string[] = []
    const off = harness.supervisor.onStatus((status) => seen.push(status.state))
    const start = harness.supervisor.start()
    await settle()
    off()
    harness.forks[0]!.child.listen(41000)
    await start
    expect(seen).toEqual(['starting'])
  })
})

describe('engine supervisor: messages to the running engine', () => {
  const GOOGLE = { type: 'connection.set', name: 'google', kind: 'google', secret: `ya29.${MARKER}0123456789` }

  it('posts a message to the child once the engine listens and says it did', async () => {
    const { supervisor, forks } = await running()
    expect(supervisor.send(GOOGLE)).toBe(true)
    expect(forks[0]!.child.posted).toEqual([GOOGLE])
  })

  it('posts nothing and says so before the listening line', async () => {
    const { supervisor, forks } = await started()
    expect(supervisor.send(GOOGLE)).toBe(false)
    forks[0]!.child.listen(41000)
    await settle()
    expect(forks[0]!.child.posted).toEqual([])
  })

  it('posts nothing when nothing was started, after stop, and after the engine exited', async () => {
    const idle = setup()
    expect(idle.supervisor.send(GOOGLE)).toBe(false)
    const { supervisor, forks } = await running()
    forks[0]!.child.exit(1)
    expect(supervisor.send(GOOGLE)).toBe(false)
    expect(forks[0]!.child.posted).toEqual([])
    const second = await running()
    await second.supervisor.stop()
    expect(second.supervisor.send(GOOGLE)).toBe(false)
    expect(second.forks[0]!.child.posted).toEqual([])
  })

  it('queues nothing: a message sent while the engine restarts is never delivered later', async () => {
    const { supervisor, forks } = await running()
    const restart = supervisor.restart()
    await settle()
    expect(supervisor.send(GOOGLE)).toBe(false)
    forks[1]!.child.listen(41001)
    await restart
    await settle()
    expect(forks[0]!.child.posted).toEqual([])
    expect(forks[1]!.child.posted).toEqual([])
    expect(supervisor.send(GOOGLE)).toBe(true)
    expect(forks[1]!.child.posted).toEqual([GOOGLE])
  })

  it('posts to the engine of the current start, not to an earlier one', async () => {
    const { supervisor, forks } = await running()
    const restart = supervisor.restart()
    await settle()
    forks[1]!.child.listen(41001)
    await restart
    supervisor.send(GOOGLE)
    expect(forks[0]!.child.posted).toEqual([])
    expect(forks[1]!.child.posted).toEqual([GOOGLE])
  })

  it('reports a failed post as false and keeps the message text out of the log', async () => {
    const { supervisor, forks, logs } = await running()
    forks[0]!.child.postFails = true
    expect(supervisor.send(GOOGLE)).toBe(false)
    expect(logs.join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain('ya29')
  })

  it('lets a status listener send to the engine at the moment it reports running', async () => {
    const harness = await started()
    const results: boolean[] = []
    harness.supervisor.onStatus((status) => {
      if (status.state === 'running') results.push(harness.supervisor.send(GOOGLE))
    })
    harness.forks[0]!.child.listen(41000)
    await harness.start
    expect(results).toEqual([true])
    expect(harness.forks[0]!.child.posted).toEqual([GOOGLE])
  })
})

describe('engine supervisor: connections of signed-in accounts', () => {
  const GOOGLE_TOKEN = `ya29.${MARKER}0123456789`
  const MICROSOFT_TOKEN = `eyJ${MARKER}0123456789.payload.sig`

  it('seeds them into RILL_CONNECTIONS with their kind next to the saved connections, and never into the arguments', async () => {
    const { forks } = await started({
      connections: [{ name: 'team', kind: 'slack', secret: HOOK }],
      oauthConnections: [
        { name: 'google', kind: 'google', secret: GOOGLE_TOKEN },
        { name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_TOKEN },
      ],
    })
    expect(JSON.parse(forks[0]!.options.env.RILL_CONNECTIONS!)).toEqual({
      team: { secret: HOOK, kind: 'slack' },
      google: { secret: GOOGLE_TOKEN, kind: 'google' },
      microsoft: { secret: MICROSOFT_TOKEN, kind: 'microsoft' },
    })
    expect(forks[0]!.args.join(' ')).not.toContain(MARKER)
  })

  it('sets RILL_CONNECTIONS when only an account is signed in, and leaves it out when there is nothing', async () => {
    const only = await started({ oauthConnections: [{ name: 'google', kind: 'google', secret: GOOGLE_TOKEN }] })
    expect(JSON.parse(only.forks[0]!.options.env.RILL_CONNECTIONS!)).toEqual({ google: { secret: GOOGLE_TOKEN, kind: 'google' } })
    const none = await started({ oauthConnections: [] })
    expect('RILL_CONNECTIONS' in none.forks[0]!.options.env).toBe(false)
  })

  it('reads the tokens again at every start', async () => {
    const tokens = [{ name: 'google' as const, kind: 'google' as const, secret: GOOGLE_TOKEN }]
    const { supervisor, forks } = await running({ oauthConnections: tokens })
    tokens[0]!.secret = `ya29.${MARKER}NEWER000000`
    const restart = supervisor.restart()
    await settle()
    forks[1]!.child.listen(41001)
    await restart
    expect(JSON.parse(forks[0]!.options.env.RILL_CONNECTIONS!).google.secret).toBe(GOOGLE_TOKEN)
    expect(JSON.parse(forks[1]!.options.env.RILL_CONNECTIONS!).google.secret).toBe(`ya29.${MARKER}NEWER000000`)
  })

  it('keeps a saved connection that has the same name instead of an account entry', async () => {
    const { forks } = await started({
      connections: [{ name: 'google', kind: 'http', secret: 'plain-api-key' }],
      oauthConnections: [{ name: 'google', kind: 'google', secret: GOOGLE_TOKEN }],
    })
    expect(JSON.parse(forks[0]!.options.env.RILL_CONNECTIONS!)).toEqual({ google: { secret: 'plain-api-key', kind: 'http' } })
  })
})
