import { isTrigger, type WorkflowNode } from '@rill/dsl'
import type { NodeInfo, StepDetail } from '@rill/protocol'
import { useMemo } from 'react'
import { useLocale, useT, type Translate } from '../i18n'
import { badgesOf } from '../model/badges'
import type { NodeRunState } from '../model/status'
import { formatTimestamp } from '../model/time'
import { StatusChip } from '../ui/StatusChip'
import { CappedText, JsonView } from './JsonView'
import styles from './Inspector.module.css'

export interface InspectorProps {
  node: WorkflowNode | undefined
  info: NodeInfo | undefined
  steps: readonly StepDetail[]
  state: NodeRunState | undefined
  timeZone?: string
}

export function Inspector({ node, info, steps, state, timeZone }: InspectorProps) {
  const t = useT()
  return (
    <aside className={styles.root} aria-label={t('inspector.heading')}>
      <h2 className={styles.heading}>{t('inspector.heading')}</h2>
      {node === undefined ? <p className={styles.empty}>{t('inspector.empty')}</p> : <NodeDetails node={node} info={info} steps={steps} state={state} timeZone={timeZone} />}
    </aside>
  )
}

function onErrorLabel(t: Translate, onError: WorkflowNode['onError']): string {
  return onError === 'continue' ? t('inspector.onError.continue') : t('inspector.onError.fail')
}

function NodeDetails({ node, info, steps, state, timeZone }: InspectorProps & { node: WorkflowNode }) {
  const t = useT()
  const locale = useLocale()
  const rows = useMemo(
    () => steps.filter((row) => row.nodeId === node.id).sort((a, b) => a.attempt - b.attempt || a.startedAt - b.startedAt),
    [steps, node.id],
  )
  const status = state?.status ?? 'idle'
  const badges = badgesOf(node.type, info)
  const trigger = isTrigger(node.type)
  const liveError = state?.error !== null && state?.error !== undefined && !rows.some((row) => row.error === state.error) ? state.error : undefined
  const notRun = rows.length === 0 && !trigger && (state === undefined || state.status === 'idle')
  const when = (at: number | null): string => (at === null ? '' : formatTimestamp(at, locale, timeZone))

  return (
    <div className={styles.body}>
      <header className={styles.header}>
        <h3 className={styles.title}>{info?.title ?? node.type}</h3>
        {info?.description !== undefined && <p className={styles.description}>{info.description}</p>}
      </header>

      <dl className={styles.facts}>
        <dt>{t('inspector.type')}</dt>
        <dd className={styles.mono}>{node.type}</dd>
        <dt>{t('inspector.nodeId')}</dt>
        <dd className={styles.mono}>{node.id}</dd>
        <dt>{t('inspector.status')}</dt>
        <dd>
          <StatusChip status={status} label={t(`status.${status}`)} />
        </dd>
        {node.retry !== undefined && (
          <>
            <dt>{t('inspector.retry')}</dt>
            <dd>{t('inspector.retryValue', { count: node.retry.maxAttempts })}</dd>
          </>
        )}
        {node.onError !== undefined && (
          <>
            <dt>{t('inspector.onError')}</dt>
            <dd>{onErrorLabel(t, node.onError)}</dd>
          </>
        )}
      </dl>

      {badges.includes('externalTransfer') && (
        <p className={styles.note}>
          <span className={styles.badge}>{t('badge.externalTransfer')}</span> <span>{t('badge.externalTransfer.hint')}</span>
        </p>
      )}
      {badges.includes('writesFile') && <p className={styles.note}>{t('badge.writesFile')}</p>}
      {badges.includes('network') && <p className={styles.note}>{t('badge.network')}</p>}

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>{t('inspector.config')}</h4>
        {Object.keys(node.config).length === 0 ? <p className={styles.muted}>{t('inspector.noConfig')}</p> : <JsonView value={node.config} />}
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>{t('inspector.attempts')}</h4>
        {notRun && <p className={styles.muted}>{t('inspector.notRun')}</p>}
        {trigger && rows.length === 0 && <p className={styles.muted}>{t('inspector.triggerNoData')}</p>}
        {liveError !== undefined && (
          <div className={styles.block}>
            <h5 className={styles.blockTitle}>{t('inspector.liveError')}</h5>
            <CappedText text={liveError} />
          </div>
        )}
        {rows.length > 0 && (
          <ol className={styles.attempts}>
            {rows.map((row) => (
              <li key={`${row.attempt}-${row.startedAt}`} className={styles.attempt}>
                <div className={styles.attemptHeader}>
                  <strong>{t('node.attempt', { count: row.attempt })}</strong>
                  <StatusChip status={row.status} label={t(`status.${row.status}`)} />
                </div>
                <dl className={styles.times}>
                  <dt>{t('inspector.startedAt')}</dt>
                  <dd>{when(row.startedAt)}</dd>
                  {row.finishedAt !== null && (
                    <>
                      <dt>{t('inspector.finishedAt')}</dt>
                      <dd>{when(row.finishedAt)}</dd>
                    </>
                  )}
                </dl>
                {row.input !== null && (
                  <div className={styles.block}>
                    <h5 className={styles.blockTitle}>{t('inspector.input')}</h5>
                    <JsonView value={row.input} />
                  </div>
                )}
                {row.output !== null && (
                  <div className={styles.block}>
                    <h5 className={styles.blockTitle}>{t('inspector.output')}</h5>
                    <JsonView value={row.output} />
                  </div>
                )}
                {row.error !== null && (
                  <div className={styles.block}>
                    <h5 className={styles.blockTitle}>{t('inspector.error')}</h5>
                    <CappedText text={row.error} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
