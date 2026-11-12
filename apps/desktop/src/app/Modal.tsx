import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import styles from './Modal.module.css'

export interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children, footer, wide = false }: ModalProps) {
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement
    const box = root.current
    const first = box?.querySelector<HTMLElement>('[data-autofocus]') ?? box?.querySelector<HTMLElement>(FOCUSABLE) ?? box
    first?.focus()
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    if (items.length === 0) return
    const firstItem = items[0]!
    const lastItem = items[items.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && active === firstItem) {
      event.preventDefault()
      lastItem.focus()
    } else if (!event.shiftKey && active === lastItem) {
      event.preventDefault()
      firstItem.focus()
    }
  }

  return (
    <div className={styles.overlay}>
      <div ref={root} className={wide ? `${styles.box} ${styles.wide}` : styles.box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  )
}
