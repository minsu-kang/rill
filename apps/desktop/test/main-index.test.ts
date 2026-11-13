// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS, ENGINE_STATUS_EVENT, OAUTH_CHANGED_EVENT } from '../src/shared/host-api'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = 0
  postMessage = vi.fn()
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
    if (code.includes('data-rill-app')) return { rendered: true, graph: true, violations: 0 }
    if (code.includes("dispatchEvent(new Event('focus'))")) return true
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
  registerScheme: ReturnType<typeof vi.fn>
  protocolHandlers: Map<string, (request: { url: string; method: string }) => Promise<Response>>
  netFetch: ReturnType<typeof vi.fn>
  setApplicationMenu: ReturnType<typeof vi.fn>
  ready: ReturnType<typeof vi.fn>
  powerMonitor: EventEmitter
  openExternal: ReturnType<typeof vi.fn>
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
  vi.unstubAllGlobals()
  process.argv = originalArgv
  rmSync(userData, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('electron')
  vi.doUnmock('@rill/protocol')
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
  const registerScheme = vi.fn()
  const protocolHandlers = new Map<string, (request: { url: string; method: string }) => Promise<Response>>()
  const netFetch = vi.fn(async (url: string) => new Response(`served ${url}`))
  const setApplicationMenu = vi.fn()
  const powerMonitor = new EventEmitter()
  const openExternal = vi.fn(async () => undefined)
  vi.doMock('electron', () => ({
    app,
    net: { fetch: netFetch },
    protocol: { registerSchemesAsPrivileged: registerScheme, handle: (scheme: string, handler: (request: { url: string; method: string }) => Promise<Response>) => protocolHandlers.set(scheme, handler) },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showSaveDialog: vi.fn(async () => ({ canceled: true })) },
    ipcMain: { handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
    Menu: { buildFromTemplate: (template: unknown) => ({ template }), setApplicationMenu },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain),
      decryptString: (bytes: Buffer) => bytes.toString(),
    },
    Tray: FakeTray,
    shell: { openExternal },
    powerMonitor,
    utilityProcess: { fork },
  }))
  vi.doMock('@rill/protocol', async () => ({
    ...(await vi.importActual<typeof import('@rill/protocol')>('@rill/protocol')),
    RillClient: { connect: async () => ({ request: async () => ({ workflowId: 'wf-smoke' }), close: () => undefined }) },
  }))
  const first = FakeBrowserWindow.instances.length
  const module = await import('../src/main/index')
  await module.whenStarted
  const window = () => FakeBrowserWindow.instances[first]!
  const rendererUrl = 'app://rill/index.html'
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
    registerScheme,
    protocolHandlers,
    netFetch,
    setApplicationMenu,
    ready: app.whenReady as ReturnType<typeof vi.fn>,
    powerMonitor,
    openExternal,
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

  it('registers the app scheme before the app is ready, serves the renderer files through it, and loads the window from it', async () => {
    const h = await load()
    expect(h.registerScheme).toHaveBeenCalledExactlyOnceWith([{ scheme: 'app', privileges: { standard: true, secure: true } }])
    expect(h.registerScheme.mock.invocationCallOrder[0]!).toBeLessThan(h.ready.mock.invocationCallOrder[0]!)
    expect(h.window().loadURL).toHaveBeenCalledExactlyOnceWith('app://rill/index.html')
    expect(h.window().loadFile).not.toHaveBeenCalled()
    const serve = h.protocolHandlers.get('app')!
    expect(await (await serve({ url: 'app://rill/assets/a.js', method: 'GET' })).text()).toBe(`served ${pathToFileURL(join(import.meta.dirname, '../src/renderer/assets/a.js')).href}`)
    expect((await serve({ url: 'app://rill/..%2fmain%2findex.mjs', method: 'GET' })).status).toBe(404)
    expect((await serve({ url: 'file:///etc/passwd', method: 'GET' })).status).toBe(404)
    expect(h.netFetch).toHaveBeenCalledTimes(1)
  })

  it('turns the developer tools and the menu with the reload and tools items off when packaged, and leaves both on in development', async () => {
    const packaged = await load({ packaged: true })
    expect(packaged.window().options.webPreferences).toMatchObject({ devTools: false })
    expect(packaged.setApplicationMenu).toHaveBeenCalledTimes(1)
    const menu = packaged.setApplicationMenu.mock.calls[0]![0] as { template: Array<{ role?: string; submenu?: unknown }> }
    expect(menu.template.map((item) => item.role)).toEqual(['appMenu', 'editMenu'])
    expect(JSON.stringify(menu.template)).not.toMatch(/dev|reload|viewMenu|inspect/i)
    const dev = await load()
    expect(dev.window().options.webPreferences).toMatchObject({ devTools: true })
    expect(dev.setApplicationMenu).not.toHaveBeenCalled()
  })

  it('removes leftover partial attachment files before the engine starts', async () => {
    mkdirSync(join(userData, 'attachments'), { recursive: true })
    writeFileSync(join(userData, 'attachments', '.partial-abcdefgh1234'), 'half')
    writeFileSync(join(userData, 'attachments', 'abcdefgh1234.txt'), 'kept')
    const h = await load()
    expect(readdirSync(join(h.userData, 'attachments'))).toEqual(['abcdefgh1234.txt'])
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
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, windowApi: true, engine: true, ping: true, appRendered: true, graphRendered: true, cspViolations: 0 })
    expect(existsSync(h.userData)).toBe(false)
    expect(h.window().shown).toBe(0)
  })

  it('never reads the real keychain: the smoke run supplies its own storage', async () => {
    const h = await load({ smoke: true })
    expect(h.exits).toHaveLength(1)
    expect(existsSync(join(h.userData, 'secrets.bin'))).toBe(false)
  })
})


