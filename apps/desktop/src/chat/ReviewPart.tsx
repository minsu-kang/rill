import { useId, useRef, useState } from 'react'
import { useT } from '../i18n'
import { TransferIcon } from '../ui/TransferMark'
import { useStepFocus } from '../ui/useStepFocus'
import { plainText } from './model/clamp'
import type { ReviewState } from './model/review'
import { ReviewPanel } from './ReviewPanel'
import styles from './ReviewPart.module.css'

export interface ReviewReviewer {
  id: string
  name: string
  sendsText?: boolean
}

export interface ReviewPartProps {
  reviewers: readonly ReviewReviewer[]
  agents: 'ready' | 'loading' | 'error'
  state: ReviewState
  deployed: boolean
  onAsk(agentId: string): void
  onCancel(): void
  onClose(): void
}

const NAME_CAP = 40

export function ReviewPart({ reviewers, agents, state, deployed, onAsk, onCancel, onClose }: ReviewPartProps) {
  const t = useT()
  const selectId = useId()
  const reasonId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const anchor = useStepFocus(state.phase, { container: root })
  const last = state.phase === 'idle' ? undefined : state.agentId
  const selected = reviewers.find((reviewer) => reviewer.id === picked) ?? reviewers.find((reviewer) => reviewer.id === last) ?? reviewers[0]
  const reason =
    deployed ? t('chat.review.deployed') : selected !== undefined ? undefined : agents === 'loading' ? t('agents.picker.loading') : agents === 'error' ? t('agents.picker.loadError') : t('chat.review.none')
  const allowed = reason === undefined && selected !== undefined
  const label = state.phase === 'done' ? 'chat.review.askAgain' : state.phase === 'error' ? 'chat.review.retry' : 'chat.review.ask'

  return (
    <div ref={root} className={styles.part} role="group" aria-label={t('chat.review.group')}>
      {state.phase === 'asking' ? (
        <div className={styles.asking}>
          <p role="status" ref={anchor} tabIndex={-1} className={styles.progress}>
            {t('chat.review.asking')}
          </p>
          <p className={styles.note}>{t('chat.review.cancelNote')}</p>
          <div>
            <button type="button" className={styles.button} onClick={onCancel}>
              {t('chat.review.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {state.phase === 'error' ? (
            <p role="alert" ref={anchor} tabIndex={-1} className={styles.error}>
              {t(state.key)}
            </p>
          ) : null}
          {state.phase === 'done' ? <ReviewPanel result={state.result} agentSent={state.agentSent === true} focusRef={anchor} /> : null}
          <div className={styles.row}>
            {reviewers.length > 1 && selected !== undefined ? (
              <div className={styles.field}>
                <label htmlFor={selectId} className={styles.label}>
                  {t('chat.review.reviewer')}
                </label>
                <select id={selectId} className={styles.select} value={selected.id} onChange={(event) => setPicked(event.target.value)}>
                  {reviewers.map((reviewer) => (
                    <option key={reviewer.id} value={reviewer.id}>
                      {plainText(reviewer.name, NAME_CAP)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <button
              type="button"
              ref={state.phase === 'idle' ? anchor : undefined}
              className={state.phase === 'idle' ? styles.primary : styles.button}
              data-rill-ask-review=""
              disabled={!allowed}
              aria-describedby={reason === undefined ? undefined : reasonId}
              onClick={() => {
                if (selected !== undefined) onAsk(selected.id)
              }}
            >
              {t(label)}
            </button>
            {state.phase === 'done' ? (
              <button type="button" className={styles.button} onClick={onClose}>
                {t('chat.review.close')}
              </button>
            ) : null}
            {allowed ? (
              <p role="note" className={styles.transfer}>
                <TransferIcon />
                <span>{t(selected?.sendsText === true ? 'chat.review.transferAgent' : 'chat.review.transfer')}</span>
              </p>
            ) : null}
          </div>
          {reason === undefined ? null : (
            <p id={reasonId} className={styles.note}>
              {reason}
            </p>
          )}
        </>
      )}
    </div>
  )
}
