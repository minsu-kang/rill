// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentError, createAttachmentStore } from '../src/main/attachments'
import { createConfigStore } from '../src/main/config-store'
import { createIpcHandlers, type DialogLike } from '../src/main/ipc-handlers'
import type { KeyChecker } from '../src/main/key-check'
import { createSecretStore, type SafeStorageLike } from '../src/main/secret-store'
import { CHANNELS, HostError, MAX_SECRET_LENGTH, hostErrorCode, validateResult, type Channel, type EngineInfo, type EngineStatus, type KeyVerdict } from '../src/shared/host-api'

const MARKER = 'IPC-MARKER'
const KEY = `sk-ant-${MARKER}-key`
const HOOK = `https://hooks.example.test/${MARKER}`

let dir: string
let userFiles: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-ipc-'))
  userFiles = join(dir, 'user')
  mkdirSync(userFiles)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function harness(options: { available?: boolean; picks?: string[]; verdict?: KeyVerdict } = {}) {
  const safeStorage: SafeStorageLike & { available: boolean } = {
    available: options.available ?? true,
    isEncryptionAvailable: () => safeStorage.available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
  }
  const config = createConfigStore({ dir: join(dir, 'data') })
  const secrets = createSecretStore({ dir: join(dir, 'data'), safeStorage })
  const attachments = createAttachmentStore({ dir: join(dir, 'data', 'attachments') })
  const info: EngineInfo = { url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 }
  const supervisor = { info: vi.fn(async () => info), restart: vi.fn(async () => undefined), status: vi.fn((): EngineStatus => ({ state: 'running', restarts: 0 })) }
  const picks = [...(options.picks ?? [])]
  const showOpenDialog = vi.fn(async (options: unknown) => (options === undefined || picks.length === 0 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picks.shift()!] }))
  const dialog: DialogLike = { showOpenDialog: showOpenDialog as DialogLike['showOpenDialog'] }
  const app = { quit: vi.fn() }
  const loginItem = { set: vi.fn() }
  const keyCheck = vi.fn<KeyChecker>(async () => options.verdict ?? { status: 'valid' })
  const handlers = createIpcHandlers({ config, secrets, supervisor, attachments, dialog, app, loginItem, keyCheck })
  const call = (channel: Channel, args?: unknown) => handlers[channel](args)
  const allow = async (...folders: string[]) => {
    for (const folder of folders) {
      picks.push(folder)
      await call(CHANNELS.dialogsPickFolder)
    }
  }
  return { handlers, call, allow, picks, supervisor, dialog, showOpenDialog, app, loginItem, safeStorage, config, secrets, keyCheck }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('ipc handlers: shape', () => {
  it('has one handler for every channel', () => {
    const { handlers } = harness()
    expect(Object.keys(handlers).sort()).toEqual(Object.values(CHANNELS).sort())
  })

  it('rejects invalid arguments for every channel that takes some with INVALID_ARGUMENTS, and runs nothing', async () => {
    const h = harness()
    const bad: Array<[Channel, unknown]> = [
      [CHANNELS.engineInfo, { x: 1 }],
      [CHANNELS.engineStatus, 'now'],
      [CHANNELS.settingsUpdate, { extra: true }],
      [CHANNELS.settingsUpdate, 'text'],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic' }],
      [CHANNELS.secretsSetProviderKey, { provider: 'nope', value: 'k' }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: { force: true } }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: { saveAnyway: 'yes' } }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', saveAnyway: true }],
      [CHANNELS.secretsClearProviderKey, undefined],
      [CHANNELS.secretsSetConnection, { name: 'a', kind: 'ftp', secret: 's' }],
      [CHANNELS.secretsSetCustomConnection, { name: 'a', auth: { type: 'digest' } }],
      [CHANNELS.secretsSetCustomConnection, { name: 'a', kind: 'http', secret: 's' }],
      [CHANNELS.oauthConnect, { provider: 'github' }],
      [CHANNELS.oauthDisconnect, undefined],
      [CHANNELS.secretsRemoveConnection, { name: '' }],
      [CHANNELS.dialogsPickFile, { kind: 'other' }],
      [CHANNELS.attachmentsAddFromPath, { path: 5 }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'a.txt', bytes: 'text' }],
      [CHANNELS.appQuit, 'now'],
    ]
    for (const [channel, args] of bad) {
      const error = await failure(h.call(channel, args))
      expect(hostErrorCode(error), `${channel} ${JSON.stringify(args)}`).toBe('INVALID_ARGUMENTS')
      expect(error.message).toBe('INVALID_ARGUMENTS')
    }
    expect(h.supervisor.restart).not.toHaveBeenCalled()
    expect(h.app.quit).not.toHaveBeenCalled()
    expect(h.showOpenDialog).not.toHaveBeenCalled()
    expect(h.keyCheck).not.toHaveBeenCalled()
    expect(await h.secrets.configuredProviders()).toEqual([])
  })

  it('returns results that validate against the schemas', async () => {
    const h = harness({ picks: [join(userFiles, 'a.txt')] })
    writeFileSync(join(userFiles, 'a.txt'), 'hello')
    const checks: Array<[Channel, unknown]> = [
      [CHANNELS.engineInfo, undefined],
      [CHANNELS.engineStatus, undefined],
      [CHANNELS.engineRestart, undefined],
      [CHANNELS.settingsGet, undefined],
      [CHANNELS.settingsUpdate, { openAtLogin: true }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY }],
      [CHANNELS.secretsClearProviderKey, { provider: 'anthropic' }],
      [CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK }],
      [CHANNELS.secretsSetCustomConnection, { name: 'api', auth: { type: 'basic', username: 'u', password: 'p' } }],
      [CHANNELS.secretsRemoveConnection, { name: 'team' }],
      [CHANNELS.oauthDisconnect, { provider: 'google' }],
      [CHANNELS.dialogsPickFile, { kind: 'attachment' }],
      [CHANNELS.attachmentsAddFromPath, { path: join(userFiles, 'a.txt') }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'b.txt', bytes: new Uint8Array([1, 2]) }],
      [CHANNELS.dialogsPickFolder, undefined],
      [CHANNELS.appQuit, undefined],
    ]
    for (const [channel, args] of checks) {
      const result = await h.call(channel, args)
      expect(validateResult(channel, result), channel).toBe(true)
    }
  })
})

