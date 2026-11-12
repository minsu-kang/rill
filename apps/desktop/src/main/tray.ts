export interface TrayLike {
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  on(event: string, listener: () => void): unknown
  destroy(): void
}

export interface MenuItemLike {
  label?: string
  type?: 'checkbox' | 'separator'
  checked?: boolean
  click?: (item: { checked: boolean }) => void
}

export interface TrayDeps {
  Tray: new (image: unknown) => TrayLike
  Menu: { buildFromTemplate(template: MenuItemLike[]): unknown }
  image: unknown
  locale: string
  getOpenAtLogin(): boolean
  onOpen(): void
  onToggleOpenAtLogin(next: boolean): void
  onQuit(): void
}

export interface RillTray {
  refresh(): void
  destroy(): void
}

const LABELS = {
  en: { open: 'Open Rill', openAtLogin: 'Open at login', quit: 'Quit Rill' },
  ko: { open: 'Rill 열기', openAtLogin: '로그인 시 시작', quit: 'Rill 종료' },
}

export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAj0lEQVR4nO2VXQ6AMAiDd/9LzwsYoX8jJiPxzbXfsOBat35Yu3jGjGMgqLEVhBG0Qagi0nlXG2kdZ5hgrUSSIc1RgETrIe1k8I4AfO0AGqALU42cBFBBdMRlgLfDyKKRMuD46cghVMzbAAyE1Rx+OQHghqC0mDbbdVQIyyXUcbN8xs4OUEc0AhKrMeNbkXoAfc4BDnEa9IIAAAAASUVORK5CYII='

export function createTray(deps: TrayDeps): RillTray {
  const labels = deps.locale.toLowerCase().startsWith('ko') ? LABELS.ko : LABELS.en
  const tray = new deps.Tray(deps.image)
  tray.setToolTip('Rill')
  tray.on('double-click', () => deps.onOpen())
  function refresh(): void {
    tray.setContextMenu(
      deps.Menu.buildFromTemplate([
        { label: labels.open, click: () => deps.onOpen() },
        { label: labels.openAtLogin, type: 'checkbox', checked: deps.getOpenAtLogin(), click: (item) => deps.onToggleOpenAtLogin(item.checked) },
        { type: 'separator' },
        { label: labels.quit, click: () => deps.onQuit() },
      ]),
    )
  }
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}
