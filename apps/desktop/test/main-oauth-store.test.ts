// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretStoreError, createSecretStore, type OAuthAccountRecord, type SafeStorageLike } from '../src/main/secret-store'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH, MARKERS, MICROSOFT_CLIENT_ID, MICROSOFT_REFRESH, scanFor } from './oauth-helpers'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-oauth-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface FakeSafeStorage extends SafeStorageLike {
  available: boolean
}

function fakeSafeStorage(): FakeSafeStorage {
  const fake: FakeSafeStorage = {
    available: true,
    isEncryptionAvailable: () => fake.available,
    encryptString(plain) {
      if (!fake.available) throw new Error('encryption is not available')
      return Buffer.concat([Buffer.from('v10'), Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)])
    },
    decryptString(encrypted) {
      if (!fake.available) throw new Error('decryption is not available')
      if (!encrypted.subarray(0, 3).equals(Buffer.from('v10'))) throw new Error('cannot decrypt')
      return Buffer.from(encrypted.subarray(3).map((byte) => byte ^ 0x5a)).toString('utf8')
    },
  }
  return fake
}

function setup() {
  const safeStorage = fakeSafeStorage()
  const logs: string[] = []
  const store = createSecretStore({ dir, safeStorage, log: (message) => logs.push(message) })
  return { store, safeStorage, logs }
}

const file = () => join(dir, 'secrets.bin')
const plainOf = (safeStorage: SafeStorageLike) => JSON.parse(safeStorage.decryptString(readFileSync(file()))) as Record<string, unknown>

function writeBlob(safeStorage: SafeStorageLike, blob: unknown): void {
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(blob)))
}

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof SecretStoreError ? error.reason : `other:${String(error)}`
  }
  return undefined
}

const ACCOUNT: OAuthAccountRecord = { refreshToken: GOOGLE_REFRESH, scope: 'openid https://www.googleapis.com/auth/spreadsheets', account: 'someone@example.com', connectedAt: 1_700_000_000_000 }
const GOOGLE_APP = { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
const MICROSOFT_APP = { clientId: MICROSOFT_CLIENT_ID }

describe('oauth section: values', () => {
  it('starts empty', async () => {
    const { store } = setup()
    expect(await store.getOAuth()).toEqual({ apps: {}, accounts: {} })
  })

  it('round-trips apps and accounts and survives a new store on the same folder', async () => {
    const { store, safeStorage } = setup()
    expect(await store.setOAuthApp('google', GOOGLE_APP)).toBe(true)
    expect(await store.setOAuthApp('microsoft', MICROSOFT_APP)).toBe(true)
    expect(await store.setOAuthAccount('google', ACCOUNT)).toBe(true)
    const again = createSecretStore({ dir, safeStorage })
    expect(await again.getOAuth()).toEqual({ apps: { google: GOOGLE_APP, microsoft: MICROSOFT_APP }, accounts: { google: ACCOUNT } })
  })

  it('returns copies, so a caller cannot change what is stored', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.setOAuthAccount('google', ACCOUNT)
    const snapshot = await store.getOAuth()
    snapshot.apps.google!.clientId = 'changed'
    snapshot.accounts.google!.refreshToken = 'changed'
    expect(await store.getOAuth()).toEqual({ apps: { google: GOOGLE_APP }, accounts: { google: ACCOUNT } })
  })

  it('writes nothing readable: the file holds no secret and no refresh token', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.setOAuthAccount('google', ACCOUNT)
    const raw = readFileSync(file())
    for (const text of [raw.toString('utf8'), raw.toString('latin1')]) expect(scanFor(text, [...MARKERS, 'apps.googleusercontent.com', 'someone@example.com'])).toEqual([])
  })

  it('keeps provider keys and saved connections when it writes the oauth section', async () => {
    const { store } = setup()
    await store.setProviderKey('anthropic', 'sk-ant-TESTMARKER-key-0001')
    await store.setConnection({ name: 'team', kind: 'slack', secret: 'https://hooks.example.test/hook' })
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.clearOAuthApp('google')
    expect(await store.getProviderKey('anthropic')).toBe('sk-ant-TESTMARKER-key-0001')
    expect((await store.listConnections()).map((entry) => entry.name)).toEqual(['team'])
  })

  it('keeps two parallel writes for the two providers', async () => {
    const { store } = setup()
    await Promise.all([store.setOAuthApp('google', GOOGLE_APP), store.setOAuthApp('microsoft', MICROSOFT_APP)])
    expect(Object.keys((await store.getOAuth()).apps).sort()).toEqual(['google', 'microsoft'])
  })
})

