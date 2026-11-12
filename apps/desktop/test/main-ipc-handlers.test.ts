// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../src/main/attachments'
import { createConfigStore } from '../src/main/config-store'
import { createIpcHandlers, type DialogLike } from '../src/main/ipc-handlers'
import { createSecretStore, type SafeStorageLike } from '../src/main/secret-store'
import { CHANNELS, HostError, hostErrorCode, validateResult, type Channel, type EngineInfo } from '../src/shared/host-api'

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

function harness(options: { available?: boolean; picks?: string[] } = {}) {
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
  const supervisor = { info: vi.fn(async () => info), restart: vi.fn(async () => undefined) }
  const picks = [...(options.picks ?? [])]
  const showOpenDialog = vi.fn(async (options: unknown) => (options === undefined || picks.length === 0 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picks.shift()!] }))
  const dialog: DialogLike = { showOpenDialog: showOpenDialog as DialogLike['showOpenDialog'] }
  const app = { quit: vi.fn() }
  const loginItem = { set: vi.fn() }
  const handlers = createIpcHandlers({ config, secrets, supervisor, attachments, dialog, app, loginItem })
  const call = (channel: Channel, args?: unknown) => handlers[channel](args)
  return { handlers, call, supervisor, dialog, showOpenDialog, app, loginItem, safeStorage, config, secrets }
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
      [CHANNELS.settingsUpdate, { extra: true }],
      [CHANNELS.settingsUpdate, 'text'],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic' }],
      [CHANNELS.secretsSetProviderKey, { provider: 'nope', value: 'k' }],
      [CHANNELS.secretsClearProviderKey, undefined],
      [CHANNELS.secretsSetConnection, { name: 'a', kind: 'ftp', secret: 's' }],
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
    expect(await h.secrets.configuredProviders()).toEqual([])
  })

  it('returns results that validate against the schemas', async () => {
    const h = harness({ picks: [join(userFiles, 'a.txt')] })
    writeFileSync(join(userFiles, 'a.txt'), 'hello')
    const checks: Array<[Channel, unknown]> = [
      [CHANNELS.engineInfo, undefined],
      [CHANNELS.engineRestart, undefined],
      [CHANNELS.settingsGet, undefined],
      [CHANNELS.settingsUpdate, { openAtLogin: true }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY }],
      [CHANNELS.secretsClearProviderKey, { provider: 'anthropic' }],
      [CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: HOOK }],
      [CHANNELS.secretsRemoveConnection, { name: 'team' }],
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

  it('returns the engine address and maps a missing engine to ENGINE_UNAVAILABLE', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.engineInfo)).toEqual({ url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 })
    h.supervisor.info.mockRejectedValueOnce(new HostError('ENGINE_UNAVAILABLE'))
    expect(hostErrorCode(await failure(h.call(CHANNELS.engineInfo)))).toBe('ENGINE_UNAVAILABLE')
  })
})

describe('ipc handlers: secrets', () => {
  it('returns nothing from secrets calls, whatever the outcome', async () => {
    const h = harness()
    expect(await h.call(CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: KEY })).toBeUndefined()
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
