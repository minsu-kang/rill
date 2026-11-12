// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FsLike } from '../src/main/config-store'
import { SecretStoreError, createSecretStore, type SafeStorageLike } from '../src/main/secret-store'

const KEY = 'sk-ant-TESTMARKER-key-0001'
const OTHER_KEY = 'sk-oai-TESTMARKER-key-0002'
const HOOK = 'https://hooks.example.test/TESTMARKER-hook-0003'
const MARKERS = [KEY, OTHER_KEY, HOOK, 'TESTMARKER']

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-secrets-'))
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
      if (!encrypted.subarray(0, 3).equals(Buffer.from('v10'))) throw new Error(`cannot decrypt ${encrypted.toString('utf8')} TESTMARKER`)
      return Buffer.from(encrypted.subarray(3).map((byte) => byte ^ 0x5a)).toString('utf8')
    },
  }
  return fake
}

function setup(overrides: { fs?: FsLike } = {}) {
  const safeStorage = fakeSafeStorage()
  const logs: string[] = []
  const store = createSecretStore({ dir, safeStorage, log: (message) => logs.push(message), ...overrides })
  return { store, safeStorage, logs }
}

async function errorOf(promise: Promise<unknown>): Promise<SecretStoreError | undefined> {
  try {
    await promise
  } catch (error) {
    return error as SecretStoreError
  }
  return undefined
}

const file = () => join(dir, 'secrets.bin')

describe('secret store: values', () => {
  it('round-trips provider keys and survives a new store on the same folder', async () => {
    const { store, safeStorage } = setup()
    expect(await store.setProviderKey('anthropic', KEY)).toBe(true)
    expect(await store.setProviderKey('openai', OTHER_KEY)).toBe(true)
    expect(await store.getProviderKey('anthropic')).toBe(KEY)
    expect(await store.configuredProviders()).toEqual(['anthropic', 'openai'])
    const again = createSecretStore({ dir, safeStorage })
    expect(await again.getProviderKey('openai')).toBe(OTHER_KEY)
    expect(await again.getProviderKey('gemini')).toBeUndefined()
  })

  it('writes nothing readable: the file holds no marker, and has mode 0600 in a 0700 folder', async () => {
    const { store } = setup()
    await store.setProviderKey('anthropic', KEY)
    await store.setConnection({ name: 'team', kind: 'slack', secret: HOOK })
    const raw = readFileSync(file())
    for (const marker of MARKERS) expect(raw.includes(Buffer.from(marker)), marker).toBe(false)
    expect(raw.includes(Buffer.from('anthropic'))).toBe(false)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir)).toEqual(['secrets.bin'])
  })

  it('reports whether a change happened and does not rewrite when the value is the same', async () => {
    const { store } = setup()
    expect(await store.setProviderKey('anthropic', KEY)).toBe(true)
    const stamp = statSync(file()).mtimeMs
    expect(await store.setProviderKey('anthropic', KEY)).toBe(false)
    expect(statSync(file()).mtimeMs).toBe(stamp)
    expect(await store.setProviderKey('anthropic', `${KEY}-2`)).toBe(true)
    expect(await store.clearProviderKey('anthropic')).toBe(true)
    expect(await store.clearProviderKey('anthropic')).toBe(false)
    expect(await store.configuredProviders()).toEqual([])
  })

  it('lists connections by name and kind only, and hands the secrets to the main process on request', async () => {
    const { store } = setup()
    await store.setConnection({ name: 'team', kind: 'slack', secret: HOOK })
    await store.setConnection({ name: 'api', kind: 'http', secret: OTHER_KEY })
    expect(await store.listConnections()).toEqual([
      { name: 'team', kind: 'slack' },
      { name: 'api', kind: 'http' },
    ])
    expect(JSON.stringify(await store.listConnections())).not.toContain('TESTMARKER')
    expect(await store.getConnections()).toEqual([
      { name: 'team', kind: 'slack', secret: HOOK },
      { name: 'api', kind: 'http', secret: OTHER_KEY },
    ])
  })

  it('replaces a connection of the same name, and removes one', async () => {
    const { store } = setup()
    await store.setConnection({ name: 'team', kind: 'slack', secret: HOOK })
    expect(await store.setConnection({ name: 'team', kind: 'slack', secret: HOOK })).toBe(false)
    expect(await store.setConnection({ name: 'team', kind: 'http', secret: HOOK })).toBe(true)
    expect(await store.listConnections()).toEqual([{ name: 'team', kind: 'http' }])
    expect(await store.removeConnection('team')).toBe(true)
    expect(await store.removeConnection('team')).toBe(false)
    expect(await store.listConnections()).toEqual([])
  })

  it('refuses a name that collides with another after case folding, naming no secret', async () => {
    const { store, logs } = setup()
    await store.setConnection({ name: 'Slack', kind: 'slack', secret: HOOK })
    const error = await errorOf(store.setConnection({ name: 'slack', kind: 'slack', secret: OTHER_KEY }))
    expect(error).toBeInstanceOf(SecretStoreError)
    expect(error?.reason).toBe('name_collision')
    expect(error?.message).not.toContain('TESTMARKER')
    expect(await store.listConnections()).toEqual([{ name: 'Slack', kind: 'slack' }])
    expect(logs.join('\n')).not.toContain('TESTMARKER')
  })

  it('refuses an empty value, a value with a NUL byte and a bad connection name', async () => {
    const { store } = setup()
    for (const value of ['', 'a\u0000b']) expect((await errorOf(store.setProviderKey('anthropic', value)))?.reason, JSON.stringify(value)).toBe('invalid_value')
    expect((await errorOf(store.setConnection({ name: '', kind: 'slack', secret: 's' })))?.reason).toBe('invalid_value')
    expect((await errorOf(store.setConnection({ name: 'a\nb', kind: 'slack', secret: 's' })))?.reason).toBe('invalid_value')
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps names that look like object keys as plain names', async () => {
    const { store } = setup()
    await store.setConnection({ name: '__proto__', kind: 'http', secret: HOOK })
    await store.setConnection({ name: 'constructor', kind: 'http', secret: HOOK })
    expect((await store.getConnections()).map((c) => c.name)).toEqual(['__proto__', 'constructor'])
  })

  it('serialises concurrent writes so none is lost', async () => {
    const { store } = setup()
    await Promise.all([
      store.setProviderKey('anthropic', KEY),
      store.setProviderKey('openai', OTHER_KEY),
      store.setConnection({ name: 'a', kind: 'http', secret: 's1' }),
      store.setConnection({ name: 'b', kind: 'http', secret: 's2' }),
    ])
    expect(await store.configuredProviders()).toEqual(['anthropic', 'openai'])
    expect((await store.listConnections()).map((c) => c.name)).toEqual(['a', 'b'])
  })
})

