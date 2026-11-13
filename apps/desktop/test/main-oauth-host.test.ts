// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../src/main/attachments'
import { createConfigStore } from '../src/main/config-store'
import { createIpcHandlers, type DialogLike, type IpcDeps } from '../src/main/ipc-handlers'
import { createOAuthManager } from '../src/main/oauth-manager'
import { SecretStoreError, createSecretStore, type SafeStorageLike } from '../src/main/secret-store'
import { createTextFiles } from '../src/main/text-files'
import {
  CHANNELS,
  HOST_ERROR_CODES,
  HostError,
  MAX_CLIENT_ID_LENGTH,
  OAuthAppInfoSchema,
  OAuthStateSchema,
  SettingsSchema,
  hostErrorCode,
  isOAuthApp,
  isOAuthClientId,
  isOAuthClientSecret,
  isReservedConnectionName,
  validateArgs,
  validateOAuthChange,
  validateResult,
  type Channel,
} from '../src/shared/host-api'
import Value from 'typebox/value'
import {
  GOOGLE_ACCESS,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH,
  ManualClock,
  MICROSOFT_CLIENT_ID,
  httpCall,
  json,
  scanFor,
  tokenAnswer,
  type RecordedCall,
} from './oauth-helpers'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-oauth-host-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('host contract: client values', () => {
  it('accepts a Google Client ID of the documented shape and refuses lookalikes', () => {
    expect(isOAuthClientId('google', GOOGLE_CLIENT_ID)).toBe(true)
    for (const value of ['', 'x', MICROSOFT_CLIENT_ID, `${GOOGLE_CLIENT_ID}.evil.example`, ` ${GOOGLE_CLIENT_ID}`, GOOGLE_CLIENT_ID.replace('.apps', '.app'), `${'1'.repeat(MAX_CLIENT_ID_LENGTH)}-a.apps.googleusercontent.com`]) {
      expect(isOAuthClientId('google', value), value).toBe(false)
    }
  })

  it('accepts a Microsoft Client ID that is a GUID in any case and refuses the rest', () => {
    expect(isOAuthClientId('microsoft', MICROSOFT_CLIENT_ID)).toBe(true)
    expect(isOAuthClientId('microsoft', MICROSOFT_CLIENT_ID.toUpperCase())).toBe(true)
    for (const value of ['', GOOGLE_CLIENT_ID, MICROSOFT_CLIENT_ID.replace(/-/g, ''), `${MICROSOFT_CLIENT_ID}x`, `urn:${MICROSOFT_CLIENT_ID}`]) expect(isOAuthClientId('microsoft', value), value).toBe(false)
  })

  it('accepts a Client secret without blanks or control characters, 1 to 256 characters', () => {
    expect(isOAuthClientSecret(GOOGLE_CLIENT_SECRET)).toBe(true)
    expect(isOAuthClientSecret('x'.repeat(256))).toBe(true)
    for (const value of ['', 'x'.repeat(257), 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u0085b', 'a b', 'a b']) expect(isOAuthClientSecret(value), JSON.stringify(value)).toBe(false)
  })

  it('takes a secret for Google only', () => {
    expect(isOAuthApp({ provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET })).toBe(true)
    expect(isOAuthApp({ provider: 'google', clientId: GOOGLE_CLIENT_ID })).toBe(true)
    expect(isOAuthApp({ provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID })).toBe(true)
    expect(isOAuthApp({ provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET })).toBe(false)
    expect(isOAuthApp({ provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: '' })).toBe(false)
  })

  it('reserves the provider names for the sign-in, in any case and width', () => {
    for (const name of ['google', 'Google', 'GOOGLE', 'microsoft', 'MicroSoft', 'ｇｏｏｇｌｅ']) expect(isReservedConnectionName(name), name).toBe(true)
    for (const name of ['google2', 'my google', 'googl', 'ms', '']) expect(isReservedConnectionName(name), name).toBe(false)
  })
})

describe('host contract: arguments and results', () => {
  it('validates the oauth.setApp arguments against the shapes of the providers', () => {
    const ok: unknown[] = [
      { provider: 'google', clientId: GOOGLE_CLIENT_ID },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      { provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID },
    ]
    for (const args of ok) expect(validateArgs(CHANNELS.oauthSetApp, args), JSON.stringify(args)).toBe(true)
    const bad: unknown[] = [
      undefined,
      {},
      { provider: 'google' },
      { clientId: GOOGLE_CLIENT_ID },
      { provider: 'github', clientId: GOOGLE_CLIENT_ID },
      { provider: 'google', clientId: MICROSOFT_CLIENT_ID },
      { provider: 'microsoft', clientId: GOOGLE_CLIENT_ID },
      { provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: 'has space' },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: '' },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: 5 },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, extra: true },
      { provider: 'google', clientId: 5 },
    ]
    for (const args of bad) expect(validateArgs(CHANNELS.oauthSetApp, args), JSON.stringify(args)).toBe(false)
  })

  it('takes a provider for the other oauth channels and nothing else', () => {
    for (const channel of [CHANNELS.oauthClearApp, CHANNELS.oauthConnect, CHANNELS.oauthCancel, CHANNELS.oauthDisconnect]) {
      expect(validateArgs(channel, { provider: 'google' })).toBe(true)
      expect(validateArgs(channel, { provider: 'microsoft', extra: 1 })).toBe(false)
      expect(validateArgs(channel, 'google')).toBe(false)
    }
  })

  it('gives each oauth channel the result that the plan names', () => {
    expect(validateResult(CHANNELS.oauthSetApp, {})).toBe(true)
    expect(validateResult(CHANNELS.oauthClearApp, {})).toBe(true)
    expect(validateResult(CHANNELS.oauthSetApp, { clientSecret: GOOGLE_CLIENT_SECRET })).toBe(false)
    expect(validateResult(CHANNELS.oauthSetApp, undefined)).toBe(false)
    expect(validateResult(CHANNELS.oauthConnect, {})).toBe(true)
    expect(validateResult(CHANNELS.oauthConnect, { account: 'someone@example.com' })).toBe(true)
    expect(validateResult(CHANNELS.oauthConnect, { account: '' })).toBe(false)
    expect(validateResult(CHANNELS.oauthConnect, { account: 'a\u0000b' })).toBe(false)
    expect(validateResult(CHANNELS.oauthConnect, { account: 'x'.repeat(201) })).toBe(false)
    expect(validateResult(CHANNELS.oauthConnect, { account: 'a', token: 'ya29.x' })).toBe(false)
    expect(validateResult(CHANNELS.oauthCancel, undefined)).toBe(true)
    expect(validateResult(CHANNELS.oauthDisconnect, undefined)).toBe(true)
  })

  const settings = {
    allowedFolders: [],
    provider: 'anthropic',
    openAtLogin: false,
    language: 'system',
    configuredProviders: [],
    connections: [],
    encryptionAvailable: true,
  }

  it('shapes the oauth part of the settings as available, accounts with a status, and apps with a flag for the secret', () => {
    const oauth = {
      available: true,
      accounts: [
        { provider: 'google', status: 'connected', account: 'someone@example.com' },
        { provider: 'microsoft', status: 'needs_reconnect' },
      ],
      apps: [
        { provider: 'google', clientId: GOOGLE_CLIENT_ID, hasSecret: true },
        { provider: 'microsoft', hasSecret: false },
      ],
    }
    expect(Value.Check(OAuthStateSchema, oauth)).toBe(true)
    expect(Value.Check(SettingsSchema, { ...settings, oauth })).toBe(true)
  })

  it('refuses an oauth state that holds a secret, an unknown status or a stray key', () => {
    const base = { available: true, accounts: [], apps: [] }
    for (const bad of [
      { ...base, accounts: [{ provider: 'google', status: 'unknown' }] },
      { ...base, accounts: [{ provider: 'google', status: 'connected', refreshToken: 'x' }] },
      { ...base, accounts: [{ provider: 'google' }] },
      { ...base, accounts: [{ provider: 'google', status: 'connected', account: 'a\u0000' }] },
      { ...base, apps: [{ provider: 'google', clientId: GOOGLE_CLIENT_ID, hasSecret: true, clientSecret: 'x' }] },
      { ...base, apps: [{ provider: 'google', hasSecret: 'yes' }] },
      { ...base, apps: [{ provider: 'github', hasSecret: false }] },
      { ...base, accounts: [{ provider: 'google', status: 'connected' }, { provider: 'microsoft', status: 'connected' }, { provider: 'google', status: 'connected' }] },
      { available: true, accounts: [] },
      { ...base, extra: 1 },
    ]) {
      expect(Value.Check(OAuthStateSchema, bad), JSON.stringify(bad)).toBe(false)
    }
    expect(Value.Check(OAuthAppInfoSchema, { provider: 'google', hasSecret: false })).toBe(true)
  })

  it('checks the change event the main process sends to the window', () => {
    expect(validateOAuthChange({ provider: 'google', status: 'connected', account: 'someone@example.com' })).toBe(true)
    expect(validateOAuthChange({ provider: 'microsoft', status: 'needs_reconnect' })).toBe(true)
    for (const bad of [null, 'x', {}, { provider: 'google' }, { provider: 'google', status: 'connected', token: 'x' }, { provider: 'google', status: 'connected', account: 'a\ud800' }, { provider: 'slack', status: 'connected' }]) {
      expect(validateOAuthChange(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('has an error code for each failure of the sign-in, and finds it in an error text', () => {
    const codes = ['OAUTH_NOT_CONFIGURED', 'OAUTH_BUSY', 'OAUTH_TIMEOUT', 'OAUTH_CANCELLED', 'OAUTH_DENIED', 'OAUTH_EXCHANGE_FAILED', 'OAUTH_SCOPE_MISSING', 'OAUTH_STATE', 'OAUTH_UNAVAILABLE']
    for (const code of codes) {
      expect(HOST_ERROR_CODES).toContain(code)
      expect(hostErrorCode(new Error(`Error invoking remote method 'rill:oauth:connect': Error: ${code}`))).toBe(code)
      expect(hostErrorCode(new HostError(code as never))).toBe(code)
    }
    expect(hostErrorCode(new Error('OAUTH_TIMEOUTS'))).toBe('INTERNAL')
  })
})

const unusedSlackCheck = async () => ({ status: 'valid' as const })

function harness(options: { oauth?: IpcDeps['oauth']; available?: boolean } = {}) {
  const safeStorage: SafeStorageLike & { available: boolean } = {
    available: options.available ?? true,
    isEncryptionAvailable: () => safeStorage.available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
  }
  const config = createConfigStore({ dir: join(dir, 'data') })
  const secrets = createSecretStore({ dir: join(dir, 'data'), safeStorage })
  const logs: string[] = []
  const supervisor = { info: vi.fn(async () => ({ url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 })), restart: vi.fn(async () => undefined), status: vi.fn(() => ({ state: 'running' as const, restarts: 0 })) }
  const slackCheck = vi.fn(unusedSlackCheck)
  const manager: IpcDeps['oauth'] = options.oauth ?? {
    state: vi.fn(async () => ({ available: true, accounts: [], apps: [] })),
    setApp: vi.fn(async () => undefined),
    clearApp: vi.fn(async () => undefined),
    connect: vi.fn(async () => ({ account: 'someone@example.com' })),
    cancel: vi.fn(),
    disconnect: vi.fn(async () => undefined),
  }
  const handlers = createIpcHandlers({
    textFiles: createTextFiles(),
    config,
    secrets,
    supervisor,
    attachments: createAttachmentStore({ dir: join(dir, 'data', 'attachments') }),
    oauth: manager,
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) } as unknown as DialogLike,
    app: { quit: vi.fn() },
    loginItem: { set: vi.fn() },
    keyCheck: vi.fn(async () => ({ status: 'valid' as const })),
    slackCheck,
    log: (line) => logs.push(line),
  })
  const call = (channel: Channel, args?: unknown) => handlers[channel](args)
  return { call, manager, secrets, safeStorage, logs, supervisor, slackCheck }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('ipc handlers: the oauth channels', () => {
  it('passes a valid app to the sign-in manager once and answers with an empty object', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.oauthSetApp, { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET })).toEqual({})
    expect(h.manager.setApp).toHaveBeenCalledExactlyOnceWith('google', { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET })
    expect(await h.call(CHANNELS.oauthSetApp, { provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID })).toEqual({})
    expect(h.manager.setApp).toHaveBeenLastCalledWith('microsoft', { clientId: MICROSOFT_CLIENT_ID })
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('refuses an app of the wrong shape with INVALID_ARGUMENTS and never calls the manager', async () => {
    const h = harness()
    for (const args of [
      { provider: 'google', clientId: 'not a client id' },
      { provider: 'google', clientId: MICROSOFT_CLIENT_ID },
      { provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: 'has space' },
      { provider: 'google', clientId: GOOGLE_CLIENT_ID, extra: true },
    ]) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.oauthSetApp, args))), JSON.stringify(args)).toBe('INVALID_ARGUMENTS')
    }
    expect(h.manager.setApp).not.toHaveBeenCalled()
  })

  it('clears, cancels and disconnects through the manager', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.oauthClearApp, { provider: 'google' })).toEqual({})
    expect(await h.call(CHANNELS.oauthCancel, { provider: 'microsoft' })).toBeUndefined()
    expect(await h.call(CHANNELS.oauthDisconnect, { provider: 'google' })).toBeUndefined()
    expect(h.manager.clearApp).toHaveBeenCalledExactlyOnceWith('google')
    expect(h.manager.cancel).toHaveBeenCalledExactlyOnceWith('microsoft')
    expect(h.manager.disconnect).toHaveBeenCalledExactlyOnceWith('google')
  })

  it('stays open until the sign-in is done and returns the account', async () => {
    const h = harness()
    let finish: ((value: { account?: string }) => void) | undefined
    vi.mocked(h.manager.connect).mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    let settled = false
    const pending = h.call(CHANNELS.oauthConnect, { provider: 'google' }).then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    finish!({ account: 'someone@example.com' })
    expect(await pending).toEqual({ account: 'someone@example.com' })
    expect(validateResult(CHANNELS.oauthConnect, await pending)).toBe(true)
  })

  it('gives the provider back to the manager for a connect and refuses an invalid provider', async () => {
    const h = harness()
    await h.call(CHANNELS.oauthConnect, { provider: 'microsoft' })
    expect(h.manager.connect).toHaveBeenCalledExactlyOnceWith('microsoft')
    expect(hostErrorCode(await failure(h.call(CHANNELS.oauthConnect, { provider: 'github' })))).toBe('INVALID_ARGUMENTS')
    expect(h.manager.connect).toHaveBeenCalledTimes(1)
  })

  it('passes every failure code of the sign-in to the window unchanged and as nothing but the code', async () => {
    for (const code of ['OAUTH_NOT_CONFIGURED', 'OAUTH_BUSY', 'OAUTH_TIMEOUT', 'OAUTH_CANCELLED', 'OAUTH_DENIED', 'OAUTH_EXCHANGE_FAILED', 'OAUTH_SCOPE_MISSING', 'OAUTH_STATE', 'NO_KEYCHAIN'] as const) {
      const h = harness()
      vi.mocked(h.manager.connect).mockRejectedValue(new HostError(code))
      const error = await failure(h.call(CHANNELS.oauthConnect, { provider: 'google' }))
      expect(hostErrorCode(error)).toBe(code)
      expect(error.message).toBe(code)
      expect(h.logs).toEqual([])
    }
  })

  it('maps a store error to its code, and an unexpected error to INTERNAL with only the error name in the log', async () => {
    const h = harness()
    vi.mocked(h.manager.connect).mockRejectedValueOnce(new SecretStoreError('no_keychain'))
    expect(hostErrorCode(await failure(h.call(CHANNELS.oauthConnect, { provider: 'google' })))).toBe('NO_KEYCHAIN')
    vi.mocked(h.manager.connect).mockRejectedValueOnce(new SecretStoreError('write_failed'))
    expect(hostErrorCode(await failure(h.call(CHANNELS.oauthConnect, { provider: 'google' })))).toBe('INTERNAL')
    vi.mocked(h.manager.setApp).mockRejectedValueOnce(new Error(`secret ${GOOGLE_CLIENT_SECRET} ${GOOGLE_REFRESH}`))
    const error = await failure(h.call(CHANNELS.oauthSetApp, { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }))
    expect(error.message).toBe('INTERNAL')
    expect(scanFor(h.logs.join('\n') + error.message)).toEqual([])
    expect(h.logs.join('\n')).toContain('rill:oauth:set-app failed: Error')
  })

  it('refuses to connect while a saved connection already has the name of the provider, in any case, and says why', async () => {
    const h = harness()
    const blob = JSON.stringify({ version: 1, providerKeys: [], connections: [{ name: 'Google', kind: 'http', secret: 'plain-secret' }] })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 'secrets.bin'), h.safeStorage.encryptString(blob))
    expect(hostErrorCode(await failure(h.call(CHANNELS.oauthConnect, { provider: 'google' })))).toBe('NAME_COLLISION')
    expect(h.manager.connect).not.toHaveBeenCalled()
    await h.call(CHANNELS.oauthConnect, { provider: 'microsoft' })
    expect(h.manager.connect).toHaveBeenCalledExactlyOnceWith('microsoft')
  })

  it('puts the oauth state of the manager into the settings, and nothing else about it', async () => {
    const state = { available: true, accounts: [{ provider: 'google' as const, status: 'connected' as const, account: 'someone@example.com' }], apps: [{ provider: 'google' as const, clientId: GOOGLE_CLIENT_ID, hasSecret: true }] }
    const h = harness({
      oauth: { state: async () => state, setApp: async () => undefined, clearApp: async () => undefined, connect: async () => ({}), cancel: () => undefined, disconnect: async () => undefined },
    })
    const settings = (await h.call(CHANNELS.settingsGet)) as { oauth: unknown }
    expect(settings.oauth).toEqual(state)
    expect(Value.Check(SettingsSchema, settings)).toBe(true)
  })
})

