import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { HostError, PROVIDER_KEY_ENV, type EngineInfo, type EngineStatus } from '../shared/host-api'
import type { ConfigStore } from './config-store'
import type { SecretStore } from './secret-store'

export interface StreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface ChildLike {
  readonly pid: number | undefined
  readonly stdout: StreamLike | null
  readonly stderr: StreamLike | null
  kill(): boolean
  postMessage(message: unknown): void
  on(event: 'exit', listener: (code: number | null) => void): unknown
}

export interface ForkOptions {
  env: Record<string, string>
  cwd: string
  stdio: 'pipe'
  serviceName: string
}

export type ForkLike = (modulePath: string, args: string[], options: ForkOptions) => ChildLike

export interface ClockLike {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface EngineSupervisor {
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  status(): EngineStatus
  onStatus(listener: (status: EngineStatus) => void): () => void
  info(): Promise<EngineInfo>
  send(message: unknown): boolean
}

export interface AccountConnection {
  name: 'google' | 'microsoft'
  kind: 'google' | 'microsoft'
  secret: string
}

export interface EngineSupervisorDeps {
  fork: ForkLike
  bundlePath: string
  userData: string
  secrets: SecretStore
  config: ConfigStore
  oauthConnections?: () => readonly AccountConnection[]
  oauthReady?: () => Promise<unknown>
  clock?: ClockLike
  randomToken?: () => string
  forceKill?: (child: ChildLike) => void
  env?: Readonly<Record<string, string | undefined>>
  log?: (message: string) => void
}

const START_TIMEOUT_MS = 20_000
const STOP_GRACE_MS = 10_000
const KILL_WAIT_MS = 2_000
const ENGINE_SHUTDOWN_MS = 8_000
const FAILURE_WINDOW_MS = 60_000
const MAX_TRIES = 5
const MAX_BACKOFF_MS = 4_000
const USAGE_EXIT_CODE = 2
const MAX_LINE_BUFFER = 65_536
const PASSED_VARIABLES = ['PATH', 'HOME', 'LANG'] as const

type Outcome = { kind: 'running' } | { kind: 'done' } | { kind: 'cancelled' } | { kind: 'failed'; reason: 'crashed' | 'start_timeout'; code?: number | null }

interface Entry {
  child: ChildLike
  epoch: number
  listening: boolean
  exited: boolean
  stopping: boolean
  timedOut: boolean
  settled: boolean
  timer: unknown
  exitWaiters: Array<() => void>
  settle(outcome: Outcome): void
}

const realClock: ClockLike = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function defaultForceKill(child: ChildLike): void {
  if (child.pid === undefined) return
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    return
  }
}

function parseListening(line: string): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { type, host, port } = value as { type?: unknown; host?: unknown; port?: unknown }
  if (type !== 'listening' || host !== '127.0.0.1') return undefined
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

