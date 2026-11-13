import { useId, useRef, useState, type FormEvent } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { escapeInvisible } from '../../model/text'
import {
  AUTH_TYPES,
  MAX_AUTH_NAME_LENGTH,
  MAX_AUTH_VALUE_LENGTH,
  MAX_NAME_LENGTH,
  OAUTH_PROVIDERS,
  type AuthType,
  type ConnectionSummary,
  type OAuthProvider,
} from '../../shared/host-api'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import { useHost } from '../host'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import { buildCustomAuth, nameProblem, type CustomField, type CustomFieldValues } from './connection-form'
import look from './ConnectionsSection.module.css'
import { SlackCard } from './SlackCard'
import styles from './Settings.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

const MAX_CONNECTIONS = 200

function readField(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name)
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : ''
}

function clearSecrets(form: HTMLFormElement): void {
  for (const field of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) field.value = ''
}

interface ListProps {
  entries: readonly ConnectionSummary[]
  chip(entry: ConnectionSummary): string
  label: string
  empty: string
  disabled: boolean
  onRemove(name: string): void
}

function SavedList({ entries, chip, label, empty, disabled, onRemove }: ListProps) {
  const t = useT()
  if (entries.length === 0) return <p className={controls.note}>{empty}</p>
  return (
    <ul className={controls.list} aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.name} className={styles.item}>
          <span className={styles.itemMain}>
            <strong>
              <SafeText text={entry.name} />
            </strong>
            <span className={controls.chip}>{chip(entry)}</span>
          </span>
          <button type="button" className={controls.button} disabled={disabled} aria-label={t('app.connections.removeLabel', { name: escapeInvisible(entry.name) })} onClick={() => onRemove(entry.name)}>
            {t('app.connections.remove')}
          </button>
        </li>
      ))}
    </ul>
  )
}

interface GroupProps {
  api: SettingsApi
  locked: boolean
  full: boolean
  onRemove(name: string): void
}

