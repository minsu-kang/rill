import type { ExplainMeta, ExplainResult } from '@rill/protocol'
import { useId } from 'react'
import { useLocale, useT, type Locale, type Translate } from '../i18n'
import { escapeInvisible, truncate } from '../model/text'
import { SafeText } from '../ui/SafeText'
import { ActionButtons } from './ActionButtons'
import { Clamped } from './Clamped'
import styles from './ExplainCard.module.css'
import { FixProposal } from './FixProposal'
import { causeKey, signalKey } from './model/labels'

type Action = ExplainResult['suggestedActions'][number]

export interface ExplainCardProps {
  result: ExplainResult
  onAction(action: Action, context: { runId: string; nodeId?: string }): void
  onProposeFix(proposal: { nodeId: string; requestText: string }): void
}

const MAX_SIGNALS = 12
const MAX_SIGNAL_NODE = 32

const LANGUAGE_TAGS: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US' }

function effortLabel(t: Translate, effort: ExplainMeta['effort']['requested']): string {
  return t(`explain.effort.${effort}`)
}

function metaParts(t: Translate, locale: Locale, meta: ExplainMeta): string[] {
  const { requested, effective } = meta.effort
  const money = new Intl.NumberFormat(LANGUAGE_TAGS[locale], { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return [
    t('explain.meta.model', { provider: meta.provider, model: meta.model }),
    requested === effective
      ? t('explain.meta.effort', { effort: effortLabel(t, effective) })
      : t('explain.meta.effortLowered', { requested: effortLabel(t, requested), effective: effortLabel(t, effective) }),
    meta.costUsd === null ? t('explain.meta.costUnknown') : t('explain.meta.cost', { cost: money.format(meta.costUsd) }),
    t('explain.meta.digest', { count: meta.digestChars }),
  ]
}

export function ExplainCard({ result, onAction, onProposeFix }: ExplainCardProps) {
  const t = useT()
  const locale = useLocale()
  const signalsId = useId()
  const signals = result.signals.slice(0, MAX_SIGNALS)
  const hiddenSignals = result.signals.length - signals.length
  const nodeId = result.fixProposal?.nodeId ?? result.signals[0]?.nodeId

  return (
    <article className={styles.root} aria-label={t('explain.card.label')}>
      <p className={styles.cause}>
        <span className={styles.causeLabel}>{t('explain.card.cause')}</span>
        <span className={styles.causeValue}>{t(causeKey(result.likelyCause))}</span>
      </p>
      <div className={styles.explanation}>
        <Clamped text={result.explanation} />
      </div>
      {result.signals.length > 0 && (
        <div className={styles.signals}>
          <h4 id={signalsId} className={styles.heading}>
            {t('explain.card.signals')}
          </h4>
          <ul className={styles.chips} aria-labelledby={signalsId}>
            {signals.map((entry, index) => (
              <li key={index} className={styles.chip}>
                <span>{t(signalKey(entry.signal))}</span>
                <code className={styles.node} title={escapeInvisible(entry.nodeId)}>
                  <SafeText text={truncate(entry.nodeId, MAX_SIGNAL_NODE)} />
                </code>
              </li>
            ))}
            {hiddenSignals > 0 && <li className={styles.more}>{t('explain.card.moreSignals', { count: hiddenSignals })}</li>}
          </ul>
        </div>
      )}
      <ActionButtons actions={result.suggestedActions} runId={result.runId} nodeId={nodeId} onAction={onAction} />
      {result.fixProposal !== undefined && <FixProposal proposal={result.fixProposal} onPropose={onProposeFix} />}
      <div className={styles.meta} role="group" aria-label={t('explain.card.meta')}>
        {metaParts(t, locale, result.meta).map((part) => (
          <span key={part} className={styles.metaItem}>
            <SafeText text={part} />
          </span>
        ))}
        {result.meta.truncated && <span className={styles.metaNote}>{t('explain.meta.truncated')}</span>}
        {result.meta.repaired && <span className={styles.metaNote}>{t('explain.meta.repaired')}</span>}
      </div>
    </article>
  )
}
