import { useId, useRef, useState, type FormEvent } from 'react'
import { useT } from '../../i18n'
import { MAX_SECRET_LENGTH, PROVIDER_IDS, PROVIDER_KEY_ENV, type ProviderId } from '../../shared/host-api'
import { PROVIDER_LABELS } from './providers'
import controls from '../controls.module.css'
import { useHost } from '../host'
import styles from './Settings.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

export function KeysSection({ api, locked }: { api: SettingsApi; locked: boolean }) {
  const t = useT()
  const headingId = useId()
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.sub}>
        {t('app.keys.heading')}
      </h3>
      <p className={controls.note}>{t('app.keys.intro')}</p>
      <ul className={controls.list}>
        {PROVIDER_IDS.map((provider) => (
          <KeyRow key={provider} provider={provider} configured={api.settings.configuredProviders.includes(provider)} locked={locked} api={api} />
        ))}
      </ul>
    </section>
  )
}

function KeyRow({ provider, configured, locked, api }: { provider: ProviderId; configured: boolean; locked: boolean; api: SettingsApi }) {
  const t = useT()
  const host = useHost()
  const action = useAction()
  const input = useRef<HTMLInputElement>(null)
  const [filled, setFilled] = useState(false)
  const [done, setDone] = useState<'saved' | 'removed' | undefined>(undefined)
  const inputId = useId()
  const label = PROVIDER_LABELS[provider]

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const field = input.current
    if (field === null || locked || action.busy) return
    const value = field.value.trim()
    field.value = ''
    setFilled(false)
    setDone(undefined)
    if (value === '') return
    void action.run(async () => {
      await host.secrets.setProviderKey(provider, value)
      await api.reload()
      setDone('saved')
    })
  }

  function remove(): void {
    setDone(undefined)
    void action.run(async () => {
      await host.secrets.clearProviderKey(provider)
      await api.reload()
      setDone('removed')
    })
  }

  return (
    <li className={styles.item}>
      <form className={styles.form} onSubmit={save}>
        <div className={styles.itemMain}>
          <strong>{label}</strong>
          <span className={configured ? controls.chipOk : controls.chip}>{configured ? t('app.keys.configured') : t('app.keys.notConfigured')}</span>
          <span className={controls.note}>{t('app.keys.env', { env: PROVIDER_KEY_ENV[provider] })}</span>
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
            disabled={locked || action.busy}
            onInput={(event) => setFilled(event.currentTarget.value.trim() !== '')}
          />
        </label>
        <button type="submit" className={controls.primary} disabled={locked || action.busy || !filled}>
          {t('app.keys.save')}
        </button>
        <button type="button" className={controls.button} disabled={locked || action.busy || !configured} onClick={remove}>
          {t('app.keys.remove')}
        </button>
      </form>
      {done === undefined || action.error !== undefined ? null : (
        <p className={controls.ok} role="status">
          {t(done === 'saved' ? 'app.keys.saved' : 'app.keys.removed')}
        </p>
      )}
      {action.error === undefined ? null : (
        <p className={controls.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </li>
  )
}
