import { useId, useRef, useState, type FormEvent } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { escapeInvisible } from '../../model/text'
import { CONNECTION_KINDS, MAX_NAME_LENGTH, MAX_SECRET_LENGTH, foldName, type ConnectionKind } from '../../shared/host-api'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import { useHost } from '../host'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import styles from './Settings.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

const MAX_CONNECTIONS = 200
const CONTROL = /\p{Cc}/u

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function ConnectionsSection({ api, locked }: { api: SettingsApi; locked: boolean }) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const nameId = useId()
  const kindId = useId()
  const secretId = useId()
  const secret = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ConnectionKind>('slack')
  const [secretState, setSecretState] = useState({ filled: false, urlLike: false })
  const [problem, setProblem] = useState<MessageKey | undefined>(undefined)
  const [added, setAdded] = useState(false)
  const [removing, setRemoving] = useState<string | undefined>(undefined)
  const connections = api.settings.connections
  const full = connections.length >= MAX_CONNECTIONS
  const trimmed = name.trim()

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const field = secret.current
    if (field === null || locked || action.busy) return
    setAdded(false)
    if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH || CONTROL.test(trimmed)) {
      setProblem('app.connections.nameInvalid')
      return
    }
    if (connections.some((entry) => foldName(entry.name) === foldName(trimmed))) {
      setProblem('app.connections.duplicate')
      return
    }
    const value = field.value.trim()
    if (value === '') return
    field.value = ''
    setSecretState({ filled: false, urlLike: false })
    setProblem(undefined)
    void action.run(async () => {
      await host.secrets.setConnection({ name: trimmed, kind, secret: value })
      await api.reload()
      setName('')
      setAdded(true)
    })
  }

  function confirmRemove(): void {
    const target = removing
    if (target === undefined) return
    void action.run(async () => {
      await host.secrets.removeConnection(target)
      await api.reload()
      setRemoving(undefined)
    })
  }

  return (
    <section className={styles.panel} aria-label={t('app.settings.section.connections')}>
      <p className={controls.note}>{t('app.connections.intro')}</p>
      {connections.length === 0 ? (
        <p className={controls.note}>{t('app.connections.empty')}</p>
      ) : (
        <ul className={controls.list}>
          {connections.map((entry) => (
            <li key={entry.name} className={styles.item}>
              <span className={styles.itemMain}>
                <strong>
                  <SafeText text={entry.name} />
                </strong>
                <span className={controls.chip}>{t(`app.connections.kind.${entry.kind}`)}</span>
              </span>
              <button type="button" className={controls.button} disabled={locked || action.busy} aria-label={t('app.connections.removeLabel', { name: escapeInvisible(entry.name) })} onClick={() => setRemoving(entry.name)}>
                {t('app.connections.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className={styles.form} onSubmit={submit}>
        <label className={`${controls.label} ${styles.grow}`} htmlFor={nameId}>
          {t('app.connections.name')}
          <input id={nameId} className={controls.input} type="text" maxLength={MAX_NAME_LENGTH} autoComplete="off" value={name} disabled={locked || action.busy || full} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className={controls.label} htmlFor={kindId}>
          {t('app.connections.kind')}
          <select id={kindId} className={controls.input} value={kind} disabled={locked || action.busy || full} onChange={(event) => setKind(event.target.value as ConnectionKind)}>
            {CONNECTION_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`app.connections.kind.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={`${controls.label} ${styles.grow}`} htmlFor={secretId}>
          {t('app.connections.secret')}
          <input
            ref={secret}
            id={secretId}
            className={controls.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_SECRET_LENGTH}
            disabled={locked || action.busy || full}
            onInput={(event) => {
              const value = event.currentTarget.value.trim()
              setSecretState({ filled: value !== '', urlLike: looksLikeUrl(value) })
            }}
          />
        </label>
        <button type="submit" className={controls.primary} disabled={locked || action.busy || full || !secretState.filled || trimmed === ''}>
          {t('app.connections.add')}
        </button>
      </form>
      {kind === 'slack' && secretState.filled && !secretState.urlLike ? <p className={controls.warn}>{t('app.connections.slackHint')}</p> : null}
      {full ? <p className={controls.warn}>{t('app.connections.limit')}</p> : null}
      {problem === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(problem)}
        </p>
      )}
      {added && action.error === undefined ? (
        <p className={controls.ok} role="status">
          {t('app.connections.added')}
        </p>
      ) : null}
      {action.error === undefined || removing !== undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
      {removing === undefined ? null : (
        <ConfirmDialog
          title={t('app.connections.removeTitle')}
          message={t('app.connections.removeConfirm', { name: escapeInvisible(removing) })}
          confirmLabel={t('app.connections.removeAction')}
          cancelLabel={t('app.common.cancel')}
          busy={action.busy}
          error={action.error === undefined ? undefined : t(action.error)}
          onConfirm={confirmRemove}
          onCancel={() => {
            setRemoving(undefined)
            action.clearError()
          }}
        />
      )}
    </section>
  )
}
