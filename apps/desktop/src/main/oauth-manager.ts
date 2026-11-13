import { HostError, OAUTH_PROVIDERS, type OAuthAccount, type OAuthConnectResult, type OAuthProvider, type OAuthState, type OAuthStatus } from '../shared/host-api'
import type { AccountConnection } from './engine-supervisor'
import { refreshTokens, revokeRefreshToken, startSignIn, type FlowDeps, type OAuthApp, type OAuthClock, type OAuthFetch, type SignIn } from './oauth-flow'
import { OAUTH_PROVIDER_CONFIGS } from './oauth-providers'
import { parseRenewRequest } from './renew-request'
import type { OAuthAppRecord, SecretStore } from './secret-store'

export type OAuthStore = Pick<SecretStore, 'encryptionAvailable' | 'getOAuth' | 'setOAuthApp' | 'clearOAuthApp' | 'setOAuthAccount' | 'clearOAuthAccount'>

export interface OAuthManagerDeps {
  store: OAuthStore
  fetch: OAuthFetch
  openExternal(url: string): Promise<void>
  clock: OAuthClock
  engine: { send(message: unknown): boolean }
  random?: () => number
  log?: (message: string) => void
  flow?: Pick<FlowDeps, 'randomBytes' | 'createServer' | 'timeoutMs'>
}

export interface OAuthManager {
  start(): Promise<void>
  state(): Promise<OAuthState>
  setApp(provider: OAuthProvider, app: OAuthApp): Promise<void>
  clearApp(provider: OAuthProvider): Promise<void>
  connect(provider: OAuthProvider): Promise<OAuthConnectResult>
  cancel(provider: OAuthProvider): void
  disconnect(provider: OAuthProvider): Promise<void>
  resume(): void
  accountConnections(): AccountConnection[]
  syncEngine(): void
  renew(request: unknown): Promise<void>
  onChange(listener: (change: OAuthAccount) => void): () => void
  stop(): void
}

interface Slot {
  status: OAuthStatus
  account: string | undefined
  scope: string | undefined
  connectedAt: number | undefined
  refreshToken: string | undefined
  persistedToken: string | undefined
  accessToken: string | undefined
  expiresAt: number | undefined
  timer: unknown
  refreshing: Promise<void> | undefined
  failures: number
  generation: number
}

interface Active {
  provider: OAuthProvider
  signIn: SignIn
  finished: Promise<void>
}

const REFRESH_MARGIN_MS = 300_000
const MIN_DELAY_MS = 5_000
const MAX_JITTER_MS = 30_000
const RESUME_SLACK_MS = 60_000
const START_WAIT_MS = 10_000
const RENEW_INTERVAL_MS = 30_000
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const

function newSlot(): Slot {
  return { status: 'not_configured', account: undefined, scope: undefined, connectedAt: undefined, refreshToken: undefined, persistedToken: undefined, accessToken: undefined, expiresAt: undefined, timer: undefined, refreshing: undefined, failures: 0, generation: 0 }
}

