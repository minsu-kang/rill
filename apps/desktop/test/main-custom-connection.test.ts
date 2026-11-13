// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FORBIDDEN_NAMES, parseConnectionSecret } from '@rill/nodes-core'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../src/main/attachments'
import { createConfigStore } from '../src/main/config-store'
import { createIpcHandlers } from '../src/main/ipc-handlers'
import { createSecretStore, type SafeStorageLike } from '../src/main/secret-store'
import {
  AUTH_TYPES,
  CHANNELS,
  CONTRACTS,
  CustomAuthSchema,
  FORBIDDEN_AUTH_NAMES,
  HostError,
  encodeCustomAuth,
  hostErrorCode,
  isValidCustomAuth,
  validateArgs,
  validateResult,
  type Channel,
  type CustomAuth,
  type EngineStatus,
} from '../src/shared/host-api'

const MARKER = 'CONN-SECRET-MARKER'
const USER = 'someone-login'
const LOGIN = Buffer.from(`${USER}:${MARKER}`).toString('base64')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-custom-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const VALID: Record<string, CustomAuth> = {
  none: { type: 'none' },
  'api key in a header': { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: MARKER },
  'api key in the query': { type: 'apiKey', in: 'query', name: 'api_key', value: MARKER },
  bearer: { type: 'bearer', token: MARKER },
  basic: { type: 'basic', username: USER, password: MARKER },
  'basic with an empty password': { type: 'basic', username: USER, password: '' },
  'basic with non-ASCII text': { type: 'basic', username: '민수', password: 'pä:ss한글' },
}

