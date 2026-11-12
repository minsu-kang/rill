import type { Settings } from '../../shared/host-api'

export interface SettingsApi {
  settings: Settings
  apply(next: Settings): void
  reload(): Promise<void>
}

export type SettingsSectionId = 'folders' | 'model' | 'keys' | 'connections' | 'general'

export const SETTINGS_SECTIONS: readonly SettingsSectionId[] = ['folders', 'model', 'keys', 'connections', 'general']
