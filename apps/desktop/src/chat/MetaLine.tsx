import type { PlanMeta } from '@rill/protocol'
import { useLocale, useT } from '../i18n'
import { ClampedText } from './ClampedText'
import { markHidden } from './model/clamp'
import { effortLabelOf } from './model/effort'
import { formatUsd } from './model/format'
import styles from './MetaLine.module.css'

export interface MetaLineProps {
  meta: PlanMeta
}

export function MetaLine({ meta }: MetaLineProps) {
  const t = useT()
  const locale = useLocale()
  const care = (effort: PlanMeta['effort']): string => t(`chat.effort.${effortLabelOf(effort)}`)
  const detail = meta.effortDetail
  return (
    <ul className={styles.list} aria-label={t('chat.meta.label')}>
      <li>{t('chat.meta.model', { model: markHidden(meta.model) })}</li>
      <li>
        {detail?.collapsed === true
          ? t('chat.meta.effortLowered', { requested: care(detail.requested), effective: care(detail.effective) })
          : t('chat.meta.effort', { effort: care(detail?.effective ?? meta.effort) })}
      </li>
      <li>{meta.costUsd === null ? t('chat.meta.costUnknown') : t('chat.meta.costUpperBound', { cost: formatUsd(meta.costUsd, locale) })}</li>
      {meta.memoryUsed !== undefined && meta.memoryUsed > 0 ? <li>{t('chat.meta.memoryUsed', { count: meta.memoryUsed })}</li> : null}
      {meta.memoryDropped !== undefined && meta.memoryDropped > 0 ? <li>{t('chat.meta.memoryDropped', { count: meta.memoryDropped })}</li> : null}
      {meta.reasoningCapped === true ? <li>{t('chat.meta.reasoningCapped')}</li> : null}
      {meta.costNote === undefined ? null : (
        <li>
          <ClampedText text={meta.costNote} max={160} />
        </li>
      )}
    </ul>
  )
}
