import { describe, expect, it } from 'vitest'
import { createFakeHost, fakeSettings, type FakeOAuthFlow } from '../src/engine/fake-host'
import { HostError, SettingsSchema, hostErrorCode, type OAuthAccount, type OAuthProvider } from '../src/shared/host-api'
import Value from 'typebox/value'

const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const GOOGLE_SECRET = 'GOCSPX-CLIENTSECRETMARKER0123456789'
const MICROSOFT_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(HostError)
    return hostErrorCode(error)
  }
  throw new Error('expected a rejection')
}

function ready(flows: Partial<Record<OAuthProvider, FakeOAuthFlow>> = {}, settings: Parameters<typeof fakeSettings>[0] = {}) {
  const host = createFakeHost({ settings: fakeSettings(settings) }, { restartDelayMs: 0, oauthFlows: flows })
  const changes: OAuthAccount[] = []
  host.oauth.onChanged((change) => changes.push(change))
  return { host, changes }
}

const statusOf = async (host: ReturnType<typeof createFakeHost>, provider: OAuthProvider) => (await host.settings.get()).oauth.accounts.find((entry) => entry.provider === provider)

describe('createFakeHost oauth: state', () => {
  it('starts with both providers not configured and no apps, and is available with a keychain', async () => {
    const { host } = ready()
    expect((await host.settings.get()).oauth).toEqual({
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

  it('is unavailable without a keychain and refuses every change with NO_KEYCHAIN', async () => {
    const { host } = ready({}, { encryptionAvailable: false })
    expect((await host.settings.get()).oauth.available).toBe(false)
    expect(await codeOf(host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID }))).toBe('NO_KEYCHAIN')
    expect(await codeOf(host.oauth.clearApp('google'))).toBe('NO_KEYCHAIN')
    expect(await codeOf(host.oauth.connect('google'))).toBe('NO_KEYCHAIN')
    expect(await codeOf(host.oauth.disconnect('google'))).toBe('NO_KEYCHAIN')
  })

  it('fills the missing rows of a state that a story gives in part', async () => {
    const { host } = ready({}, { oauth: { available: true, accounts: [{ provider: 'google', status: 'connected', account: 'someone@example.com' }], apps: [{ provider: 'google', clientId: GOOGLE_ID, hasSecret: true }] } })
    const oauth = (await host.settings.get()).oauth
    expect(oauth.accounts).toEqual([
      { provider: 'google', status: 'connected', account: 'someone@example.com' },
      { provider: 'microsoft', status: 'not_configured' },
    ])
    expect(oauth.apps).toEqual([
      { provider: 'google', clientId: GOOGLE_ID, hasSecret: true },
      { provider: 'microsoft', hasSecret: false },
    ])
    expect(Value.Check(SettingsSchema, await host.settings.get())).toBe(true)
  })

  it('starts a provider with an app and no account as not connected', async () => {
    const { host } = ready({}, { oauth: { available: true, accounts: [], apps: [{ provider: 'microsoft', clientId: MICROSOFT_ID, hasSecret: false }] } })
    expect((await statusOf(host, 'microsoft'))!.status).toBe('not_connected')
    expect((await statusOf(host, 'google'))!.status).toBe('not_configured')
  })
})

describe('createFakeHost oauth: the app', () => {
  it('saves the app with the same rules as the real host and keeps the secret out of everything it shows', async () => {
    const { host, changes } = ready()
    expect(await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID, clientSecret: GOOGLE_SECRET })).toEqual({})
    expect(await host.oauth.setApp({ provider: 'microsoft', clientId: MICROSOFT_ID })).toEqual({})
    const oauth = (await host.settings.get()).oauth
    expect(oauth.apps).toEqual([
      { provider: 'google', clientId: GOOGLE_ID, hasSecret: true },
      { provider: 'microsoft', clientId: MICROSOFT_ID, hasSecret: false },
    ])
    expect(oauth.accounts.map((entry) => entry.status)).toEqual(['not_connected', 'not_connected'])
    expect(JSON.stringify([await host.settings.get(), host.state(), changes])).not.toContain('CLIENTSECRETMARKER')
    expect(changes).toEqual([
      { provider: 'google', status: 'not_connected' },
      { provider: 'microsoft', status: 'not_connected' },
    ])
  })

  it('refuses values that the real host refuses, with INVALID_ARGUMENTS', async () => {
    const { host } = ready()
    for (const app of [
      { provider: 'google' as const, clientId: 'not a client id' },
      { provider: 'google' as const, clientId: MICROSOFT_ID },
      { provider: 'microsoft' as const, clientId: GOOGLE_ID },
      { provider: 'microsoft' as const, clientId: MICROSOFT_ID, clientSecret: GOOGLE_SECRET },
      { provider: 'google' as const, clientId: GOOGLE_ID, clientSecret: 'has space' },
      { provider: 'github' as never, clientId: GOOGLE_ID },
    ]) {
      expect(await codeOf(host.oauth.setApp(app)), JSON.stringify(app)).toBe('INVALID_ARGUMENTS')
    }
    expect((await host.settings.get()).oauth.apps.every((app) => app.clientId === undefined)).toBe(true)
  })

  it('removes the app and goes back to not configured', async () => {
    const { host, changes } = ready()
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    changes.length = 0
    expect(await host.oauth.clearApp('google')).toEqual({})
    expect((await statusOf(host, 'google'))!.status).toBe('not_configured')
    expect((await host.settings.get()).oauth.apps[0]).toEqual({ provider: 'google', hasSecret: false })
    expect(changes).toEqual([{ provider: 'google', status: 'not_configured' }])
  })

  it('disconnects a connected provider when its app is saved again', async () => {
    const { host } = ready()
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    await host.oauth.connect('google')
    expect((await statusOf(host, 'google'))!.status).toBe('connected')
    await host.oauth.setApp({ provider: 'google', clientId: '987654321098-zyxwvutsrqponm.apps.googleusercontent.com' })
    expect(await statusOf(host, 'google')).toEqual({ provider: 'google', status: 'not_connected' })
  })

  it('does not restart the engine for anything it does', async () => {
    const { host } = ready()
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    await host.oauth.connect('google')
    await host.oauth.disconnect('google')
    await host.oauth.clearApp('google')
    expect(host.state().restartCalls).toBe(0)
  })
})

