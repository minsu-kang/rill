import type { NodeStatus } from '../model/status'
import { StatusIcon } from './StatusIcon'
import styles from './StatusChip.module.css'

export interface StatusChipProps {
  status: NodeStatus
  label: string
}

export function StatusChip({ status, label }: StatusChipProps) {
  return (
    <span className={styles.chip} data-status={status}>
      <StatusIcon kind={status} label={label} />
      <span aria-hidden="true">{label}</span>
    </span>
  )
}
