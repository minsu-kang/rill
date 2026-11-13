import styles from './TransferMark.module.css'

export interface TransferMarkProps {
  label: string
  hint?: string
  size?: number
  showLabel?: boolean
  className?: string
}

export function TransferIcon({ size = 12 }: { size?: number }) {
  return (
    <svg className={styles.icon} viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M3 9l6-6M4.5 3H9v4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function TransferMark({ label, hint, size, showLabel = false, className }: TransferMarkProps) {
  return (
    <span className={className === undefined ? styles.mark : `${styles.mark} ${className}`} title={hint ?? label}>
      <TransferIcon {...(size === undefined ? {} : { size })} />
      <span className={showLabel ? styles.label : styles.hidden}>{label}</span>
    </span>
  )
}
