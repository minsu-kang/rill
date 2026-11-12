import type { RunSummary } from '@rill/protocol'
import { useLocale, useT } from '../i18n'
import { visualStatusOfRun } from '../model/status'
import { formatTimestamp, relativeTime } from '../model/time'
import { truncate } from '../model/text'
import { StatusChip } from '../ui/StatusChip'
import styles from './RunHistory.module.css'

export interface RunHistoryProps {
  runs: readonly RunSummary[]
  selectedRunId?: string
  now: number
  onSelect?(runId: string): void
  timeZone?: string
}

const MAX_ERROR = 90
const MAX_ID = 28

export function RunHistory({ runs, selectedRunId, now, onSelect, timeZone }: RunHistoryProps) {
  const t = useT()
  const locale = useLocale()
  return (
    <section className={styles.root} aria-label={t('history.heading')}>
      <h2 className={styles.heading}>{t('history.heading')}</h2>
      {runs.length === 0 ? (
        <p className={styles.empty}>{t('history.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {runs.map((run) => {
            const relative = relativeTime(run.createdAt, now)
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className={styles.item}
                  aria-current={run.id === selectedRunId ? 'true' : undefined}
                  onClick={() => onSelect?.(run.id)}
                >
                  <StatusChip status={visualStatusOfRun(run.status)} label={t(`run.status.${run.status}`)} />
                  <span className={styles.time} title={formatTimestamp(run.createdAt, locale, timeZone)}>
                    {t(relative.key, { count: relative.count })}
                  </span>
                  {run.dryRun && <span className={styles.tag}>{t('run.dryRun')}</span>}
                  <span className={styles.id} title={run.id}>
                    {truncate(run.id, MAX_ID)}
                  </span>
                  {run.error !== null && (
                    <span className={styles.error} title={run.error}>
                      {truncate(run.error, MAX_ERROR)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
