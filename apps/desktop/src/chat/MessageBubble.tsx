import type { PlanQuestion } from '@rill/protocol'
import { Fragment, type ReactNode } from 'react'
import { useLocale, useT } from '../i18n'
import { ClampedText } from './ClampedText'
import type { UserEntry } from './model/conversation'
import { safeName } from './model/attachments'
import { markHidden } from './model/clamp'
import { formatBytes } from './model/format'
import styles from './MessageBubble.module.css'

export interface MessageBubbleProps {
  role: 'user' | 'assistant'
  children: ReactNode
}

export function MessageBubble({ role, children }: MessageBubbleProps) {
  const t = useT()
  return (
    <article className={styles.bubble} data-role={role} aria-label={t(`chat.role.${role}`)}>
      <div className={styles.body}>{children}</div>
    </article>
  )
}

export interface UserMessageProps {
  entry: UserEntry
  questions?: readonly PlanQuestion[]
}

export function UserMessage({ entry, questions }: UserMessageProps) {
  const t = useT()
  const locale = useLocale()
  const answers = entry.answers === undefined ? [] : Object.entries(entry.answers)
  return (
    <>
      {entry.text === '' ? null : (
        <p className={styles.text}>
          <ClampedText text={entry.text} max={600} />
        </p>
      )}
      {entry.attachments.length === 0 ? null : (
        <ul className={styles.files} aria-label={t('chat.user.attachments')}>
          {entry.attachments.map((item) => (
            <li key={item.id} className={styles.file}>
              <span className={styles.fileName} title={safeName(item.name, Infinity).shown}>
                <bdi>{safeName(item.name).shown}</bdi>
              </span>
              <span className={styles.meta}>{formatBytes(item.bytes, locale)}</span>
            </li>
          ))}
        </ul>
      )}
      {answers.length === 0 ? null : (
        <>
          <h5 className={styles.subheading}>{t('chat.user.answers')}</h5>
          <dl className={styles.answers}>
            {answers.map(([id, answer]) => {
              const question = questions?.find((item) => item.id === id)
              return (
                <Fragment key={id}>
                  <dt>{question === undefined ? <bdi>{markHidden(id)}</bdi> : <ClampedText text={question.text} max={160} />}</dt>
                  <dd>
                    <ClampedText text={answer} max={300} />
                  </dd>
                </Fragment>
              )
            })}
          </dl>
        </>
      )}
    </>
  )
}
