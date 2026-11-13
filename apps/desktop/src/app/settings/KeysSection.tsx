import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useT, type MessageKey } from '../../i18n'
import {
  MAX_SECRET_LENGTH,
  PROVIDER_IDS,
  hostErrorCode,
  type KeyInvalidReason,
  type KeyUnverifiedReason,
  type KeyVerdict,
  type ProviderId,
} from '../../shared/host-api'
import { PROVIDER_LABELS } from './providers'
import controls from '../controls.module.css'
import { useHost } from '../host'
import styles from './Settings.module.css'
import keyStyles from './KeysSection.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

export type KeyView =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'checked'; verdict: KeyVerdict }
  | { kind: 'refused' }
  | { kind: 'removed' }

const REASON_KEYS: Readonly<Record<KeyInvalidReason | KeyUnverifiedReason, MessageKey>> = {
  unauthorized: 'app.keys.reason.unauthorized',
  rejected: 'app.keys.reason.rejected',
  malformed: 'app.keys.reason.malformed',
  forbidden: 'app.keys.reason.forbidden',
  rate_limited: 'app.keys.reason.rate_limited',
  server_error: 'app.keys.reason.server_error',
  network: 'app.keys.reason.network',
  timeout: 'app.keys.reason.timeout',
  unexpected_status: 'app.keys.reason.unexpected_status',
}

export function KeysSection({ api, locked }: { api: SettingsApi; locked: boolean }) {
  const t = useT()
  const noteId = useId()
  return (
    <section className={styles.panel} aria-label={t('app.settings.section.keys')}>
      <p className={controls.note}>{t('app.keys.intro')}</p>
      <p id={noteId} className={controls.note}>
        {t('app.keys.checkNote')}
      </p>
      <ul className={controls.list}>
        {PROVIDER_IDS.map((provider) => (
          <KeyRow
            key={provider}
            provider={provider}
            configured={api.settings.configuredProviders.includes(provider)}
            locked={locked}
            api={api}
            noteId={noteId}
          />
        ))}
      </ul>
    </section>
  )
}

export function KeyResult({
  view,
  focusOnShow = false,
  onSaveAnyway,
  onDismiss,
}: {
  view: KeyView
  focusOnShow?: boolean
  onSaveAnyway?: () => void
  onDismiss?: () => void
}) {
  const t = useT()
  const box = useRef<HTMLElement | null>(null)
  const kind = view.kind
  const remember = (node: HTMLElement | null): void => {
    box.current = node
  }

  useEffect(() => {
    if (focusOnShow && (kind === 'checked' || kind === 'refused')) box.current?.focus()
  }, [focusOnShow, kind])

  if (view.kind === 'idle') return null
  if (view.kind === 'checking') {
    return (
      <p className={controls.note} role="status">
        {t('app.keys.checking')}
      </p>
    )
  }
  if (view.kind === 'removed') {
    return (
      <p className={controls.ok} role="status">
        {t('app.keys.removed')}
      </p>
    )
  }
  if (view.kind === 'refused') {
    return (
      <div ref={remember} className={`${controls.error} ${keyStyles.result}`} role="alert" tabIndex={-1}>
        <span>{t('app.error.host.KEY_INVALID')}</span>
        <span className={keyStyles.actions}>
          <button type="button" className={controls.primary} onClick={onSaveAnyway}>
            {t('app.keys.saveAnyway')}
          </button>
          <button type="button" className={controls.button} onClick={onDismiss}>
            {t('app.common.close')}
          </button>
        </span>
      </div>
    )
  }
  const { verdict } = view
  const message: ReactNode =
    verdict.status === 'valid'
      ? t('app.keys.saved')
      : verdict.status === 'unverified'
        ? t('app.keys.unverified', { reason: t(REASON_KEYS[verdict.reason]) })
        : t('app.keys.savedAnyway', { reason: t(REASON_KEYS[verdict.reason]) })
  return (
    <p ref={remember} className={verdict.status === 'valid' ? controls.ok : controls.warn} role="status" tabIndex={-1}>
      {message}
    </p>
  )
}

function KeyRow({ provider, configured, locked, api, noteId }: { provider: ProviderId; configured: boolean; locked: boolean; api: SettingsApi; noteId: string }) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const input = useRef<HTMLInputElement>(null)
  const held = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  const [filled, setFilled] = useState(false)
  const [view, setView] = useState<KeyView>({ kind: 'idle' })
  const inputId = useId()
  const label = PROVIDER_LABELS[provider]

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      held.current = undefined
    }
  }, [])

  function submit(value: string, saveAnyway: boolean): void {
    held.current = undefined
    setView({ kind: 'checking' })
    void action.run(async () => {
      let verdict: KeyVerdict
      try {
        const call = saveAnyway ? host.secrets.setProviderKey(provider, value, { saveAnyway: true }) : host.secrets.setProviderKey(provider, value)
        verdict = (await call).verdict
      } catch (error) {
        if (hostErrorCode(error) === 'KEY_INVALID') {
          if (mounted.current) {
            held.current = value
            setView({ kind: 'refused' })
          }
          return
        }
        setView({ kind: 'idle' })
        throw error
      }
      await api.reload()
      setView({ kind: 'checked', verdict })
    })
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const field = input.current
    if (field === null || locked || action.busy) return
    const value = field.value.trim()
    field.value = ''
    setFilled(false)
    held.current = undefined
    setView({ kind: 'idle' })
    if (value === '') return
    submit(value, false)
  }

  function saveAnyway(): void {
    const value = held.current
    if (value === undefined || locked || action.busy) return
    submit(value, true)
  }

  function dismiss(): void {
    held.current = undefined
    setView({ kind: 'idle' })
    input.current?.focus()
  }

  function edit(value: string): void {
    setFilled(value.trim() !== '')
    if (view.kind === 'refused') {
      held.current = undefined
      setView({ kind: 'idle' })
    }
  }

  function remove(): void {
    held.current = undefined
    setView({ kind: 'idle' })
    void action.run(async () => {
      await host.secrets.clearProviderKey(provider)
      await api.reload()
      setView({ kind: 'removed' })
    })
  }

  return (
    <li className={styles.item}>
      <form className={styles.form} onSubmit={save}>
        <div className={styles.itemMain}>
          <strong>{label}</strong>
          <span className={configured ? controls.chipOk : controls.chip}>{configured ? t('app.keys.configured') : t('app.keys.notConfigured')}</span>
        </div>
        <label className={`${controls.label} ${styles.grow}`} htmlFor={inputId}>
          {t('app.keys.input', { provider: label })}
          <input
            ref={input}
            id={inputId}
            className={controls.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_SECRET_LENGTH}
            aria-describedby={noteId}
            disabled={locked || action.busy}
            onInput={(event) => edit(event.currentTarget.value)}
          />
        </label>
        <button type="submit" className={controls.primary} disabled={locked || action.busy || !filled}>
          {t('app.keys.save')}
        </button>
        <button type="button" className={controls.button} disabled={locked || action.busy || !configured} onClick={remove}>
          {t('app.keys.remove')}
        </button>
      </form>
      <KeyResult view={view} focusOnShow onSaveAnyway={saveAnyway} onDismiss={dismiss} />
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </li>
  )
}
