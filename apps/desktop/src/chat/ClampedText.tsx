import { useMemo, useState } from 'react'
import { useT } from '../i18n'
import { clampText, markHidden } from './model/clamp'
import styles from './ClampedText.module.css'

const HARD_MAX = 5000
const DEFAULT_MAX = 400

export interface ClampedTextProps {
  text: string
  max?: number
  className?: string
  labelFor?: string
}

function source(text: string): string {
  if (text.length <= HARD_MAX) return text
  const last = text.charCodeAt(HARD_MAX - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? HARD_MAX - 1 : HARD_MAX)
}

export function ClampedText({ text, max = DEFAULT_MAX, className, labelFor }: ClampedTextProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const marked = useMemo(() => markHidden(source(text), { keepLayout: true }), [text])
  const clamped = useMemo(() => clampText(marked, max), [marked, max])
  const unseen = text.length - source(text).length
  const expandable = clamped.cut || unseen > 0
  return (
    <span className={className === undefined ? styles.root : `${styles.root} ${className}`}>
      {labelFor === undefined ? (
        <bdi className={styles.text}>{open ? marked : clamped.shown}</bdi>
      ) : (
        <label htmlFor={labelFor}>
          <bdi className={styles.text}>{open ? marked : clamped.shown}</bdi>
        </label>
      )}
      {open && unseen > 0 ? <span className={styles.rest}>{t('chat.text.hidden', { count: unseen })}</span> : null}
      {expandable ? (
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('chat.text.less') : t('chat.text.more')}
        </button>
      ) : null}
    </span>
  )
}
