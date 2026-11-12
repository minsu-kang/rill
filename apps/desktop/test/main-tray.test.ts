// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { TRAY_ICON_DATA_URL, createTray, type MenuItemLike, type TrayLike } from '../src/main/tray'
import { applyLoginItem, launchedHidden } from '../src/main/login-item'

class FakeTray implements TrayLike {
  static last: FakeTray
  tooltip = ''
  menu: unknown
  listeners = new Map<string, Array<() => void>>()
  destroyed = false
  constructor(readonly image: unknown) {
    FakeTray.last = this
  }
  setToolTip(text: string) {
    this.tooltip = text
  }
  setContextMenu(menu: unknown) {
    this.menu = menu
  }
  on(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  destroy() {
    this.destroyed = true
  }
}

function make(options: { locale?: string; openAtLogin?: boolean } = {}) {
  const state = { openAtLogin: options.openAtLogin ?? false }
  const calls: string[] = []
  const built: MenuItemLike[][] = []
  const created = createTray({
    Tray: FakeTray as unknown as new (image: unknown) => TrayLike,
    Menu: { buildFromTemplate: (template: MenuItemLike[]) => (built.push(template), { template }) },
    image: { fake: 'image' },
    locale: options.locale ?? 'en-US',
    getOpenAtLogin: () => state.openAtLogin,
    onOpen: () => calls.push('open'),
    onToggleOpenAtLogin: (next) => calls.push(`login:${next}`),
    onQuit: () => calls.push('quit'),
  })
  return { created, state, calls, built, tray: FakeTray.last }
}

describe('tray menu', () => {
  it('has Open, Open at login with its state, and Quit, in that order', () => {
    const { built, tray } = make({ openAtLogin: true })
    expect(tray.image).toEqual({ fake: 'image' })
    expect(tray.tooltip).toBe('Rill')
    const items = built[0]!
    expect(items.map((item) => item.label ?? item.type)).toEqual(['Open Rill', 'Open at login', 'separator', 'Quit Rill'])
    expect(items[1]).toMatchObject({ type: 'checkbox', checked: true })
    expect(tray.menu).toEqual({ template: items })
  })

  it('calls the right handlers', () => {
    const { built, calls } = make()
    const [open, login, , quit] = built[0]!
    open!.click?.({ checked: false })
    login!.click?.({ checked: true })
    login!.click?.({ checked: false })
    quit!.click?.({ checked: false })
    expect(calls).toEqual(['open', 'login:true', 'login:false', 'quit'])
  })

  it('rebuilds the menu with the new login state on refresh', () => {
    const { created, state, built, tray } = make()
    expect(built[0]![1]!.checked).toBe(false)
    state.openAtLogin = true
    created.refresh()
    expect(built).toHaveLength(2)
    expect(built[1]![1]!.checked).toBe(true)
    expect(tray.menu).toEqual({ template: built[1] })
  })

  it('opens the window on double click, and removes the tray icon on destroy', () => {
    const { created, calls, tray } = make()
    tray.listeners.get('double-click')?.[0]?.()
    expect(calls).toEqual(['open'])
    created.destroy()
    expect(tray.destroyed).toBe(true)
  })

  it('speaks Korean for a Korean locale', () => {
    const { built } = make({ locale: 'ko-KR' })
    expect(built[0]!.map((item) => item.label ?? item.type)).toEqual(['Rill 열기', '로그인 시 시작', 'separator', 'Rill 종료'])
  })

  it('carries an icon the app can draw: a PNG data URL', () => {
    expect(TRAY_ICON_DATA_URL.startsWith('data:image/png;base64,')).toBe(true)
    const bytes = Buffer.from(TRAY_ICON_DATA_URL.split(',')[1]!, 'base64')
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(bytes.length).toBeLessThan(2000)
  })
})

describe('login item', () => {
  it('sets openAtLogin and the hidden argument for a packaged app', () => {
    const setLoginItemSettings = vi.fn()
    applyLoginItem({ isPackaged: true, setLoginItemSettings }, true)
    applyLoginItem({ isPackaged: true, setLoginItemSettings }, false)
    expect(setLoginItemSettings).toHaveBeenNthCalledWith(1, { openAtLogin: true, args: ['--hidden'] })
    expect(setLoginItemSettings).toHaveBeenNthCalledWith(2, { openAtLogin: false, args: ['--hidden'] })
  })

  it('leaves the system alone when the app is not packaged', () => {
    const setLoginItemSettings = vi.fn()
    applyLoginItem({ isPackaged: false, setLoginItemSettings }, true)
    expect(setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('starts hidden when opened at login or given --hidden', () => {
    const settings = (wasOpenedAtLogin: boolean) => ({ getLoginItemSettings: () => ({ wasOpenedAtLogin }) })
    expect(launchedHidden(settings(true), ['rill'])).toBe(true)
    expect(launchedHidden(settings(false), ['rill', '--hidden'])).toBe(true)
    expect(launchedHidden(settings(false), ['rill'])).toBe(false)
  })
})