export function createEngineSupervisor(deps: EngineSupervisorDeps): EngineSupervisor {
  const clock = deps.clock ?? realClock
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('hex'))
  const forceKill = deps.forceKill ?? defaultForceKill
  const baseEnv = deps.env ?? process.env
  const attachmentsDir = join(deps.userData, 'attachments')
  const listeners = new Set<(status: EngineStatus) => void>()
  const waiters: Array<{ resolve: (info: EngineInfo) => void; reject: (error: Error) => void }> = []
  let status: EngineStatus = { state: 'stopped', restarts: 0 }
  let current: Entry | undefined
  let info: EngineInfo | undefined
  let epoch = 0
  let crashTimes: number[] = []
  let consecutiveFailures = 0
  let sleeper: { handle: unknown; resolve: (slept: boolean) => void } | undefined
  let chain: Promise<void> = Promise.resolve()
  let restartPromise: Promise<void> | undefined
  let settingsRead = false
  let restartAgain = false
  let stopPromise: Promise<void> | undefined

  function setStatus(next: EngineStatus): void {
    if (next.state === status.state && next.error === status.error && next.restarts === status.restarts) return
    status = next
    deps.log?.(`engine ${next.state}`)
    for (const listener of [...listeners]) listener({ ...next })
    if (next.state === 'running' && info !== undefined) {
      for (const waiter of waiters.splice(0)) waiter.resolve({ ...info })
    } else if (next.state === 'stopped') {
      for (const waiter of waiters.splice(0)) waiter.reject(new HostError('ENGINE_UNAVAILABLE'))
    }
  }

  function sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      sleeper = {
        resolve,
        handle: clock.setTimeout(() => {
          sleeper = undefined
          resolve(true)
        }, ms),
      }
    })
  }

  function cancelSleep(): void {
    if (sleeper === undefined) return
    clock.clearTimeout(sleeper.handle)
    sleeper.resolve(false)
    sleeper = undefined
  }

  async function buildSpawn(): Promise<{ args: string[]; env: Record<string, string>; token: string }> {
    await Promise.resolve()
      .then(() => deps.oauthReady?.())
      .catch(() => undefined)
    settingsRead = true
    const config = await deps.config.get()
    const key = await deps.secrets.getProviderKey(config.provider)
    const connections = await deps.secrets.getConnections()
    const table: Record<string, { secret: string; kind: string }> = Object.fromEntries(connections.map((c) => [c.name, { secret: c.secret, kind: c.kind }]))
    for (const account of deps.oauthConnections?.() ?? []) {
      if (!Object.hasOwn(table, account.name)) table[account.name] = { secret: account.secret, kind: account.kind }
    }
    const token = randomToken()
    const args = [
      'serve', '--db', join(deps.userData, 'rill.db'), '--port', '0', '--attachments-dir', attachmentsDir,
      '--shutdown-timeout', String(ENGINE_SHUTDOWN_MS), '--llm-provider', config.provider,
      ...(config.model === undefined ? [] : ['--llm-model', config.model]),
      ...[attachmentsDir, ...config.allowedFolders].flatMap((folder) => ['--allow', folder]),
    ]
    const env: Record<string, string> = {}
    for (const name of PASSED_VARIABLES) {
      const value = baseEnv[name]
      if (value !== undefined) env[name] = value
    }
    env.RILL_TOKEN = token
    if (key !== undefined) env[PROVIDER_KEY_ENV[config.provider]] = key
    if (Object.keys(table).length > 0) env.RILL_CONNECTIONS = JSON.stringify(table)
    return { args, env, token }
  }

  function onExit(entry: Entry, code: number | null): void {
    entry.exited = true
    if (current === entry) current = undefined
    for (const wake of entry.exitWaiters.splice(0)) wake()
    if (entry.stopping) {
      entry.settle(entry.timedOut ? { kind: 'failed', reason: 'start_timeout' } : { kind: 'cancelled' })
      return
    }
    if (!entry.listening) {
      entry.settle({ kind: 'failed', reason: 'crashed', code })
      return
    }
    info = undefined
    if (entry.epoch === epoch) chain = recover(entry.epoch, 'crashed', code)
  }

  async function terminate(entry: Entry | undefined): Promise<void> {
    if (entry === undefined || entry.exited) return
    if (entry.stopping) {
      await new Promise<void>((resolve) => entry.exitWaiters.push(resolve))
      return
    }
    entry.stopping = true
    await new Promise<void>((resolve) => {
      entry.exitWaiters.push(resolve)
      const killTimer = clock.setTimeout(() => {
        forceKill(entry.child)
        const giveUp = clock.setTimeout(resolve, KILL_WAIT_MS)
        entry.exitWaiters.push(() => clock.clearTimeout(giveUp))
      }, STOP_GRACE_MS)
      entry.exitWaiters.push(() => clock.clearTimeout(killTimer))
      try {
        entry.child.kill()
      } catch {
        resolve()
      }
    })
    if (current === entry) current = undefined
  }

  async function launch(e: number): Promise<Outcome> {
    if (!deps.secrets.encryptionAvailable()) {
      setStatus({ state: 'stopped', error: 'no_keychain', restarts: status.restarts })
      return { kind: 'done' }
    }
    let spawn: Awaited<ReturnType<typeof buildSpawn>>
    try {
      spawn = await buildSpawn()
    } catch {
      return { kind: 'failed', reason: 'crashed' }
    }
    if (e !== epoch) return { kind: 'cancelled' }
    let child: ChildLike
    try {
      child = deps.fork(deps.bundlePath, spawn.args, { env: spawn.env, cwd: deps.userData, stdio: 'pipe', serviceName: 'rill-engine' })
    } catch {
      return { kind: 'failed', reason: 'crashed' }
    }
    return new Promise<Outcome>((resolve) => {
      const entry: Entry = {
        child,
        epoch: e,
        listening: false,
        exited: false,
        stopping: false,
        timedOut: false,
        settled: false,
        timer: undefined,
        exitWaiters: [],
        settle(outcome) {
          if (entry.settled) return
          entry.settled = true
          clock.clearTimeout(entry.timer)
          resolve(outcome)
        },
      }
      current = entry
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      child.stdout?.on('data', (chunk) => {
        if (entry.listening) return
        buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
        let newline = buffer.indexOf('\n')
        while (newline !== -1 && !entry.listening) {
          const port = parseListening(buffer.slice(0, newline).trim())
          buffer = buffer.slice(newline + 1)
          if (port !== undefined) {
            entry.listening = true
            consecutiveFailures = 0
            info = { url: `ws://127.0.0.1:${port}/`, token: spawn.token, protocol: 1 }
            setStatus({ state: 'running', restarts: status.restarts })
            entry.settle({ kind: 'running' })
            return
          }
          newline = buffer.indexOf('\n')
        }
        if (buffer.length > MAX_LINE_BUFFER) buffer = ''
      })
      child.stderr?.on('data', () => undefined)
      child.on('exit', (code) => onExit(entry, code))
      entry.timer = clock.setTimeout(() => {
        if (entry.exited || entry.listening) return
        entry.timedOut = true
        void terminate(entry).then(() => entry.settle({ kind: 'failed', reason: 'start_timeout' }))
      }, START_TIMEOUT_MS)
    })
  }

  async function run(e: number): Promise<void> {
    if (e !== epoch) return
    const outcome = await launch(e)
    if (outcome.kind === 'failed') await recover(e, outcome.reason, outcome.code)
  }

  async function recover(e: number, reason: 'crashed' | 'start_timeout', code?: number | null): Promise<void> {
    if (e !== epoch) return
    if (code === USAGE_EXIT_CODE) {
      setStatus({ state: 'stopped', error: 'crashed', restarts: status.restarts })
      return
    }
    const now = clock.now()
    crashTimes = crashTimes.filter((time) => now - time < FAILURE_WINDOW_MS)
    crashTimes.push(now)
    consecutiveFailures++
    if (crashTimes.length > MAX_TRIES || consecutiveFailures > MAX_TRIES) {
      setStatus({ state: 'stopped', error: reason, restarts: status.restarts })
      return
    }
    setStatus({ state: 'restarting', restarts: status.restarts + 1 })
    const slept = await sleep(Math.min(1000 * 2 ** (crashTimes.length - 1), MAX_BACKOFF_MS))
    if (!slept || e !== epoch) return
    await run(e)
  }

  function begin(): number {
    epoch++
    cancelSleep()
    crashTimes = []
    consecutiveFailures = 0
    return epoch
  }

  return {
    start() {
      if (status.state !== 'stopped') return chain
      const e = begin()
      setStatus({ state: 'starting', restarts: status.restarts })
      chain = run(e)
      return chain
    },
    restart() {
      if (restartPromise !== undefined) {
        if (settingsRead) restartAgain = true
        return restartPromise
      }
      restartPromise = (async () => {
        do {
          restartAgain = false
          settingsRead = false
          const e = begin()
          const old = current
          setStatus({ state: 'restarting', restarts: status.restarts + 1 })
          await terminate(old)
          await run(e)
        } while (restartAgain)
      })().finally(() => {
        restartPromise = undefined
      })
      chain = restartPromise
      return restartPromise
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise
      restartAgain = false
      begin()
      const old = current
      stopPromise = (async () => {
        await terminate(old)
        info = undefined
        setStatus({ state: 'stopped', restarts: status.restarts })
      })().finally(() => {
        stopPromise = undefined
      })
      return stopPromise
    },
    status: () => ({ ...status }),
    send(message) {
      const entry = current
      if (entry === undefined || !entry.listening || entry.exited || entry.stopping) return false
      try {
        entry.child.postMessage(message)
        return true
      } catch {
        return false
      }
    },
    onStatus(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    info() {
      if (status.state === 'running' && info !== undefined) return Promise.resolve({ ...info })
      if (status.state === 'stopped') return Promise.reject(new HostError('ENGINE_UNAVAILABLE'))
      return new Promise<EngineInfo>((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}
