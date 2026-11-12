import { useT, type MessageKey } from '../i18n'
import styles from './ErrorNotice.module.css'

export interface ErrorNoticeProps {
  messageKey: MessageKey
  onDismiss?: () => void
}

export function ErrorNotice({ messageKey, onDismiss }: ErrorNoticeProps) {
  const t = useT()
  return (
    <div className={styles.notice} role="alert">
      <span>{t(messageKey)}</span>
      {onDismiss === undefined ? null : (
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          {t('chat.error.dismiss')}
        </button>
      )}
    </div>
  )
}
