import { useState } from 'react'
import { useT } from '../i18n'
import { truncate } from '../model/text'
import { SafeText } from '../ui/SafeText'
import styles from './Clamped.module.css'

export interface ClampedProps {
  text: string
  limit?: number
  hardLimit?: number
}

export const CLAMP_LIMIT = 600
export const CLAMP_HARD_LIMIT = 2_000

export function Clamped({ text, limit = CLAMP_LIMIT, hardLimit = CLAMP_HARD_LIMIT }: ClampedProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const long = text.length > limit
  const shown = !long ? text : truncate(text, open ? hardLimit : limit)
  const omitted = open && text.length > hardLimit ? text.length - hardLimit : 0
  return (
    <span className={styles.root}>
      <span className={styles.text}>
        <SafeText text={shown} />
      </span>
      {omitted > 0 && <span className={styles.omitted}>{t('explain.card.omitted', { count: omitted })}</span>}
      {long && (
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'explain.card.showLess' : 'explain.card.showMore')}
        </button>
      )}
    </span>
  )
}