describe('saved connections and the names of the providers', () => {
  const NAMES = ['google', 'Google', 'MICROSOFT', 'microsoft']

  it('refuses a saved connection of any kind under such a name, with NAME_COLLISION', async () => {
    const h = harness()
    for (const name of NAMES) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetConnection, { name, kind: 'http', secret: 'plain-secret' }))), name).toBe('NAME_COLLISION')
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetConnection, { name, kind: 'slack', secret: 'https://hooks.example.test/x' }))), name).toBe('NAME_COLLISION')
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetCustomConnection, { name, auth: { type: 'bearer', token: 'plain-token' } }))), name).toBe('NAME_COLLISION')
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetSlackBot, { name, token: 'xoxb-0123456789-abcdef' }))), name).toBe('NAME_COLLISION')
    }
    expect(h.slackCheck).not.toHaveBeenCalled()
    expect(await h.secrets.listConnections()).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('still saves names that only look similar', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'google sheets', kind: 'http', secret: 'plain-secret' })
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'microsoft-graph', auth: { type: 'bearer', token: 'plain-token' } })
    expect((await h.secrets.listConnections()).map((entry) => entry.name)).toEqual(['google sheets', 'microsoft-graph'])
  })

  it('refuses the kinds google and microsoft for a saved connection at the contract', async () => {
    const h = harness()
    for (const kind of ['google', 'microsoft']) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetConnection, { name: 'sheets', kind, secret: 'ya29.TOKENMARKER0123456789' })))).toBe('INVALID_ARGUMENTS')
    }
    expect(await h.secrets.listConnections()).toEqual([])
  })
})

