import type { ReviewResult } from '@rill/protocol'
import type { RefCallback } from 'react'
import { useLocale, useT } from '../i18n'
import { escapeInvisible, truncate } from '../model/text'
import { SafeText } from '../ui/SafeText'
import { ClampedText } from './ClampedText'
import { plainText } from './model/clamp'
import { formatUsd } from './model/format'
import styles from './ReviewPanel.module.css'

export interface ReviewPanelProps {
  result: ReviewResult
  focusRef?: RefCallback<HTMLElement>
}

const NODE_CAP = 32

export function ReviewPanel({ result, focusRef }: ReviewPanelProps) {
  const t = useT()
  const locale = useLocale()
  const { review, meta } = result
  return (
    <article className={styles.panel} aria-label={t('chat.review.panel')} ref={focusRef} tabIndex={focusRef === undefined ? undefined : -1}>
      <p className={styles.advice}>{t('chat.review.advice')}</p>
      <p className={styles.summary}>
        <ClampedText text={review.summary} max={400} />
      </p>
      {review.findings.length === 0 ? (
        <p className={styles.none}>{t('chat.review.noFindings')}</p>
      ) : (
        <ul className={styles.findings} aria-label={t('chat.review.findings')}>
          {review.findings.map((finding, index) => (
            <li key={index} className={styles.finding}>
              <span className={`${styles.chip} ${styles[finding.severity]}`} data-severity={finding.severity}>
                {t(`chat.review.severity.${finding.severity}`)}
              </span>
              <div className={styles.body}>
                {finding.nodeId === undefined ? null : (
                  <span className={styles.nodeLabel}>
                    {t('chat.review.node')}{' '}
                    <code className={styles.node} title={escapeInvisible(finding.nodeId)}>
                      <SafeText text={truncate(finding.nodeId, NODE_CAP)} />
                    </code>
                  </span>
                )}
                <ClampedText text={finding.text} max={240} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <ul className={styles.meta} aria-label={t('chat.review.details')}>
        <li>{t('chat.review.meta.reviewer', { name: plainText(meta.agentUsed.name, 40) })}</li>
        <li>{t('chat.review.meta.model', { provider: plainText(meta.provider, 30), model: plainText(meta.model, 40) })}</li>
        <li>{meta.costUsd === null ? t('chat.meta.costUnknown') : t('chat.meta.costUpperBound', { cost: formatUsd(meta.costUsd, locale) })}</li>
        {meta.skillsUsed > 0 ? <li>{t('chat.meta.skillsUsed', { count: meta.skillsUsed })}</li> : null}
        {meta.agentDropped > 0 ? <li>{t('chat.meta.agentDropped')}</li> : null}
        {meta.costNote === undefined ? null : (
          <li>
            <ClampedText text={meta.costNote} max={160} />
          </li>
        )}
      </ul>
      <p className={styles.sent}>{t('chat.review.sent')}</p>
    </article>
  )
}
