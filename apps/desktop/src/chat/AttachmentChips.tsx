import type { AttachmentRef } from '@rill/protocol'
import { useLocale, useT } from '../i18n'
import { safeName } from './model/attachments'
import { formatBytes } from './model/format'
import styles from './AttachmentChips.module.css'

export interface AttachmentChipsProps {
  items: readonly AttachmentRef[]
  pending: readonly { name: string }[]
  errors: readonly { name: string; reason: string }[]
  onRemove(id: string): void
}

function Name({ name }: { name: string }) {
  return (
    <span className={styles.name} title={safeName(name, Infinity).shown}>
      <bdi>{safeName(name).shown}</bdi>
    </span>
  )
}

export function AttachmentChips({ items, pending, errors, onRemove }: AttachmentChipsProps) {
  const t = useT()
  const locale = useLocale()
  if (items.length === 0 && pending.length === 0 && errors.length === 0) return null
  return (
    <ul className={styles.list} aria-label={t('chat.attach.list')}>
      {items.map((item) => (
        <li key={item.id} className={styles.chip}>
          <Name name={item.name} />
          <span className={styles.size}>{formatBytes(item.bytes, locale)}</span>
          <span className={styles.badge}>{t('badge.externalTransfer')}</span>
          <button type="button" className={styles.remove} aria-label={t('chat.attach.remove', { name: safeName(item.name).shown })} onClick={() => onRemove(item.id)}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </li>
      ))}
      {pending.map((item, index) => (
        <li key={`pending-${index}`} className={styles.chip} data-state="pending" aria-busy="true">
          <Name name={item.name} />
          <span className={styles.size}>{t('chat.attach.pending')}</span>
        </li>
      ))}
      {errors.map((item, index) => (
        <li key={`error-${index}`} className={styles.chip} data-state="error">
          <Name name={item.name} />
          <span className={styles.reason} role="alert">
            {item.reason}
          </span>
        </li>
      ))}
    </ul>
  )
}