describe('ipc handlers: settings', () => {
  it('assembles the settings from the stores without any secret', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetProviderKey, { provider: 'openai', value: KEY })
    await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK })
    await h.allow('/Users/a/Docs')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Docs'], provider: 'openai', model: 'gpt-6.1-sol' })
    const settings = await h.call(CHANNELS.settingsGet)
    expect(settings).toEqual({
      allowedFolders: ['/Users/a/Docs'],
      provider: 'openai',
      model: 'gpt-6.1-sol',
      openAtLogin: false,
      configuredProviders: ['openai'],
      connections: [{ name: 'team', kind: 'slack' }],
      encryptionAvailable: true,
      oauth: { available: false, accounts: [] },
    })
    expect(JSON.stringify(settings)).not.toContain(MARKER)
  })

  it('leaves out the model when there is none, and reports a missing keychain', async () => {
    const h = harness({ available: false })
    const settings = (await h.call(CHANNELS.settingsGet)) as Record<string, unknown>
    expect('model' in settings).toBe(false)
    expect(settings.encryptionAvailable).toBe(false)
  })

  it('restarts the engine once when the folders, the provider or the model change, and not when they do not', async () => {
    const h = harness()
    await h.allow('/a', '/b')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/a'] })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/a/'] })
    await h.call(CHANNELS.settingsUpdate, {})
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.settingsUpdate, { model: 'claude-haiku-5-5' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
    await h.call(CHANNELS.settingsUpdate, { provider: 'openai', model: 'gpt-6.1-sol', allowedFolders: ['/b'] })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(3)
  })

  it('refuses a folder the folder dialog never returned, even a harmless one, and changes nothing', async () => {
    const h = harness({ picks: ['/Users/a/Docs'] })
    for (const folder of ['/', '/Users/a/Docs', '/etc', '/Users/a/Other']) {
      expect(hostErrorCode(await failure(h.call(CHANNELS.settingsUpdate, { allowedFolders: [folder] }))), folder).toBe('INVALID_SETTINGS')
    }
    expect(((await h.call(CHANNELS.settingsGet)) as { allowedFolders: string[] }).allowedFolders).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('accepts a folder the dialog returned, in any spelling of the same path, and then keeps it without a new pick', async () => {
    const h = harness()
    await h.allow('/Users/a/Docs/')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Docs'] })
    await h.allow('/Users/a/Receipts')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Receipts', '/Users/a/Docs'] })
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Docs'] })
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: [] })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(4)
  })

  it('refuses a mixed list when one folder was never picked, and keeps the old list', async () => {
    const h = harness()
    await h.allow('/Users/a/Docs')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Docs'] })
    expect(hostErrorCode(await failure(h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Docs', '/Users/a/.ssh'] })))).toBe('INVALID_SETTINGS')
    expect(((await h.call(CHANNELS.settingsGet)) as { allowedFolders: string[] }).allowedFolders).toEqual(['/Users/a/Docs'])
  })

  it('does not remember a folder from the file dialog, and forgets the oldest of the folders after 100', async () => {
    const h = harness()
    h.picks.push('/Users/a/Docs')
    await h.call(CHANNELS.dialogsPickFile, { kind: 'any' })
    expect(hostErrorCode(await failure(h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/Users/a/Docs'] })))).toBe('INVALID_SETTINGS')
    for (let i = 0; i < 101; i++) await h.allow(`/f${i}`)
    expect(hostErrorCode(await failure(h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/f0'] })))).toBe('INVALID_SETTINGS')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/f1', '/f100'] })
  })

  it('restarts when only the provider changes, and when one folder is swapped for another', async () => {
    const h = harness()
    await h.call(CHANNELS.settingsUpdate, { provider: 'openai', model: 'gpt-6.1-sol' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.settingsUpdate, { provider: 'gemini', model: 'gpt-6.1-sol' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
    await h.allow('/a', '/b', '/c')
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/a', '/b'] })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(3)
    await h.call(CHANNELS.settingsUpdate, { allowedFolders: ['/a', '/c'] })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(4)
  })

  it('applies the login item without restarting the engine', async () => {
    const h = harness()
    await h.call(CHANNELS.settingsUpdate, { openAtLogin: true })
    expect(h.loginItem.set).toHaveBeenCalledExactlyOnceWith(true)
    expect(h.supervisor.restart).not.toHaveBeenCalled()
    await h.call(CHANNELS.settingsUpdate, { openAtLogin: true })
    expect(h.loginItem.set).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.settingsUpdate, { openAtLogin: false })
    expect(h.loginItem.set).toHaveBeenLastCalledWith(false)
  })

  it('maps a bad folder or a missing model to INVALID_SETTINGS, without a restart', async () => {
    const h = harness()
    await h.allow('relative')
    expect(hostErrorCode(await failure(h.call(CHANNELS.settingsUpdate, { allowedFolders: ['relative'] })))).toBe('INVALID_SETTINGS')
    expect(hostErrorCode(await failure(h.call(CHANNELS.settingsUpdate, { provider: 'grok' })))).toBe('INVALID_SETTINGS')
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('restarts the engine on demand, always, and waits for it', async () => {
    const h = harness()
    await h.call(CHANNELS.engineRestart)
    await h.call(CHANNELS.engineRestart)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
  })

  it('returns the current engine state with every call, so a page that loads late still sees it', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.engineStatus)).toEqual({ state: 'running', restarts: 0 })
    h.supervisor.status.mockReturnValue({ state: 'stopped', error: 'crashed', restarts: 5 })
    expect(await h.call(CHANNELS.engineStatus)).toEqual({ state: 'stopped', error: 'crashed', restarts: 5 })
  })

  it('refuses a result that does not match its schema, with INTERNAL, and says so in the log', async () => {
    const h = harness()
    const logs: string[] = []
    h.supervisor.status.mockReturnValue({ state: 'running', restarts: 0, token: 'leak' } as never)
    const handlers = createIpcHandlers({ config: h.config, secrets: h.secrets, supervisor: h.supervisor, attachments: createAttachmentStore({ dir: join(dir, 'a') }), dialog: h.dialog, app: h.app, loginItem: h.loginItem, keyCheck: h.keyCheck, log: (line) => logs.push(line) })
    expect(await failure(handlers[CHANNELS.engineStatus](undefined))).toMatchObject({ message: 'INTERNAL' })
    expect(logs).toEqual([`result of ${CHANNELS.engineStatus} did not match its schema`])
  })

  it('returns the engine address and maps a missing engine to ENGINE_UNAVAILABLE', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.engineInfo)).toEqual({ url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 })
    h.supervisor.info.mockRejectedValueOnce(new HostError('ENGINE_UNAVAILABLE'))
    expect(hostErrorCode(await failure(h.call(CHANNELS.engineInfo)))).toBe('ENGINE_UNAVAILABLE')
  })
})

describe('ipc handlers: secrets', () => {
  it('returns the verdict from setProviderKey and nothing from the other secrets calls', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY })).toEqual({ verdict: { status: 'valid' } })
    expect(await h.call(CHANNELS.secretsClearProviderKey, { provider: 'anthropic' })).toBeUndefined()
    expect(await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK })).toBeUndefined()
    expect(await h.call(CHANNELS.secretsRemoveConnection, { name: 'team' })).toBeUndefined()
  })

  it('restarts once when the key of the chosen provider changes, and not for another provider or the same value', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsSetProviderKey, { provider: 'openai', value: `${KEY}-2` })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsClearProviderKey, { provider: 'openai' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsClearProviderKey, { provider: 'anthropic' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
    await h.call(CHANNELS.secretsClearProviderKey, { provider: 'anthropic' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
  })

  it('restarts once when a connection is added, changed or removed, and not for no change', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: `${HOOK}2` })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
    await h.call(CHANNELS.secretsRemoveConnection, { name: 'team' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(3)
    await h.call(CHANNELS.secretsRemoveConnection, { name: 'team' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(3)
  })

  it('maps a missing keychain to NO_KEYCHAIN and a name clash to NAME_COLLISION, with fixed messages', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'Team', kind: 'slack', secret: HOOK })
    const clash = await failure(h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK }))
    expect(clash).toMatchObject({ message: 'NAME_COLLISION' })
    h.safeStorage.available = false
    const none = await failure(h.call(CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY }))
    expect(none).toMatchObject({ message: 'NO_KEYCHAIN' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('never puts a value into any thrown error, even when a store fails with a message that has one', async () => {
    const h = harness()
    const hostile = createIpcHandlers({
      config: { get: async () => { throw new Error(`config broke ${KEY}`) }, update: async () => { throw new Error(`update broke ${HOOK}`) } },
      secrets: { ...h.secrets, setProviderKey: async () => { throw new Error(`set broke ${KEY}`) }, setConnection: async () => { throw new Error(HOOK) } } as never,
      supervisor: h.supervisor,
      attachments: { addFromPath: async () => { throw new Error(KEY) }, addFromBytes: async () => { throw new Error(KEY) } },
      dialog: h.dialog,
      app: h.app,
      loginItem: h.loginItem,
      keyCheck: h.keyCheck,
    })
    const calls: Array<[Channel, unknown]> = [
      [CHANNELS.settingsGet, undefined],
      [CHANNELS.settingsUpdate, { openAtLogin: true }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY }],
      [CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'a.txt', bytes: new Uint8Array([1]) }],
    ]
    for (const [channel, args] of calls) {
      const error = await failure(hostile[channel](args))
      expect(error.message, channel).toBe('INTERNAL')
      expect(String(error.stack)).not.toContain(MARKER)
      expect((error as { cause?: unknown }).cause).toBeUndefined()
    }
  })
})

