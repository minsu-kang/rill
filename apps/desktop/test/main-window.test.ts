// @vitest-environment node
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CSP, injectCsp } from '../src/main/csp'
import {
  ENGINE_REQUEST_FILTER,
  WEB_PREFERENCES,
  createMainWindow,
  guardSession,
  isAppUrl,
  type BrowserWindowLike,
  type SessionLike,
  type WebContentsLike,
} from '../src/main/window'

type Listener = (...args: never[]) => void

class FakeSession implements SessionLike {
  permissionRequest: ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined
  permissionCheck: (() => boolean) | undefined
  headersReceived: ((details: { url: string; responseHeaders?: Record<string, string[]> }, callback: (response: { responseHeaders?: Record<string, string[]> }) => void) => void) | undefined
  beforeSend: { filter: unknown; listener: (details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void } | undefined
  webRequest = {
    onHeadersReceived: (listener: NonNullable<FakeSession['headersReceived']>) => {
      this.headersReceived = listener
    },
    onBeforeSendHeaders: (filter: unknown, listener: NonNullable<FakeSession['beforeSend']>['listener']) => {
      this.beforeSend = { filter, listener }
    },
  }
  setPermissionRequestHandler(handler: NonNullable<FakeSession['permissionRequest']>) {
    this.permissionRequest = handler
  }
  setPermissionCheckHandler(handler: () => boolean) {
    this.permissionCheck = handler
  }
}

class FakeWebContents implements WebContentsLike {
  session = new FakeSession()
  openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
  listeners = new Map<string, Listener[]>()
  sent: Array<[string, unknown]> = []
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }) {
    this.openHandler = handler
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload])
  }
  executeJavaScript = vi.fn(async () => undefined)
  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload)
  }
}

class FakeWindow implements BrowserWindowLike {
  static last: FakeWindow
  webContents = new FakeWebContents()
  loadedFile: string | undefined
  loadedUrl: string | undefined
  shown = 0
  hidden = 0
  focused = 0
  restored = 0
  minimized = false
  listeners = new Map<string, Listener[]>()
  constructor(readonly options: Record<string, unknown>) {
    FakeWindow.last = this
  }
  loadFile(path: string) {
    this.loadedFile = path
    return Promise.resolve()
  }
  loadURL(url: string) {
    this.loadedUrl = url
    return Promise.resolve()
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  once(event: string, listener: Listener) {
    this.on(event, listener)
  }
  show() {
    this.shown++
  }
  hide() {
    this.hidden++
  }
  focus() {
    this.focused++
  }
  restore() {
    this.restored++
    this.minimized = false
  }
  isMinimized() {
    return this.minimized
  }
  isDestroyed() {
    return false
  }
  emit(event: string, payload?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) (listener as (p?: unknown) => void)(payload)
  }
}

const RENDERER = '/app/dist/renderer/index.html'

function make(options: { devUrl?: string; startHidden?: boolean; quitting?: boolean } = {}) {
  const state = { quitting: options.quitting ?? false }
  const created = createMainWindow({
    BrowserWindow: FakeWindow as unknown as new (options: Record<string, unknown>) => BrowserWindowLike,
    preloadPath: '/app/dist/preload/index.cjs',
    rendererFile: RENDERER,
    ...(options.devUrl === undefined ? {} : { devUrl: options.devUrl }),
    startHidden: options.startHidden ?? false,
    isQuitting: () => state.quitting,
  })
  return { created, window: FakeWindow.last, state }
}

