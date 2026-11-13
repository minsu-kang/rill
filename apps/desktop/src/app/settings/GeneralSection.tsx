import { useId } from 'react'
import { useT } from '../../i18n'
import controls from '../controls.module.css'
import type { ConnectionState } from '../connection'
import { useHost } from '../host'
import styles from './Settings.module.css'
import { isLanguage } from '../../shared/host-api'
import { LANGUAGE_OPTIONS } from './languages'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

export function GeneralSection({ api, connection }: { api: SettingsApi; connection: Pick<ConnectionState, 'state' | 'status'> }) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const loginId = useId()
  const languageId = useId()
  const state = connection.status?.state ?? 'starting'
  const error = connection.status?.error

  function toggle(next: boolean): void {
    void action.run(async () => {
      api.apply(await host.settings.update({ openAtLogin: next }))
    })
  }

  function chooseLanguage(value: string): void {
    if (!isLanguage(value)) return
    void action.run(async () => {
      api.apply(await host.settings.update({ language: value }))
    })
  }

  function restart(): void {
    void action.run(async () => {
      await host.engine.restart()
    })
  }

  return (
    <section className={styles.panel} aria-label={t('app.settings.section.general')}>
      <div className={controls.row}>
        <label htmlFor={languageId}>{t('app.general.language')}</label>
        <select id={languageId} className={controls.input} value={api.settings.language} disabled={action.busy} onChange={(event) => chooseLanguage(event.target.value)}>
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <p className={controls.note}>{t('app.general.languageHint')}</p>
      <div className={styles.checkbox}>
        <input id={loginId} type="checkbox" checked={api.settings.openAtLogin} disabled={action.busy} onChange={(event) => toggle(event.target.checked)} />
        <label htmlFor={loginId}>{t('app.general.openAtLogin')}</label>
      </div>
      <p className={controls.note}>{t('app.general.openAtLoginHint')}</p>
      <div className={controls.row}>
        <strong>{t('app.general.engine')}</strong>
        <span className={controls.chip} role="status">
          {t(`app.engine.state.${state}`)}
        </span>
        <button type="button" className={controls.button} disabled={action.busy || state === 'restarting'} onClick={restart}>
          {t('app.general.restart')}
        </button>
      </div>
      {error === undefined ? null : <p className={controls.warn}>{t(`app.engine.error.${error}`)}</p>}
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
      <p className={controls.note}>{t('app.general.dataNote')}</p>
    </section>
  )
}
