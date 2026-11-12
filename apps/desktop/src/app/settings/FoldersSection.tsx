import { useId, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { escapeInvisible } from '../../model/text'
import { MAX_FOLDERS } from '../../shared/host-api'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import { useHost } from '../host'
import styles from './Settings.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

export function FoldersSection({ api }: { api: SettingsApi }) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const headingId = useId()
  const [notice, setNotice] = useState<MessageKey | undefined>(undefined)
  const folders = api.settings.allowedFolders
  const full = folders.length >= MAX_FOLDERS

  function add(): void {
    setNotice(undefined)
    void action.run(async () => {
      const path = await host.dialogs.pickFolder()
      if (path === undefined) return
      if (folders.includes(path)) {
        setNotice('app.folders.exists')
        return
      }
      api.apply(await host.settings.update({ allowedFolders: [...folders, path] }))
      setNotice('app.folders.restartNote')
    })
  }

  function remove(path: string): void {
    setNotice(undefined)
    void action.run(async () => {
      api.apply(await host.settings.update({ allowedFolders: folders.filter((folder) => folder !== path) }))
      setNotice('app.folders.restartNote')
    })
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.sub}>
        {t('app.folders.heading')}
      </h3>
      <p className={controls.note}>{t('app.folders.intro')}</p>
      {folders.length === 0 ? (
        <p className={controls.warn}>{t('app.folders.empty')}</p>
      ) : (
        <ul className={controls.list}>
          {folders.map((path) => (
            <li key={path} className={styles.item}>
              <span className={controls.mono}>
                <SafeText text={path} />
              </span>
              <button type="button" className={controls.button} disabled={action.busy} aria-label={t('app.folders.removeLabel', { path: escapeInvisible(path) })} onClick={() => remove(path)}>
                {t('app.folders.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={controls.row}>
        <button type="button" className={controls.primary} disabled={action.busy || full} onClick={add}>
          {t('app.folders.add')}
        </button>
        {full ? <span className={controls.note}>{t('app.folders.limit', { max: MAX_FOLDERS })}</span> : null}
      </div>
      {notice === undefined ? null : (
        <p className={controls.note} role="status">
          {t(notice)}
        </p>
      )}
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </section>
  )
}
