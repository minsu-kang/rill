// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOAuthManager, type OAuthManager } from '../src/main/oauth-manager'
import type { OAuthStore } from '../src/main/oauth-manager'
import { SecretStoreError, createSecretStore, type OAuthAccountRecord, type OAuthAppRecord, type SafeStorageLike } from '../src/main/secret-store'
import { HostError, isOAuthApp, type OAuthAccount, type OAuthProvider } from '../src/shared/host-api'
import {
  GOOGLE_ACCESS,
  GOOGLE_ACCESS_2,
  GOOGLE_APP,
  GOOGLE_CLIENT_ID,
  GOOGLE_REFRESH,
  GOOGLE_REFRESH_2,
  GOOGLE_SCOPE,
  ManualClock,
  MARKERS,
  MICROSOFT_ACCESS,
  MICROSOFT_ACCESS_2,
  MICROSOFT_APP,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_REFRESH_2,
  deferred,
  httpCall,
  json,
  microsoftTokenAnswer,
  scanFor,
  settle,
  tokenAnswer,
  type RecordedCall,
} from './oauth-helpers'

let dir: string
const managers: OAuthManager[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-oauth-manager-'))
})

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop()
  rmSync(dir, { recursive: true, force: true })
})

function fakeSafeStorage(): SafeStorageLike & { available: boolean } {
  const fake = {
    available: true,
    isEncryptionAvailable: () => fake.available,
    encryptString: (plain: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)]),
    decryptString: (encrypted: Buffer) => Buffer.from(encrypted.subarray(3).map((byte) => byte ^ 0x5a)).toString('utf8'),
  }
  return fake
}

type MemoryStore = OAuthStore & { available: boolean }

function memoryStore(available = true): MemoryStore {
  const apps = new Map<OAuthProvider, OAuthAppRecord>()
  const accounts = new Map<OAuthProvider, OAuthAccountRecord>()
  const store: MemoryStore = {
    available,
    encryptionAvailable: () => store.available,
    getOAuth: async () => (store.available ? { apps: Object.fromEntries([...apps].map(([p, a]) => [p, { ...a }])), accounts: Object.fromEntries([...accounts].map(([p, a]) => [p, { ...a }])) } : { apps: {}, accounts: {} }),
    setOAuthApp: async (provider, app) => {
      if (!isOAuthApp({ provider, ...app })) throw new SecretStoreError('invalid_value')
      apps.set(provider, { ...app })
      accounts.delete(provider)
      return true
    },
    clearOAuthApp: async (provider) => {
      const removedApp = apps.delete(provider)
      const removedAccount = accounts.delete(provider)
      return removedApp || removedAccount
    },
    setOAuthAccount: async (provider, account) => {
      if (!apps.has(provider)) throw new SecretStoreError('invalid_value')
      accounts.set(provider, { ...account })
      return true
    },
    clearOAuthAccount: async (provider) => accounts.delete(provider),
  }
  return store
}

type QueuedName = 'setOAuthApp' | 'clearOAuthApp' | 'setOAuthAccount' | 'clearOAuthAccount'

function queuedStore(inner: OAuthStore) {
  let tail: Promise<unknown> = Promise.resolve()
  const holds = new Map<QueuedName, Promise<void>>()
  const failures = new Set<QueuedName>()
  const serial = <T,>(name: QueuedName | 'read', work: () => Promise<T>): Promise<T> => {
    const hold = name === 'read' ? undefined : holds.get(name)
    if (name !== 'read') holds.delete(name)
    const fails = name !== 'read' && failures.delete(name)
    const run = tail.then(async () => {
      if (hold !== undefined) await hold
      if (fails) throw new Error('keychain locked')
      return work()
    })
    tail = run.catch(() => undefined)
    return run
  }
  const store: OAuthStore = {
    encryptionAvailable: () => inner.encryptionAvailable(),
    getOAuth: () => serial('read', () => inner.getOAuth()),
    setOAuthApp: (provider, app) => serial('setOAuthApp', () => inner.setOAuthApp(provider, app)),
    clearOAuthApp: (provider) => serial('clearOAuthApp', () => inner.clearOAuthApp(provider)),
    setOAuthAccount: (provider, account) => serial('setOAuthAccount', () => inner.setOAuthAccount(provider, account)),
    clearOAuthAccount: (provider) => serial('clearOAuthAccount', () => inner.clearOAuthAccount(provider)),
  }
  return {
    store,
    hold(name: QueuedName): () => void {
      const gate = deferred<void>()
      holds.set(name, gate.promise)
      return () => gate.resolve()
    },
    failNext(name: QueuedName): void {
      failures.add(name)
    },
  }
}

type Responder = (call: RecordedCall) => Response | Promise<Response>
type Mode = 'code' | 'denied' | 'none'

interface Options {
  random?: number
  mode?: Mode
  keychain?: boolean
  clock?: ManualClock
  store?: OAuthStore
  userinfo?: Responder
  revoke?: Responder
}

