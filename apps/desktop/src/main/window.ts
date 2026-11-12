import { pathToFileURL } from 'node:url'
import { CSP } from './csp'

export interface NavigationEventLike {
  url: string
  preventDefault(): void
}

export interface SessionLike {
  webRequest: {
    onHeadersReceived(
      listener: (
        details: { url: string; responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
      ) => void,
    ): void
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void,
    ): void
  }
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
}

export interface WebContentsLike {
  session: SessionLike
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: string, listener: (event: NavigationEventLike) => void): unknown
  send(channel: string, payload: unknown): void
  executeJavaScript(code: string): Promise<unknown>
}

export interface BrowserWindowLike {
  webContents: WebContentsLike
  loadFile(path: string): Promise<void>
  loadURL(url: string): Promise<void>
  on(event: string, listener: (event: { preventDefault(): void }) => void): unknown
  once(event: string, listener: () => void): unknown
  show(): void
  hide(): void
  focus(): void
  restore(): void
  isMinimized(): boolean
  isDestroyed(): boolean
}

export interface MainWindowDeps {
  BrowserWindow: new (options: Record<string, unknown>) => BrowserWindowLike
  preloadPath: string
  rendererFile: string
  devUrl?: string
  startHidden: boolean
  isQuitting: () => boolean
}

export interface MainWindow {
  window: BrowserWindowLike
  show(): void
}

export const ENGINE_REQUEST_FILTER = { urls: ['ws://127.0.0.1/*', 'ws://localhost/*'] }

export function WEB_PREFERENCES(preloadPath: string) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  }
}

export function isAppUrl(url: string, appFile: string, devUrl: string | undefined): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (devUrl !== undefined && parsed.origin === new URL(devUrl).origin) return true
  const app = pathToFileURL(appFile)
  return parsed.protocol === 'file:' && parsed.host === '' && parsed.pathname === app.pathname
}

export function guardSession(session: SessionLike, options: { appFile: string; devUrl: string | undefined }): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  if (options.devUrl === undefined) {
    session.webRequest.onHeadersReceived((details, callback) => {
      if (!isAppUrl(details.url, options.appFile, undefined)) return callback({ ...(details.responseHeaders === undefined ? {} : { responseHeaders: details.responseHeaders }) })
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
    })
  }
  session.webRequest.onBeforeSendHeaders(ENGINE_REQUEST_FILTER, (details, callback) => {
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders).filter(([name]) => name.toLowerCase() !== 'origin'))
    callback({ requestHeaders })
  })
}

export function createMainWindow(deps: MainWindowDeps): MainWindow {
  const window = new deps.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'Rill',
    webPreferences: WEB_PREFERENCES(deps.preloadPath),
  })
  const contents = window.webContents
  guardSession(contents.session, { appFile: deps.rendererFile, devUrl: deps.devUrl })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const event of ['will-navigate', 'will-redirect']) {
    contents.on(event, (navigation) => {
      if (!isAppUrl(navigation.url, deps.rendererFile, deps.devUrl)) navigation.preventDefault()
    })
  }
  contents.on('will-attach-webview', (event) => event.preventDefault())
  window.on('close', (event) => {
    if (deps.isQuitting()) return
    event.preventDefault()
    window.hide()
  })
  if (!deps.startHidden) window.once('ready-to-show', () => window.show())
  void (deps.devUrl === undefined ? window.loadFile(deps.rendererFile) : window.loadURL(deps.devUrl))
  return {
    window,
    show() {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    },
  }
}
