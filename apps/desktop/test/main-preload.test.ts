// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createHostApi, type IpcLike } from '../src/preload/host-bridge'
import { CHANNELS, ENGINE_STATUS_EVENT, HOST_API_METHODS, hostErrorCode, type AttachmentRef } from '../src/shared/host-api'

const REF: AttachmentRef = { id: 'abcdefgh1234', mediaType: 'text/plain', name: 'a.txt', bytes: 3 }
const SETTINGS = { allowedFolders: [], provider: 'anthropic', openAtLogin: false, configuredProviders: [], connections: [], encryptionAvailable: true }

type Handler = (event: unknown, payload: unknown) => void

function fakeIpc(results: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const subscribed: Array<[string, Handler]> = []
  const removed: Array<[string, Handler]> = []
  const ipc: IpcLike = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      calls.push([channel, ...args])
      if (channel in results) {
        const value = results[channel]
        if (value instanceof Error) throw value
        return value
      }
      return undefined
    }),
    on: vi.fn((channel: string, handler: Handler) => {
      subscribed.push([channel, handler])
    }),
    removeListener: vi.fn((channel: string, handler: Handler) => {
      removed.push([channel, handler])
    }),
  }
  return { ipc, calls, subscribed, removed }
}

describe('preload bridge: surface', () => {
  it('exposes exactly the HostApi groups and methods, nothing else', () => {
    const api = createHostApi(fakeIpc().ipc)
    expect(Object.keys(api).sort()).toEqual(Object.keys(HOST_API_METHODS).sort())
    for (const [group, methods] of Object.entries(HOST_API_METHODS)) {
      const exposed = api[group as keyof typeof api] as Record<string, unknown>
      expect(Object.keys(exposed).sort(), group).toEqual(Object.keys(methods).sort())
      for (const value of Object.values(exposed)) expect(typeof value).toBe('function')
    }
  })

  it('holds no reference to the ipc object', () => {
    const { ipc } = fakeIpc()
    const api = createHostApi(ipc)
    const seen = new Set<unknown>()
    const walk = (value: unknown): void => {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) return
      seen.add(value)
      for (const key of Reflect.ownKeys(value)) walk((value as Record<PropertyKey, unknown>)[key])
    }
    walk(api)
    expect(seen.has(ipc)).toBe(false)
    expect(seen.has(ipc.invoke)).toBe(false)
  })
})

