import type { ReactNode } from 'react'
import { Modal } from '../Modal'
import controls from '../controls.module.css'

export interface ConfirmDialogProps {
  title: string
  message: ReactNode
  details?: ReactNode
  confirmLabel: string
  cancelLabel: string
  confirmDisabled?: boolean
  busy?: boolean
  error?: string | undefined
  onConfirm(): void
  onCancel(): void
}

export function ConfirmDialog({ title, message, details, confirmLabel, cancelLabel, confirmDisabled = false, busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className={controls.button} data-autofocus="" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={controls.primary} disabled={confirmDisabled || busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className={controls.note}>{message}</p>
      {details}
      {error === undefined ? null : (
        <p className={controls.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