describe('secret store: no keychain', () => {
  it('refuses to save with no_keychain, writes no file, and reads as empty', async () => {
    const { store, safeStorage } = setup()
    safeStorage.available = false
    expect(store.encryptionAvailable()).toBe(false)
    expect((await errorOf(store.setProviderKey('anthropic', KEY)))?.reason).toBe('no_keychain')
    expect((await errorOf(store.setConnection({ name: 'team', kind: 'slack', secret: HOOK })))?.reason).toBe('no_keychain')
    expect((await errorOf(store.clearProviderKey('anthropic')))?.reason).toBe('no_keychain')
    expect(readdirSync(dir)).toEqual([])
    expect(await store.configuredProviders()).toEqual([])
    expect(await store.getConnections()).toEqual([])
  })

  it('does not touch an existing file while the keychain is unavailable', async () => {
    const { store, safeStorage } = setup()
    await store.setProviderKey('anthropic', KEY)
    const before = readFileSync(file())
    safeStorage.available = false
    expect(await store.configuredProviders()).toEqual([])
    expect(readFileSync(file()).equals(before)).toBe(true)
    safeStorage.available = true
    expect(await store.getProviderKey('anthropic')).toBe(KEY)
  })
})

describe('secret store: unreadable file', () => {
  it('reports an undecryptable file without a crash, without content and with one fixed log line', async () => {
    writeFileSync(file(), `garbage ${KEY} garbage`)
    const { store, logs } = setup()
    expect(await store.unreadable()).toBe(true)
    expect(await store.configuredProviders()).toEqual([])
    expect(await store.listConnections()).toEqual([])
    expect(await store.getProviderKey('anthropic')).toBeUndefined()
    expect(logs).toEqual(['the secrets file could not be read'])
  })

  it('treats a decryptable file with the wrong content as unreadable', async () => {
    for (const inner of ['not json', '[]', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, providerKeys: [{ provider: 'azure', value: 'x' }], connections: [] }), JSON.stringify({ version: 1, providerKeys: [], connections: [{ name: 'a', kind: 'ftp', secret: 'x' }] })]) {
      const safeStorage = fakeSafeStorage()
      writeFileSync(file(), safeStorage.encryptString(inner))
      const store = createSecretStore({ dir, safeStorage })
      expect(await store.unreadable(), inner).toBe(true)
      expect(await store.configuredProviders()).toEqual([])
    }
  })

  it('lets the user enter the keys again: the bad file is kept as secrets.bin.bak and replaced', async () => {
    writeFileSync(file(), 'broken bytes')
    const { store } = setup()
    expect(await store.setProviderKey('anthropic', KEY)).toBe(true)
    expect(readFileSync(join(dir, 'secrets.bin.bak'), 'utf8')).toBe('broken bytes')
    expect(await store.unreadable()).toBe(false)
    expect(await store.getProviderKey('anthropic')).toBe(KEY)
  })
})

