import { useId } from 'react'
import { useT, type MessageKey } from '../i18n'
import type { Settings } from '../shared/host-api'
import controls from './controls.module.css'
import styles from './FirstRunCard.module.css'

export type FirstRunTarget = 'folders' | 'keys' | 'connections'

export interface FirstRunCardProps {
  settings: Settings
  onOpen(section: FirstRunTarget): void
}

interface Item {
  id: FirstRunTarget
  done: boolean
  optional: boolean
  label: MessageKey
  action: MessageKey
}

export function firstRunItems(settings: Settings): Item[] {
  return [
    { id: 'folders', done: settings.allowedFolders.length > 0, optional: false, label: 'app.firstRun.folder', action: 'app.firstRun.folder.action' },
    { id: 'keys', done: settings.configuredProviders.includes(settings.provider), optional: false, label: 'app.firstRun.key', action: 'app.firstRun.key.action' },
    { id: 'connections', done: settings.connections.some((entry) => entry.kind === 'slack'), optional: true, label: 'app.firstRun.slack', action: 'app.firstRun.slack.action' },
  ]
}

export function firstRunDone(settings: Settings): boolean {
  return firstRunItems(settings).every((item) => item.done || item.optional)
}

export function FirstRunCard({ settings, onOpen }: FirstRunCardProps) {
  const t = useT()
  const headingId = useId()
  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.title}>
        {t('app.firstRun.title')}
      </h2>
      <p className={controls.note}>{t('app.firstRun.intro')}</p>
      <ol className={styles.items}>
        {firstRunItems(settings).map((item) => (
          <li key={item.id} className={styles.item} data-done={item.done}>
            <span className={styles.label}>{t(item.label)}</span>
            {item.optional ? <span className={controls.chip}>{t('app.firstRun.optional')}</span> : null}
            <span className={item.done ? controls.chipOk : controls.chip}>{t(item.done ? 'app.firstRun.done' : 'app.firstRun.todo')}</span>
            <button type="button" className={item.done ? controls.button : controls.primary} onClick={() => onOpen(item.id)}>
              {t(item.action)}
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
