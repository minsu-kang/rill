import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { escapeInvisible, truncate } from '../../model/text'
import { MAX_CLIENT_ID_LENGTH, OAUTH_REDIRECT_REGISTRATION, hostErrorCode, isOAuthClientId, isOAuthClientSecret, type OAuthProvider, type OAuthState, type OAuthStatus } from '../../shared/host-api'
import controls from '../controls.module.css'
import { useHost } from '../host'
import { ConfirmDialog } from '../workflows/ConfirmDialog'
import look from './ConnectionsSection.module.css'
import { hostErrorKey } from './errors'
import styles from './OAuthCard.module.css'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

const MAX_ACCOUNT_SHOWN = 56
const MAX_CLIENT_ID_SHOWN = 100
const SECRET_INPUT_LIMIT = 512

const STEPS = {
  google: ['app.oauth.google.step1', 'app.oauth.google.step2', 'app.oauth.google.step3', 'app.oauth.google.step4', 'app.oauth.google.step5'],
  microsoft: ['app.oauth.microsoft.step1', 'app.oauth.microsoft.step2', 'app.oauth.microsoft.step3', 'app.oauth.microsoft.step4', 'app.oauth.microsoft.step5'],
} as const satisfies Record<OAuthProvider, readonly MessageKey[]>

type Notice = { kind: 'saved' } | { kind: 'connected'; account: string | undefined } | { kind: 'disconnected' } | { kind: 'removed' }
type Problem = 'clientId' | 'secret'

export function oauthStatusOf(oauth: OAuthState, provider: OAuthProvider): { status: OAuthStatus; account: string | undefined } {
  const entry = oauth.accounts.find((account) => account.provider === provider)
  const configured = oauth.apps.find((app) => app.provider === provider)?.clientId !== undefined
  return { status: entry?.status ?? (configured ? 'not_connected' : 'not_configured'), account: entry?.account }
}

function oauthErrorKey(error: unknown): MessageKey {
  return hostErrorCode(error) === 'NAME_COLLISION' ? 'app.oauth.nameTaken' : hostErrorKey(error)
}

function NoticeLine({ children }: { children: string }) {
  const line = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    line.current?.focus()
  }, [])
  return (
    <p ref={line} className={`${controls.ok} ${styles.notice}`} role="status" tabIndex={-1}>
      {children}
    </p>
  )
}