describe('ipc handlers with the real sign-in manager', () => {
  function realManagerHarness() {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
      decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
    }
    const store = createSecretStore({ dir: join(dir, 'real'), safeStorage })
    const clock = new ManualClock()
    const calls: RecordedCall[] = []
    const sent: unknown[] = []
    const manager = createOAuthManager({
      store,
      fetch: async (url, init) => {
        const call: RecordedCall = { url, init, form: new URLSearchParams(init.body ?? '') }
        calls.push(call)
        if (url.includes('/token')) return tokenAnswer()
        if (url.includes('userinfo')) return json({ email: 'someone@example.com' })
        return new Response('', { status: 200 })
      },
      openExternal: async (url) => {
        const params = new URL(url).searchParams
        const port = Number(new URL(params.get('redirect_uri')!).port)
        setImmediate(() => void httpCall({ port, path: `/oauth/callback?code=AUTHCODEMARKER-x&state=${params.get('state')}` }).catch(() => undefined))
      },
      clock,
      engine: { send: (message) => (sent.push(message), true) },
      random: () => 0,
    })
    const config = createConfigStore({ dir: join(dir, 'real') })
    const handlers = createIpcHandlers({
    textFiles: createTextFiles(),
      config,
      secrets: store,
      supervisor: { info: async () => ({ url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 }), restart: vi.fn(async () => undefined), status: () => ({ state: 'running', restarts: 0 }) },
      attachments: createAttachmentStore({ dir: join(dir, 'real', 'attachments') }),
      oauth: manager,
      dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) } as unknown as DialogLike,
      app: { quit: vi.fn() },
      loginItem: { set: vi.fn() },
      keyCheck: vi.fn(async () => ({ status: 'valid' as const })),
      slackCheck: unusedSlackCheck,
    })
    return { handlers, manager, calls, sent, store, safeStorage }
  }

  it('saves an app, signs in, shows the account and signs out, and no secret is in any result', async () => {
    const h = realManagerHarness()
    const outputs: unknown[] = []
    outputs.push(await h.handlers[CHANNELS.oauthSetApp]({ provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }))
    outputs.push(await h.handlers[CHANNELS.settingsGet](undefined))
    const connected = await h.handlers[CHANNELS.oauthConnect]({ provider: 'google' })
    outputs.push(connected)
    const settings = (await h.handlers[CHANNELS.settingsGet](undefined)) as { oauth: { accounts: Array<{ provider: string; status: string; account?: string }>; apps: unknown[] } }
    outputs.push(settings)
    expect(connected).toEqual({ account: 'someone@example.com' })
    expect(settings.oauth.accounts[0]).toEqual({ provider: 'google', status: 'connected', account: 'someone@example.com' })
    expect(settings.oauth.apps[0]).toEqual({ provider: 'google', clientId: GOOGLE_CLIENT_ID, hasSecret: true })
    expect(scanFor(JSON.stringify(outputs))).toEqual([])
    expect(h.sent).toEqual([{ type: 'connection.set', name: 'google', kind: 'google', secret: GOOGLE_ACCESS }])
    await h.handlers[CHANNELS.oauthDisconnect]({ provider: 'google' })
    const after = (await h.handlers[CHANNELS.settingsGet](undefined)) as { oauth: { accounts: Array<{ status: string }> } }
    expect(after.oauth.accounts[0]!.status).toBe('not_connected')
    h.manager.stop()
  })

  it('shows the saved connections without the account entries, which the sign-in alone owns', async () => {
    const h = realManagerHarness()
    await h.handlers[CHANNELS.oauthSetApp]({ provider: 'google', clientId: GOOGLE_CLIENT_ID })
    await h.handlers[CHANNELS.oauthConnect]({ provider: 'google' })
    const settings = (await h.handlers[CHANNELS.settingsGet](undefined)) as { connections: unknown[] }
    expect(settings.connections).toEqual([])
    expect(await h.store.listConnections()).toEqual([])
    expect(await h.store.getConnections()).toEqual([])
    h.manager.stop()
  })

  it('refuses a second connect while the first is open, from the window', async () => {
    const h = realManagerHarness()
    await h.handlers[CHANNELS.oauthSetApp]({ provider: 'google', clientId: GOOGLE_CLIENT_ID })
    await h.handlers[CHANNELS.oauthSetApp]({ provider: 'microsoft', clientId: MICROSOFT_CLIENT_ID })
    const first = h.handlers[CHANNELS.oauthConnect]({ provider: 'google' })
    const second = await failure(h.handlers[CHANNELS.oauthConnect]({ provider: 'microsoft' }))
    expect(hostErrorCode(second)).toBe('OAUTH_BUSY')
    await first
    h.manager.stop()
  })

  it('never writes anything for an account in the connections of the saved secrets', async () => {
    const h = realManagerHarness()
    await h.handlers[CHANNELS.oauthSetApp]({ provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET })
    await h.handlers[CHANNELS.oauthConnect]({ provider: 'google' })
    expect(await h.store.getConnections()).toEqual([])
    expect((await h.store.getOAuth()).accounts.google!.refreshToken).toBe(GOOGLE_REFRESH)
    h.manager.stop()
  })
})