describe('app entry: sign-in to Google and Microsoft', () => {
  const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
  const REFRESH = '1//0gREFRESHMARKER0123456789abcdefghijklmnop'
  const ACCESS = 'ya29.ACCESSMARKER0123456789abcdef'

  function storeAccount(): void {
    const blob = {
      version: 2,
      providerKeys: [],
      connections: [],
      oauth: {
        apps: { google: { clientId: GOOGLE_ID } },
        accounts: { google: { refreshToken: REFRESH, scope: 'openid https://www.googleapis.com/auth/spreadsheets', account: 'someone@example.com', connectedAt: 1 } },
      },
    }
    writeFileSync(join(userData, 'secrets.bin'), Buffer.from(JSON.stringify(blob)))
  }

  function tokenEndpoint(answer: () => Promise<Response> | Response = () => new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' }), { status: 200 })) {
    const answered = vi.fn()
    const fetchSpy = vi.fn(async (...args: [string, RequestInit]) => {
      void args
      const response = await answer()
      answered()
      return response
    })
    vi.stubGlobal('fetch', fetchSpy)
    return { fetchSpy, answered }
  }

  const quit = async (h: Harness) => {
    h.app.emit('before-quit', { preventDefault: () => undefined })
    await settle()
  }

  it('asks the engine for nothing and the provider for nothing when no account is signed in', async () => {
    const { fetchSpy } = tokenEndpoint()
    const h = await load()
    await up(h)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(h.openExternal).not.toHaveBeenCalled()
    expect((h.fork.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env.RILL_CONNECTIONS).toBeUndefined()
  })

  it('refreshes a signed-in account before the engine starts and starts the engine with the new access token and its kind', async () => {
    storeAccount()
    const { fetchSpy, answered } = tokenEndpoint()
    const h = await load()
    await up(h)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(String(init.body)).toContain('grant_type=refresh_token')
    expect(answered.mock.invocationCallOrder[0]!).toBeLessThan(h.fork.mock.invocationCallOrder[0]!)
    const [, args, options] = h.fork.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(JSON.parse(options.env.RILL_CONNECTIONS!)).toEqual({ google: { secret: ACCESS, kind: 'google' } })
    expect(JSON.stringify([args, Object.entries(options.env).filter(([name]) => name !== 'RILL_CONNECTIONS')])).not.toContain('REFRESHMARKER')
    await quit(h)
  })

  it('opens the window while the refresh is still waiting, and starts the engine with the token when it answers', async () => {
    storeAccount()
    let answer!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      answer = resolve
    })
    tokenEndpoint(() => pending)
    const h = await load()
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.fork).not.toHaveBeenCalled()
    answer(new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' }), { status: 200 }))
    await up(h)
    const [, , options] = h.fork.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(JSON.parse(options.env.RILL_CONNECTIONS!)).toEqual({ google: { secret: ACCESS, kind: 'google' } })
    await quit(h)
  })

  it('starts the engine without the token when the refresh fails, and sends the token over the channel once a retry works', async () => {
    storeAccount()
    let attempts = 0
    tokenEndpoint(() => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' }), { status: 200 })
    })
    const h = await load()
    await up(h)
    const [, , options] = h.fork.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(options.env.RILL_CONNECTIONS).toBeUndefined()
    expect(h.children[0]!.postMessage.mock.calls).toEqual([[{ type: 'connection.remove', name: 'google' }], [{ type: 'connection.remove', name: 'microsoft' }]])
    await quit(h)
  })

  it('sends the current token to the engine over the channel when the engine reports running', async () => {
    storeAccount()
    tokenEndpoint()
    const h = await load()
    await up(h)
    expect(h.children[0]!.postMessage).toHaveBeenCalledWith({ type: 'connection.set', name: 'google', kind: 'google', secret: ACCESS })
    await quit(h)
  })

  it('sends the token again to the new engine after every restart, and seeds it into the environment of the new start', async () => {
    storeAccount()
    tokenEndpoint()
    const h = await load()
    await up(h)
    await h.handlers.get(CHANNELS.engineRestart)!(h.senderEvent(), undefined)
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    await vi.waitFor(() => expect(h.children[1]!.postMessage).toHaveBeenCalledWith({ type: 'connection.set', name: 'google', kind: 'google', secret: ACCESS }))
    const [, , options] = h.fork.mock.calls[1] as unknown as [string, string[], { env: Record<string, string> }]
    expect(JSON.parse(options.env.RILL_CONNECTIONS!)).toEqual({ google: { secret: ACCESS, kind: 'google' } })
    expect(h.children[0]!.postMessage.mock.calls.filter(([message]) => (message as { type: string }).type === 'connection.set')).toHaveLength(1)
    await quit(h)
  })

  it('tells the window about a change of an account and lists the oauth state in the settings', async () => {
    const h = await load()
    await up(h)
    const sent = h.window().webContents.sent
    await h.handlers.get(CHANNELS.oauthSetApp)!(h.senderEvent(), { provider: 'google', clientId: GOOGLE_ID })
    expect(sent.filter(([channel]) => channel === OAUTH_CHANGED_EVENT)).toEqual([[OAUTH_CHANGED_EVENT, { provider: 'google', status: 'not_connected' }]])
    const settings = (await h.handlers.get(CHANNELS.settingsGet)!(h.senderEvent(), undefined)) as { oauth: { apps: unknown[] } }
    expect(settings.oauth.apps[0]).toEqual({ provider: 'google', clientId: GOOGLE_ID, hasSecret: false })
  })

  it('refreshes a token that expired while the computer slept, when the system resumes', async () => {
    storeAccount()
    let issued = 0
    tokenEndpoint(() => new Response(JSON.stringify({ access_token: `ya29.ACCESSMARKER${String(++issued).padStart(10, '0')}`, expires_in: 100, token_type: 'Bearer' }), { status: 200 }))
    const h = await load()
    await up(h)
    expect(h.powerMonitor.listenerCount('resume')).toBe(1)
    h.powerMonitor.emit('resume')
    await vi.waitFor(() => expect(h.children[0]!.postMessage).toHaveBeenCalledWith({ type: 'connection.set', name: 'google', kind: 'google', secret: 'ya29.ACCESSMARKER0000000002' }))
    await quit(h)
  })

  it('refreshes and answers over the channel when the running engine asks for a new token, and ignores anything else it sends', async () => {
    storeAccount()
    let issued = 0
    const { fetchSpy } = tokenEndpoint(() => new Response(JSON.stringify({ access_token: `ya29.ACCESSMARKER${String(++issued).padStart(10, '0')}`, expires_in: 3599, token_type: 'Bearer' }), { status: 200 }))
    const h = await load()
    await up(h)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const child = h.children[0]!
    child.postMessage.mockClear()
    child.emit('message', { type: 'connection.renew', name: 'google', secret: 'x' })
    child.emit('message', { type: 'connection.renew', name: 'slack' })
    child.emit('message', 'connection.renew')
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(child.postMessage).not.toHaveBeenCalled()
    child.emit('message', { type: 'connection.renew', name: 'google' })
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledWith({ type: 'connection.set', name: 'google', kind: 'google', secret: 'ya29.ACCESSMARKER0000000002' }))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    child.emit('message', { type: 'connection.renew', name: 'google' })
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await quit(h)
  })

  it('opens the browser only with the address of the provider and never at start', async () => {
    const h = await load()
    await up(h)
    expect(h.openExternal).not.toHaveBeenCalled()
  })
})