function build(options: Options = {}) {
  const clock = options.clock ?? new ManualClock()
  const realStore = options.store ?? memoryStore(options.keychain ?? true)
  const events: Array<[string, unknown]> = []
  const store: OAuthStore = {
    ...realStore,
    setOAuthAccount: async (provider, account) => {
      events.push(['store.account', { provider, ...account }])
      if (failAccountWrites) throw new Error('keychain locked')
      return realStore.setOAuthAccount(provider, account)
    },
    setOAuthApp: (provider, app) => realStore.setOAuthApp(provider, app),
    clearOAuthApp: (provider) => realStore.clearOAuthApp(provider),
    clearOAuthAccount: async (provider) => {
      events.push(['store.clear', provider])
      return realStore.clearOAuthAccount(provider)
    },
    encryptionAvailable: () => realStore.encryptionAvailable(),
    getOAuth: () => realStore.getOAuth(),
  }
  const calls: RecordedCall[] = []
  const queue: Responder[] = []
  const logs: string[] = []
  const changes: OAuthAccount[] = []
  const messages: unknown[] = []
  let mode: Mode = options.mode ?? 'code'
  let failSend = false
  let failAccountWrites = false
  const respond: Responder = (call) => {
    if (call.url.includes('/token')) {
      const next = queue.shift()
      if (next !== undefined) return next(call)
      return call.url.includes('microsoftonline') ? microsoftTokenAnswer() : tokenAnswer()
    }
    if (call.url.includes('userinfo')) return options.userinfo === undefined ? json({ email: 'someone@example.com' }) : options.userinfo(call)
    if (call.url.includes('graph.microsoft.com')) return json({ displayName: 'Alex Doe' })
    if (call.url.includes('/revoke')) return options.revoke === undefined ? new Response('', { status: 200 }) : options.revoke(call)
    return json({}, 404)
  }
  const manager = createOAuthManager({
    store,
    fetch: async (url, init) => {
      const call: RecordedCall = { url, init, form: new URLSearchParams(init.body ?? '') }
      calls.push(call)
      return respond(call)
    },
    openExternal: async (url) => {
      if (mode === 'none') return
      const params = new URL(url).searchParams
      const port = Number(new URL(params.get('redirect_uri')!).port)
      const query = mode === 'denied' ? `error=access_denied&error_description=PROVIDERTEXTMARKER&state=${params.get('state')}` : `code=AUTHCODEMARKER-4%2F0Af&state=${params.get('state')}`
      setImmediate(() => void httpCall({ port, path: `/oauth/callback?${query}` }).catch(() => undefined))
    },
    clock,
    engine: {
      send: (message) => {
        if (failSend) return false
        messages.push(message)
        events.push(['engine', message])
        return true
      },
    },
    random: () => options.random ?? 0,
    log: (message) => logs.push(message),
  })
  managers.push(manager)
  manager.onChange((change) => {
    changes.push(change)
    events.push(['change', change])
  })
  return {
    manager,
    clock,
    store,
    realStore,
    calls,
    queue,
    logs,
    changes,
    messages,
    events,
    setMode: (next: Mode) => {
      mode = next
    },
    failSends: (value: boolean) => {
      failSend = value
    },
    failAccountWrites: (value: boolean) => {
      failAccountWrites = value
    },
    tokenCalls: () => calls.filter((call) => call.url.includes('/token')),
    refreshCalls: () => calls.filter((call) => call.form.get('grant_type') === 'refresh_token'),
  }
}

type Harness = ReturnType<typeof build>

async function withApp(harness: Harness, provider: OAuthProvider = 'google'): Promise<void> {
  await harness.manager.setApp(provider, provider === 'google' ? GOOGLE_APP : MICROSOFT_APP)
}

async function connected(options: Options = {}, provider: OAuthProvider = 'google') {
  const harness = build(options)
  await withApp(harness, provider)
  const result = await harness.manager.connect(provider)
  harness.calls.length = 0
  harness.messages.length = 0
  harness.events.length = 0
  harness.changes.length = 0
  return { ...harness, result }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof HostError ? error.code : `other:${String(error)}`
  }
  return 'resolved'
}

async function statusOf(manager: OAuthManager, provider: OAuthProvider = 'google') {
  const state = await manager.state()
  return state.accounts.find((entry) => entry.provider === provider)
}

const GOOGLE_EXPIRY_DELAY = 3599_000 - 300_000

describe('state', () => {
  it('starts with both providers not configured and no apps', async () => {
    const { manager } = build()
    expect(await manager.state()).toEqual({
      available: true,
      accounts: [
        { provider: 'google', status: 'not_configured' },
        { provider: 'microsoft', status: 'not_configured' },
      ],
      apps: [
        { provider: 'google', hasSecret: false },
        { provider: 'microsoft', hasSecret: false },
      ],
    })
  })

  it('is unavailable without a keychain, and refuses to write', async () => {
    const { manager } = build({ keychain: false })
    expect((await manager.state()).available).toBe(false)
    expect(await codeOf(manager.setApp('google', GOOGLE_APP))).toBe('NO_KEYCHAIN')
    expect(await codeOf(manager.connect('google'))).toBe('NO_KEYCHAIN')
    expect(await codeOf(manager.clearApp('google'))).toBe('NO_KEYCHAIN')
    expect(await codeOf(manager.disconnect('google'))).toBe('NO_KEYCHAIN')
  })

  it('shows the app after it is saved: the Client ID, whether a secret exists, never the secret', async () => {
    const harness = build()
    await withApp(harness, 'google')
    await withApp(harness, 'microsoft')
    const state = await harness.manager.state()
    expect(state.apps).toEqual([
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, hasSecret: true },
      { provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID, hasSecret: false },
    ])
    expect(state.accounts.map((entry) => entry.status)).toEqual(['not_connected', 'not_connected'])
    expect(scanFor(JSON.stringify(state))).toEqual([])
    expect(harness.changes).toEqual([
      { provider: 'google', status: 'not_connected' },
      { provider: 'microsoft', status: 'not_connected' },
    ])
  })

  it('saves a Google app without a secret', async () => {
    const harness = build()
    await harness.manager.setApp('google', { clientId: GOOGLE_CLIENT_ID })
    expect((await harness.manager.state()).apps[0]).toEqual({ provider: 'google', clientId: GOOGLE_CLIENT_ID, hasSecret: false })
  })

  it('removes the app and goes back to not configured', async () => {
    const harness = build()
    await withApp(harness)
    harness.changes.length = 0
    await harness.manager.clearApp('google')
    expect(await statusOf(harness.manager)).toEqual({ provider: 'google', status: 'not_configured' })
    expect((await harness.manager.state()).apps[0]).toEqual({ provider: 'google', hasSecret: false })
    expect(harness.changes).toEqual([{ provider: 'google', status: 'not_configured' }])
  })

  it('loads what an earlier run stored', async () => {
    const first = await connected()
    const again = build({ store: first.realStore })
    expect(await statusOf(again.manager)).toEqual({ provider: 'google', status: 'connected', account: 'someone@example.com' })
    expect((await again.manager.state()).apps[0]).toEqual({ provider: 'google', clientId: GOOGLE_CLIENT_ID, hasSecret: true })
  })
})

