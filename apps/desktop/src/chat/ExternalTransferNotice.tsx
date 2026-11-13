import { useT } from '../i18n'
import styles from './ExternalTransferNotice.module.css'

export type TransferItem = 'request' | 'attachments' | 'memory' | 'agent'

export interface ExternalTransferNoticeProps {
  items: readonly TransferItem[]
}

export function ExternalTransferNotice({ items }: ExternalTransferNoticeProps) {
  const t = useT()
  if (items.length === 0) return null
  const names = items.map((item) => t(`chat.transfer.item.${item}`)).join(', ')
  return (
    <p className={styles.notice} role="note">
      <span className={styles.badge}>{t('badge.externalTransfer')}</span>
      <span>{`${t('chat.transfer.lead')} ${names}`}</span>
    </p>
  )
}
