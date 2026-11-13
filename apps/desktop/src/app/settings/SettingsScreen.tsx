import { useRef, useState } from 'react'
import type { EngineClient } from '../../engine/client'
import { useT } from '../../i18n'
import { useStepFocus } from '../../ui/useStepFocus'
import hidden from '../../ui/visuallyHidden.module.css'
import type { ConnectionState } from '../connection'
import controls from '../controls.module.css'
import { ConnectionsSection } from './ConnectionsSection'
import { FoldersSection } from './FoldersSection'
import { GeneralSection } from './GeneralSection'
import { KeysSection } from './KeysSection'
import { ModelSection } from './ModelSection'
import styles from './Settings.module.css'
import { SETTINGS_SECTIONS, type SettingsApi, type SettingsSectionId } from './types'
import type { SettingsState } from './useSettings'

export interface SettingsScreenProps {
  state: SettingsState
  client: EngineClient | undefined
  connection: Pick<ConnectionState, 'state' | 'status'>
  section?: SettingsSectionId
  onSectionChange?(section: SettingsSectionId): void
}

export function SettingsScreen({ state, client, connection, section, onSectionChange }: SettingsScreenProps) {
  const t = useT()
  const [own, setOwn] = useState<SettingsSectionId>('folders')
  const current = section ?? own
  const root = useRef<HTMLDivElement>(null)
  const heading = useStepFocus(state.settings === undefined ? 'loading' : current, { container: root, initial: true })

  function choose(next: SettingsSectionId): void {
    setOwn(next)
    onSectionChange?.(next)
  }

  const { settings } = state
  if (settings === undefined) {
    return (
      <div className={styles.root} ref={root}>
        <div className={styles.panel}>
          {state.failed ? (
            <>
              <p className={controls.error} role="alert">
                {t('app.settings.loadError')}
              </p>
              <div className={controls.row}>
                <button type="button" className={controls.button} onClick={() => void state.reload()}>
                  {t('app.settings.retry')}
                </button>
              </div>
            </>
          ) : (
            <p className={controls.note} role="status">
              {t('app.settings.loading')}
            </p>
          )}
        </div>
      </div>
    )
  }

  const api: SettingsApi = { settings, apply: state.apply, reload: state.reload }
  const locked = !settings.encryptionAvailable

  return (
    <div className={styles.root} ref={root} data-rill-region="settings">
      <nav className={styles.nav} aria-label={t('app.settings.nav')}>
        {SETTINGS_SECTIONS.map((id) => (
          <button key={id} type="button" className={styles.navButton} aria-current={id === current ? 'page' : undefined} onClick={() => choose(id)}>
            {t(`app.settings.section.${id}`)}
          </button>
        ))}
      </nav>
      <div className={styles.panel}>
        <h2 ref={heading} tabIndex={-1} className={hidden.hidden}>
          {t(`app.settings.section.${current}`)}
        </h2>
        {locked ? (
          <div className={controls.warn} role="alert">
            <strong>{t('app.settings.noKeychain.title')}</strong>
            <p className={controls.note}>{t('app.settings.noKeychain.body')}</p>
          </div>
        ) : null}
        {current === 'folders' ? <FoldersSection api={api} /> : null}
        {current === 'model' ? <ModelSection api={api} client={client} connection={connection} onGoKeys={() => choose('keys')} /> : null}
        {current === 'keys' ? <KeysSection api={api} locked={locked} /> : null}
        {current === 'connections' ? <ConnectionsSection api={api} locked={locked} /> : null}
        {current === 'general' ? <GeneralSection api={api} connection={connection} /> : null}
      </div>
    </div>
  )
}