describe('connect', () => {
  it('refuses without an app', async () => {
    const { manager } = build()
    expect(await codeOf(manager.connect('google'))).toBe('OAUTH_NOT_CONFIGURED')
  })

  it('signs in to Google, stores the account, tells the engine and shows the account', async () => {
    const harness = build()
    await withApp(harness)
    harness.changes.length = 0
    const result = await harness.manager.connect('google')
    expect(result).toEqual({ account: 'someone@example.com' })
    expect(harness.changes).toEqual([
      { provider: 'google', status: 'connecting' },
      { provider: 'google', status: 'connected', account: 'someone@example.com' },
    ])
    expect((await harness.realStore.getOAuth()).accounts.google).toEqual({ refreshToken: GOOGLE_REFRESH, scope: GOOGLE_SCOPE, account: 'someone@example.com', connectedAt: harness.clock.now() })
    expect(harness.messages).toEqual([{ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS }])
    expect(harness.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS }])
    expect(harness.clock.nextDelay()).toBe(GOOGLE_EXPIRY_DELAY)
    expect(await statusOf(harness.manager)).toEqual({ provider: 'google', status: 'connected', account: 'someone@example.com' })
  })

  it('signs in to Microsoft with the kind microsoft', async () => {
    const harness = build()
    await withApp(harness, 'microsoft')
    harness.queue.push(() => microsoftTokenAnswer())
    const result = await harness.manager.connect('microsoft')
    expect(result).toEqual({ account: 'Alex Doe' })
    expect(harness.messages).toEqual([{ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_ACCESS }])
    expect(harness.manager.accountConnections()).toEqual([{ name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_ACCESS }])
  })

  it('connects without a name when the account request fails', async () => {
    const harness = build({ userinfo: () => json({}, 500) })
    await withApp(harness)
    harness.changes.length = 0
    expect(await harness.manager.connect('google')).toEqual({})
    expect(await statusOf(harness.manager)).toEqual({ provider: 'google', status: 'connected' })
    expect(harness.changes).toEqual([
      { provider: 'google', status: 'connecting' },
      { provider: 'google', status: 'connected' },
    ])
  })

  it('refuses a second sign-in while one runs, for the same or the other provider', async () => {
    const harness = build({ mode: 'none' })
    await withApp(harness, 'google')
    await withApp(harness, 'microsoft')
    const first = harness.manager.connect('google').catch((error: unknown) => error)
    await settle()
    expect(await codeOf(harness.manager.connect('google'))).toBe('OAUTH_BUSY')
    expect(await codeOf(harness.manager.connect('microsoft'))).toBe('OAUTH_BUSY')
    expect((await statusOf(harness.manager, 'microsoft'))!.status).toBe('not_connected')
    harness.manager.cancel('google')
    expect(((await first) as HostError).code).toBe('OAUTH_CANCELLED')
    harness.setMode('code')
    expect((await harness.manager.connect('microsoft').catch(() => undefined)) !== undefined).toBe(true)
  })

  it('reports connecting while the browser is open', async () => {
    const harness = build({ mode: 'none' })
    await withApp(harness)
    const pending = harness.manager.connect('google').catch(() => undefined)
    await settle()
    expect(await statusOf(harness.manager)).toEqual({ provider: 'google', status: 'connecting' })
    harness.manager.cancel('google')
    await pending
  })

  it('ends with OAUTH_CANCELLED on cancel, goes back to not connected and stores nothing', async () => {
    const harness = build({ mode: 'none' })
    await withApp(harness)
    harness.changes.length = 0
    const pending = codeOf(harness.manager.connect('google'))
    await settle()
    harness.manager.cancel('microsoft')
    harness.manager.cancel('google')
    expect(await pending).toBe('OAUTH_CANCELLED')
    expect(harness.changes).toEqual([
      { provider: 'google', status: 'connecting' },
      { provider: 'google', status: 'not_connected' },
    ])
    expect((await harness.realStore.getOAuth()).accounts).toEqual({})
    expect(harness.messages).toEqual([])
  })

  it('ends with OAUTH_TIMEOUT after three minutes', async () => {
    const harness = build({ mode: 'none' })
    await withApp(harness)
    const pending = codeOf(harness.manager.connect('google'))
    await settle()
    await harness.clock.advance(180_000)
    expect(await pending).toBe('OAUTH_TIMEOUT')
    expect((await statusOf(harness.manager))!.status).toBe('not_connected')
  })

  it('ends with OAUTH_DENIED when the user refuses, and never shows the provider text', async () => {
    const harness = build({ mode: 'denied' })
    await withApp(harness)
    expect(await codeOf(harness.manager.connect('google'))).toBe('OAUTH_DENIED')
    expect(scanFor(JSON.stringify([harness.changes, harness.logs, harness.events]))).toEqual([])
    expect((await harness.realStore.getOAuth()).accounts).toEqual({})
  })

  it('ends with OAUTH_SCOPE_MISSING without a refresh token or with a short grant, and stores nothing', async () => {
    for (const answer of [() => tokenAnswer({ refresh_token: undefined }), () => tokenAnswer({ scope: 'openid email' })]) {
      const harness = build()
      await withApp(harness)
      harness.queue.push(answer)
      expect(await codeOf(harness.manager.connect('google'))).toBe('OAUTH_SCOPE_MISSING')
      expect((await harness.realStore.getOAuth()).accounts).toEqual({})
      expect(harness.messages).toEqual([])
      expect(harness.manager.accountConnections()).toEqual([])
    }
  })

  it('ends with OAUTH_EXCHANGE_FAILED when the token endpoint refuses', async () => {
    const harness = build()
    await withApp(harness)
    harness.queue.push(() => json({ error: 'invalid_client', error_description: 'PROVIDERTEXTMARKER' }, 401))
    expect(await codeOf(harness.manager.connect('google'))).toBe('OAUTH_EXCHANGE_FAILED')
    expect(scanFor(JSON.stringify([harness.changes, harness.logs, harness.messages]))).toEqual([])
  })

  it('keeps a connected account connected when a second sign-in fails, and needs reconnect when it was that', async () => {
    const harness = await connected()
    harness.setMode('denied')
    expect(await codeOf(harness.manager.connect('google'))).toBe('OAUTH_DENIED')
    expect((await statusOf(harness.manager))!.status).toBe('connected')
    expect(harness.manager.accountConnections()).toHaveLength(1)
    harness.queue.push(() => json({ error: 'invalid_grant' }, 400))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect((await statusOf(harness.manager))!.status).toBe('needs_reconnect')
    expect(await codeOf(harness.manager.connect('google'))).toBe('OAUTH_DENIED')
    expect((await statusOf(harness.manager))!.status).toBe('needs_reconnect')
  })

  it('replaces an account that is connected and revokes the old Google refresh token after storing the new one', async () => {
    const harness = await connected()
    harness.setMode('code')
    harness.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH_2 }))
    await harness.manager.connect('google')
    const revoke = harness.calls.find((call) => call.url.includes('/revoke'))!
    expect(revoke.form.get('token')).toBe(GOOGLE_REFRESH)
    expect((await harness.realStore.getOAuth()).accounts.google!.refreshToken).toBe(GOOGLE_REFRESH_2)
    expect(harness.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
  })

  it('throws when the account cannot be saved, revokes the new token, tells the engine nothing and goes back', async () => {
    const harness = build()
    await withApp(harness)
    harness.failAccountWrites(true)
    harness.changes.length = 0
    expect(await codeOf(harness.manager.connect('google'))).toMatch(/^other:/)
    expect(harness.changes).toEqual([
      { provider: 'google', status: 'connecting' },
      { provider: 'google', status: 'not_connected' },
    ])
    expect(harness.calls.find((call) => call.url.includes('/revoke'))!.form.get('token')).toBe(GOOGLE_REFRESH)
    expect(harness.messages).toEqual([])
    expect(harness.manager.accountConnections()).toEqual([])
    expect((await harness.realStore.getOAuth()).accounts).toEqual({})
  })
})