describe('preload bridge: calls', () => {
  it('invokes only channel constants, with the argument shapes of the contract', async () => {
    const { ipc, calls } = fakeIpc({
      [CHANNELS.engineInfo]: { url: 'ws://127.0.0.1:1/', token: 't', protocol: 1 },
      [CHANNELS.engineStatus]: { state: 'running', restarts: 0 },
      [CHANNELS.settingsGet]: SETTINGS,
      [CHANNELS.settingsUpdate]: SETTINGS,
      [CHANNELS.attachmentsAddFromPath]: REF,
      [CHANNELS.attachmentsAddFromBytes]: REF,
    })
    const api = createHostApi(ipc)
    await api.engine.info()
    await api.engine.restart()
    expect(await api.engine.status()).toEqual({ state: 'running', restarts: 0 })
    await api.settings.get()
    await api.settings.update({ openAtLogin: true })
    await api.secrets.setProviderKey('anthropic', 'k')
    await api.secrets.clearProviderKey('anthropic')
    await api.secrets.setConnection({ name: 'team', kind: 'slack', secret: 's' })
    await api.secrets.removeConnection('team')
    await api.dialogs.pickFolder()
    await api.dialogs.pickFile('attachment')
    await api.attachments.addFromPath('/a/b.txt')
    await api.attachments.addFromBytes({ name: 'b.txt', bytes: new Uint8Array([1, 2]) })
    await api.app.quit()
    expect(calls).toEqual([
      [CHANNELS.engineInfo],
      [CHANNELS.engineRestart],
      [CHANNELS.engineStatus],
      [CHANNELS.settingsGet],
      [CHANNELS.settingsUpdate, { openAtLogin: true }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k' }],
      [CHANNELS.secretsClearProviderKey, { provider: 'anthropic' }],
      [CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: 's' }],
      [CHANNELS.secretsRemoveConnection, { name: 'team' }],
      [CHANNELS.dialogsPickFolder],
      [CHANNELS.dialogsPickFile, { kind: 'attachment' }],
      [CHANNELS.attachmentsAddFromPath, { path: '/a/b.txt' }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'b.txt', bytes: new Uint8Array([1, 2]) }],
      [CHANNELS.appQuit],
    ])
    expect(new Set(calls.map((call) => call[0]))).toEqual(new Set(Object.values(CHANNELS)))
  })

  it('refuses invalid arguments before they leave the preload', async () => {
    const { ipc, calls } = fakeIpc()
    const api = createHostApi(ipc)
    const attempts: Array<Promise<unknown>> = [
      api.secrets.setProviderKey('anthropic', ''),
      api.secrets.setProviderKey('nope' as never, 'k'),
      api.secrets.setConnection({ name: 'a', kind: 'ftp' as never, secret: 's' }),
      api.settings.update({ extra: 1 } as never),
      api.attachments.addFromPath(5 as never),
      api.attachments.addFromBytes({ name: 'a.txt', bytes: [1, 2] as never }),
      api.dialogs.pickFile('folder' as never),
    ]
    for (const attempt of attempts) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(hostErrorCode(error)).toBe('INVALID_ARGUMENTS')
    }
    expect(calls).toEqual([])
  })

  it('maps a remote error to its fixed code and hides any other text', async () => {
    const remote = new Error("Error invoking remote method 'rill:secrets:set-provider-key': Error: NO_KEYCHAIN")
    const leak = new Error('Error invoking remote method: Error: boom with sk-ant-SECRET')
    const { ipc } = fakeIpc({ [CHANNELS.secretsSetProviderKey]: remote, [CHANNELS.secretsRemoveConnection]: leak })
    const api = createHostApi(ipc)
    const first = await api.secrets.setProviderKey('anthropic', 'k').catch((error: Error) => error)
    expect(first).toBeInstanceOf(Error)
    expect((first as Error).message).toBe('NO_KEYCHAIN')
    const second = await api.secrets.removeConnection('team').catch((error: Error) => error)
    expect((second as Error).message).toBe('INTERNAL')
    expect(String((second as Error).stack)).not.toContain('SECRET')
  })

  it('rejects a result that does not match its schema', async () => {
    const { ipc } = fakeIpc({ [CHANNELS.settingsGet]: { ...SETTINGS, apiKey: 'leak' }, [CHANNELS.engineInfo]: { nope: true } })
    const api = createHostApi(ipc)
    for (const attempt of [api.settings.get(), api.engine.info()]) {
      const error = await attempt.catch((caught: Error) => caught)
      expect((error as Error).message).toBe('INTERNAL')
    }
  })

  it('returns valid results unchanged', async () => {
    const { ipc } = fakeIpc({ [CHANNELS.dialogsPickFolder]: '/Users/a', [CHANNELS.settingsGet]: SETTINGS })
    const api = createHostApi(ipc)
    expect(await api.dialogs.pickFolder()).toBe('/Users/a')
    expect(await api.settings.get()).toEqual(SETTINGS)
  })
})

describe('preload bridge: status events', () => {
  it('passes only the status to the listener, drops malformed ones, and unsubscribes', () => {
    const { ipc, subscribed, removed } = fakeIpc()
    const api = createHostApi(ipc)
    const seen: unknown[] = []
    const off = api.engine.onStatus((status) => seen.push(status))
    expect(subscribed).toHaveLength(1)
    const [channel, handler] = subscribed[0]!
    expect(channel).toBe(ENGINE_STATUS_EVENT)
    const event = { sender: { secret: 'x' } }
    handler(event, { state: 'running', restarts: 0 })
    handler(event, { state: 'weird', restarts: 0 })
    handler(event, 'text')
    handler(event, { state: 'stopped', error: 'crashed', restarts: 5 })
    expect(seen).toEqual([{ state: 'running', restarts: 0 }, { state: 'stopped', error: 'crashed', restarts: 5 }])
    off()
    off()
    expect(removed).toEqual([[ENGINE_STATUS_EVENT, handler]])
  })

  it('keeps listeners apart', () => {
    const { ipc, subscribed, removed } = fakeIpc()
    const api = createHostApi(ipc)
    const a: unknown[] = []
    const b: unknown[] = []
    api.engine.onStatus((status) => a.push(status))
    const offB = api.engine.onStatus((status) => b.push(status))
    subscribed[1]![1](undefined, { state: 'starting', restarts: 0 })
    expect(a).toHaveLength(0)
    expect(b).toHaveLength(1)
    offB()
    expect(removed).toEqual([[ENGINE_STATUS_EVENT, subscribed[1]![1]]])
  })
})

describe('preload entry', () => {
  it('exposes one object named rill with the bridge, and never the ipc renderer', async () => {
    vi.resetModules()
    const exposeInMainWorld = vi.fn()
    const ipcRenderer = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }
    vi.doMock('electron', () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer }))
    await import('../src/preload/index')
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [name, api] = exposeInMainWorld.mock.calls[0]!
    expect(name).toBe('rill')
    expect(Object.keys(api).sort()).toEqual(Object.keys(HOST_API_METHODS).sort())
    expect(Object.values(api)).not.toContain(ipcRenderer)
    vi.doUnmock('electron')
  })
})