describe('ipc handlers: key check before saving', () => {
  const set = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}, provider = 'anthropic', value = KEY) =>
    h.call(CHANNELS.secretsSetProviderKey, { provider, value, ...extra })

  it('asks the checker once with the provider and the key, then saves a valid key and returns the verdict', async () => {
    const h = harness({ verdict: { status: 'valid' } })
    expect(await set(h)).toEqual({ verdict: { status: 'valid' } })
    expect(h.keyCheck).toHaveBeenCalledTimes(1)
    expect(h.keyCheck).toHaveBeenCalledWith('anthropic', KEY)
    expect(await h.secrets.getProviderKey('anthropic')).toBe(KEY)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('saves an unverified key and returns the verdict with its reason', async () => {
    const h = harness({ verdict: { status: 'unverified', reason: 'network' } })
    expect(await set(h)).toEqual({ verdict: { status: 'unverified', reason: 'network' } })
    expect(await h.secrets.getProviderKey('anthropic')).toBe(KEY)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('refuses an invalid key with KEY_INVALID, saves nothing and does not restart the engine', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    const error = await failure(set(h))
    expect(hostErrorCode(error)).toBe('KEY_INVALID')
    expect(error.message).toBe('KEY_INVALID')
    expect(String(error.stack)).not.toContain(MARKER)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(await h.secrets.configuredProviders()).toEqual([])
    expect(await h.secrets.getProviderKey('anthropic')).toBeUndefined()
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('keeps an earlier key when a new one is refused', async () => {
    const h = harness()
    await set(h)
    h.keyCheck.mockResolvedValueOnce({ status: 'invalid', reason: 'rejected' })
    expect(hostErrorCode(await failure(set(h, {}, 'anthropic', `${KEY}-new`)))).toBe('KEY_INVALID')
    expect(await h.secrets.getProviderKey('anthropic')).toBe(KEY)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('saves an invalid key when saveAnyway is true, still checks it, and returns the invalid verdict', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect(await set(h, { options: { saveAnyway: true } })).toEqual({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect(h.keyCheck).toHaveBeenCalledTimes(1)
    expect(await h.secrets.getProviderKey('anthropic')).toBe(KEY)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('refuses an invalid key when saveAnyway is false or absent from the options', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'rejected' } })
    expect(hostErrorCode(await failure(set(h, { options: { saveAnyway: false } })))).toBe('KEY_INVALID')
    expect(hostErrorCode(await failure(set(h, { options: {} })))).toBe('KEY_INVALID')
    expect(await h.secrets.configuredProviders()).toEqual([])
  })

  it('restarts only when something was saved and the chosen provider changed', async () => {
    const h = harness()
    await set(h)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    expect(await set(h)).toEqual({ verdict: { status: 'valid' } })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await set(h, {}, 'openai', `${KEY}-2`)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    expect(await h.secrets.configuredProviders()).toEqual(['anthropic', 'openai'])
  })

  it('does not check or send anything when there is no keychain', async () => {
    const h = harness({ available: false })
    expect(hostErrorCode(await failure(set(h)))).toBe('NO_KEYCHAIN')
    expect(h.keyCheck).not.toHaveBeenCalled()
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('rejects arguments that do not validate before any request: unknown option, wrong type, over-long key', async () => {
    const h = harness()
    const bad: Array<Record<string, unknown>> = [
      { options: { force: true } },
      { options: { saveAnyway: 'yes' } },
      { options: { saveAnyway: 1 } },
      { options: 'saveAnyway' },
      { options: null },
      { saveAnyway: true },
      { value: 'x'.repeat(MAX_SECRET_LENGTH + 1) },
      { value: '' },
    ]
    for (const extra of bad) {
      const error = await failure(h.call(CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY, ...extra }))
      expect(hostErrorCode(error), JSON.stringify(extra)).toBe('INVALID_ARGUMENTS')
    }
    expect(h.keyCheck).not.toHaveBeenCalled()
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('accepts a key of the longest allowed length', async () => {
    const h = harness()
    const long = 'k'.repeat(MAX_SECRET_LENGTH)
    expect(await set(h, {}, 'anthropic', long)).toEqual({ verdict: { status: 'valid' } })
    expect(h.keyCheck).toHaveBeenCalledWith('anthropic', long)
  })

  it('turns a failing checker into INTERNAL without the key, and saves nothing', async () => {
    const h = harness()
    h.keyCheck.mockRejectedValueOnce(new Error(`checker broke ${KEY}`))
    const error = await failure(set(h))
    expect(error.message).toBe('INTERNAL')
    expect(String(error.stack)).not.toContain(MARKER)
    expect(await h.secrets.configuredProviders()).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('turns a checker answer that is not a verdict into INTERNAL', async () => {
    const h = harness()
    h.keyCheck.mockResolvedValueOnce({ status: 'maybe' } as never)
    expect(hostErrorCode(await failure(set(h)))).toBe('INTERNAL')
    expect(await h.secrets.configuredProviders()).toEqual([])
  })

  it('puts neither the key nor a verdict detail anywhere else: results, logs and errors carry only the fixed shapes', async () => {
    const logs: string[] = []
    const base = harness()
    const handlers = createIpcHandlers({
      config: base.config,
      secrets: base.secrets,
      supervisor: base.supervisor,
      attachments: createAttachmentStore({ dir: join(dir, 'a') }),
      dialog: base.dialog,
      app: base.app,
      loginItem: base.loginItem,
      keyCheck: base.keyCheck,
      log: (line) => logs.push(line),
    })
    const seen: unknown[] = []
    for (const verdict of [
      { status: 'valid' },
      { status: 'unverified', reason: 'timeout' },
      { status: 'invalid', reason: 'unauthorized' },
    ] as KeyVerdict[]) {
      base.keyCheck.mockResolvedValueOnce(verdict)
      const outcome = await handlers[CHANNELS.secretsSetProviderKey]({ provider: 'openai', value: `${KEY}-${verdict.status}` }).then(
        (result) => result,
        (error: Error) => ({ message: error.message, stack: error.stack }),
      )
      seen.push(outcome)
    }
    expect(JSON.stringify([seen, logs])).not.toContain(MARKER)
    expect(validateResult(CHANNELS.secretsSetProviderKey, seen[0])).toBe(true)
    expect(validateResult(CHANNELS.secretsSetProviderKey, seen[1])).toBe(true)
  })
})

describe('ipc handlers: key check races and refusals', () => {
  type Gate = { release: (verdict?: KeyVerdict) => void }

  function gated(h: ReturnType<typeof harness>, keys: string[]): Record<string, Gate> {
    const gates: Record<string, Gate> = {}
    h.keyCheck.mockImplementation(
      (_provider, key) =>
        new Promise<KeyVerdict>((resolve) => {
          if (!keys.includes(key)) return resolve({ status: 'valid' })
          gates[key] = { release: (verdict = { status: 'valid' }) => resolve(verdict) }
        }),
    )
    return gates
  }

  const set = (h: ReturnType<typeof harness>, value: string, provider = 'openai', extra: Record<string, unknown> = {}) =>
    h.call(CHANNELS.secretsSetProviderKey, { provider, value, ...extra })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('keeps the newer key when an older slow check finishes after it, and tells the older call it was superseded', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`)
    await tick()
    expect(await set(h, `${KEY}-B`)).toEqual({ verdict: { status: 'valid' } })
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-B`)
    gates[`${KEY}-A`]!.release()
    const error = await failure(first)
    expect(hostErrorCode(error)).toBe('SUPERSEDED')
    expect(error.message).toBe('SUPERSEDED')
    expect(String(error.stack)).not.toContain(MARKER)
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-B`)
  })

  it('supersedes the older call even when the older check finishes first', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`, `${KEY}-B`])
    const first = set(h, `${KEY}-A`)
    await tick()
    const second = set(h, `${KEY}-B`)
    await tick()
    gates[`${KEY}-A`]!.release()
    expect(hostErrorCode(await failure(first))).toBe('SUPERSEDED')
    expect(await h.secrets.getProviderKey('openai')).toBeUndefined()
    gates[`${KEY}-B`]!.release()
    await second
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-B`)
  })

  it('does not restart the engine for a superseded call', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`, 'anthropic')
    await tick()
    await set(h, `${KEY}-B`, 'anthropic')
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    gates[`${KEY}-A`]!.release()
    await failure(first)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    expect(await h.secrets.getProviderKey('anthropic')).toBe(`${KEY}-B`)
  })

  it('does not bring back a key that was removed while its check was running', async () => {
    const h = harness()
    await set(h, `${KEY}-old`)
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`)
    await tick()
    expect(await h.call(CHANNELS.secretsClearProviderKey, { provider: 'openai' })).toBeUndefined()
    expect(await h.secrets.configuredProviders()).toEqual([])
    gates[`${KEY}-A`]!.release()
    expect(hostErrorCode(await failure(first))).toBe('SUPERSEDED')
    expect(await h.secrets.configuredProviders()).toEqual([])
    expect(await h.secrets.getProviderKey('openai')).toBeUndefined()
  })

  it('reports a superseded call as superseded even when its verdict was a refusal', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`)
    await tick()
    await set(h, `${KEY}-B`)
    gates[`${KEY}-A`]!.release({ status: 'invalid', reason: 'unauthorized' })
    expect(hostErrorCode(await failure(first))).toBe('SUPERSEDED')
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-B`)
  })

  it('lets a slow check of one provider finish while another provider is saved', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`, 'openai')
    await tick()
    await set(h, `${KEY}-G`, 'gemini')
    await h.call(CHANNELS.secretsClearProviderKey, { provider: 'gemini' })
    gates[`${KEY}-A`]!.release()
    expect(await first).toEqual({ verdict: { status: 'valid' } })
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-A`)
  })

  it('lets a later call save normally after a superseded one', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`)
    await tick()
    await set(h, `${KEY}-B`)
    gates[`${KEY}-A`]!.release()
    await failure(first)
    expect(await set(h, `${KEY}-C`)).toEqual({ verdict: { status: 'valid' } })
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-C`)
  })

  it('does not count a call that fails before any check, such as one without a keychain', async () => {
    const h = harness()
    const gates = gated(h, [`${KEY}-A`])
    const first = set(h, `${KEY}-A`)
    await tick()
    h.safeStorage.available = false
    expect(hostErrorCode(await failure(set(h, `${KEY}-B`)))).toBe('NO_KEYCHAIN')
    h.safeStorage.available = true
    gates[`${KEY}-A`]!.release()
    expect(await first).toEqual({ verdict: { status: 'valid' } })
    expect(await h.secrets.getProviderKey('openai')).toBe(`${KEY}-A`)
  })

  it('refuses a malformed key with KEY_MALFORMED, even with saveAnyway, and saves nothing', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'malformed' } })
    for (const extra of [{}, { options: { saveAnyway: true } }, { options: { saveAnyway: false } }]) {
      const error = await failure(set(h, `${KEY}-bad`, 'anthropic', extra))
      expect(hostErrorCode(error)).toBe('KEY_MALFORMED')
      expect(error.message).toBe('KEY_MALFORMED')
      expect(String(error.stack)).not.toContain(MARKER)
    }
    expect(await h.secrets.configuredProviders()).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('still saves an invalid key with another reason when saveAnyway is true', async () => {
    for (const reason of ['unauthorized', 'rejected'] as const) {
      const h = harness({ verdict: { status: 'invalid', reason } })
      expect(hostErrorCode(await failure(set(h, KEY, 'anthropic')))).toBe('KEY_INVALID')
      expect(await set(h, KEY, 'anthropic', { options: { saveAnyway: true } })).toEqual({ verdict: { status: 'invalid', reason } })
      expect(await h.secrets.getProviderKey('anthropic')).toBe(KEY)
    }
  })
})

describe('ipc handlers: dialogs and attachments', () => {
  it('opens a folder dialog and returns the choice, or nothing when cancelled', async () => {
    const h = harness({ picks: ['/Users/a/Receipts'] })
    expect(await h.call(CHANNELS.dialogsPickFolder)).toBe('/Users/a/Receipts')
    expect(h.showOpenDialog.mock.calls[0]![0]).toMatchObject({ properties: expect.arrayContaining(['openDirectory']) })
    expect(await h.call(CHANNELS.dialogsPickFolder)).toBeUndefined()
  })

  it('offers only the attachment types for kind attachment, and everything for kind any', async () => {
    const h = harness({ picks: [join(userFiles, 'a.txt'), join(userFiles, 'b.bin')] })
    await h.call(CHANNELS.dialogsPickFile, { kind: 'attachment' })
    await h.call(CHANNELS.dialogsPickFile, { kind: 'any' })
    const attachment = h.showOpenDialog.mock.calls[0]![0] as { properties: string[]; filters?: Array<{ extensions: string[] }> }
    const any = h.showOpenDialog.mock.calls[1]![0] as { properties: string[]; filters?: unknown }
    expect(attachment.properties).toEqual(['openFile'])
    expect(attachment.filters?.[0]?.extensions).toEqual(expect.arrayContaining(['pdf', 'png', 'jpg', 'txt', 'csv', 'md']))
    expect(any.filters).toBeUndefined()
  })

  it('copies a file the user picked, and refuses a path the user never picked', async () => {
    const picked = join(userFiles, 'picked.txt')
    const other = join(userFiles, 'other.txt')
    writeFileSync(picked, 'hello')
    writeFileSync(other, 'private')
    const h = harness({ picks: [picked] })
    expect(await failure(h.call(CHANNELS.attachmentsAddFromPath, { path: picked }))).toMatchObject({ message: 'INVALID_ARGUMENTS' })
    await h.call(CHANNELS.dialogsPickFile, { kind: 'attachment' })
    expect(await h.call(CHANNELS.attachmentsAddFromPath, { path: picked })).toMatchObject({ mediaType: 'text/plain', name: 'picked.txt', bytes: 5 })
    expect(await failure(h.call(CHANNELS.attachmentsAddFromPath, { path: other }))).toMatchObject({ message: 'INVALID_ARGUMENTS' })
    expect(readdirSync(join(dir, 'data', 'attachments'))).toHaveLength(1)
  })

  it('maps a refused attachment to ATTACHMENT_REJECTED and a failed copy to INTERNAL', async () => {
    const h = harness()
    const tooBig = await failure(h.call(CHANNELS.attachmentsAddFromBytes, { name: 'a.txt', bytes: new Uint8Array(1024 * 1024 + 1) }))
    expect(tooBig).toMatchObject({ message: 'ATTACHMENT_REJECTED' })
    expect(await failure(h.call(CHANNELS.attachmentsAddFromBytes, { name: 'a.exe', bytes: new Uint8Array(1) }))).toMatchObject({ message: 'ATTACHMENT_REJECTED' })
  })

  it('maps a full attachment folder to ATTACHMENT_REJECTED, not to INTERNAL', async () => {
    const h = harness()
    const full = createIpcHandlers({
      config: h.config,
      secrets: h.secrets,
      supervisor: h.supervisor,
      attachments: { addFromPath: async () => { throw new AttachmentError('quota') }, addFromBytes: async () => { throw new AttachmentError('quota') } },
      dialog: h.dialog,
      app: h.app,
      loginItem: h.loginItem,
      keyCheck: h.keyCheck,
    })
    expect(await failure(full[CHANNELS.attachmentsAddFromBytes]({ name: 'a.txt', bytes: new Uint8Array([1]) }))).toMatchObject({ message: 'ATTACHMENT_REJECTED' })
  })

  it('accepts bytes and returns a reference without the path', async () => {
    const h = harness()
    const ref = (await h.call(CHANNELS.attachmentsAddFromBytes, { name: 'notes.md', bytes: new Uint8Array([35, 32, 104, 105]) })) as Record<string, unknown>
    expect(Object.keys(ref).sort()).toEqual(['bytes', 'id', 'mediaType', 'name'])
    expect(ref).toMatchObject({ mediaType: 'text/markdown', name: 'notes.md', bytes: 4 })
  })

  it('quits the app', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.appQuit)).toBeUndefined()
    expect(h.app.quit).toHaveBeenCalledTimes(1)
  })
})

describe('unexpected failures are logged by name only', () => {
  it('logs the channel and the error name or reason for an unexpected failure, never its message or any value', async () => {
    const logs: string[] = []
    const h = harness()
    const broken = { ...h.secrets, setProviderKey: async () => { throw new TypeError(`cannot use ${KEY} here`) } }
    const handlers = createIpcHandlers({ config: h.config, secrets: broken as never, supervisor: h.supervisor, attachments: createAttachmentStore({ dir: join(dir, 'a2') }), dialog: h.dialog, app: h.app, loginItem: h.loginItem, keyCheck: h.keyCheck, log: (line) => logs.push(line) })
    const error = await failure(handlers[CHANNELS.secretsSetProviderKey]({ provider: 'anthropic', value: KEY }))
    expect(hostErrorCode(error)).toBe('INTERNAL')
    expect(logs).toEqual(['rill:secrets:set-provider-key failed: TypeError'])
    expect(JSON.stringify(logs)).not.toContain(MARKER)
  })

  it('names the reason of a secret store failure that has no message of its own for the user', async () => {
    const logs: string[] = []
    const h = harness()
    const { SecretStoreError } = await import('../src/main/secret-store')
    const broken = { ...h.secrets, setProviderKey: async () => { throw new SecretStoreError('write_failed') } }
    const handlers = createIpcHandlers({ config: h.config, secrets: broken as never, supervisor: h.supervisor, attachments: createAttachmentStore({ dir: join(dir, 'a3') }), dialog: h.dialog, app: h.app, loginItem: h.loginItem, keyCheck: h.keyCheck, log: (line) => logs.push(line) })
    await failure(handlers[CHANNELS.secretsSetProviderKey]({ provider: 'anthropic', value: KEY }))
    expect(logs).toEqual(['rill:secrets:set-provider-key failed: SecretStoreError:write_failed'])
  })

  it('does not log the failures that already have their own code', async () => {
    const logs: string[] = []
    const h = harness({ available: false })
    const handlers = createIpcHandlers({ config: h.config, secrets: h.secrets, supervisor: h.supervisor, attachments: createAttachmentStore({ dir: join(dir, 'a4') }), dialog: h.dialog, app: h.app, loginItem: h.loginItem, keyCheck: h.keyCheck, log: (line) => logs.push(line) })
    const error = await failure(handlers[CHANNELS.secretsSetProviderKey]({ provider: 'anthropic', value: KEY }))
    expect(hostErrorCode(error)).toBe('NO_KEYCHAIN')
    expect(logs).toEqual([])
  })
})
