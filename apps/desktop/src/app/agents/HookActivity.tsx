import { HOOK_COOLDOWN_MS, HOOK_LOG_DEFAULT_LIMIT, HOOK_OUTCOMES, HOOK_RATE_LIMIT, HOOK_RATE_WINDOW_MS, type Hook, type HookLogEntry, type HookOutcome } from '@rill/protocol'
import { useId } from 'react'
import type { HookLogState } from '../../engine/hook-store'
import { useLocale, useT } from '../../i18n'
import { formatTimestamp } from '../../model/time'
import { SafeText } from '../../ui/SafeText'
import visuallyHidden from '../../ui/visuallyHidden.module.css'
import controls from '../controls.module.css'
import styles from './HooksScreen.module.css'
import type { HookLabels } from './model/hooks'

export interface HookActivityProps {
  log: HookLogState
  hooks: readonly Hook[]
  visible: HookLabels
  names: ReadonlyMap<string, string>
  clip(text: string): string
  timeZone?: string
  onRefresh(): void
}

const OUTCOME_CLASS: Readonly<Record<HookOutcome, string | undefined>> = {
  ok: styles.outcomeOk,
  failed: styles.outcomeFailed,
  skipped_cooldown: styles.outcomeSkipped,
  rate_limited: styles.outcomeSkipped,
  blocked_by_rule: styles.outcomeBlocked,
  skipped_inactive: styles.outcomeSkipped,
}

const CODES = ['connection', 'timeout', 'http_status', 'slack_error', 'unknown'] as const

export function HookActivity({ log, hooks, visible, names, clip, timeZone, onRefresh }: HookActivityProps) {
  const t = useT()
  const locale = useLocale()
  const titleId = useId()
  const hooksById = new Map(hooks.map((hook) => [hook.id, hook]))
  const waiting = log.status === 'loading' || log.status === 'idle'
  const statusText = waiting ? t('agents.hooks.activity.loading') : log.status === 'ready' && log.entries.length > 0 ? t('agents.hooks.activity.count', { count: log.entries.length }) : ''

  function describe(entry: HookLogEntry) {
    const hook = hooksById.get(entry.hookId)
    const workflow = names.get(entry.workflowId)
    return {
      hook: hook === undefined ? t('agents.hooks.activity.deletedHook') : t('agents.hooks.activity.hookNow', { action: visible.action(hook.action) }),
      deleted: hook === undefined,
      workflow: workflow === undefined ? t('agents.hooks.scope.unknown') : clip(workflow),
    }
  }

  return (
    <section className={styles.group} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.groupTitle}>
        {t('agents.hooks.activity.title')}
      </h3>
      <div className={styles.card}>
        <p className={controls.note}>{t('agents.hooks.activity.intro', { max: HOOK_LOG_DEFAULT_LIMIT })}</p>
        <div className={controls.row}>
          <button type="button" className={controls.button} data-hook-refresh="" onClick={onRefresh}>
            {t('agents.hooks.activity.refresh')}
          </button>
          <span className={styles.count} role="status">
            {statusText}
          </span>
        </div>
        {log.status === 'error' ? (
          <p className={controls.error} role="alert">
            {t('agents.hooks.activity.loadError')}
          </p>
        ) : null}
        {log.entries.length === 0 ? (
          log.status === 'ready' ? (
            <p className={controls.note}>{t('agents.hooks.activity.empty')}</p>
          ) : null
        ) : (
          <ul className={styles.log} aria-busy={waiting}>
            {log.entries.map((entry) => {
              const shown = describe(entry)
              return (
                <li key={entry.id} className={styles.logRow}>
                  <div className={styles.logTop}>
                    <span className={OUTCOME_CLASS[entry.outcome]}>{t(`agents.hooks.activity.outcome.${entry.outcome}`)}</span>
                    {entry.code === null ? null : (
                      <>
                        <code className={styles.code} title={t(`agents.hooks.activity.code.${entry.code}`)}>
                          {entry.code}
                        </code>
                        <span className={visuallyHidden.hidden}>{t(`agents.hooks.activity.code.${entry.code}`)}</span>
                      </>
                    )}
                    <span className={styles.time}>{formatTimestamp(entry.at, locale, timeZone)}</span>
                  </div>
                  <p className={styles.logHook}>
                    {shown.deleted ? <em>{shown.hook}</em> : <SafeText text={shown.hook} />}
                    <span className={styles.muted}> · {t(`agents.hooks.event.${entry.event}`)}</span>
                  </p>
                  <p className={styles.logWorkflow}>
                    <span className={styles.muted}>{t('agents.hooks.activity.workflow')}: </span>
                    <SafeText text={shown.workflow} />
                  </p>
                </li>
              )
            })}
          </ul>
        )}
        <details className={styles.meaning}>
          <summary>{t('agents.hooks.activity.meaning')}</summary>
          <dl className={styles.meanings}>
            {HOOK_OUTCOMES.map((outcome) => (
              <div key={outcome}>
                <dt>{t(`agents.hooks.activity.outcome.${outcome}`)}</dt>
                <dd>{t(`agents.hooks.activity.meaning.${outcome}`, { seconds: HOOK_COOLDOWN_MS / 1000, actions: HOOK_RATE_LIMIT, minutes: HOOK_RATE_WINDOW_MS / 60_000 })}</dd>
              </div>
            ))}
            {CODES.map((code) => (
              <div key={code}>
                <dt>
                  <code>{code}</code>
                </dt>
                <dd>{t(`agents.hooks.activity.code.${code}`)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </section>
  )
}