function Accounts({ api, locked }: GroupProps) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const noteId = useId()
  const headingId = useId()
  const [done, setDone] = useState<{ provider: OAuthProvider; connected: boolean } | undefined>(undefined)
  const { oauth } = api.settings
  const label = (provider: OAuthProvider): string => t(`app.connections.provider.${provider}`)

  function change(provider: OAuthProvider, connected: boolean): void {
    setDone(undefined)
    void action.run(async () => {
      if (connected) await host.oauth.connect(provider)
      else await host.oauth.disconnect(provider)
      await api.reload()
      setDone({ provider, connected })
    })
  }

  return (
    <section className={look.group} aria-labelledby={headingId}>
      <h3 id={headingId} className={look.groupTitle}>
        {t('app.connections.accounts.heading')}
      </h3>
      {oauth.available ? null : (
        <p id={noteId} className={controls.note}>
          {t('app.connections.accounts.unavailable')}
        </p>
      )}
      <ul className={controls.list}>
        {OAUTH_PROVIDERS.map((provider) => {
          const entry = oauth.accounts.find((account) => account.provider === provider)
          const connected = entry !== undefined
          return (
            <li key={provider} className={look.card}>
              <div className={look.cardHead}>
                <span className={styles.itemMain}>
                  <strong>{label(provider)}</strong>
                  <span className={connected ? controls.chipOk : controls.chip}>
                    {!connected
                      ? t('app.connections.account.notConnected')
                      : entry.account === undefined
                        ? t('app.connections.account.connected')
                        : t('app.connections.account.connectedAs', { account: escapeInvisible(entry.account) })}
                  </span>
                </span>
                <button
                  type="button"
                  className={connected ? controls.button : controls.primary}
                  disabled={locked || action.busy || !oauth.available}
                  aria-describedby={oauth.available ? undefined : noteId}
                  aria-label={t(connected ? 'app.connections.account.disconnectLabel' : 'app.connections.account.connectLabel', { provider: label(provider) })}
                  onClick={() => change(provider, !connected)}
                >
                  {t(connected ? 'app.connections.account.disconnect' : 'app.connections.account.connect')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {done === undefined || action.error !== undefined ? null : (
        <p className={controls.ok} role="status">
          {t(done.connected ? 'app.connections.account.didConnect' : 'app.connections.account.didDisconnect', { provider: label(done.provider) })}
        </p>
      )}
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </section>
  )
}

function AuthFields({ type, disabled }: { type: AuthType; disabled: boolean }) {
  const t = useT()
  const ids = [useId(), useId(), useId()]
  const text = (id: string, name: CustomField, label: MessageKey, secret: boolean, max: number) => (
    <label className={`${controls.label} ${look.field}`} htmlFor={id}>
      {t(label)}
      <input id={id} name={name} className={controls.input} type={secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} maxLength={max} disabled={disabled} aria-required={name !== 'password'} />
    </label>
  )
  switch (type) {
    case 'none':
      return <p className={controls.note}>{t('app.connections.custom.noneNote')}</p>
    case 'apiKey':
      return (
        <>
          {text(ids[0]!, 'keyName', 'app.connections.custom.keyName', false, MAX_AUTH_NAME_LENGTH)}
          {text(ids[1]!, 'keyValue', 'app.connections.custom.keyValue', true, MAX_AUTH_VALUE_LENGTH)}
          <label className={`${controls.label} ${look.field}`} htmlFor={ids[2]}>
            {t('app.connections.custom.keyIn')}
            <select id={ids[2]} name="keyIn" className={controls.input} defaultValue="header" disabled={disabled}>
              <option value="header">{t('app.connections.custom.in.header')}</option>
              <option value="query">{t('app.connections.custom.in.query')}</option>
            </select>
          </label>
        </>
      )
    case 'bearer':
      return text(ids[0]!, 'token', 'app.connections.custom.token', true, MAX_AUTH_VALUE_LENGTH)
    case 'basic':
      return (
        <>
          {text(ids[0]!, 'username', 'app.connections.custom.username', false, 256)}
          {text(ids[1]!, 'password', 'app.connections.custom.password', true, MAX_AUTH_VALUE_LENGTH)}
        </>
      )
  }
}

function CustomConnection({ api, locked, full, onRemove }: GroupProps) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const headingId = useId()
  const nameId = useId()
  const typeId = useId()
  const form = useRef<HTMLFormElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<AuthType>('none')
  const [serial, setSerial] = useState(0)
  const [problem, setProblem] = useState<MessageKey | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const { connections } = api.settings
  const custom = connections.filter((entry) => entry.kind === 'http')
  const off = locked || action.busy || full

  function choose(next: AuthType): void {
    setType(next)
    setProblem(undefined)
    setSaved(false)
  }

  function focusField(field: CustomField): void {
    const target = form.current?.elements.namedItem(field)
    if (target instanceof HTMLElement) target.focus()
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const element = form.current
    if (element === null || locked || action.busy || submitting.current) return
    setSaved(false)
    const trimmed = name.trim()
    const refused = trimmed === '' ? 'app.connections.custom.missing' : nameProblem(trimmed, connections)
    if (refused !== undefined) {
      setProblem(refused)
      nameField.current?.focus()
      return
    }
    const values: CustomFieldValues = {
      keyName: readField(element, 'keyName'),
      keyValue: readField(element, 'keyValue'),
      keyIn: readField(element, 'keyIn'),
      token: readField(element, 'token'),
      username: readField(element, 'username'),
      password: readField(element, 'password'),
    }
    const built = buildCustomAuth(type, values)
    if ('problem' in built) {
      setProblem(built.problem === 'missing' ? 'app.connections.custom.missing' : 'app.connections.custom.invalid')
      focusField(built.field)
      return
    }
    clearSecrets(element)
    setProblem(undefined)
    submitting.current = true
    void action
      .run(async () => {
        await host.secrets.setCustomConnection({ name: trimmed, auth: built.auth })
        await api.reload()
        setName('')
        setSerial((current) => current + 1)
        setSaved(true)
      })
      .finally(() => {
        submitting.current = false
      })
  }

  return (
    <section className={look.group} aria-labelledby={headingId}>
      <h3 id={headingId} className={look.groupTitle}>
        {t('app.connections.custom.heading')}
      </h3>
      <p className={controls.note}>{t('app.connections.custom.intro')}</p>
      <SavedList
        entries={custom}
        chip={(entry) => (entry.authType === undefined ? t('app.connections.custom.legacy') : t(`app.connections.custom.type.${entry.authType}`))}
        label={t('app.connections.custom.listTitle')}
        empty={t('app.connections.custom.none')}
        disabled={locked || action.busy}
        onRemove={onRemove}
      />
      <form ref={form} className={look.customForm} onSubmit={submit} noValidate>
        <div className={look.fields}>
          <label className={`${controls.label} ${look.field}`} htmlFor={nameId}>
            {t('app.connections.name')}
            <input ref={nameField} id={nameId} className={controls.input} type="text" maxLength={MAX_NAME_LENGTH} autoComplete="off" value={name} disabled={off} aria-required="true" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className={`${controls.label} ${look.field}`} htmlFor={typeId}>
            {t('app.connections.custom.authType')}
            <select id={typeId} className={controls.input} value={type} disabled={off} onChange={(event) => choose(event.target.value as AuthType)}>
              {AUTH_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`app.connections.custom.type.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={look.fields} key={`${type}-${serial}`}>
          <AuthFields type={type} disabled={off} />
        </div>
        <button type="submit" className={controls.primary} disabled={off}>
          {t('app.connections.custom.save')}
        </button>
      </form>
      {problem === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(problem)}
        </p>
      )}
      {saved && action.error === undefined ? (
        <p className={controls.ok} role="status">
          {t('app.connections.custom.didSave')}
        </p>
      ) : null}
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </section>
  )
}

function OtherSecrets({ entries, disabled, onRemove }: { entries: readonly ConnectionSummary[]; disabled: boolean; onRemove(name: string): void }) {
  const t = useT()
  const headingId = useId()
  return (
    <section className={look.group} aria-labelledby={headingId}>
      <h3 id={headingId} className={look.groupTitle}>
        {t('app.connections.other.heading')}
      </h3>
      <p className={controls.note}>{t('app.connections.other.note')}</p>
      <SavedList entries={entries} chip={() => t('app.connections.other.webhookSecret')} label={t('app.connections.other.heading')} empty="" disabled={disabled} onRemove={onRemove} />
    </section>
  )
}

export function ConnectionsSection({ api, locked }: { api: SettingsApi; locked: boolean }) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const [removing, setRemoving] = useState<string | undefined>(undefined)
  const { connections } = api.settings
  const other = connections.filter((entry) => entry.kind === 'webhookSecret')
  const full = connections.length >= MAX_CONNECTIONS

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
      {full ? <p className={controls.warn}>{t('app.connections.limit')}</p> : null}
      <Accounts api={api} locked={locked} full={full} onRemove={setRemoving} />
      <SlackCard api={api} locked={locked} full={full} onRemove={setRemoving} />
      <CustomConnection api={api} locked={locked} full={full} onRemove={setRemoving} />
      {other.length === 0 ? null : <OtherSecrets entries={other} disabled={locked || action.busy} onRemove={setRemoving} />}
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