export function OAuthCard({ provider, api, locked }: { provider: OAuthProvider; api: SettingsApi; locked: boolean }) {
  const t = useT()
  const host = useHost()
  const action = useAction(oauthErrorKey)
  const connecting = useAction(oauthErrorKey)
  const titleId = useId()
  const panelId = useId()
  const clientIdId = useId()
  const clientIdHintId = useId()
  const secretId = useId()
  const secretHintId = useId()
  const redirectId = useId()
  const needSetupId = useId()
  const idField = useRef<HTMLInputElement>(null)
  const secretField = useRef<HTMLInputElement>(null)
  const redirectField = useRef<HTMLInputElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const { oauth } = api.settings
  const { status, account } = oauthStatusOf(oauth, provider)
  const app = oauth.apps.find((entry) => entry.provider === provider)
  const savedClientId = app?.clientId
  const configured = savedClientId !== undefined
  const unavailable = locked || !oauth.available
  const waiting = status === 'connecting' || connecting.busy
  const shown: OAuthStatus = waiting ? 'connecting' : status
  const label = t(`app.connections.provider.${provider}`)
  const redirect = OAUTH_REDIRECT_REGISTRATION[provider]
  const formOff = unavailable || waiting || action.busy
  const [open, setOpen] = useState(false)
  const [filled, setFilled] = useState(false)
  const [problem, setProblem] = useState<Problem | undefined>(undefined)
  const [notice, setNotice] = useState<{ serial: number; value: Notice } | undefined>(undefined)
  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | undefined>(undefined)
  const [copied, setCopied] = useState<'ok' | 'failed' | undefined>(undefined)

  useEffect(() => {
    if (waiting) cancelButton.current?.focus()
  }, [waiting])

  function clearId(): void {
    if (idField.current !== null) idField.current.value = ''
    setFilled(false)
  }

  function show(value: Notice): void {
    setNotice((current) => ({ serial: (current?.serial ?? 0) + 1, value }))
  }

  function connect(): void {
    if (unavailable || waiting || !configured) return
    action.clearError()
    setNotice(undefined)
    void connecting.run(async () => {
      try {
        const result = await host.oauth.connect(provider)
        await api.reload()
        show({ kind: 'connected', account: result.account })
      } catch (error) {
        await api.reload()
        throw error
      }
    })
  }

  function cancel(): void {
    void host.oauth.cancel(provider).catch(() => undefined)
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (formOff || submitting.current) return
    const id = (idField.current?.value ?? '').trim()
    if (id === '') return
    if (!isOAuthClientId(provider, id)) {
      setProblem('clientId')
      idField.current?.focus()
      return
    }
    const secret = (secretField.current?.value ?? '').trim()
    if (secret !== '' && !isOAuthClientSecret(secret)) {
      setProblem('secret')
      secretField.current?.focus()
      return
    }
    if (secretField.current !== null) secretField.current.value = ''
    setProblem(undefined)
    setNotice(undefined)
    connecting.clearError()
    submitting.current = true
    void action
      .run(async () => {
        await host.oauth.setApp({ provider, clientId: id, ...(secret === '' ? {} : { clientSecret: secret }) })
        await api.reload()
        clearId()
        setOpen(false)
        show({ kind: 'saved' })
      })
      .finally(() => {
        submitting.current = false
      })
  }

  function confirmed(): void {
    const target = confirm
    if (target === undefined) return
    connecting.clearError()
    void action.run(async () => {
      if (target === 'disconnect') await host.oauth.disconnect(provider)
      else await host.oauth.clearApp(provider)
      await api.reload()
      setConfirm(undefined)
      if (target === 'remove') {
        clearId()
        setOpen(true)
      }
      show({ kind: target === 'disconnect' ? 'disconnected' : 'removed' })
    })
  }

  async function copy(): Promise<void> {
    if (redirect === undefined) return
    try {
      await navigator.clipboard.writeText(redirect)
      setCopied('ok')
      return
    } catch {
      redirectField.current?.select()
    }
    try {
      setCopied(document.execCommand('copy') ? 'ok' : 'failed')
    } catch {
      setCopied('failed')
    }
  }

  function noticeText(value: Notice): string {
    switch (value.kind) {
      case 'saved':
        return t('app.oauth.saved')
      case 'connected':
        return value.account === undefined ? t('app.oauth.didConnect', { provider: label }) : t('app.oauth.didConnectAs', { account: escapeInvisible(truncate(value.account, MAX_ACCOUNT_SHOWN)) })
      case 'disconnected':
        return t('app.oauth.didDisconnect', { provider: label })
      case 'removed':
        return t('app.oauth.didRemove', { provider: label })
    }
  }

  const chipClass = shown === 'connected' ? controls.chipOk : shown === 'needs_reconnect' ? styles.chipWarn : shown === 'connecting' ? styles.chipBusy : controls.chip
  const chipText =
    shown === 'connected' && account !== undefined
      ? t('app.oauth.status.connectedAs', { account: escapeInvisible(truncate(account, MAX_ACCOUNT_SHOWN)) })
      : t(`app.oauth.status.${shown}`)
  const errorKey = confirm === undefined ? (connecting.error ?? action.error) : connecting.error
  const hasAccountToDrop = status === 'connected' || status === 'needs_reconnect'

  return (
    <section className={look.group} aria-labelledby={titleId}>
      <h3 id={titleId} className={look.groupTitle}>
        {label}
      </h3>
      <div className={look.card}>
        <div className={look.cardHead}>
          <span className={`${chipClass} ${styles.chipText}`}>{chipText}</span>
          <span className={styles.actions}>
            {waiting ? (
              <button ref={cancelButton} type="button" className={controls.button} aria-label={t('app.oauth.cancelLabel', { provider: label })} onClick={cancel}>
                {t('app.oauth.cancel')}
              </button>
            ) : shown === 'connected' ? (
              <button type="button" className={controls.button} disabled={formOff} aria-label={t('app.oauth.disconnectLabel', { provider: label })} onClick={() => setConfirm('disconnect')}>
                {t('app.oauth.disconnect')}
              </button>
            ) : shown === 'needs_reconnect' ? (
              <>
                <button type="button" className={controls.primary} disabled={formOff} aria-label={t('app.oauth.reconnectLabel', { provider: label })} onClick={connect}>
                  {t('app.oauth.reconnect')}
                </button>
                <button type="button" className={controls.button} disabled={formOff} aria-label={t('app.oauth.disconnectLabel', { provider: label })} onClick={() => setConfirm('disconnect')}>
                  {t('app.oauth.disconnect')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={controls.primary}
                disabled={formOff || !configured}
                aria-describedby={configured ? undefined : needSetupId}
                aria-label={t('app.oauth.connectLabel', { provider: label })}
                onClick={connect}
              >
                {t('app.oauth.connect')}
              </button>
            )}
          </span>
        </div>
        <p className={controls.note}>{t(`app.oauth.${provider}.intro`)}</p>
        {savedClientId !== undefined ? (
          <p className={styles.appLine}>
            <span className={controls.mono}>{t('app.oauth.app.clientId', { clientId: escapeInvisible(truncate(savedClientId, MAX_CLIENT_ID_SHOWN)) })}</span>
            {app?.hasSecret === true ? <span>{t('app.oauth.app.secretSaved')}</span> : provider === 'google' ? <span>{t('app.oauth.app.noSecret')}</span> : null}
          </p>
        ) : (
          <p id={needSetupId} className={controls.note}>
            {t('app.error.host.OAUTH_NOT_CONFIGURED')}
          </p>
        )}
        {waiting ? (
          <p className={controls.note} role="status">
            {t('app.oauth.waiting')}
          </p>
        ) : null}
        {shown === 'needs_reconnect' ? <p className={controls.warn}>{t(`app.oauth.reconnectNote.${provider}`)}</p> : null}
        {unavailable ? <p className={controls.note}>{t('app.oauth.noKeychain')}</p> : null}
        {notice === undefined || errorKey !== undefined ? null : <NoticeLine key={notice.serial}>{noticeText(notice.value)}</NoticeLine>}
        {errorKey === undefined ? null : errorKey === 'app.error.host.OAUTH_CANCELLED' ? (
          <p className={controls.note} role="status">
            {t(errorKey)}
          </p>
        ) : (
          <p className={controls.error} role="alert">
            {t(errorKey)}
          </p>
        )}
        <button type="button" className={`${controls.button} ${look.toggle}`} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={t('app.oauth.setupLabel', { provider: label })} onClick={() => setOpen(!open)}>
          {t('app.oauth.setup')}
        </button>
        {open ? (
          <div id={panelId} className={look.advanced}>
            <ol className={styles.steps} aria-label={t('app.oauth.setupLabel', { provider: label })}>
              {STEPS[provider].map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ol>
            <p className={controls.note}>{t(`app.oauth.${provider}.limit`)}</p>
            {redirect === undefined ? (
              <p className={controls.note}>{t('app.oauth.google.redirect')}</p>
            ) : (
              <div className={styles.redirect}>
                <label className={controls.label} htmlFor={redirectId}>
                  {t('app.oauth.redirect.label')}
                </label>
                <span className={styles.redirectRow}>
                  <input
                    ref={redirectField}
                    id={redirectId}
                    className={`${controls.input} ${controls.mono} ${styles.redirectField}`}
                    type="text"
                    readOnly
                    value={redirect}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button type="button" className={controls.button} aria-label={t('app.oauth.redirect.copyLabel')} onClick={() => void copy()}>
                    {t('app.oauth.redirect.copy')}
                  </button>
                </span>
                <p className={controls.note}>{t('app.oauth.redirect.note')}</p>
                {copied === undefined ? null : copied === 'ok' ? (
                  <p className={controls.ok} role="status">
                    {t('app.oauth.redirect.copied')}
                  </p>
                ) : (
                  <p className={controls.error} role="alert">
                    {t('app.oauth.redirect.copyFailed')}
                  </p>
                )}
              </div>
            )}
            <form className={look.customForm} onSubmit={submit} noValidate>
              <div className={look.fields}>
                <label className={`${controls.label} ${look.field}`} htmlFor={clientIdId}>
                  {t(`app.oauth.clientId.${provider}`)}
                  <input
                    ref={idField}
                    id={clientIdId}
                    className={controls.input}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_CLIENT_ID_LENGTH}
                    disabled={formOff}
                    aria-required="true"
                    aria-invalid={problem === 'clientId' ? true : undefined}
                    aria-describedby={clientIdHintId}
                    onInput={(event) => {
                      setFilled(event.currentTarget.value.trim() !== '')
                      if (problem === 'clientId') setProblem(undefined)
                    }}
                  />
                </label>
                {provider === 'google' ? (
                  <label className={`${controls.label} ${look.field}`} htmlFor={secretId}>
                    {t('app.oauth.secret.label')}
                    <input
                      ref={secretField}
                      id={secretId}
                      className={controls.input}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={SECRET_INPUT_LIMIT}
                      disabled={formOff}
                      aria-invalid={problem === 'secret' ? true : undefined}
                      aria-describedby={secretHintId}
                      onInput={() => {
                        if (problem === 'secret') setProblem(undefined)
                      }}
                    />
                  </label>
                ) : null}
              </div>
              <p id={clientIdHintId} className={controls.note}>
                {t(`app.oauth.clientId.hint.${provider}`)}
              </p>
              {provider === 'google' ? (
                <p id={secretHintId} className={controls.note}>
                  {t('app.oauth.secret.hint')}
                </p>
              ) : null}
              {configured && hasAccountToDrop ? <p className={controls.warn}>{t('app.oauth.replaceNote')}</p> : null}
              {problem === undefined ? null : (
                <p className={controls.error} role="alert">
                  {problem === 'clientId' ? t(`app.oauth.clientId.invalid.${provider}`) : t('app.oauth.secret.invalid')}
                </p>
              )}
              <button type="submit" className={controls.primary} disabled={formOff || !filled}>
                {t('app.oauth.save')}
              </button>
            </form>
            {configured ? (
              <div className={styles.dangerZone}>
                <button type="button" className={controls.danger} disabled={formOff} aria-label={t('app.oauth.removeLabel', { provider: label })} onClick={() => setConfirm('remove')}>
                  {t('app.oauth.remove')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {confirm === undefined ? null : (
        <ConfirmDialog
          title={confirm === 'disconnect' ? t('app.oauth.disconnectTitle', { provider: label }) : t('app.oauth.removeTitle')}
          message={confirm === 'disconnect' ? t(`app.oauth.disconnectConfirm.${provider}`) : t('app.oauth.removeConfirm', { provider: label })}
          confirmLabel={confirm === 'disconnect' ? t('app.oauth.disconnectAction') : t('app.oauth.removeAction')}
          cancelLabel={t('app.common.cancel')}
          danger
          busy={action.busy}
          error={action.error === undefined ? undefined : t(action.error)}
          onConfirm={confirmed}
          onCancel={() => {
            setConfirm(undefined)
            action.clearError()
          }}
        />
      )}
    </section>
  )
}