export function createOAuthManager(deps: OAuthManagerDeps): OAuthManager {
  const { store, clock } = deps
  const random = deps.random ?? Math.random
  const slots = new Map<OAuthProvider, Slot>(OAUTH_PROVIDERS.map((provider) => [provider, newSlot()]))
  const apps = new Map<OAuthProvider, OAuthAppRecord>()
  const listeners = new Set<(change: OAuthAccount) => void>()
  const lastRenewal = new Map<OAuthProvider, number>()
  let loading: Promise<void> | undefined
  let active: Active | undefined

  const slotOf = (provider: OAuthProvider): Slot => slots.get(provider)!
  const note = (message: string): void => deps.log?.(message)

  function view(provider: OAuthProvider): OAuthAccount {
    const slot = slotOf(provider)
    const shown = slot.status === 'connected' || slot.status === 'needs_reconnect'
    return { provider, status: slot.status, ...(shown && slot.account !== undefined ? { account: slot.account } : {}) }
  }

  function change(provider: OAuthProvider, apply: () => void): void {
    const before = JSON.stringify(view(provider))
    apply()
    const after = view(provider)
    if (JSON.stringify(after) === before) return
    for (const listener of [...listeners]) {
      try {
        listener({ ...after })
      } catch {
        continue
      }
    }
  }

  function requireKeychain(): void {
    if (!store.encryptionAvailable()) throw new HostError('NO_KEYCHAIN')
  }

  async function load(): Promise<void> {
    const records = await store.getOAuth()
    for (const provider of OAUTH_PROVIDERS) {
      const app = records.apps[provider]
      if (app === undefined) continue
      const slot = slotOf(provider)
      apps.set(provider, app)
      slot.status = 'not_connected'
      const account = records.accounts[provider]
      if (account === undefined) continue
      slot.scope = account.scope
      slot.connectedAt = account.connectedAt
      slot.account = account.account
      if (account.needsReconnect === true) slot.status = 'needs_reconnect'
      else if (account.refreshToken !== undefined) {
        slot.status = 'connected'
        slot.refreshToken = account.refreshToken
        slot.persistedToken = account.refreshToken
      }
    }
  }

  function ensureLoaded(): Promise<void> {
    loading ??= load()
    return loading
  }

  function clearTimer(slot: Slot): void {
    if (slot.timer === undefined) return
    clock.clearTimeout(slot.timer)
    slot.timer = undefined
  }

  function dropTokens(slot: Slot): void {
    clearTimer(slot)
    slot.accessToken = undefined
    slot.expiresAt = undefined
    slot.refreshToken = undefined
    slot.persistedToken = undefined
    slot.refreshing = undefined
    slot.failures = 0
    slot.generation += 1
  }

  function suspend(slot: Slot): void {
    clearTimer(slot)
    slot.refreshing = undefined
    slot.generation += 1
  }

  function rearm(provider: OAuthProvider): void {
    const slot = slotOf(provider)
    if (slot.status !== 'connected' || slot.refreshToken === undefined) return
    const stale = slot.accessToken === undefined || slot.expiresAt === undefined || slot.expiresAt - clock.now() <= REFRESH_MARGIN_MS + RESUME_SLACK_MS
    if (stale) void refresh(provider)
    else schedule(provider)
  }

  async function guardedWrite(provider: OAuthProvider, write: () => Promise<unknown>): Promise<void> {
    suspend(slotOf(provider))
    try {
      await write()
    } catch (error) {
      rearm(provider)
      throw error
    }
  }

  function send(message: unknown): void {
    try {
      deps.engine.send(message)
    } catch {
      return
    }
  }

  function hasLiveToken(slot: Slot): slot is Slot & { accessToken: string; expiresAt: number } {
    return slot.accessToken !== undefined && slot.expiresAt !== undefined && slot.expiresAt > clock.now()
  }

  function pushToken(provider: OAuthProvider): void {
    const slot = slotOf(provider)
    if (hasLiveToken(slot)) send({ type: 'connection.set', name: provider, kind: provider, secret: slot.accessToken })
  }

  function pushRemove(provider: OAuthProvider): void {
    send({ type: 'connection.remove', name: provider })
  }

  function later(provider: OAuthProvider, delay: number): void {
    const slot = slotOf(provider)
    clearTimer(slot)
    slot.timer = clock.setTimeout(() => {
      slot.timer = undefined
      void refresh(provider)
    }, delay)
  }

  function schedule(provider: OAuthProvider): void {
    const slot = slotOf(provider)
    if (slot.expiresAt === undefined) return
    const jitter = Math.floor(random() * MAX_JITTER_MS)
    later(provider, Math.max(MIN_DELAY_MS, slot.expiresAt - clock.now() - REFRESH_MARGIN_MS - jitter))
  }

  function retry(provider: OAuthProvider, retryAfterMs?: number): void {
    const slot = slotOf(provider)
    slot.failures += 1
    const backoff = BACKOFF_MS[Math.min(slot.failures, BACKOFF_MS.length) - 1]!
    note(`oauth ${provider}: refresh failed, will retry`)
    later(provider, Math.max(backoff, retryAfterMs ?? 0))
  }

  function accountRecord(provider: OAuthProvider, slot: Slot) {
    return {
      scope: slot.scope ?? OAUTH_PROVIDER_CONFIGS[provider].scopes.join(' '),
      ...(slot.account === undefined ? {} : { account: slot.account }),
      connectedAt: slot.connectedAt ?? clock.now(),
    }
  }

  async function markNeedsReconnect(provider: OAuthProvider, generation: number): Promise<void> {
    const slot = slotOf(provider)
    note(`oauth ${provider}: the sign-in was withdrawn, reconnect needed`)
    try {
      await store.setOAuthAccount(provider, { needsReconnect: true, ...accountRecord(provider, slot) })
    } catch {
      note(`oauth ${provider}: could not save the reconnect mark`)
    }
    if (slot.generation !== generation) return
    dropTokens(slot)
    pushRemove(provider)
    change(provider, () => {
      slot.status = 'needs_reconnect'
    })
  }

  async function doRefresh(provider: OAuthProvider): Promise<void> {
    const slot = slotOf(provider)
    const app = apps.get(provider)
    const token = slot.refreshToken
    if (slot.status !== 'connected' || token === undefined || app === undefined) return
    const generation = slot.generation
    const outcome = await refreshTokens({ provider, app, refreshToken: token, deps: { fetch: deps.fetch, clock } })
    if (slot.generation !== generation) return
    if (outcome.kind === 'revoked') {
      await markNeedsReconnect(provider, generation)
      return
    }
    if (outcome.kind === 'transient') {
      retry(provider, outcome.retryAfterMs)
      return
    }
    const { grant } = outcome
    const next = grant.refreshToken ?? token
    if (next !== slot.persistedToken) {
      slot.refreshToken = next
      try {
        await store.setOAuthAccount(provider, { refreshToken: next, ...accountRecord(provider, slot) })
        slot.persistedToken = next
      } catch {
        if (slot.generation === generation) {
          note(`oauth ${provider}: could not save the new sign-in`)
          retry(provider)
        }
        return
      }
      if (slot.generation !== generation) return
    }
    slot.accessToken = grant.accessToken
    slot.expiresAt = grant.expiresAt
    slot.failures = 0
    schedule(provider)
    pushToken(provider)
  }

  function refresh(provider: OAuthProvider): Promise<void> {
    const slot = slotOf(provider)
    if (slot.refreshing !== undefined) return slot.refreshing
    const run: Promise<void> = doRefresh(provider)
      .catch(() => {
        if (slot.status === 'connected') retry(provider)
      })
      .finally(() => {
        if (slot.refreshing === run) slot.refreshing = undefined
      })
    slot.refreshing = run
    return run
  }

  function revoke(provider: OAuthProvider, token: string | undefined): Promise<void> {
    return token === undefined ? Promise.resolve() : revokeRefreshToken({ provider, refreshToken: token, deps: { fetch: deps.fetch, clock } })
  }

  async function endFlow(provider: OAuthProvider): Promise<void> {
    const running = active
    if (running === undefined || running.provider !== provider) return
    running.signIn.cancel()
    await running.finished
  }

  function restingStatus(provider: OAuthProvider): OAuthStatus {
    return apps.has(provider) ? 'not_connected' : 'not_configured'
  }

  function forget(provider: OAuthProvider): void {
    const slot = slotOf(provider)
    dropTokens(slot)
    slot.account = undefined
    slot.scope = undefined
    slot.connectedAt = undefined
  }

  return {
    async start() {
      await ensureLoaded()
      const targets = OAUTH_PROVIDERS.filter((provider) => slotOf(provider).status === 'connected' && slotOf(provider).refreshToken !== undefined)
      if (targets.length === 0) return
      let timer: unknown
      const limit = new Promise<void>((resolve) => {
        timer = clock.setTimeout(resolve, START_WAIT_MS)
      })
      await Promise.race([Promise.all(targets.map((provider) => refresh(provider))), limit])
      clock.clearTimeout(timer)
    },

    async state() {
      await ensureLoaded()
      return {
        available: store.encryptionAvailable(),
        accounts: OAUTH_PROVIDERS.map(view),
        apps: OAUTH_PROVIDERS.map((provider) => {
          const app = apps.get(provider)
          return { provider, ...(app === undefined ? {} : { clientId: app.clientId }), hasSecret: app?.clientSecret !== undefined }
        }),
      }
    },

    async setApp(provider, app) {
      await ensureLoaded()
      requireKeychain()
      await endFlow(provider)
      const slot = slotOf(provider)
      const oldToken = slot.persistedToken
      const wasConnected = slot.status === 'connected'
      await guardedWrite(provider, () => store.setOAuthApp(provider, app))
      apps.set(provider, { clientId: app.clientId, ...(app.clientSecret === undefined ? {} : { clientSecret: app.clientSecret }) })
      forget(provider)
      if (wasConnected) pushRemove(provider)
      change(provider, () => {
        slot.status = 'not_connected'
      })
      await revoke(provider, oldToken)
    },

    async clearApp(provider) {
      await ensureLoaded()
      requireKeychain()
      await endFlow(provider)
      const slot = slotOf(provider)
      const oldToken = slot.persistedToken
      const wasConnected = slot.status === 'connected'
      await guardedWrite(provider, () => store.clearOAuthApp(provider))
      apps.delete(provider)
      forget(provider)
      if (wasConnected) pushRemove(provider)
      change(provider, () => {
        slot.status = 'not_configured'
      })
      await revoke(provider, oldToken)
    },

    async connect(provider) {
      await ensureLoaded()
      requireKeychain()
      const app = apps.get(provider)
      if (app === undefined) throw new HostError('OAUTH_NOT_CONFIGURED')
      if (active !== undefined) throw new HostError('OAUTH_BUSY')
      const slot = slotOf(provider)
      const previous = slot.status
      const signIn = startSignIn({ provider, app, deps: { fetch: deps.fetch, clock, openExternal: deps.openExternal, ...deps.flow } })
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      active = { provider, signIn, finished }
      change(provider, () => {
        slot.status = 'connecting'
      })
      try {
        const result = await signIn.done
        const oldToken = slot.persistedToken
        try {
          await guardedWrite(provider, () =>
            store.setOAuthAccount(provider, {
              refreshToken: result.refreshToken,
              scope: result.scope,
              ...(result.account === undefined ? {} : { account: result.account }),
              connectedAt: clock.now(),
            }),
          )
        } catch (error) {
          await revoke(provider, result.refreshToken)
          throw error
        }
        dropTokens(slot)
        slot.refreshToken = result.refreshToken
        slot.persistedToken = result.refreshToken
        slot.accessToken = result.accessToken
        slot.expiresAt = result.expiresAt
        slot.scope = result.scope
        slot.connectedAt = clock.now()
        slot.account = result.account
        schedule(provider)
        pushToken(provider)
        change(provider, () => {
          slot.status = 'connected'
        })
        if (oldToken !== undefined && oldToken !== result.refreshToken) await revoke(provider, oldToken)
        return result.account === undefined ? {} : { account: result.account }
      } catch (error) {
        change(provider, () => {
          if (slot.status === 'connecting') slot.status = previous
        })
        if (slot.timer === undefined && slot.refreshing === undefined) rearm(provider)
        throw error
      } finally {
        if (active?.signIn === signIn) active = undefined
        finish()
      }
    },

    cancel(provider) {
      if (active?.provider === provider) active.signIn.cancel()
    },

    async disconnect(provider) {
      await ensureLoaded()
      requireKeychain()
      await endFlow(provider)
      const slot = slotOf(provider)
      if (slot.status !== 'connected' && slot.status !== 'needs_reconnect') return
      const oldToken = slot.persistedToken
      const wasConnected = slot.status === 'connected'
      await guardedWrite(provider, () => store.clearOAuthAccount(provider))
      forget(provider)
      if (wasConnected) pushRemove(provider)
      change(provider, () => {
        slot.status = restingStatus(provider)
      })
      await revoke(provider, oldToken)
    },

    resume() {
      for (const provider of OAUTH_PROVIDERS) rearm(provider)
    },

    accountConnections() {
      return OAUTH_PROVIDERS.flatMap((provider) => {
        const slot = slotOf(provider)
        return hasLiveToken(slot) ? [{ name: provider, kind: provider, secret: slot.accessToken }] : []
      })
    },

    syncEngine() {
      for (const provider of OAUTH_PROVIDERS) {
        if (hasLiveToken(slotOf(provider))) pushToken(provider)
        else pushRemove(provider)
      }
    },

    async renew(request) {
      const parsed = parseRenewRequest(request)
      if (parsed === undefined) return
      const provider = parsed.name
      const slot = slotOf(provider)
      if (slot.status !== 'connected' || slot.refreshToken === undefined) return
      const now = clock.now()
      const last = lastRenewal.get(provider)
      if (last !== undefined && now - last < RENEW_INTERVAL_MS) return
      lastRenewal.set(provider, now)
      note(`oauth ${provider}: the engine asked for a new access token`)
      await refresh(provider)
    },

    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    stop() {
      for (const provider of OAUTH_PROVIDERS) clearTimer(slotOf(provider))
      active?.signIn.cancel()
    },
  }
}