describe('CustomAuth', () => {
  it('lists the four auth types', () => {
    expect([...AUTH_TYPES]).toEqual(['none', 'apiKey', 'bearer', 'basic'])
  })

  it.each(Object.entries(VALID))('accepts %s', (_label, auth) => {
    expect(Value.Check(CustomAuthSchema, auth)).toBe(true)
    expect(isValidCustomAuth(auth)).toBe(true)
  })

  const INVALID: Record<string, unknown> = {
    'an unknown type': { type: 'digest' },
    'no type': {},
    'an extra field on none': { type: 'none', token: MARKER },
    'an extra field on bearer': { type: 'bearer', token: MARKER, extra: 1 },
    'an api key without a location': { type: 'apiKey', name: 'k', value: MARKER },
    'an api key in a cookie': { type: 'apiKey', in: 'cookie', name: 'k', value: MARKER },
    'an api key name with a space': { type: 'apiKey', in: 'header', name: 'bad name', value: MARKER },
    'an api key name with a colon': { type: 'apiKey', in: 'header', name: 'a:b', value: MARKER },
    'an empty api key name': { type: 'apiKey', in: 'header', name: '', value: MARKER },
    'a 129 character api key name': { type: 'apiKey', in: 'query', name: 'a'.repeat(129), value: MARKER },
    'an empty api key value': { type: 'apiKey', in: 'header', name: 'k', value: '' },
    'a control character in a value': { type: 'apiKey', in: 'header', name: 'k', value: 'a\nb' },
    'an empty token': { type: 'bearer', token: '' },
    'a token with a NUL byte': { type: 'bearer', token: 'a\u0000b' },
    'a 2001 character token': { type: 'bearer', token: 't'.repeat(2001) },
    'a colon in the username': { type: 'basic', username: 'a:b', password: 'x' },
    'an empty username': { type: 'basic', username: '', password: 'x' },
    'a 257 character username': { type: 'basic', username: 'u'.repeat(257), password: 'x' },
    'a 2001 character password': { type: 'basic', username: 'u', password: 'p'.repeat(2001) },
    'a control character in the password': { type: 'basic', username: 'u', password: 'p\tw' },
    'a missing password': { type: 'basic', username: 'u' },
    'a number': 5,
    null: null,
  }
  for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'CONNECTION', 'Cookie', 'set-cookie', 'Upgrade', 'Keep-Alive', 'Expect', 'TE', 'Trailer', 'Proxy-Connection', 'Idempotency-Key', 'Content-Type']) {
    INVALID[`the forbidden name ${name}`] = { type: 'apiKey', in: 'header', name, value: MARKER }
  }
  INVALID['a lone surrogate in an api key value'] = { type: 'apiKey', in: 'query', name: 'key', value: 'ab\uD800cd' }
  INVALID['a lone low surrogate in a token'] = { type: 'bearer', token: 'ab\uDC00cd' }
  INVALID['a lone surrogate in a username'] = { type: 'basic', username: 'us\uD800er', password: 'x' }
  INVALID['a lone surrogate in a password'] = { type: 'basic', username: 'u', password: 'pass\uD800word' }

  it.each(Object.entries(INVALID))('refuses %s', (_label, auth) => {
    expect(isValidCustomAuth(auth)).toBe(false)
  })

  it('keeps the reserved header names equal to the ones the engine refuses', () => {
    expect([...FORBIDDEN_AUTH_NAMES].sort()).toEqual([...FORBIDDEN_NAMES].sort())
  })

  it('accepts a well-formed surrogate pair', () => {
    expect(isValidCustomAuth({ type: 'basic', username: 'u😀', password: 'pass😀word' })).toBe(true)
  })

  it('counts length in UTF-16 units like the engine, so a value the engine would refuse never reaches it', () => {
    const emoji = '😀'.repeat(1001)
    expect(isValidCustomAuth({ type: 'bearer', token: emoji })).toBe(false)
    expect(isValidCustomAuth({ type: 'bearer', token: '😀'.repeat(1000) })).toBe(true)
  })

  it('accepts the limits exactly', () => {
    expect(isValidCustomAuth({ type: 'apiKey', in: 'header', name: 'a'.repeat(128), value: 'v'.repeat(2000) })).toBe(true)
    expect(isValidCustomAuth({ type: 'basic', username: 'u'.repeat(256), password: 'p'.repeat(2000) })).toBe(true)
  })

  it.each(Object.entries(VALID))('encodes %s so the engine parser reads it back unchanged', (_label, auth) => {
    expect(parseConnectionSecret(encodeCustomAuth(auth))).toEqual({ kind: 'structured', auth })
  })

  it('validates the channel arguments, the name rules included', () => {
    const channel = CHANNELS.secretsSetCustomConnection
    expect(validateArgs(channel, { name: 'My API', auth: VALID.bearer })).toBe(true)
    expect(validateArgs(channel, { name: 'My API', auth: VALID.bearer, extra: 1 })).toBe(false)
    expect(validateArgs(channel, { name: '', auth: VALID.bearer })).toBe(false)
    expect(validateArgs(channel, { name: 'My API', auth: INVALID['the forbidden name Host'] })).toBe(false)
    expect(validateArgs(channel, { name: 'My API', auth: INVALID['an extra field on bearer'] })).toBe(false)
    expect(validateArgs(channel, { name: 'My API' })).toBe(false)
    expect(Value.Check(CONTRACTS[channel].result, undefined)).toBe(true)
  })

  it('validates the oauth channel arguments', () => {
    for (const channel of [CHANNELS.oauthConnect, CHANNELS.oauthDisconnect]) {
      for (const provider of ['google', 'microsoft', 'slack']) expect(validateArgs(channel, { provider })).toBe(true)
      expect(validateArgs(channel, { provider: 'github' })).toBe(false)
      expect(validateArgs(channel, { provider: 'google', extra: 1 })).toBe(false)
      expect(validateArgs(channel, undefined)).toBe(false)
    }
  })
})

