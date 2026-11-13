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
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABJ2lDQ1BfAAB4nJWQP0vDQBjGf5aCf6iD6OiQsYtSFbqoSxWLTlIrWJ3SNE2FJoYkpQhufgE/hODsKEJnBwVBcBQ/gji4xicJki4dfI/37nfPPdzd+0JhBkWxAq4XBY16zThpnRrTn0xppGFaoc/kkOvnPfO+rfD/mO3YoaX1S9kJ9LiubIqXnIx7Cbczvkp4GPmR+CbhoNnYEd+Ky84Yt8fY8oPE/yzecvsDK/83Jds7PtK6p1xml3NCfPqYXGJwyIbmunYuAyLxUI6IniikoZOaqEkghyeliy0m6V/2xPUHbI/iOH7MtYMR3Fdh7iHXypuwUIKnl1zLe+qbgZlKRWWh24XvO5hvweKr7jn7a+SE2oy0tjoXGo5qs6Xs678Wq6J1KqxR/QUglE37tILJPAAAAYtJREFUeJzsl71KA0EUhY8xSkDQRgsR1E6F+F+oneAD2Fhob0ACYmHnG4hg4QMIotj4HHYSI1oKik1KNaCI/2fIgCvZ2b13srDNHvgg2T3JPTt3ZpjNIWXlkLKyAKkHaEdr2iEL5ByeaoO/5gKFZ8kVPOQboM8W7LffH8gEeYZSvnPgLFDcaJAcwUM+c2CLbIRcHyX3ULZC24IRUiUFx/26DVKDUJoW5NEY+kKEp5ucQiFNgBIZF/gWyQqEkrbAPP0tGRL6byALKx6BVUVxoyJZkhilAUrQa11ikrRgmNxBrzfSS16iTJIRmI64V4N7yZnVMoMYSQK4el8mA5ayw1NEAgFeQ659kGPyYzkh3yG+LyQQoOq43hH4nHcUqyCBANdofjpTfBeNrXmM7OF/IKNP+9tISTeiA7IJnfbJdpxJGqCTXEC4u6HRNnNgeY8zSjci80fL5FLgrVhvbHEjzXngiRySLjKP5tEzq8EM+xp5hFC+R7IeMkmm8DfZzEGkDqVaOZQmouzFJAvwCwAA//+tfNyIAAAABklEQVQDAOiBO21K74HTAAAAAElFTkSuQmCC'

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
