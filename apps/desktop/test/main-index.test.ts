// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS, ENGINE_STATUS_EVENT } from '../src/shared/host-api'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = 0
  kill() {
    this.killed++
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

class FakeContents {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  sent: Array<[string, unknown]> = []
  session = {
    webRequest: { onHeadersReceived: vi.fn(), onBeforeSendHeaders: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }
  setWindowOpenHandler = vi.fn()
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload])
  }
  executeJavaScript = vi.fn(async (code: string) => {
    if (code.includes('window.rill')) return true
    return { state: 'ok', ms: '3' }
  })
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  static autoLoad = false
  webContents = new FakeContents()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  shown = 0
  constructor(readonly options: Record<string, unknown>) {
    FakeBrowserWindow.instances.push(this)
    if (FakeBrowserWindow.autoLoad) setTimeout(() => this.webContents.emit('did-finish-load'), 20)
  }
  loadFile = vi.fn(async () => undefined)
  loadURL = vi.fn(async () => undefined)
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  once(event: string, listener: (...args: unknown[]) => void) {
    this.on(event, listener)
  }
  show() {
    this.shown++
  }
  hide = vi.fn()
  focus = vi.fn()
  restore = vi.fn()
  isMinimized = () => false
  isDestroyed = () => false
}

class FakeTray {
  static instances: FakeTray[] = []
  menu: unknown
  constructor(readonly image: unknown) {
    FakeTray.instances.push(this)
  }
  setToolTip = vi.fn()
  setContextMenu(menu: unknown) {
    this.menu = menu
  }
  on = vi.fn()
  destroy = vi.fn()
}

interface Harness {
  app: EventEmitter & Record<string, unknown>
  children: FakeChild[]
  fork: ReturnType<typeof vi.fn>
  handlers: Map<string, (event: unknown, args: unknown) => Promise<unknown>>
  userData: string
  stdout: string[]
  exits: number[]
  loginItems: unknown[]
  quitCalls: () => number
  window: () => FakeBrowserWindow
  senderEvent: () => { sender: unknown; senderFrame: { url: string } }
  rendererUrl: string
  restore: () => void
}

let userData: string
const originalArgv = process.argv

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'rill-index-'))
  FakeBrowserWindow.instances = []
  FakeBrowserWindow.autoLoad = false
  FakeTray.instances = []
})