function harness(options: { available?: boolean } = {}) {
  const safeStorage: SafeStorageLike & { available: boolean } = {
    available: options.available ?? true,
    isEncryptionAvailable: () => safeStorage.available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
  }
  const logs: string[] = []
  const config = createConfigStore({ dir: join(dir, 'data') })
  const secrets = createSecretStore({ dir: join(dir, 'data'), safeStorage, log: (line) => logs.push(line) })
  const attachments = createAttachmentStore({ dir: join(dir, 'data', 'attachments') })
  const supervisor = {
    info: vi.fn(async () => ({ url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 })),
    restart: vi.fn(async () => undefined),
    status: vi.fn((): EngineStatus => ({ state: 'running', restarts: 0 })),
  }
  const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
  const handlers = createIpcHandlers({ config, secrets, supervisor, attachments, dialog, app: { quit: vi.fn() }, loginItem: { set: vi.fn() }, keyCheck: vi.fn(async () => ({ status: 'valid' as const })), log: (line) => logs.push(line) })
  const call = (channel: Channel, args?: unknown) => handlers[channel](args)
  return { call, logs, supervisor, secrets, safeStorage }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('ipc: setCustomConnection', () => {
  it.each(Object.entries(VALID))('stores %s as an http connection with the structured string and its auth type', async (_label, auth) => {
    const h = harness()
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth })
    expect(await h.secrets.getConnections()).toEqual([{ name: 'My API', kind: 'http', secret: encodeCustomAuth(auth), authType: auth.type }])
    expect(await h.secrets.listConnections()).toEqual([{ name: 'My API', kind: 'http', authType: auth.type }])
  })

  it('restarts the engine once, and not when nothing changed', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.bearer })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.bearer })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.basic })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
  })

  it('refuses a name that differs only in case or form from any saved connection of any kind', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'Team', kind: 'slack', secret: 'https://hooks.example.test/abc' })
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.bearer })
    for (const name of ['team', 'TEAM', 'my api', 'MY API']) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetCustomConnection, { name, auth: VALID.bearer })))).toBe('NAME_COLLISION')
    }
    expect(await h.secrets.listConnections()).toEqual([
      { name: 'Team', kind: 'slack' },
      { name: 'My API', kind: 'http', authType: 'bearer' },
    ])
  })

  it('refuses the exact name of a saved connection of another kind, and keeps it', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'Team', kind: 'slack', secret: 'https://hooks.example.test/abc' })
    expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetCustomConnection, { name: 'Team', auth: VALID.bearer })))).toBe('NAME_COLLISION')
    expect(await h.secrets.listConnections()).toEqual([{ name: 'Team', kind: 'slack' }])
  })

  it('refuses the exact name of a saved plain http connection, and keeps its secret', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'Legacy', kind: 'http', secret: 'plain-token-0123' })
    expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetCustomConnection, { name: 'Legacy', auth: VALID.bearer })))).toBe('NAME_COLLISION')
    expect(await h.secrets.getConnections()).toEqual([{ name: 'Legacy', kind: 'http', secret: 'plain-token-0123' }])
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('never overwrites a connection of another kind that is saved at the same moment', async () => {
    const slack = { name: 'Team', kind: 'slack' as const, secret: 'https://hooks.example.test/abc' }
    const before = harness()
    await Promise.allSettled([before.call(CHANNELS.secretsSetCustomConnection, { name: 'Team', auth: VALID.bearer }), before.secrets.setConnection(slack)])
    expect(await before.secrets.listConnections()).toEqual([{ name: 'Team', kind: 'slack' }])
    const after = harness()
    const [stored, custom] = await Promise.allSettled([after.secrets.setConnection(slack), after.call(CHANNELS.secretsSetCustomConnection, { name: 'Team', auth: VALID.bearer })])
    expect(stored.status).toBe('fulfilled')
    expect(hostErrorCode((custom as PromiseRejectedResult).reason)).toBe('NAME_COLLISION')
    expect(await after.secrets.listConnections()).toEqual([{ name: 'Team', kind: 'slack' }])
  })

  it('still replaces a custom connection of the same name', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.bearer })
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.basic })
    expect(await h.secrets.listConnections()).toEqual([{ name: 'My API', kind: 'http', authType: 'basic' }])
  })

  it('refuses unknown fields and malformed auth, and stores nothing', async () => {
    const h = harness()
    for (const args of [
      { name: 'a', auth: { ...VALID.bearer, extra: 1 } },
      { name: 'a', auth: VALID.bearer, kind: 'slack' },
      { name: 'a', auth: INVALID_HOST },
      { name: 'a', auth: { type: 'basic', username: 'a:b', password: 'x' } },
      { name: '', auth: VALID.bearer },
      { auth: VALID.bearer },
    ]) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetCustomConnection, args)))).toBe('INVALID_ARGUMENTS')
    }
    expect(await h.secrets.listConnections()).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('maps a missing keychain to NO_KEYCHAIN', async () => {
    const h = harness({ available: false })
    expect(hostErrorCode(await failure(h.call(CHANNELS.secretsSetCustomConnection, { name: 'a', auth: VALID.bearer })))).toBe('NO_KEYCHAIN')
  })

  it('carries no component in any result, log or error text', async () => {
    const h = harness()
    const seen: string[] = []
    for (const auth of [VALID['api key in the query']!, VALID.basic!, VALID.bearer!]) {
      seen.push(JSON.stringify(await h.call(CHANNELS.secretsSetCustomConnection, { name: `n-${auth.type}`, auth })))
    }
    seen.push(JSON.stringify(await h.call(CHANNELS.settingsGet)))
    const error = await failure(h.call(CHANNELS.secretsSetCustomConnection, { name: 'n-bearer', auth: { type: 'bearer', token: `${MARKER}\n` } }))
    seen.push(error.message, String(error.stack ?? ''))
    const collision = await failure(h.call(CHANNELS.secretsSetCustomConnection, { name: 'N-BEARER', auth: VALID.bearer }))
    seen.push(collision.message)
    const everything = [...seen, ...h.logs].join('\n')
    for (const hidden of [MARKER, LOGIN, `${USER}:${MARKER}`]) expect(everything).not.toContain(hidden)
    expect(h.logs).toEqual([])
  })

  it('keeps the file encrypted and the components out of clear text', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'My API', auth: VALID.basic })
    const bytes = readFileSync(join(dir, 'data', 'secrets.bin'))
    expect(bytes.toString('utf8')).not.toContain(MARKER)
    expect(bytes.toString('latin1')).not.toContain(MARKER)
  })

  it('returns a result that validates, and accepts a 2000 character value although the string is longer', async () => {
    const h = harness()
    const auth: CustomAuth = { type: 'basic', username: 'u'.repeat(256), password: 'p'.repeat(2000) }
    const result = await h.call(CHANNELS.secretsSetCustomConnection, { name: 'Big', auth })
    expect(validateResult(CHANNELS.secretsSetCustomConnection, result)).toBe(true)
    const stored = (await h.secrets.getConnections())[0]!
    expect(stored.secret.length).toBeGreaterThan(2000)
    expect(parseConnectionSecret(stored.secret)).toEqual({ kind: 'structured', auth })
  })
})

