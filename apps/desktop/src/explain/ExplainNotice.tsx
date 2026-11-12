import type { ExplainEffort } from '@rill/protocol'
import { useId, type RefCallback } from 'react'
import { useT } from '../i18n'
import { SafeText } from '../ui/SafeText'
import styles from './ExplainNotice.module.css'

export interface ExplainNoticeProps {
  model?: { provider: string; model: string }
  effort: ExplainEffort
  skipNext: boolean
  onSkipNextChange(value: boolean): void
  onSend(): void
  onCancel(): void
  headingRef?: RefCallback<HTMLElement>
}

export function ExplainNotice({ model, effort, skipNext, onSkipNextChange, onSend, onCancel, headingRef }: ExplainNoticeProps) {
  const t = useT()
  const headingId = useId()
  return (
    <section className={styles.root} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} ref={headingRef} tabIndex={headingRef === undefined ? undefined : -1} className={styles.heading}>
        {t('explain.notice.heading')}
      </h3>
      <p className={styles.body}>{t('explain.notice.body')}</p>
      <p className={styles.target}>
        {model === undefined ? (
          t('explain.notice.targetUnknown')
        ) : (
          <SafeText text={t('explain.notice.target', { provider: model.provider, model: model.model })} />
        )}
      </p>
      <p className={styles.target}>{t('explain.notice.effort', { effort: t(`explain.effort.${effort}`) })}</p>
      <label className={styles.skip}>
        <input type="checkbox" checked={skipNext} onChange={(event) => onSkipNextChange(event.target.checked)} />
        {t('explain.notice.skip')}
      </label>
      <div className={styles.buttons}>
        <button type="button" className={styles.primary} onClick={onSend}>
          {t('explain.notice.send')}
        </button>
        <button type="button" className={styles.button} onClick={onCancel}>
          {t('explain.notice.cancel')}
        </button>
      </div>
    </section>
  )
}
