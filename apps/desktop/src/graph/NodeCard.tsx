import type { WorkflowNode } from '@rill/dsl'
import type { NodeInfo } from '@rill/protocol'
import { useT } from '../i18n'
import { badgesOf, type BadgeKind } from '../model/badges'
import type { NodeRunState } from '../model/status'
import { truncate } from '../model/text'
import { StatusChip } from '../ui/StatusChip'
import { StatusIcon } from '../ui/StatusIcon'
import styles from './NodeCard.module.css'

export const CARD_SIZE = { width: 264, height: 116 } as const

const MAX_TITLE = 36
const MAX_ID = 28
const MAX_TYPE = 30

const BADGE_LABEL = {
  externalTransfer: 'badge.externalTransfer',
  writesFile: 'badge.writesFile',
  network: 'badge.network',
} as const

export interface NodeCardProps {
  node: WorkflowNode
  info: NodeInfo | undefined
  state: NodeRunState | undefined
  selected: boolean
}

export function NodeCard({ node, info, state, selected }: NodeCardProps) {
  const t = useT()
  const status = state?.status ?? 'idle'
  const title = info?.title ?? node.type
  const attempt = state?.attempt ?? 1
  const badges = badgesOf(node.type, info)

  return (
    <div className={styles.card} role="treeitem" aria-selected={selected} data-selected={selected} style={{ width: CARD_SIZE.width }}>
      <div className={styles.header}>
        <span className={styles.title} title={title}>
          {truncate(title, MAX_TITLE)}
        </span>
        <StatusChip status={status} label={t(`status.${status}`)} />
      </div>
      <div className={styles.meta}>
        <span className={styles.id} title={node.id}>
          {truncate(node.id, MAX_ID)}
        </span>
        <span className={styles.type} title={node.type}>
          {truncate(node.type, MAX_TYPE)}
        </span>
      </div>
      <div className={styles.footer}>
        {attempt > 1 && <span className={styles.note}>{t('node.attempt', { count: attempt })}</span>}
        {state?.retrying === true && (
          <span className={styles.note}>
            <StatusIcon kind="retry" />
            {t('node.retrying')}
          </span>
        )}
        {badges.map((kind) => (
          <Badge key={kind} kind={kind} label={t(BADGE_LABEL[kind])} hint={kind === 'externalTransfer' ? t('badge.externalTransfer.hint') : undefined} />
        ))}
      </div>
    </div>
  )
}

function Badge({ kind, label, hint }: { kind: BadgeKind; label: string; hint: string | undefined }) {
  return (
    <span className={kind === 'externalTransfer' ? styles.badgeExternal : styles.badgeEffect} data-badge={kind} title={hint}>
      {label}
    </span>
  )
}
