import { useId, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { Modal } from '../Modal'
import controls from '../controls.module.css'
import styles from './Workflows.module.css'
import { payloadSample } from './samples'

export interface PayloadDialogProps {
  triggerType: string
  mode: 'dry' | 'live'
  busy?: boolean
  error?: string | undefined
  onSubmit(payload: unknown): void
  onCancel(): void
}

export const MAX_PAYLOAD_CHARS = 200_000

export function PayloadDialog({ triggerType, mode, busy = false, error, onSubmit, onCancel }: PayloadDialogProps) {
  const t = useT()
  const fieldId = useId()
  const problemId = useId()
  const [text, setText] = useState(() => payloadSample(triggerType))
  const [problem, setProblem] = useState<MessageKey | undefined>(undefined)

  function submit(): void {
    if (text.length > MAX_PAYLOAD_CHARS) {
      setProblem('app.payload.tooLarge')
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      setProblem('app.payload.invalid')
      return
    }
    setProblem(undefined)
    onSubmit(payload)
  }

  return (
    <Modal
      title={t(mode === 'dry' ? 'app.payload.dryTitle' : 'app.payload.liveTitle')}
      onClose={onCancel}
      wide
      footer={
        <>
          <button type="button" className={controls.button} onClick={onCancel}>
            {t('app.common.cancel')}
          </button>
          <button type="button" className={controls.primary} disabled={busy} onClick={submit}>
            {t(mode === 'dry' ? 'app.payload.submitDry' : 'app.payload.submitLive')}
          </button>
        </>
      }
    >
      <p className={controls.note}>{t('app.payload.intro')}</p>
      {mode === 'dry' ? (
        <p className={controls.warn}>
          <span className={controls.badge}>{t('badge.externalTransfer')}</span> {t('app.payload.dryNote')}
        </p>
      ) : null}
      <label className={controls.label} htmlFor={fieldId}>
        {t('app.payload.label')}
        <textarea
          id={fieldId}
          className={`${controls.input} ${styles.payload}`}
          rows={10}
          spellCheck={false}
          value={text}
          aria-invalid={problem !== undefined}
          aria-describedby={problem === undefined ? undefined : problemId}
          data-autofocus=""
          onChange={(event) => {
            setText(event.target.value)
            setProblem(undefined)
          }}
        />
      </label>
      {problem === undefined ? null : (
        <p id={problemId} className={controls.error} role="alert">
          {t(problem)}
        </p>
      )}
      {error === undefined ? null : (
        <p className={controls.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