describe('refresh', () => {
  it('refreshes five minutes before expiry, minus a jitter of at most 30 seconds', async () => {
    for (const [random, delay] of [[0, 3299_000], [0.5, 3284_000], [0.999, 3299_000 - 29_970]] as const) {
      const harness = await connected({ random })
      expect(harness.clock.nextDelay(), String(random)).toBe(delay)
    }
  })

  it('never refreshes sooner than five seconds from now', async () => {
    const harness = build()
    await withApp(harness)
    harness.queue.push(() => tokenAnswer({ expires_in: 100 }))
    await harness.manager.connect('google')
    expect(harness.clock.nextDelay()).toBe(5000)
  })

  it('sends the new access token to the engine, schedules the next refresh and stays quiet for the window', async () => {
    const harness = await connected()
    harness.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.refreshCalls()).toHaveLength(1)
    expect(harness.refreshCalls()[0]!.form.get('refresh_token')).toBe(GOOGLE_REFRESH)
    expect(harness.messages).toEqual([{ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
    expect(harness.changes).toEqual([])
    expect(harness.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
    expect(harness.clock.nextDelay()).toBe(GOOGLE_EXPIRY_DELAY)
  })

  it('writes a rotated refresh token to the store before the new access token is used or sent', async () => {
    const harness = await connected({}, 'microsoft')
    harness.queue.push(() => microsoftTokenAnswer({ access_token: MICROSOFT_ACCESS_2, refresh_token: MICROSOFT_REFRESH_2 }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.events.map(([kind]) => kind)).toEqual(['store.account', 'engine'])
    expect((harness.events[0]![1] as { refreshToken: string }).refreshToken).toBe(MICROSOFT_REFRESH_2)
    expect((await harness.realStore.getOAuth()).accounts.microsoft!.refreshToken).toBe(MICROSOFT_REFRESH_2)
    harness.queue.push(() => microsoftTokenAnswer({ refresh_token: undefined }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.refreshCalls()[1]!.form.get('refresh_token')).toBe(MICROSOFT_REFRESH_2)
  })

  it('does not write the store when the refresh token did not change or is absent', async () => {
    const harness = await connected()
    harness.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    harness.queue.push(() => tokenAnswer({ refresh_token: undefined }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.events.filter(([kind]) => kind === 'store.account')).toEqual([])
  })

  it('does not use the new access token when the rotated refresh token cannot be saved, and saves it before it uses it at the next try', async () => {
    const harness = await connected({}, 'microsoft')
    harness.failAccountWrites(true)
    harness.queue.push(() => microsoftTokenAnswer({ access_token: MICROSOFT_ACCESS_2, refresh_token: MICROSOFT_REFRESH_2 }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.messages).toEqual([])
    expect(harness.manager.accountConnections().map((entry) => entry.secret)).toEqual([MICROSOFT_ACCESS])
    expect(harness.clock.nextDelay()).toBe(30_000)
    expect(scanFor(harness.logs.join('\n'))).toEqual([])
    harness.failAccountWrites(false)
    harness.events.length = 0
    harness.queue.push(() => microsoftTokenAnswer({ refresh_token: undefined }))
    await harness.clock.advance(30_000)
    expect(harness.refreshCalls()[1]!.form.get('refresh_token')).toBe(MICROSOFT_REFRESH_2)
    expect(harness.events.map(([kind]) => kind)).toEqual(['store.account', 'engine'])
    expect((await harness.realStore.getOAuth()).accounts.microsoft!.refreshToken).toBe(MICROSOFT_REFRESH_2)
  })

  it('makes one refresh at a time per provider, however many things ask', async () => {
    const harness = await connected()
    const gate = deferred<Response>()
    harness.queue.push(() => gate.promise)
    harness.clock.jump(GOOGLE_EXPIRY_DELAY)
    harness.manager.resume()
    harness.manager.resume()
    await harness.clock.advance(0)
    await harness.clock.advance(10)
    expect(harness.refreshCalls()).toHaveLength(1)
    gate.resolve(tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    await settle()
    expect(harness.refreshCalls()).toHaveLength(1)
    expect(harness.manager.accountConnections()[0]!.secret).toBe(GOOGLE_ACCESS_2)
  })

  it('goes to needs reconnect on invalid_grant: deletes the refresh token, removes the connection from the engine and says so', async () => {
    const harness = await connected()
    harness.queue.push(() => json({ error: 'invalid_grant', error_description: 'PROVIDERTEXTMARKER' }, 400))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.changes).toEqual([{ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' }])
    expect(harness.messages).toEqual([{ type: 'connection.remove', name: 'google' }])
    expect(harness.manager.accountConnections()).toEqual([])
    const stored = (await harness.realStore.getOAuth()).accounts.google!
    expect(stored.refreshToken).toBeUndefined()
    expect(stored.needsReconnect).toBe(true)
    expect(harness.clock.pending()).toBe(0)
    expect(scanFor(harness.logs.join('\n'))).toEqual([])
    expect(harness.logs).toEqual(['oauth google: the sign-in was withdrawn, reconnect needed'])
  })

  it('goes to needs reconnect when the provider answers 400 unauthorized_client or invalid_request, and does not retry', async () => {
    for (const error of ['unauthorized_client', 'invalid_request']) {
      const harness = await connected({}, 'microsoft')
      harness.queue.push(() => json({ error, error_description: 'PROVIDERTEXTMARKER' }, 400))
      await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
      expect(await statusOf(harness.manager, 'microsoft'), error).toEqual({ provider: 'microsoft', status: 'needs_reconnect', account: 'Alex Doe' })
      expect(harness.messages, error).toEqual([{ type: 'connection.remove', name: 'microsoft' }])
      expect(harness.clock.pending(), error).toBe(0)
      expect(scanFor(harness.logs.join('\n'))).toEqual([])
    }
  })

  it('goes to needs reconnect on invalid_client too, and survives a restart of the app in that state', async () => {
    const harness = await connected()
    harness.queue.push(() => json({ error: 'invalid_client' }, 401))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    harness.manager.stop()
    const again = build({ store: harness.realStore })
    expect(await statusOf(again.manager)).toEqual({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
    await again.manager.start()
    expect(again.calls).toEqual([])
  })

  it('stays connected and retries after 30 seconds, 1, 2 and 5 minutes on a network error, and then every 5 minutes', async () => {
    const harness = await connected()
    for (let i = 0; i < 6; i++) harness.queue.push(() => Promise.reject(new Error('offline PROVIDERTEXTMARKER')))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      delays.push(harness.clock.nextDelay()!)
      await harness.clock.advance(harness.clock.nextDelay()!)
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 300_000, 300_000])
    expect(harness.refreshCalls()).toHaveLength(6)
    expect((await statusOf(harness.manager))!.status).toBe('connected')
    expect(harness.changes).toEqual([])
    expect(scanFor(harness.logs.join('\n'))).toEqual([])
  })

  it('starts the back-off over after a success', async () => {
    const harness = await connected()
    harness.queue.push(() => Promise.reject(new Error('offline')))
    harness.queue.push(() => Promise.reject(new Error('offline')))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    await harness.clock.advance(30_000)
    expect(harness.clock.nextDelay()).toBe(60_000)
    await harness.clock.advance(60_000)
    expect(harness.clock.nextDelay()).toBe(GOOGLE_EXPIRY_DELAY)
    harness.queue.push(() => new Response('', { status: 503 }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.clock.nextDelay()).toBe(30_000)
  })

  it('honours Retry-After when it is longer than the back-off, and keeps the back-off when it is shorter', async () => {
    const harness = await connected()
    harness.queue.push(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.clock.nextDelay()).toBe(120_000)
    harness.queue.push(() => new Response('', { status: 429, headers: { 'retry-after': '5' } }))
    await harness.clock.advance(120_000)
    expect(harness.clock.nextDelay()).toBe(60_000)
  })

  it('treats a 5xx answer and an unusable answer as temporary', async () => {
    const harness = await connected()
    harness.queue.push(() => new Response('PROVIDERTEXTMARKER', { status: 500 }))
    harness.queue.push(() => new Response('not json', { status: 200 }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    await harness.clock.advance(30_000)
    expect((await statusOf(harness.manager))!.status).toBe('connected')
    expect(harness.clock.nextDelay()).toBe(60_000)
  })

  it('keeps the old access token for the engine while a refresh is failing, until that token expires', async () => {
    const harness = await connected()
    harness.queue.push(() => Promise.reject(new Error('offline')))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(harness.messages).toEqual([])
    expect(harness.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS }])
    harness.clock.jump(300_000)
    expect(harness.manager.accountConnections()).toEqual([])
  })
})

describe('start', () => {
  it('refreshes every connected account before it returns and gives the engine the new token', async () => {
    const first = await connected()
    first.manager.stop()
    const again = build({ store: first.realStore, clock: first.clock })
    again.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    await again.manager.start()
    expect(again.refreshCalls()).toHaveLength(1)
    expect(again.refreshCalls()[0]!.form.get('refresh_token')).toBe(GOOGLE_REFRESH)
    expect(again.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
  })

  it('returns at once when nothing is connected, with no timer left', async () => {
    const harness = build()
    await harness.manager.start()
    await withApp(harness)
    await harness.manager.start()
    expect(harness.calls).toEqual([])
    expect(harness.clock.pending()).toBe(0)
  })

  it('waits at most ten seconds for a refresh that does not answer, and the refresh still lands later', async () => {
    const first = await connected()
    first.manager.stop()
    const again = build({ store: first.realStore, clock: first.clock })
    const gate = deferred<Response>()
    again.queue.push(() => gate.promise)
    let returned = false
    const started = again.manager.start().then(() => {
      returned = true
    })
    await settle()
    expect(returned).toBe(false)
    await again.clock.advance(9_999)
    expect(returned).toBe(false)
    await again.clock.advance(1)
    await started
    expect(returned).toBe(true)
    expect(again.manager.accountConnections()).toEqual([])
    gate.resolve(tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    await settle()
    expect(again.messages).toEqual([{ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
  })

  it('returns after a network failure without waiting for the ten seconds, with no token for the engine and a retry planned', async () => {
    const first = await connected()
    first.manager.stop()
    const again = build({ store: first.realStore, clock: first.clock })
    again.queue.push(() => Promise.reject(new Error('offline')))
    await again.manager.start()
    expect(again.manager.accountConnections()).toEqual([])
    expect(again.clock.nextDelay()).toBe(30_000)
    again.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    await again.clock.advance(30_000)
    expect(again.messages).toEqual([{ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
  })
})

describe('wake', () => {
  it('refreshes a token that is expired or about to expire', async () => {
    const harness = await connected()
    harness.clock.jump(GOOGLE_EXPIRY_DELAY + 1000)
    harness.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    harness.manager.resume()
    await settle()
    expect(harness.refreshCalls()).toHaveLength(1)
    expect(harness.manager.accountConnections()[0]!.secret).toBe(GOOGLE_ACCESS_2)
  })

  it('does not call the provider for a token that is still fresh, and keeps one timer', async () => {
    const harness = await connected()
    harness.clock.jump(60_000)
    harness.manager.resume()
    await settle()
    expect(harness.refreshCalls()).toHaveLength(0)
    expect(harness.clock.pending()).toBe(1)
  })

  it('does nothing for an account that needs reconnecting or is not set up', async () => {
    const harness = await connected()
    harness.queue.push(() => json({ error: 'invalid_grant' }, 400))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    harness.calls.length = 0
    harness.manager.resume()
    await settle()
    expect(harness.calls).toEqual([])
  })

  it('refreshes at once when an earlier refresh failed and no token is held', async () => {
    const harness = await connected()
    harness.queue.push(() => Promise.reject(new Error('offline')))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    harness.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: undefined }))
    harness.manager.resume()
    await settle()
    expect(harness.manager.accountConnections()[0]!.secret).toBe(GOOGLE_ACCESS_2)
  })
})

describe('the engine', () => {
  it('gets the current tokens again when asked, as the four-key messages and nothing else', async () => {
    const harness = await connected()
    harness.messages.length = 0
    harness.manager.syncEngine()
    expect(harness.messages).toEqual([
      { type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS },
      { type: 'connection.remove', name: 'microsoft' },
    ])
    expect(Object.keys(harness.messages[0] as object).sort()).toEqual(['kind', 'name', 'secret', 'type'])
    expect(Object.keys(harness.messages[1] as object).sort()).toEqual(['name', 'type'])
  })

  it('tells the engine to drop an account that is not connected, has no token or whose token has expired', async () => {
    const removes = [
      { type: 'connection.remove', name: 'google' },
      { type: 'connection.remove', name: 'microsoft' },
    ]
    const harness = build()
    await withApp(harness)
    harness.manager.syncEngine()
    expect(harness.messages).toEqual(removes)
    const connectedOne = await connected()
    connectedOne.messages.length = 0
    connectedOne.clock.jump(GOOGLE_EXPIRY_DELAY + 400_000)
    connectedOne.manager.syncEngine()
    expect(connectedOne.messages).toEqual(removes)
    expect(connectedOne.manager.accountConnections()).toEqual([])
  })

  it('tells an engine that was not listening when the account was disconnected to forget it once it runs', async () => {
    const harness = await connected()
    harness.failSends(true)
    await harness.manager.disconnect('google')
    expect(harness.messages).toEqual([])
    harness.failSends(false)
    harness.manager.syncEngine()
    expect(harness.messages).toEqual([
      { type: 'connection.remove', name: 'google' },
      { type: 'connection.remove', name: 'microsoft' },
    ])
  })

  it('sends tokens for both providers after a restart of the engine', async () => {
    const harness = await connected()
    await withApp(harness, 'microsoft')
    harness.queue.push(() => microsoftTokenAnswer())
    await harness.manager.connect('microsoft')
    harness.messages.length = 0
    harness.manager.syncEngine()
    expect(harness.messages).toEqual([
      { type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS },
      { type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_ACCESS },
    ])
  })

  it('does not fail when the engine is not running and the message cannot be sent', async () => {
    const harness = build()
    harness.failSends(true)
    await withApp(harness)
    await expect(harness.manager.connect('google')).resolves.toEqual({ account: 'someone@example.com' })
  })
})

describe('disconnect', () => {
  it('revokes the Google refresh token, removes the connection from the engine, clears the account and the timer', async () => {
    const harness = await connected()
    await harness.manager.disconnect('google')
    expect(harness.calls.map((call) => call.url)).toEqual(['https://oauth2.googleapis.com/revoke'])
    expect(harness.calls[0]!.form.get('token')).toBe(GOOGLE_REFRESH)
    expect(harness.messages).toEqual([{ type: 'connection.remove', name: 'google' }])
    expect(harness.changes).toEqual([{ provider: 'google', status: 'not_connected' }])
    expect((await harness.realStore.getOAuth()).accounts).toEqual({})
    expect((await harness.realStore.getOAuth()).apps.google).toEqual(GOOGLE_APP)
    expect(harness.clock.pending()).toBe(0)
    expect(harness.manager.accountConnections()).toEqual([])
  })

  it('finishes locally before the revoke answers, and gives up on a revoke that hangs after 15 seconds', async () => {
    const first = await connected()
    first.manager.stop()
    const again = build({
      store: first.realStore,
      revoke: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    let finished = false
    const pending = again.manager.disconnect('google').then(() => {
      finished = true
    })
    await settle()
    expect(finished).toBe(false)
    expect((await first.realStore.getOAuth()).accounts).toEqual({})
    expect(again.changes).toEqual([{ provider: 'google', status: 'not_connected' }])
    expect(again.messages).toEqual([{ type: 'connection.remove', name: 'google' }])
    await again.clock.advance(15_000)
    await pending
    expect(finished).toBe(true)
  })

  it('ignores a revoke that fails', async () => {
    const first = await connected()
    first.manager.stop()
    const again = build({ store: first.realStore, revoke: () => Promise.reject(new Error('offline PROVIDERTEXTMARKER')) })
    await expect(again.manager.disconnect('google')).resolves.toBeUndefined()
    expect(await statusOf(again.manager)).toEqual({ provider: 'google', status: 'not_connected' })
    expect(scanFor(again.logs.join('\n'))).toEqual([])
  })

  it('makes no request for Microsoft, which has no revoke', async () => {
    const harness = await connected({}, 'microsoft')
    await harness.manager.disconnect('microsoft')
    expect(harness.calls).toEqual([])
    expect(harness.messages).toEqual([{ type: 'connection.remove', name: 'microsoft' }])
  })

  it('clears an account that needs reconnecting, and does nothing for one that is not connected', async () => {
    const harness = await connected()
    harness.queue.push(() => json({ error: 'invalid_grant' }, 400))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    harness.changes.length = 0
    await harness.manager.disconnect('google')
    expect(harness.changes).toEqual([{ provider: 'google', status: 'not_connected' }])
    harness.changes.length = 0
    harness.calls.length = 0
    await harness.manager.disconnect('google')
    expect(harness.changes).toEqual([])
    expect(harness.calls).toEqual([])
  })

  it('cancels a sign-in that is running', async () => {
    const harness = build({ mode: 'none' })
    await withApp(harness)
    const pending = codeOf(harness.manager.connect('google'))
    await settle()
    await harness.manager.disconnect('google')
    expect(await pending).toBe('OAUTH_CANCELLED')
    expect((await statusOf(harness.manager))!.status).toBe('not_connected')
  })

  it('ignores the result of a refresh that was in flight', async () => {
    const harness = await connected()
    const gate = deferred<Response>()
    harness.queue.push(() => gate.promise)
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    await harness.manager.disconnect('google')
    harness.messages.length = 0
    gate.resolve(tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH_2 }))
    await settle()
    expect(harness.messages).toEqual([])
    expect(harness.manager.accountConnections()).toEqual([])
    expect((await harness.realStore.getOAuth()).accounts).toEqual({})
    expect(harness.clock.pending()).toBe(0)
  })
})

describe('changing the app', () => {
  it('disconnects a connected provider first: revoke, engine removal, no account, new app', async () => {
    const harness = await connected()
    await harness.manager.setApp('google', { clientId: '987654321098-zyxwvutsrqponm.apps.googleusercontent.com' })
    expect(harness.calls.map((call) => call.url)).toEqual(['https://oauth2.googleapis.com/revoke'])
    expect(harness.calls[0]!.form.get('token')).toBe(GOOGLE_REFRESH)
    expect(harness.messages).toEqual([{ type: 'connection.remove', name: 'google' }])
    expect(await statusOf(harness.manager)).toEqual({ provider: 'google', status: 'not_connected' })
    expect((await harness.manager.state()).apps[0]).toEqual({ provider: 'google', clientId: '987654321098-zyxwvutsrqponm.apps.googleusercontent.com', hasSecret: false })
    expect((await harness.realStore.getOAuth()).accounts).toEqual({})
    expect(harness.clock.pending()).toBe(0)
  })

  it('disconnects an account that needs reconnecting too, and leaves the other provider alone', async () => {
    const harness = await connected()
    await withApp(harness, 'microsoft')
    harness.queue.push(() => microsoftTokenAnswer())
    await harness.manager.connect('microsoft')
    harness.messages.length = 0
    await harness.manager.setApp('google', { clientId: GOOGLE_CLIENT_ID })
    expect((await statusOf(harness.manager, 'microsoft'))!.status).toBe('connected')
    expect(harness.messages).toEqual([{ type: 'connection.remove', name: 'google' }])
  })

  it('cancels a sign-in that is running for that provider', async () => {
    const harness = build({ mode: 'none' })
    await withApp(harness)
    const pending = codeOf(harness.manager.connect('google'))
    await settle()
    await harness.manager.setApp('google', { clientId: GOOGLE_CLIENT_ID })
    expect(await pending).toBe('OAUTH_CANCELLED')
    expect((await statusOf(harness.manager))!.status).toBe('not_connected')
  })

  it('removes the app of a connected provider together with its account', async () => {
    const harness = await connected()
    await harness.manager.clearApp('google')
    expect(harness.calls.map((call) => call.url)).toEqual(['https://oauth2.googleapis.com/revoke'])
    expect(harness.messages).toEqual([{ type: 'connection.remove', name: 'google' }])
    expect(await statusOf(harness.manager)).toEqual({ provider: 'google', status: 'not_configured' })
    expect(await harness.realStore.getOAuth()).toEqual({ apps: {}, accounts: {} })
    expect(harness.clock.pending()).toBe(0)
  })

  it('keeps everything when the store refuses the new app', async () => {
    const harness = await connected()
    await expect(harness.manager.setApp('google', { clientId: 'not a client id' })).rejects.toBeInstanceOf(Error)
    expect((await statusOf(harness.manager))!.status).toBe('connected')
    expect(harness.calls).toEqual([])
    expect(harness.messages).toEqual([])
    expect(harness.manager.accountConnections()).toHaveLength(1)
  })
})

describe('a write that overlaps a refresh', () => {
  const STALE_REFRESH = '1//0gREFRESHMARKER-STALE-0123456789abcdefghijkl'
  const OTHER_GOOGLE_ID = '987654321098-zyxwvutsrqponm.apps.googleusercontent.com'

  async function queuedConnected(provider: OAuthProvider) {
    const queued = queuedStore(memoryStore())
    const harness = await connected({ store: queued.store }, provider)
    return { ...harness, queued }
  }

  async function refreshInFlight(harness: Awaited<ReturnType<typeof queuedConnected>>) {
    const gate = deferred<Response>()
    harness.queue.push(() => gate.promise)
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    return gate
  }

  it('does not write a rotated refresh token behind a disconnect that is still writing', async () => {
    const h = await queuedConnected('microsoft')
    const gate = await refreshInFlight(h)
    const release = h.queued.hold('clearOAuthAccount')
    const disconnecting = h.manager.disconnect('microsoft')
    await settle()
    gate.resolve(microsoftTokenAnswer({ access_token: MICROSOFT_ACCESS_2, refresh_token: MICROSOFT_REFRESH_2 }))
    await settle()
    release()
    await disconnecting
    await settle()
    expect((await h.realStore.getOAuth()).accounts).toEqual({})
    expect(h.messages).toEqual([{ type: 'connection.remove', name: 'microsoft' }])
    expect(h.manager.accountConnections()).toEqual([])
    const again = build({ store: h.realStore })
    expect(await statusOf(again.manager, 'microsoft')).toEqual({ provider: 'microsoft', status: 'not_connected' })
  })

  it('does not write the reconnect mark behind a disconnect that is still writing', async () => {
    const h = await queuedConnected('microsoft')
    const gate = await refreshInFlight(h)
    const release = h.queued.hold('clearOAuthAccount')
    const disconnecting = h.manager.disconnect('microsoft')
    await settle()
    gate.resolve(json({ error: 'invalid_grant' }, 400))
    await settle()
    release()
    await disconnecting
    await settle()
    expect((await h.realStore.getOAuth()).accounts).toEqual({})
    expect(h.logs).toEqual([])
    const again = build({ store: h.realStore })
    expect(await statusOf(again.manager, 'microsoft')).toEqual({ provider: 'microsoft', status: 'not_connected' })
  })

  it('does not keep the old sign-in under a new app that is still being written', async () => {
    const h = await queuedConnected('google')
    const gate = await refreshInFlight(h)
    const release = h.queued.hold('setOAuthApp')
    const saving = h.manager.setApp('google', { clientId: OTHER_GOOGLE_ID })
    await settle()
    gate.resolve(tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH_2 }))
    await settle()
    release()
    await saving
    await settle()
    const records = await h.realStore.getOAuth()
    expect(records.apps.google).toEqual({ clientId: OTHER_GOOGLE_ID })
    expect(records.accounts).toEqual({})
    expect(h.manager.accountConnections()).toEqual([])
    expect(await statusOf(h.manager)).toEqual({ provider: 'google', status: 'not_connected' })
  })

  it('does not write an account behind an app that is being removed', async () => {
    const h = await queuedConnected('google')
    const gate = await refreshInFlight(h)
    const release = h.queued.hold('clearOAuthApp')
    const removing = h.manager.clearApp('google')
    await settle()
    gate.resolve(tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH_2 }))
    await settle()
    release()
    await removing
    await settle()
    expect(await h.realStore.getOAuth()).toEqual({ apps: {}, accounts: {} })
    expect(h.logs).toEqual([])
    expect(h.clock.pending()).toBe(0)
  })

  it('does not let a stale rotated refresh token replace the account that a new sign-in is saving', async () => {
    const h = await queuedConnected('google')
    const gate = await refreshInFlight(h)
    const release = h.queued.hold('setOAuthAccount')
    h.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH_2 }))
    const signingIn = h.manager.connect('google')
    await vi.waitFor(() => expect(h.events.some(([name]) => name === 'store.account')).toBe(true))
    gate.resolve(tokenAnswer({ refresh_token: STALE_REFRESH }))
    await settle()
    release()
    await signingIn
    await settle()
    expect((await h.realStore.getOAuth()).accounts.google!.refreshToken).toBe(GOOGLE_REFRESH_2)
    expect(h.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS_2 }])
  })

  it('keeps the account and refreshes it again when the store cannot clear it', async () => {
    const h = await queuedConnected('google')
    const gate = await refreshInFlight(h)
    const release = h.queued.hold('clearOAuthAccount')
    h.queued.failNext('clearOAuthAccount')
    const outcome = h.manager.disconnect('google').then(
      () => 'done',
      () => 'failed',
    )
    await settle()
    gate.resolve(tokenAnswer({ access_token: GOOGLE_ACCESS_2 }))
    await settle()
    release()
    expect(await outcome).toBe('failed')
    await settle()
    expect(await statusOf(h.manager)).toEqual({ provider: 'google', status: 'connected', account: 'someone@example.com' })
    expect(h.messages).not.toContainEqual({ type: 'connection.remove', name: 'google' })
    expect(h.refreshCalls()).toHaveLength(2)
    expect(h.clock.pending()).toBe(1)
    expect(h.manager.accountConnections()).toEqual([{ name: 'google', kind: 'google', secret: GOOGLE_ACCESS }])
  })

  it('keeps the account and its refresh schedule when the store cannot save a new app', async () => {
    const h = await queuedConnected('google')
    h.queued.failNext('setOAuthApp')
    await expect(h.manager.setApp('google', { clientId: OTHER_GOOGLE_ID })).rejects.toBeInstanceOf(Error)
    expect((await statusOf(h.manager))!.status).toBe('connected')
    expect(h.clock.pending()).toBe(1)
    await h.clock.advance(GOOGLE_EXPIRY_DELAY)
    expect(h.refreshCalls()).toHaveLength(1)
  })

  it('refreshes again after a sign-in attempt that ended while the refresh timer ran', async () => {
    const h = await connected()
    h.setMode('none')
    await h.clock.advance(GOOGLE_EXPIRY_DELAY - 60_000)
    const pending = codeOf(h.manager.connect('google'))
    await settle()
    await h.clock.advance(70_000)
    expect(h.refreshCalls()).toHaveLength(0)
    h.manager.cancel('google')
    expect(await pending).toBe('OAUTH_CANCELLED')
    await settle()
    expect((await statusOf(h.manager))!.status).toBe('connected')
    expect(h.refreshCalls()).toHaveLength(1)
    expect(h.clock.pending()).toBe(1)
  })
})

describe('stop', () => {
  it('clears the timers and ends a sign-in that is running', async () => {
    const harness = await connected()
    expect(harness.clock.pending()).toBe(1)
    harness.manager.stop()
    expect(harness.clock.pending()).toBe(0)
    const pending = build({ mode: 'none' })
    await withApp(pending)
    const running = codeOf(pending.manager.connect('google'))
    await settle()
    pending.manager.stop()
    expect(await running).toBe('OAUTH_CANCELLED')
  })
})

describe('listeners', () => {
  it('stops calling a listener that unsubscribed, and survives one that throws', async () => {
    const harness = build()
    const seen: string[] = []
    const off = harness.manager.onChange((change) => seen.push(change.status))
    harness.manager.onChange(() => {
      throw new Error('listener failed')
    })
    await withApp(harness)
    off()
    await harness.manager.clearApp('google')
    expect(seen).toEqual(['not_connected'])
  })
})

describe('nothing secret leaves the manager', () => {
  it('keeps every secret out of the state, the events, the logs and the errors, and sends the engine nothing but the access token', async () => {
    const harness = build()
    await withApp(harness)
    const outputs: unknown[] = []
    outputs.push(await harness.manager.connect('google'))
    harness.queue.push(() => Promise.reject(new Error('offline PROVIDERTEXTMARKER')))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    harness.queue.push(() => tokenAnswer({ access_token: GOOGLE_ACCESS_2, refresh_token: GOOGLE_REFRESH_2 }))
    await harness.clock.advance(30_000)
    outputs.push(await harness.manager.state())
    harness.setMode('denied')
    outputs.push(String(await harness.manager.connect('google').catch((error: unknown) => error)))
    harness.queue.push(() => json({ error: 'invalid_grant', error_description: 'PROVIDERTEXTMARKER' }, 400))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    outputs.push(await harness.manager.state(), harness.changes, harness.logs)
    expect(scanFor(JSON.stringify(outputs))).toEqual([])
    const withoutAccessToken = harness.messages.map((message) => ({ ...(message as object), secret: undefined }))
    expect(scanFor(JSON.stringify(withoutAccessToken))).toEqual([])
    for (const message of harness.messages) expect([GOOGLE_ACCESS, GOOGLE_ACCESS_2, undefined]).toContain((message as { secret?: string }).secret)
    for (const call of harness.calls) expect(['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', 'https://oauth2.googleapis.com/revoke']).toContain(call.url)
    expect(MARKERS.length).toBeGreaterThan(0)
  })
})

describe('with the real encrypted store', () => {
  async function until(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('keeps no refresh token in the file once the sign-in was withdrawn, and remembers the mark in a new run', async () => {
    const safeStorage = fakeSafeStorage()
    const real = createSecretStore({ dir, safeStorage })
    const harness = build({ store: real })
    await withApp(harness)
    await harness.manager.connect('google')
    const before = safeStorage.decryptString(readFileSync(join(dir, 'secrets.bin')))
    expect(before).toContain(GOOGLE_REFRESH)
    harness.queue.push(() => json({ error: 'invalid_grant' }, 400))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    await until(async () => (await real.getOAuth()).accounts.google?.needsReconnect === true)
    const raw = readFileSync(join(dir, 'secrets.bin'))
    const after = safeStorage.decryptString(raw)
    expect(scanFor(raw.toString('latin1') + after, ['REFRESHMARKER'])).toEqual([])
    expect(after).toContain('needsReconnect')
    harness.manager.stop()
    const again = build({ store: createSecretStore({ dir, safeStorage }) })
    expect(await statusOf(again.manager)).toEqual({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
  })

  it('writes a rotated refresh token to the file before it sends the new access token', async () => {
    const safeStorage = fakeSafeStorage()
    const real = createSecretStore({ dir, safeStorage })
    const harness = build({ store: real })
    await withApp(harness, 'microsoft')
    harness.queue.push(() => microsoftTokenAnswer())
    await harness.manager.connect('microsoft')
    harness.messages.length = 0
    const writes: string[] = []
    const original = real.setOAuthAccount.bind(real)
    real.setOAuthAccount = async (provider, account) => {
      const result = await original(provider, account)
      writes.push(safeStorage.decryptString(readFileSync(join(dir, 'secrets.bin'))))
      return result
    }
    harness.queue.push(() => microsoftTokenAnswer({ access_token: MICROSOFT_ACCESS_2, refresh_token: MICROSOFT_REFRESH_2 }))
    await harness.clock.advance(GOOGLE_EXPIRY_DELAY)
    await until(async () => harness.messages.length > 0)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(MICROSOFT_REFRESH_2)
    expect(harness.messages).toEqual([{ type: 'connection.set', name: 'microsoft', kind: 'microsoft', secret: MICROSOFT_ACCESS_2 }])
  })
})
