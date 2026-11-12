import { useT, type MessageKey } from '../i18n'
import controls from './controls.module.css'
import styles from './NoticeBar.module.css'

export interface NoticeData {
  id: number
  key: MessageKey
  vars?: Record<string, string | number>
}

export interface NoticeBarProps {
  notice: NoticeData | undefined
  onDismiss(): void
}

export function NoticeBar({ notice, onDismiss }: NoticeBarProps) {
  const t = useT()
  return (
    <div className={styles.bar} role="status" aria-live="polite">
      {notice === undefined ? null : (
        <div key={notice.id} className={styles.notice}>
          <span>{t(notice.key, notice.vars)}</span>
          <button type="button" className={controls.button} onClick={onDismiss}>
            {t('app.notice.dismiss')}
          </button>
        </div>
      )}
    </div>
  )
}
