import { useT, type MessageKey } from '../i18n'
import controls from './controls.module.css'
import styles from './NoticeBar.module.css'

export interface NoticeAction {
  key: MessageKey
  run(): void
}

export interface NoticeData {
  id: number
  key: MessageKey
  vars?: Record<string, string | number>
  action?: NoticeAction
}

export interface NoticeBarProps {
  notice: NoticeData | undefined
  onDismiss(): void
}

export function NoticeBar({ notice, onDismiss }: NoticeBarProps) {
  const t = useT()
  const action = notice?.action
  return (
    <div className={styles.bar} role="status" aria-live="polite" data-rill-region="notice">
      {notice === undefined ? null : (
        <div key={notice.id} className={styles.notice}>
          <span className={styles.text}>{t(notice.key, notice.vars)}</span>
          <span className={styles.actions}>
            {action === undefined ? null : (
              <button
                type="button"
                className={controls.primary}
                onClick={() => {
                  action.run()
                  onDismiss()
                }}
              >
                {t(action.key)}
              </button>
            )}
            <button type="button" className={controls.button} onClick={onDismiss}>
              {t('app.notice.dismiss')}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