describe('createFakeHost oauth: connecting', () => {
  it('refuses without an app, and for an unknown provider', async () => {
    const { host } = ready()
    expect(await codeOf(host.oauth.connect('google'))).toBe('OAUTH_NOT_CONFIGURED')
    expect(await codeOf(host.oauth.connect('github' as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.oauth.disconnect('github' as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.oauth.cancel('github' as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.oauth.clearApp('github' as never))).toBe('INVALID_ARGUMENTS')
  })

  it('refuses when a saved connection has the name of the provider, in any case', async () => {
    const { host } = ready({}, { connections: [{ name: 'GOOGLE', kind: 'http' }] })
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    expect(await codeOf(host.oauth.connect('google'))).toBe('NAME_COLLISION')
    await host.oauth.setApp({ provider: 'microsoft', clientId: MICROSOFT_ID })
    expect((await host.oauth.connect('microsoft')).account).toBe('someone@contoso.example')
  })

  it('connects with the account of each provider, going through connecting', async () => {
    const { host, changes } = ready()
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    await host.oauth.setApp({ provider: 'microsoft', clientId: MICROSOFT_ID })
    changes.length = 0
    expect(await host.oauth.connect('google')).toEqual({ account: 'someone@example.com' })
    expect(await host.oauth.connect('microsoft')).toEqual({ account: 'someone@contoso.example' })
    expect(changes).toEqual([
      { provider: 'google', status: 'connecting' },
      { provider: 'google', status: 'connected', account: 'someone@example.com' },
      { provider: 'microsoft', status: 'connecting' },
      { provider: 'microsoft', status: 'connected', account: 'someone@contoso.example' },
    ])
  })

  it('goes back to not connected after each failure and says which one it was', async () => {
    const cases: Array<[FakeOAuthFlow, string]> = [
      ['denied', 'OAUTH_DENIED'],
      ['timeout', 'OAUTH_TIMEOUT'],
      ['scope_missing', 'OAUTH_SCOPE_MISSING'],
      ['exchange_failed', 'OAUTH_EXCHANGE_FAILED'],
    ]
    for (const [flow, code] of cases) {
      const { host, changes } = ready({ google: flow })
      await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
      changes.length = 0
      expect(await codeOf(host.oauth.connect('google')), flow).toBe(code)
      expect((await statusOf(host, 'google'))!.status).toBe('not_connected')
      expect(changes).toEqual([
        { provider: 'google', status: 'connecting' },
        { provider: 'google', status: 'not_connected' },
      ])
    }
  })

  it('waits in connecting until it is cancelled, and then fails with OAUTH_CANCELLED', async () => {
    const { host } = ready({ google: 'waiting' })
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    const pending = codeOf(host.oauth.connect('google'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await statusOf(host, 'google'))!.status).toBe('connecting')
    await host.oauth.cancel('microsoft')
    expect((await statusOf(host, 'google'))!.status).toBe('connecting')
    await host.oauth.cancel('google')
    expect(await pending).toBe('OAUTH_CANCELLED')
    expect((await statusOf(host, 'google'))!.status).toBe('not_connected')
  })

  it('refuses a second connect while one is open with OAUTH_BUSY', async () => {
    const { host } = ready({ google: 'waiting' })
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    await host.oauth.setApp({ provider: 'microsoft', clientId: MICROSOFT_ID })
    const first = codeOf(host.oauth.connect('google'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await codeOf(host.oauth.connect('microsoft'))).toBe('OAUTH_BUSY')
    expect(await codeOf(host.oauth.connect('google'))).toBe('OAUTH_BUSY')
    await host.oauth.cancel('google')
    expect(await first).toBe('OAUTH_CANCELLED')
    expect((await host.oauth.connect('microsoft')).account).toBe('someone@contoso.example')
  })

  it('ends a sign-in that is open when the provider is disconnected, its app is saved again or its app is removed', async () => {
    for (const end of [
      (host: ReturnType<typeof createFakeHost>) => host.oauth.disconnect('google'),
      (host: ReturnType<typeof createFakeHost>) => host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID }),
      (host: ReturnType<typeof createFakeHost>) => host.oauth.clearApp('google'),
    ]) {
      const { host } = ready({ google: 'waiting' })
      await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
      const pending = codeOf(host.oauth.connect('google'))
      await new Promise((resolve) => setTimeout(resolve, 5))
      await end(host)
      expect(await pending).toBe('OAUTH_CANCELLED')
    }
  })

  it('keeps the status that the end of the open sign-in set, not the one before it', async () => {
    const { host } = ready({ google: 'waiting' })
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    const pending = codeOf(host.oauth.connect('google'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await host.oauth.clearApp('google')
    await pending
    expect((await statusOf(host, 'google'))!.status).toBe('not_configured')
  })

  it('keeps a connected account connected when a second sign-in fails', async () => {
    const { host } = ready({}, { oauth: { available: true, accounts: [{ provider: 'google', status: 'connected', account: 'someone@example.com' }], apps: [{ provider: 'google', clientId: GOOGLE_ID, hasSecret: false }] } })
    const failing = createFakeHost({ settings: await host.settings.get() }, { oauthFlows: { google: 'denied' } })
    expect(await codeOf(failing.oauth.connect('google'))).toBe('OAUTH_DENIED')
    expect(await statusOf(failing, 'google')).toEqual({ provider: 'google', status: 'connected', account: 'someone@example.com' })
  })

  it('shows reconnect needed later when the flow says so, and again after a reconnect works', async () => {
    const { host, changes } = ready({ google: 'needs_reconnect_later' })
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    await host.oauth.connect('google')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await statusOf(host, 'google')).toEqual({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
    expect(changes.at(-1)).toEqual({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
  })

  it('lets a test expire a connected account by hand, and does nothing for one that is not connected', async () => {
    const { host, changes } = ready()
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    host.expireOAuth('google')
    expect(changes).toEqual([{ provider: 'google', status: 'not_connected' }])
    await host.oauth.connect('google')
    host.expireOAuth('google')
    expect((await statusOf(host, 'google'))!.status).toBe('needs_reconnect')
  })
})

describe('createFakeHost oauth: disconnecting and events', () => {
  it('disconnects a connected account and an account that needs reconnecting, and ignores one that is not connected', async () => {
    const { host, changes } = ready()
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    await host.oauth.connect('google')
    changes.length = 0
    await host.oauth.disconnect('google')
    expect(changes).toEqual([{ provider: 'google', status: 'not_connected' }])
    await host.oauth.connect('google')
    host.expireOAuth('google')
    changes.length = 0
    await host.oauth.disconnect('google')
    expect(changes).toEqual([{ provider: 'google', status: 'not_connected' }])
    changes.length = 0
    await host.oauth.disconnect('google')
    await host.oauth.disconnect('microsoft')
    expect(changes).toEqual([])
    expect((await statusOf(host, 'microsoft'))!.status).toBe('not_configured')
  })

  it('stops calling a listener that unsubscribed, survives one that throws, and counts the listeners', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0 })
    const seen: string[] = []
    const off = host.oauth.onChanged((change) => seen.push(change.status))
    host.oauth.onChanged(() => {
      throw new Error('listener failed')
    })
    expect(host.state().oauthListeners).toBe(2)
    await host.oauth.setApp({ provider: 'google', clientId: GOOGLE_ID })
    off()
    expect(host.state().oauthListeners).toBe(1)
    await host.oauth.clearApp('google')
    expect(seen).toEqual(['not_connected'])
  })

  it('returns copies, so a caller cannot change the state of the host', async () => {
    const { host } = ready()
    const settings = await host.settings.get()
    settings.oauth.accounts[0]!.status = 'connected'
    expect((await statusOf(host, 'google'))!.status).toBe('not_configured')
  })
})

describe('createFakeHost: names that belong to the sign-in', () => {
  it('refuses a saved connection of any kind under the name of a provider', async () => {
    const host = createFakeHost()
    for (const name of ['google', 'Google', 'MICROSOFT']) {
      expect(await codeOf(host.secrets.setConnection({ name, kind: 'http', secret: 'plain-secret' })), name).toBe('NAME_COLLISION')
      expect(await codeOf(host.secrets.setCustomConnection({ name, auth: { type: 'bearer', token: 'plain-token' } })), name).toBe('NAME_COLLISION')
      expect(await codeOf(host.secrets.setSlackBot({ name, token: 'xoxb-0123456789-abcdef' })), name).toBe('NAME_COLLISION')
    }
    expect((await host.settings.get()).connections).toEqual([])
    await host.secrets.setConnection({ name: 'google sheets', kind: 'http', secret: 'plain-secret' })
    expect((await host.settings.get()).connections).toHaveLength(1)
  })

  it('refuses the kinds google and microsoft for a saved connection', async () => {
    const host = createFakeHost()
    for (const kind of ['google', 'microsoft']) {
      expect(await codeOf(host.secrets.setConnection({ name: 'sheets', kind: kind as never, secret: 'ya29.TOKENMARKER0123456789' }))).toBe('INVALID_ARGUMENTS')
    }
  })
})
