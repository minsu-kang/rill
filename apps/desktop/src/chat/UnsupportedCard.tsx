import { useT } from '../i18n'
import { ClampedText } from './ClampedText'
import styles from './UnsupportedCard.module.css'

export interface UnsupportedCardProps {
  summary: string
  reason: string
  nearest: string
}

export function UnsupportedCard({ summary, reason, nearest }: UnsupportedCardProps) {
  const t = useT()
  return (
    <div className={styles.card} data-card="unsupported">
      <h4 className={styles.heading}>{t('chat.unsupported.heading')}</h4>
      <p className={styles.summary}>
        <ClampedText text={summary} max={300} />
      </p>
      <dl className={styles.facts}>
        <dt>{t('chat.unsupported.reason')}</dt>
        <dd>
          <ClampedText text={reason} max={300} />
        </dd>
        <dt>{t('chat.unsupported.nearest')}</dt>
        <dd>
          <ClampedText text={nearest} max={300} />
        </dd>
      </dl>
    </div>
  )
}
