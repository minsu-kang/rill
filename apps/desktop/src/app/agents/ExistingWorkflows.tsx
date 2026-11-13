import { RULE_CHECK_MAX_ISSUES, RULE_CHECK_MAX_WORKFLOWS } from '@rill/protocol'
import { useEffect, useId, useState } from 'react'
import { plainText } from '../../chat/model/clamp'
import type { EngineClient } from '../../engine/client'
import { useT } from '../../i18n'
import type { RuleViolation } from '../../model/rules'
import controls from '../controls.module.css'
import styles from './RulesScreen.module.css'

export interface ExistingWorkflowsProps {
  client: EngineClient
  version?: number
}

interface Answer {
  version: number
  attempt: number
  violations: RuleViolation[] | undefined
}

const NAME_CHARS = 80
const MESSAGE_CHARS = 200
const ISSUES_SHOWN = 3

export function ExistingWorkflows({ client, version = 0 }: ExistingWorkflowsProps) {
  const t = useT()
  const titleId = useId()
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<Answer | undefined>(undefined)

  useEffect(() => {
    let live = true
    client.request('checkRules', {}).then(
      (result) => {
        if (live) setAnswer({ version, attempt, violations: result.violations })
      },
      () => {
        if (live) setAnswer({ version, attempt, violations: undefined })
      },
    )
    return () => {
      live = false
    }
  }, [client, version, attempt])

  const current = answer !== undefined && answer.version === version && answer.attempt === attempt ? answer : undefined
  const violations = current?.violations
  const stopped = violations !== undefined && violations.length >= RULE_CHECK_MAX_WORKFLOWS
  const statusText =
    current === undefined
      ? t('rules.check.loading')
      : violations === undefined
        ? ''
        : violations.length === 0
          ? t('rules.check.none')
          : t(stopped ? 'rules.check.countAtLeast' : 'rules.check.count', { count: violations.length })
  const statusClass = violations !== undefined && violations.length > 0 ? controls.warn : controls.note
  const moreIssues = (total: number): string =>
    total >= RULE_CHECK_MAX_ISSUES ? t('rules.check.moreIssuesAtLeast', { count: total - ISSUES_SHOWN }) : t('rules.check.moreIssues', { count: total - ISSUES_SHOWN })

  return (
    <section className={styles.group} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.groupTitle}>
        {t('rules.check.title')}
      </h3>
      <div className={styles.card}>
        <p className={controls.note}>{t('rules.check.intro')}</p>
        {violations === undefined && current !== undefined ? (
          <p className={controls.error} role="alert">
            {t('rules.check.error')}
          </p>
        ) : null}
        <p className={statusClass} role="status" hidden={statusText === ''}>
          {statusText}
        </p>
        {violations === undefined || violations.length === 0 ? null : (
          <ul className={styles.violations} aria-label={t('rules.check.list')}>
            {violations.map((violation) => (
              <li key={violation.workflowId} className={styles.violation}>
                <strong className={styles.violationName}>{plainText(violation.name, NAME_CHARS)}</strong>
                <ul className={styles.issues}>
                  {violation.issues.slice(0, ISSUES_SHOWN).map((issue, index) => (
                    <li key={index}>{plainText(issue.message, MESSAGE_CHARS)}</li>
                  ))}
                  {violation.issues.length > ISSUES_SHOWN ? <li className={styles.more}>{moreIssues(violation.issues.length)}</li> : null}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <div className={controls.row}>
          <button type="button" className={controls.button} onClick={() => setAttempt((value) => value + 1)}>
            {t('rules.check.retry')}
          </button>
        </div>
      </div>
    </section>
  )
}
