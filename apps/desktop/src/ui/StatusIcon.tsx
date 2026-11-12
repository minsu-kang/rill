import type { NodeStatus } from '../model/status'
import styles from './StatusChip.module.css'

const PATHS: Record<NodeStatus | 'retry', string> = {
  idle: 'M8 3a5 5 0 1 0 0 10a5 5 0 1 0 0-10',
  running: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5',
  succeeded: 'M3 8.5l3.2 3.2L13 5',
  failed: 'M4 4l8 8M12 4l-8 8',
  abandoned: 'M6 4v8M10 4v8',
  skipped: 'M3 4l5 4-5 4M8 4l5 4-5 4',
  continued: 'M3 8h9M9 4.5L12.5 8 9 11.5',
  retry: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
}

export interface StatusIconProps {
  kind: NodeStatus | 'retry'
  label?: string
}

export function StatusIcon({ kind, label }: StatusIconProps) {
  const labelled = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }
  return (
    <svg
      className={kind === 'running' ? `${styles.icon} ${styles.spin}` : styles.icon}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={kind === 'idle' ? '2.2 2.2' : undefined}
      focusable="false"
      {...labelled}
    >
      <path d={PATHS[kind]} />
    </svg>
  )
}