afterEach(() => {
  process.argv = originalArgv
  rmSync(userData, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('electron')
})

async function load(options: { lock?: boolean; smoke?: boolean; packaged?: boolean } = {}): Promise<Harness> {
  vi.resetModules()
  FakeBrowserWindow.autoLoad = options.smoke === true
  Object.defineProperty(process, 'resourcesPath', { value: '/Applications/Rill.app/Contents/Resources', configurable: true })
  process.argv = options.smoke === true ? [...originalArgv, '--smoke'] : originalArgv.filter((arg) => arg !== '--smoke')
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn(() => options.lock ?? true),
    whenReady: vi.fn(async () => undefined),
    getPath: vi.fn(() => userData),
    setPath: vi.fn((_name: string, value: string) => {
      userData = value
    }),
    getLocale: () => 'en-US',
    isPackaged: options.packaged ?? false,
    quit: vi.fn(),
    exit: vi.fn(),
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: () => ({ wasOpenedAtLogin: false }),
  }) as unknown as Harness['app']
  const children: FakeChild[] = []
  const fork = vi.fn(() => {
    const child = new FakeChild()
    children.push(child)
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'listening', host: '127.0.0.1', port: 43000, protocol: 1 })}\n`))
    return child
  })
  const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
  const stdout: string[] = []
  const exits: number[] = []
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (stdout.push(String(chunk)), true)) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  ;(app.exit as ReturnType<typeof vi.fn>).mockImplementation((code: number) => exits.push(code))
  vi.doMock('electron', () => ({
    app,
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: { handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
    Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain),
      decryptString: (bytes: Buffer) => bytes.toString(),
    },
    Tray: FakeTray,
    utilityProcess: { fork },
  }))
  const first = FakeBrowserWindow.instances.length
  const module = await import('../src/main/index')
  await module.whenStarted
  const window = () => FakeBrowserWindow.instances[first]!
  const rendererUrl = pathToFileURL(join(import.meta.dirname, '../src/main/../renderer/index.html')).href
  return {
    app,
    children,
    fork,
    handlers,
    userData,
    stdout,
    exits,
    loginItems: [],
    quitCalls: () => (app.quit as ReturnType<typeof vi.fn>).mock.calls.length,
    window,
    senderEvent: () => ({ sender: window().webContents, senderFrame: { url: rendererUrl } }),
    rendererUrl,
    restore: () => stdoutSpy.mockRestore(),
  }
}

async function up(h: Harness): Promise<void> {
  await vi.waitFor(() => expect(h.window().webContents.sent.some(([, status]) => (status as { state: string }).state === 'running')).toBe(true), { timeout: 5000 })
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('app entry: normal start', () => {
  it('takes the single instance lock and quits at once when another instance holds it', async () => {
    const h = await load({ lock: false })
    expect(h.app.quit).toHaveBeenCalledTimes(1)
    expect(FakeBrowserWindow.instances).toHaveLength(0)
    expect(h.fork).not.toHaveBeenCalled()
    expect(FakeTray.instances).toHaveLength(0)
  })

  it('creates one hardened window, a tray and starts the engine from the bundle with the allowed attachment folder', async () => {
    const h = await load()
    await up(h)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(h.window().options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false })
    expect(String((h.window().options.webPreferences as { preload: string }).preload)).toMatch(/preload\/index\.cjs$/)
    expect(FakeTray.instances).toHaveLength(1)
    expect(h.fork).toHaveBeenCalledTimes(1)
    const [bundle, args, options] = h.fork.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(bundle).toMatch(/engine\/rill-engine\.mjs$/)
    expect(args).toContain(join(h.userData, 'attachments'))
    expect(Object.keys(options.env).sort()).toEqual(expect.arrayContaining(['RILL_TOKEN']))
    expect(options.env.RILL_CONNECTIONS).toBeUndefined()
  })

  it('registers a handler for every channel and nothing else', async () => {
    const h = await load()
    expect([...h.handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort())
  })

  it('answers the window and refuses any other sender or page', async () => {
    const h = await load()
    await up(h)
    const settings = h.handlers.get(CHANNELS.settingsGet)!
    expect(await settings(h.senderEvent(), undefined)).toMatchObject({ provider: 'anthropic', encryptionAvailable: true })
    const refused = [
      { sender: {}, senderFrame: { url: h.rendererUrl } },
      { sender: h.window().webContents, senderFrame: { url: 'https://example.com/' } },
      { sender: h.window().webContents, senderFrame: null },
    ]
    for (const event of refused) await expect(settings(event, undefined)).rejects.toThrow('INVALID_ARGUMENTS')
  })

  it('turns every failure into an error that carries only a code', async () => {
    const h = await load()
    const set = h.handlers.get(CHANNELS.secretsSetProviderKey)!
    await expect(set(h.senderEvent(), { provider: 'anthropic', value: 5 })).rejects.toThrow(/^INVALID_ARGUMENTS$/)
    const none = h.handlers.get(CHANNELS.attachmentsAddFromPath)!
    await expect(none(h.senderEvent(), { path: '/etc/passwd' })).rejects.toThrow(/^INVALID_ARGUMENTS$/)
  })

  it('shows the window for a second instance and for a dock click, and never closes the app with the last window', async () => {
    const h = await load()
    const before = h.window().shown
    h.app.emit('second-instance')
    h.app.emit('activate')
    expect(h.window().shown).toBe(before + 2)
    h.app.emit('window-all-closed')
    expect(h.quitCalls()).toBe(0)
    expect(h.app.listenerCount('window-all-closed')).toBe(1)
  })

  it('sends the engine status to the window, also after the page loaded', async () => {
    const h = await load()
    await up(h)
    const sent = h.window().webContents.sent
    expect(sent.some(([channel, status]) => channel === ENGINE_STATUS_EVENT && (status as { state: string }).state === 'running')).toBe(true)
    h.window().webContents.emit('did-finish-load')
    expect(sent.at(-1)).toEqual([ENGINE_STATUS_EVENT, { state: 'running', restarts: 0 }])
  })

  it('stops the engine before quitting, once, and then lets the quit through', async () => {
    const h = await load()
    await up(h)
    let prevented = 0
    h.app.emit('before-quit', { preventDefault: () => prevented++ })
    await settle()
    expect(prevented).toBe(1)
    expect(h.children[0]!.killed).toBe(1)
    expect(h.quitCalls()).toBe(1)
    h.app.emit('before-quit', { preventDefault: () => prevented++ })
    expect(prevented).toBe(1)
  })

  it('quits from the tray menu', async () => {
    const h = await load()
    const menu = FakeTray.instances[0]!.menu as { template: Array<{ label?: string; click?: (item: { checked: boolean }) => void }> }
    menu.template.find((item) => item.label === 'Quit Rill')!.click!({ checked: false })
    expect(h.quitCalls()).toBe(1)
  })

  it('changes the login setting from the tray, saves it and refreshes the menu', async () => {
    const h = await load()
    await up(h)
    const tray = FakeTray.instances[0]!
    const first = tray.menu as { template: Array<{ label?: string; checked?: boolean; click?: (item: { checked: boolean }) => void }> }
    first.template[1]!.click!({ checked: true })
    await vi.waitFor(() => expect(tray.menu).not.toBe(first), { timeout: 5000 })
    const refreshed = tray.menu as typeof first
    expect(refreshed.template[1]!.checked).toBe(true)
    const settings = (await h.handlers.get(CHANNELS.settingsGet)!(h.senderEvent(), undefined)) as { openAtLogin: boolean }
    expect(settings.openAtLogin).toBe(true)
  })

  it('does not touch the system login items while unpackaged, and applies the saved setting when packaged', async () => {
    const dev = await load()
    await up(dev)
    expect(dev.app.setLoginItemSettings).not.toHaveBeenCalled()
    const packaged = await load({ packaged: true })
    await up(packaged)
    expect(String(packaged.fork.mock.calls[0]![0])).toBe('/Applications/Rill.app/Contents/Resources/engine/rill-engine.mjs')
    expect(packaged.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, args: ['--hidden'] })
  })
})

describe('app entry: smoke mode', () => {
  it('uses a temporary data folder, no tray and no lock, prints one result line and exits 0', async () => {
    const h = await load({ smoke: true })
    expect(h.app.setPath).toHaveBeenCalledWith('userData', expect.stringContaining('rill-smoke-'))
    expect(h.app.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(FakeTray.instances).toHaveLength(0)
    expect(h.exits).toEqual([0])
    const lines = h.stdout.join('').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, windowApi: true, engine: true, ping: true })
    expect(existsSync(h.userData)).toBe(false)
    expect(h.window().shown).toBe(0)
  })

  it('never reads the real keychain: the smoke run supplies its own storage', async () => {
    const h = await load({ smoke: true })
    expect(h.exits).toHaveLength(1)
    expect(existsSync(join(h.userData, 'secrets.bin'))).toBe(false)
  })
})