describe('oauth section: the file format', () => {
  it('stays version 1 without an oauth key while nothing is stored there, so an older app keeps reading it', async () => {
    const { store, safeStorage } = setup()
    await store.setProviderKey('anthropic', 'sk-ant-TESTMARKER-key-0001')
    expect(plainOf(safeStorage)).toEqual({ version: 1, providerKeys: [{ provider: 'anthropic', value: 'sk-ant-TESTMARKER-key-0001' }], connections: [] })
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.clearOAuthApp('google')
    expect(plainOf(safeStorage).version).toBe(1)
    expect('oauth' in plainOf(safeStorage)).toBe(false)
  })

  it('becomes version 2 with the oauth section when something is stored there', async () => {
    const { store, safeStorage } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    expect(plainOf(safeStorage)).toEqual({ version: 2, providerKeys: [], connections: [], oauth: { apps: { google: GOOGLE_APP }, accounts: {} } })
  })

  it('loads a version 1 file written before this section existed, unchanged', async () => {
    const { store, safeStorage } = setup()
    writeBlob(safeStorage, {
      version: 1,
      providerKeys: [{ provider: 'openai', value: 'sk-oai-TESTMARKER-key-0002' }],
      connections: [{ name: 'api', kind: 'http', secret: 'plain-secret' }],
    })
    expect(await store.getOAuth()).toEqual({ apps: {}, accounts: {} })
    expect(await store.unreadable()).toBe(false)
    expect(await store.getProviderKey('openai')).toBe('sk-oai-TESTMARKER-key-0002')
    expect((await store.getConnections()).map((entry) => entry.name)).toEqual(['api'])
    await store.setOAuthApp('microsoft', MICROSOFT_APP)
    expect(await store.getProviderKey('openai')).toBe('sk-oai-TESTMARKER-key-0002')
    expect((await store.getConnections()).map((entry) => entry.name)).toEqual(['api'])
  })

  it('drops a saved connection of kind google or microsoft that an earlier host contract allowed, and keeps the rest', async () => {
    const { store, safeStorage } = setup()
    writeBlob(safeStorage, {
      version: 1,
      providerKeys: [],
      connections: [
        { name: 'sheets', kind: 'google', secret: 'ya29.OLDTOKENMARKER0123456789' },
        { name: 'drive', kind: 'microsoft', secret: 'eyJOLDTOKENMARKER0123456789.a.b' },
        { name: 'team', kind: 'slack', secret: 'https://hooks.example.test/hook' },
      ],
    })
    expect(await store.unreadable()).toBe(false)
    expect((await store.getConnections()).map((entry) => entry.name)).toEqual(['team'])
    await store.setProviderKey('anthropic', 'sk-ant-TESTMARKER-key-0001')
    expect(JSON.stringify(plainOf(safeStorage))).not.toContain('OLDTOKENMARKER')
    expect(readdirSync(dir).filter((name) => name.includes('.bak'))).toEqual([])
  })

  it('treats a newer or damaged oauth section as unreadable and keeps the file as a backup instead of dropping it', async () => {
    const damaged: unknown[] = [
      { version: 2, providerKeys: [], connections: [], oauth: { apps: { google: GOOGLE_APP }, accounts: {}, futureField: 1 } },
      { version: 2, providerKeys: [], connections: [], oauth: { apps: { github: { clientId: 'x' } }, accounts: {} } },
      { version: 2, providerKeys: [], connections: [] },
      { version: 2, providerKeys: [], connections: [], oauth: { apps: { google: { clientId: 'not a client id' } }, accounts: {} } },
      { version: 3, providerKeys: [], connections: [], oauth: { apps: {}, accounts: {} } },
      { version: 1, providerKeys: [], connections: [], oauth: { apps: { google: GOOGLE_APP }, accounts: {} } },
    ]
    for (const blob of damaged) {
      rmSync(dir, { recursive: true, force: true })
      dir = mkdtempSync(join(tmpdir(), 'rill-oauth-store-'))
      const { store, safeStorage } = setup()
      writeBlob(safeStorage, blob)
      const original = readFileSync(file())
      expect(await store.unreadable(), JSON.stringify(blob)).toBe(true)
      expect(await store.getOAuth()).toEqual({ apps: {}, accounts: {} })
      await store.setProviderKey('anthropic', 'sk-ant-TESTMARKER-key-0001')
      const backups = readdirSync(dir).filter((name) => name.startsWith('secrets.bin.bak'))
      expect(backups.length, JSON.stringify(blob)).toBe(1)
      expect(readFileSync(join(dir, backups[0]!)).equals(original)).toBe(true)
    }
  })

  it('reads a version 2 file whose accounts and apps are all valid, including a needs-reconnect account', async () => {
    const { store, safeStorage } = setup()
    writeBlob(safeStorage, {
      version: 2,
      providerKeys: [],
      connections: [],
      oauth: { apps: { google: GOOGLE_APP, microsoft: MICROSOFT_APP }, accounts: { microsoft: { needsReconnect: true, scope: 'Files.ReadWrite', account: 'Alex', connectedAt: 5 } } },
    })
    expect(await store.unreadable()).toBe(false)
    expect((await store.getOAuth()).accounts.microsoft).toEqual({ needsReconnect: true, scope: 'Files.ReadWrite', account: 'Alex', connectedAt: 5 })
  })

  it('does not log anything secret when the file cannot be read', async () => {
    const { store, safeStorage, logs } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    writeFileSync(file(), Buffer.from('garbage'))
    await store.getOAuth()
    expect(logs).toEqual(['the secrets file could not be read'])
    expect(scanFor(logs.join('\n'))).toEqual([])
    expect(safeStorage.available).toBe(true)
  })
})