const INVALID_HOST = { type: 'apiKey', in: 'header', name: 'Host', value: MARKER }

describe('settings: authType and oauth', () => {
  it('lists authType for custom connections only, and no secret', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: `https://hooks.example.test/${MARKER}` })
    await h.call(CHANNELS.secretsSetCustomConnection, { name: 'api', auth: VALID.basic })
    await h.call(CHANNELS.secretsSetConnection, { name: 'old', kind: 'http', secret: `plain-${MARKER}` })
    await h.call(CHANNELS.secretsSetConnection, { name: 'sign', kind: 'webhookSecret', secret: `sig-${MARKER}` })
    const settings = (await h.call(CHANNELS.settingsGet)) as { connections: unknown[]; oauth: unknown }
    expect(settings.connections).toEqual([
      { name: 'team', kind: 'slack' },
      { name: 'api', kind: 'http', authType: 'basic' },
      { name: 'old', kind: 'http' },
      { name: 'sign', kind: 'webhookSecret' },
    ])
    expect(JSON.stringify(settings)).not.toContain(MARKER)
    expect(validateResult(CHANNELS.settingsGet, settings)).toBe(true)
  })

  it('reports oauth as unavailable with no accounts in the real host', async () => {
    const h = harness()
    const settings = (await h.call(CHANNELS.settingsGet)) as { oauth: unknown }
    expect(settings.oauth).toEqual({ available: false, accounts: [] })
    const patched = (await h.call(CHANNELS.settingsUpdate, { openAtLogin: true })) as { oauth: unknown }
    expect(patched.oauth).toEqual({ available: false, accounts: [] })
  })

  it('rejects oauth.connect with OAUTH_UNAVAILABLE and resolves disconnect without changing anything', async () => {
    const h = harness()
    for (const provider of ['google', 'microsoft', 'slack']) {
      const error = await failure(h.call(CHANNELS.oauthConnect, { provider }))
      expect(error).toBeInstanceOf(HostError)
      expect(hostErrorCode(error)).toBe('OAUTH_UNAVAILABLE')
      expect(error.message).toBe('OAUTH_UNAVAILABLE')
      await expect(h.call(CHANNELS.oauthDisconnect, { provider })).resolves.toBeUndefined()
    }
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })
})