describe('window: web preferences', () => {
  it('sets every hardening flag, and nothing else that widens access', () => {
    expect(WEB_PREFERENCES('/p/preload.cjs')).toEqual({
      preload: '/p/preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    })
  })

  it('passes them to the window together with show false', () => {
    const { window } = make()
    expect(window.options.webPreferences).toEqual(WEB_PREFERENCES('/app/dist/preload/index.cjs'))
    expect(window.options.show).toBe(false)
    expect(window.options.title).toBe('Rill')
  })
})

describe('window: loading and showing', () => {
  it('loads the built file, or the dev server address when one is given', () => {
    expect(make().window.loadedFile).toBe(RENDERER)
    const dev = make({ devUrl: 'http://localhost:5173/' }).window
    expect(dev.loadedUrl).toBe('http://localhost:5173/')
    expect(dev.loadedFile).toBeUndefined()
  })

  it('shows the window when it is ready, unless it starts hidden', () => {
    const visible = make().window
    visible.emit('ready-to-show')
    expect(visible.shown).toBe(1)
    const hidden = make({ startHidden: true }).window
    hidden.emit('ready-to-show')
    expect(hidden.shown).toBe(0)
  })

  it('brings a hidden or minimized window to the front with show()', () => {
    const { created, window } = make()
    window.minimized = true
    created.show()
    expect(window.restored).toBe(1)
    expect(window.shown).toBe(1)
    expect(window.focused).toBe(1)
    created.show()
    expect(window.restored).toBe(1)
    expect(window.shown).toBe(2)
  })

  it('hides instead of closing, unless the app is quitting', () => {
    const closed = { prevented: 0 }
    const { window, state } = make()
    window.emit('close', { preventDefault: () => closed.prevented++ })
    expect(closed.prevented).toBe(1)
    expect(window.hidden).toBe(1)
    state.quitting = true
    window.emit('close', { preventDefault: () => closed.prevented++ })
    expect(closed.prevented).toBe(1)
    expect(window.hidden).toBe(1)
  })
})

describe('window: navigation and new windows', () => {
  it('denies every attempt to open a new window', () => {
    const { window } = make()
    for (const url of ['https://example.com', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)']) {
      expect(window.webContents.openHandler?.({ url }), url).toEqual({ action: 'deny' })
    }
  })

  it('blocks navigation and redirects to anything except the app file', () => {
    const { window } = make()
    const appUrl = pathToFileURL(RENDERER).href
    for (const event of ['will-navigate', 'will-redirect']) {
      const blocked: string[] = []
      for (const url of ['https://example.com/', 'file:///etc/passwd', `${appUrl}.evil`, 'file:///app/dist/renderer/other.html', 'http://127.0.0.1:1/', 'data:text/html,x', 'javascript:alert(1)']) {
        window.webContents.emit(event, { url, preventDefault: () => blocked.push(url) })
      }
      expect(blocked, event).toHaveLength(7)
      const allowed: string[] = []
      window.webContents.emit(event, { url: appUrl, preventDefault: () => allowed.push(appUrl) })
      window.webContents.emit(event, { url: `${appUrl}#section`, preventDefault: () => allowed.push('hash') })
      expect(allowed).toEqual([])
    }
  })

  it('allows the dev server only when one is configured', () => {
    const blocked: string[] = []
    const dev = make({ devUrl: 'http://localhost:5173/' }).window
    dev.webContents.emit('will-navigate', { url: 'http://localhost:5173/page', preventDefault: () => blocked.push('dev') })
    expect(blocked).toEqual([])
    dev.webContents.emit('will-navigate', { url: 'http://localhost:9999/', preventDefault: () => blocked.push('other') })
    expect(blocked).toEqual(['other'])
    const plain = make().window
    plain.webContents.emit('will-navigate', { url: 'http://localhost:5173/', preventDefault: () => blocked.push('plain') })
    expect(blocked).toEqual(['other', 'plain'])
  })

  it('refuses webview attachment', () => {
    const { window } = make()
    let prevented = 0
    window.webContents.emit('will-attach-webview', { preventDefault: () => prevented++ })
    expect(prevented).toBe(1)
  })

  it('recognises the app url exactly', () => {
    const appUrl = pathToFileURL(RENDERER).href
    expect(isAppUrl(appUrl, RENDERER, undefined)).toBe(true)
    expect(isAppUrl(`${appUrl}?a=1#b`, RENDERER, undefined)).toBe(true)
    expect(isAppUrl('file:///app/dist/renderer/', RENDERER, undefined)).toBe(false)
    expect(isAppUrl('not a url', RENDERER, undefined)).toBe(false)
    expect(isAppUrl('http://localhost:5173/x', RENDERER, 'http://localhost:5173/')).toBe(true)
    expect(isAppUrl('http://localhost.evil.test:5173/x', RENDERER, 'http://localhost:5173/')).toBe(false)
  })
})

describe('window: session', () => {
  it('denies every permission request and every permission check', () => {
    const { window } = make()
    const session = window.webContents.session
    const answers: boolean[] = []
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen', 'midi']) {
      session.permissionRequest?.({}, permission, (granted) => answers.push(granted))
    }
    expect(answers).toEqual(Array(7).fill(false))
    expect(session.permissionCheck?.()).toBe(false)
  })

  it('adds the content security policy to responses of the built app, and not in development', () => {
    const built = make().window.webContents.session
    let headers: Record<string, string[]> | undefined
    built.headersReceived?.({ url: pathToFileURL(RENDERER).href, responseHeaders: { 'X-Test': ['1'] } }, (response) => (headers = response.responseHeaders))
    expect(headers).toEqual({ 'X-Test': ['1'], 'Content-Security-Policy': [CSP] })
    const dev = make({ devUrl: 'http://localhost:5173/' }).window.webContents.session
    expect(dev.headersReceived).toBeUndefined()
  })

  it('removes the Origin header from requests to the local engine only', () => {
    const session = make().window.webContents.session
    expect(session.beforeSend?.filter).toEqual(ENGINE_REQUEST_FILTER)
    expect(ENGINE_REQUEST_FILTER.urls).toEqual(['ws://127.0.0.1/*', 'ws://localhost/*'])
    let sent: Record<string, string> | undefined
    session.beforeSend?.listener({ requestHeaders: { Origin: 'null', Cookie: 'a=b', 'Sec-WebSocket-Protocol': 'rill.v1' } }, (response) => (sent = response.requestHeaders))
    expect(sent).toEqual({ Cookie: 'a=b', 'Sec-WebSocket-Protocol': 'rill.v1' })
  })

  it('can guard a session on its own', () => {
    const session = new FakeSession()
    guardSession(session, { appFile: RENDERER, devUrl: undefined })
    expect(session.permissionRequest).toBeDefined()
    expect(session.beforeSend).toBeDefined()
  })
})

describe('content security policy', () => {
  it('allows only the app files and the local WebSocket addresses, and nothing remote', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:*; base-uri 'none'; form-action 'none'; object-src 'none'",
    )
    expect(CSP).not.toMatch(/unsafe-|\*\.|https?:|wss:/)
  })

  it('is put into the page as a meta tag at the start of the head', () => {
    const html = injectCsp('<!doctype html><html><head><title>x</title></head><body></body></html>')
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`)
    expect(injectCsp(html)).toBe(html)
  })

  it('refuses a page without a head', () => {
    expect(() => injectCsp('<html></html>')).toThrow('head')
  })
})
