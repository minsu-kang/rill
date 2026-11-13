import { useT } from '../i18n'
import { TransferIcon } from '../ui/TransferMark'
import styles from './ExternalTransferNotice.module.css'

export type TransferItem = 'request' | 'attachments' | 'memory' | 'agent'

export interface ExternalTransferNoticeProps {
  items: readonly TransferItem[]
}

const QUIET_ITEMS: readonly TransferItem[] = ['request']

export function ExternalTransferNotice({ items }: ExternalTransferNoticeProps) {
  const t = useT()
  if (items.length === 0) return null
  const names = items.map((item) => t(`chat.transfer.item.${item}`)).join(', ')
  const full = `${t('chat.transfer.lead')} ${names}`
  const showList = items.some((item) => !QUIET_ITEMS.includes(item))
  return (
    <p className={styles.notice} role="note" title={full}>
      <TransferIcon />
      <span>{showList ? full : t('chat.transfer.short')}</span>
    </p>
  )
}