describe('secret store: an unreadable file is never destroyed', () => {
  it('keeps the first bad file and every later one under a new name instead of overwriting the backup', async () => {
    writeFileSync(file(), 'first bad file')
    const { store } = setup()
    expect(await store.setProviderKey('anthropic', KEY)).toBe(true)
    writeFileSync(file(), 'second bad file')
    expect(await store.setProviderKey('openai', OTHER_KEY)).toBe(true)
    writeFileSync(file(), 'third bad file')
    expect(await store.clearProviderKey('openai')).toBe(false)
    expect(readFileSync(join(dir, 'secrets.bin.bak'), 'utf8')).toBe('first bad file')
    expect(readFileSync(join(dir, 'secrets.bin.bak.1'), 'utf8')).toBe('second bad file')
    expect(readFileSync(join(dir, 'secrets.bin.bak.2'), 'utf8')).toBe('third bad file')
    expect(readdirSync(dir).sort()).toEqual(['secrets.bin', 'secrets.bin.bak', 'secrets.bin.bak.1', 'secrets.bin.bak.2'])
  })

  it('refuses to write when the bad file cannot be kept, and leaves it where it is', async () => {
    writeFileSync(file(), 'bad file')
    const { safeStorage } = setup()
    const failing = createSecretStore({ dir, safeStorage, fs: { ...fsp, rename: (async (from: string, to: string) => { if (to.includes('.bak')) throw new Error('no permission'); return fsp.rename(from, to) }) as FsLike['rename'] } })
    expect((await errorOf(failing.setProviderKey('anthropic', KEY)))?.reason).toBe('write_failed')
    expect(readFileSync(file(), 'utf8')).toBe('bad file')
    expect(readdirSync(dir)).toEqual(['secrets.bin'])
  })

  it('refuses to write when ten backups already exist, and overwrites none of them', async () => {
    writeFileSync(file(), 'newest bad file')
    writeFileSync(join(dir, 'secrets.bin.bak'), 'backup 0')
    for (let i = 1; i < 10; i++) writeFileSync(join(dir, `secrets.bin.bak.${i}`), `backup ${i}`)
    const { store } = setup()
    expect((await errorOf(store.setProviderKey('anthropic', KEY)))?.reason).toBe('write_failed')
    expect(readFileSync(file(), 'utf8')).toBe('newest bad file')
    expect(readFileSync(join(dir, 'secrets.bin.bak'), 'utf8')).toBe('backup 0')
    expect(readFileSync(join(dir, 'secrets.bin.bak.9'), 'utf8')).toBe('backup 9')
  })
})

describe('secret store: failures and logging', () => {
  it('keeps the old file and throws a fixed error when the rename fails', async () => {
    const { store, safeStorage } = setup()
    await store.setProviderKey('anthropic', KEY)
    const before = readFileSync(file())
    const failing = createSecretStore({
      dir,
      safeStorage,
      fs: { ...fsp, rename: (async () => { throw new Error(`disk problem near ${KEY}`) }) as FsLike['rename'] },
    })
    const error = await errorOf(failing.setProviderKey('openai', OTHER_KEY))
    expect(error?.reason).toBe('write_failed')
    expect(error?.message).not.toContain('TESTMARKER')
    expect(error?.cause).toBeUndefined()
    expect(readFileSync(file()).equals(before)).toBe(true)
    expect(readdirSync(dir)).toEqual(['secrets.bin'])
    expect(await store.configuredProviders()).toEqual(['anthropic'])
  })

  it('never puts a value in any error message or log line, whatever goes wrong', async () => {
    const { store, safeStorage, logs } = setup()
    const messages: string[] = []
    const attempts: Array<Promise<unknown>> = [
      store.setProviderKey('anthropic', KEY),
      store.setConnection({ name: 'team', kind: 'slack', secret: HOOK }),
      store.setConnection({ name: 'TEAM', kind: 'slack', secret: HOOK }),
    ]
    for (const attempt of attempts) {
      const error = await errorOf(attempt)
      if (error) messages.push(error.message, String(error.stack ?? ''))
    }
    safeStorage.available = false
    const error = await errorOf(store.setProviderKey('openai', OTHER_KEY))
    messages.push(error?.message ?? '', String(error?.stack ?? ''))
    writeFileSync(file(), `corrupt ${KEY}`)
    safeStorage.available = true
    await store.configuredProviders()
    for (const text of [...messages, ...logs]) for (const marker of MARKERS) expect(text, marker).not.toContain(marker)
    expect(logs.length).toBeGreaterThan(0)
  })
})
