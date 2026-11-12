import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, Tray, utilityProcess } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore } from './attachments'
import { createConfigStore } from './config-store'
import { createEngineSupervisor, type ForkLike } from './engine-supervisor'
import { createIpcHandlers, type DialogLike } from './ipc-handlers'
import { applyLoginItem, launchedHidden } from './login-item'
import { createSecretStore, type SafeStorageLike } from './secret-store'
import { runSmoke } from './smoke'
import { TRAY_ICON_DATA_URL, createTray, type MenuItemLike, type RillTray, type TrayLike } from './tray'
import { createMainWindow, isAppUrl, type BrowserWindowLike } from './window'
import { CHANNELS, ENGINE_STATUS_EVENT, hostErrorCode, type Settings } from '../shared/host-api'

const smoke = process.argv.includes('--smoke')

const smokeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: () => {
    throw new Error('safeStorage is not used in smoke mode')
  },
  decryptString: () => {
    throw new Error('safeStorage is not used in smoke mode')
  },
}

function log(message: string): void {
  process.stderr.write(`[rill] ${message}\n`)
}

async function start(): Promise<void> {
  let smokeDir: string | undefined
  if (smoke) {
    smokeDir = mkdtempSync(join(tmpdir(), 'rill-smoke-'))
    app.setPath('userData', smokeDir)
  } else if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  await app.whenReady()

  const userData = app.getPath('userData')
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  const rendererFile = join(import.meta.dirname, '../renderer/index.html')
  const bundlePath = app.isPackaged ? join(process.resourcesPath, 'engine', 'rill-engine.mjs') : join(import.meta.dirname, '../engine/rill-engine.mjs')

  const config = createConfigStore({ dir: userData })
  const secrets = createSecretStore({ dir: userData, safeStorage: smoke ? smokeStorage : safeStorage, log })
  const attachments = createAttachmentStore({ dir: join(userData, 'attachments') })
  const supervisor = createEngineSupervisor({
    fork: utilityProcess.fork as unknown as ForkLike,
    bundlePath,
    userData,
    secrets,
    config,
    log,
  })

  let quitting = false
  let engineStopped = false
  let openAtLogin = (await config.get()).openAtLogin
  const shell: { tray?: RillTray; window?: ReturnType<typeof createMainWindow> } = {}

  const dialogAdapter: DialogLike = {
    showOpenDialog: (options) =>
      shell.window === undefined ? dialog.showOpenDialog(options as never) : dialog.showOpenDialog(shell.window.window as unknown as BrowserWindow, options as never),
  }
  const handlers = createIpcHandlers({
    config,
    secrets,
    supervisor,
    attachments,
    dialog: dialogAdapter,
    app: { quit: () => app.quit() },
    loginItem: { set: (enabled) => applyLoginItem(app, enabled) },
    log,
  })
  const updateSettings = handlers[CHANNELS.settingsUpdate]
  handlers[CHANNELS.settingsUpdate] = async (args) => {
    const result = await updateSettings(args)
    openAtLogin = (result as Settings).openAtLogin
    shell.tray?.refresh()
    return result
  }

  for (const channel of Object.values(CHANNELS)) {
    ipcMain.handle(channel, async (event, args: unknown) => {
      const trusted = shell.window !== undefined && event.sender === (shell.window.window.webContents as unknown) && isAppUrl(event.senderFrame?.url ?? '', rendererFile, devUrl)
      if (!trusted) throw new Error('INVALID_ARGUMENTS')
      return handlers[channel](args).catch((error: unknown) => {
        throw new Error(hostErrorCode(error))
      })
    })
  }

  void supervisor.start()
  const window = createMainWindow({
    BrowserWindow: BrowserWindow as unknown as new (options: Record<string, unknown>) => BrowserWindowLike,
    preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
    rendererFile,
    ...(devUrl === undefined ? {} : { devUrl }),
    startHidden: smoke || launchedHidden(app, process.argv),
    isQuitting: () => quitting,
  })
  shell.window = window
  supervisor.onStatus((status) => window.window.webContents.send(ENGINE_STATUS_EVENT, status))
  window.window.webContents.on('did-finish-load', () => window.window.webContents.send(ENGINE_STATUS_EVENT, supervisor.status()))

  app.on('window-all-closed', () => undefined)
  app.on('activate', () => window.show())
  app.on('before-quit', (event) => {
    quitting = true
    if (engineStopped) return
    event.preventDefault()
    void supervisor.stop().finally(() => {
      engineStopped = true
      app.quit()
    })
  })

  if (smoke) {
    const loaded = new Promise<void>((resolve) => window.window.webContents.on('did-finish-load', () => resolve()))
    await runSmoke({
      contents: window.window.webContents,
      loaded,
      supervisor,
      print: (line) => process.stdout.write(`${line}\n`),
      exit: (code) => {
        if (smokeDir !== undefined) rmSync(smokeDir, { recursive: true, force: true })
        app.exit(code)
      },
      versions: { electron: process.versions.electron, node: process.versions.node },
    })
    return
  }

  app.on('second-instance', () => window.show())
  if (app.isPackaged) applyLoginItem(app, openAtLogin)
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  icon.setTemplateImage(true)
  shell.tray = createTray({
    Tray: Tray as unknown as new (image: unknown) => TrayLike,
    Menu: Menu as unknown as { buildFromTemplate(template: MenuItemLike[]): unknown },
    image: icon,
    locale: app.getLocale(),
    getOpenAtLogin: () => openAtLogin,
    onOpen: () => window.show(),
    onToggleOpenAtLogin: (next) => {
      void handlers[CHANNELS.settingsUpdate]({ openAtLogin: next }).catch(() => shell.tray?.refresh())
    },
    onQuit: () => {
      quitting = true
      app.quit()
    },
  })
}

export const whenStarted = start().catch((error: unknown) => {
  log(`start failed: ${error instanceof Error ? error.name : 'unknown error'}`)
  app.exit(1)
})