describe('secret store: older files', () => {
  it('loads a file written before authType existed, and keeps loading it after a new connection is added', async () => {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
      decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
    }
    const old = { version: 1, providerKeys: [], connections: [{ name: 'team', kind: 'slack', secret: 'https://hooks.example.test/x' }, { name: 'api', kind: 'http', secret: 'plain-token' }] }
    writeFileSync(join(dir, 'secrets.bin'), safeStorage.encryptString(JSON.stringify(old)))
    const store = createSecretStore({ dir, safeStorage })
    expect(await store.listConnections()).toEqual([{ name: 'team', kind: 'slack' }, { name: 'api', kind: 'http' }])
    await store.setConnection({ name: 'custom', kind: 'http', secret: encodeCustomAuth(VALID.bearer!), authType: 'bearer' })
    expect(await store.listConnections()).toEqual([{ name: 'team', kind: 'slack' }, { name: 'api', kind: 'http' }, { name: 'custom', kind: 'http', authType: 'bearer' }])
    expect(await store.unreadable()).toBe(false)
  })

  it('treats a file with an unknown authType as unreadable, and refuses an authType on a kind other than http', async () => {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (bytes) => bytes.toString('utf8'),
    }
    writeFileSync(join(dir, 'secrets.bin'), JSON.stringify({ version: 1, providerKeys: [], connections: [{ name: 'a', kind: 'http', secret: 'x', authType: 'digest' }] }))
    const store = createSecretStore({ dir, safeStorage })
    expect(await store.unreadable()).toBe(true)
    await expect(store.setConnection({ name: 'b', kind: 'slack', secret: 'https://hooks.example.test/x', authType: 'bearer' })).rejects.toMatchObject({ reason: 'invalid_value' })
    await expect(store.setConnection({ name: 'b', kind: 'http', secret: 'x', authType: 'digest' as never })).rejects.toMatchObject({ reason: 'invalid_value' })
  })

  it('counts a change of the auth type alone as a change', async () => {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (bytes) => bytes.toString('utf8'),
    }
    const store = createSecretStore({ dir, safeStorage })
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'same' })).resolves.toBe(true)
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'same' })).resolves.toBe(false)
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'same', authType: 'bearer' })).resolves.toBe(true)
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'same', authType: 'bearer' })).resolves.toBe(false)
    expect(await store.listConnections()).toEqual([{ name: 'a', kind: 'http', authType: 'bearer' }])
  })

  it('keeps the 2000 character limit for every kind but http', async () => {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (bytes) => bytes.toString('utf8'),
    }
    const store = createSecretStore({ dir, safeStorage })
    await expect(store.setConnection({ name: 'a', kind: 'slack', secret: 'x'.repeat(2001) })).rejects.toMatchObject({ reason: 'invalid_value' })
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'x'.repeat(8193) })).rejects.toMatchObject({ reason: 'invalid_value' })
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'x'.repeat(8192) })).resolves.toBe(true)
  })
})
