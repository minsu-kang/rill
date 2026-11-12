export interface LoginItemApp {
  isPackaged: boolean
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }): void
}

export interface LoginItemReader {
  getLoginItemSettings(): { wasOpenedAtLogin: boolean }
}

export const HIDDEN_ARGUMENT = '--hidden'

export function applyLoginItem(app: LoginItemApp, enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARGUMENT] })
}

export function launchedHidden(app: LoginItemReader, argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_ARGUMENT) || app.getLoginItemSettings().wasOpenedAtLogin
}
