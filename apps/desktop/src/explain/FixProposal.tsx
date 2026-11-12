import { useId } from 'react'
import { useT } from '../i18n'
import { truncate } from '../model/text'
import { SafeText } from '../ui/SafeText'
import { Clamped } from './Clamped'
import styles from './FixProposal.module.css'
import { HIDDEN_MARK } from './model/labels'

export interface FixProposalProps {
  proposal: { nodeId: string; requestText: string }
  onPropose(proposal: { nodeId: string; requestText: string }): void
}

const MAX_NODE_ID = 40

export function FixProposal({ proposal, onPropose }: FixProposalProps) {
  const t = useT()
  const headingId = useId()
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h4 id={headingId} className={styles.heading}>
        {t('explain.fix.heading')}
      </h4>
      <p className={styles.node}>
        <SafeText text={t('explain.fix.node', { node: truncate(proposal.nodeId, MAX_NODE_ID) })} />
      </p>
      <blockquote className={styles.text}>
        <Clamped text={proposal.requestText} />
      </blockquote>
      {proposal.requestText.includes(HIDDEN_MARK) && <p className={styles.note}>{t('explain.fix.hidden')}</p>}
      <p className={styles.note}>{t('explain.fix.note')}</p>
      <div>
        <button type="button" className={styles.button} onClick={() => onPropose({ nodeId: proposal.nodeId, requestText: proposal.requestText })}>
          {t('explain.fix.use')}
        </button>
      </div>
    </section>
  )
}