describe('oauth section: validation of the app', () => {
  it('accepts a Google Client ID of the documented shape, with or without a secret, and refuses anything else', async () => {
    const { store } = setup()
    expect(await store.setOAuthApp('google', { clientId: GOOGLE_CLIENT_ID })).toBe(true)
    for (const clientId of ['', 'plain', '123456789012-abc.apps.googleusercontent.com.evil.example', '123456789012-abc.apps.googleusercontent.co', 'abc-def.apps.googleusercontent.com', '123456789012-abc def.apps.googleusercontent.com', '123456789012-.apps.googleusercontent.com', ` ${GOOGLE_CLIENT_ID}`, `${GOOGLE_CLIENT_ID}\n`, `${'1'.repeat(150)}-${'a'.repeat(100)}.apps.googleusercontent.com`, MICROSOFT_CLIENT_ID]) {
      expect(await reasonOf(store.setOAuthApp('google', { clientId })), JSON.stringify(clientId)).toBe('invalid_value')
    }
  })

  it('accepts a Microsoft Client ID that is a GUID and refuses anything else', async () => {
    const { store } = setup()
    for (const clientId of [MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_ID.toUpperCase()]) expect(await store.setOAuthApp('microsoft', { clientId })).toBe(true)
    for (const clientId of ['', 'not-a-guid', GOOGLE_CLIENT_ID, MICROSOFT_CLIENT_ID.slice(1), `${MICROSOFT_CLIENT_ID}0`, `{${MICROSOFT_CLIENT_ID}}`, MICROSOFT_CLIENT_ID.replace(/-/g, '')]) {
      expect(await reasonOf(store.setOAuthApp('microsoft', { clientId })), clientId).toBe('invalid_value')
    }
  })

  it('accepts a Client secret of 1 to 256 characters without blanks or control characters, for Google only', async () => {
    const { store } = setup()
    for (const clientSecret of ['a', 'GOCSPX-0123456789abcdefghijklmnopqr', 'x'.repeat(256), 'ünï-çödé-secret']) {
      expect(await store.setOAuthApp('google', { clientId: GOOGLE_CLIENT_ID, clientSecret }), clientSecret).toBe(true)
    }
    for (const clientSecret of ['', 'x'.repeat(257), 'has space', 'tab\there', 'new\nline', 'nul\u0000', 'bell\u0007', 'c1\u0085x', ' lead', 'trail ', 'nbsp x']) {
      expect(await reasonOf(store.setOAuthApp('google', { clientId: GOOGLE_CLIENT_ID, clientSecret })), JSON.stringify(clientSecret)).toBe('invalid_value')
    }
    expect(await reasonOf(store.setOAuthApp('microsoft', { clientId: MICROSOFT_CLIENT_ID, clientSecret: 'a-secret' }))).toBe('invalid_value')
  })

  it('replaces the secret when the app is saved again without one', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.setOAuthApp('google', { clientId: GOOGLE_CLIENT_ID })
    expect((await store.getOAuth()).apps.google).toEqual({ clientId: GOOGLE_CLIENT_ID })
  })

  it('refuses a provider that does not exist', async () => {
    const { store } = setup()
    expect(await reasonOf(store.setOAuthApp('github' as never, { clientId: 'x' }))).toBe('invalid_value')
  })
})

describe('oauth section: the account record', () => {
  it('needs an app for the provider', async () => {
    const { store } = setup()
    expect(await reasonOf(store.setOAuthAccount('google', ACCOUNT))).toBe('invalid_value')
    await store.setOAuthApp('microsoft', MICROSOFT_APP)
    expect(await reasonOf(store.setOAuthAccount('google', ACCOUNT))).toBe('invalid_value')
  })

  it('accepts a refresh token of 4096 characters and refuses 4097, an empty one and one with a NUL', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    expect(await store.setOAuthAccount('google', { ...ACCOUNT, refreshToken: 'r'.repeat(4096) })).toBe(true)
    for (const refreshToken of ['r'.repeat(4097), '', 'a\u0000b']) {
      expect(await reasonOf(store.setOAuthAccount('google', { ...ACCOUNT, refreshToken })), refreshToken.length.toString()).toBe('invalid_value')
    }
  })

  it('takes either a refresh token or the needs-reconnect mark, never both and never neither', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    expect(await store.setOAuthAccount('google', { needsReconnect: true, scope: ACCOUNT.scope, connectedAt: 1 })).toBe(true)
    expect(await reasonOf(store.setOAuthAccount('google', { ...ACCOUNT, needsReconnect: true }))).toBe('invalid_value')
    expect(await reasonOf(store.setOAuthAccount('google', { scope: ACCOUNT.scope, connectedAt: 1 }))).toBe('invalid_value')
    expect(await reasonOf(store.setOAuthAccount('google', { needsReconnect: false as never, scope: ACCOUNT.scope, connectedAt: 1 }))).toBe('invalid_value')
  })

  it('limits the account text to 200 characters without control characters, the scope and the time', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    expect(await store.setOAuthAccount('google', { ...ACCOUNT, account: 'a'.repeat(200) })).toBe(true)
    for (const bad of [{ account: 'a'.repeat(201) }, { account: '' }, { account: 'a\u0000b' }, { account: 'a\u0085b' }, { scope: '' }, { scope: 's'.repeat(2001) }, { connectedAt: -1 }, { connectedAt: 1.5 }, { connectedAt: Number.NaN }, { connectedAt: '5' as never }]) {
      expect(await reasonOf(store.setOAuthAccount('google', { ...ACCOUNT, ...bad })), JSON.stringify(bad)).toBe('invalid_value')
    }
  })

  it('reports no change for the same account and a change for another', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    expect(await store.setOAuthAccount('google', ACCOUNT)).toBe(true)
    expect(await store.setOAuthAccount('google', { ...ACCOUNT })).toBe(false)
    expect(await store.setOAuthAccount('google', { ...ACCOUNT, refreshToken: 'rotated-refresh-token-value' })).toBe(true)
  })
})

describe('oauth section: removing', () => {
  it('disconnects the provider when its app is saved again, and leaves the other provider alone', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.setOAuthApp('microsoft', MICROSOFT_APP)
    await store.setOAuthAccount('google', ACCOUNT)
    await store.setOAuthAccount('microsoft', { ...ACCOUNT, refreshToken: MICROSOFT_REFRESH })
    expect(await store.setOAuthApp('google', { clientId: '987654321098-zyxwvutsrqponm.apps.googleusercontent.com' })).toBe(true)
    const { apps, accounts } = await store.getOAuth()
    expect(apps.google!.clientId).toBe('987654321098-zyxwvutsrqponm.apps.googleusercontent.com')
    expect(accounts.google).toBeUndefined()
    expect(accounts.microsoft!.refreshToken).toBe(MICROSOFT_REFRESH)
  })

  it('clears the app together with its account', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.setOAuthAccount('google', ACCOUNT)
    expect(await store.clearOAuthApp('google')).toBe(true)
    expect(await store.getOAuth()).toEqual({ apps: {}, accounts: {} })
    expect(await store.clearOAuthApp('google')).toBe(false)
  })

  it('clears the account and keeps the app', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    await store.setOAuthAccount('google', ACCOUNT)
    expect(await store.clearOAuthAccount('google')).toBe(true)
    expect(await store.getOAuth()).toEqual({ apps: { google: GOOGLE_APP }, accounts: {} })
    expect(await store.clearOAuthAccount('google')).toBe(false)
  })
})

describe('oauth section: the keychain', () => {
  it('refuses every write and reads nothing without a keychain, and writes no file', async () => {
    const { store, safeStorage } = setup()
    safeStorage.available = false
    expect(await reasonOf(store.setOAuthApp('google', GOOGLE_APP))).toBe('no_keychain')
    expect(await reasonOf(store.clearOAuthApp('google'))).toBe('no_keychain')
    expect(await reasonOf(store.setOAuthAccount('google', ACCOUNT))).toBe('no_keychain')
    expect(await reasonOf(store.clearOAuthAccount('google'))).toBe('no_keychain')
    expect(await store.getOAuth()).toEqual({ apps: {}, accounts: {} })
    expect(existsSync(file())).toBe(false)
  })

  it('maps a failing write to write_failed and keeps the earlier state', async () => {
    const { store } = setup()
    await store.setOAuthApp('google', GOOGLE_APP)
    const failing = createSecretStore({
      dir,
      safeStorage: { isEncryptionAvailable: () => true, decryptString: (bytes) => Buffer.from(bytes.subarray(3).map((byte) => byte ^ 0x5a)).toString('utf8'), encryptString: () => { throw new Error('keychain locked') } },
    })
    expect(await reasonOf(failing.setOAuthApp('microsoft', MICROSOFT_APP))).toBe('write_failed')
    expect((await store.getOAuth()).apps).toEqual({ google: GOOGLE_APP })
  })
})
