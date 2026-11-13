import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { escapeInvisible } from '../../model/text'
import {
  MAX_NAME_LENGTH,
  MAX_SLACK_CHANNEL_LENGTH,
  hostErrorCode,
  isSlackChannel,
  isSlackToken,
  type ConnectionSummary,
  type SlackVerdict,
} from '../../shared/host-api'
import { SafeText } from '../../ui/SafeText'
import controls from '../controls.module.css'
import { useHost } from '../host'
import { slackNameProblem } from './connection-form'
import look from './ConnectionsSection.module.css'
import keyStyles from './KeysSection.module.css'
import styles from './Settings.module.css'
import { hostErrorKey } from './errors'
import type { SettingsApi } from './types'
import { useAction } from './useAction'

export type SlackView = { kind: 'idle' } | { kind: 'checking' } | { kind: 'checked'; verdict: SlackVerdict } | { kind: 'refused' }

const REASON_KEYS: Readonly<Record<'unauthorized' | 'forbidden' | 'rate_limited' | 'server_error' | 'network' | 'timeout' | 'unexpected_status', MessageKey>> = {
  unauthorized: 'app.slackBot.reason.unauthorized',
  forbidden: 'app.slackBot.reason.forbidden',
  rate_limited: 'app.slackBot.reason.rate_limited',
  server_error: 'app.slackBot.reason.server_error',
  network: 'app.slackBot.reason.network',
  timeout: 'app.slackBot.reason.timeout',
  unexpected_status: 'app.slackBot.reason.unexpected_status',
}

function slackErrorKey(error: unknown): MessageKey {
  return hostErrorCode(error) === 'SUPERSEDED' ? 'app.slackBot.superseded' : hostErrorKey(error)
}

export function SlackResult({
  view,
  focusOnShow = false,
  onSaveAnyway,
  onDismiss,
}: {
  view: SlackView
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
        {t('app.slackBot.checking')}
      </p>
    )
  }
  if (view.kind === 'refused') {
    return (
      <div ref={remember} className={`${controls.error} ${keyStyles.result}`} role="alert" tabIndex={-1}>
        <span>{t('app.error.host.TOKEN_INVALID')}</span>
        <span className={keyStyles.actions}>
          <button type="button" className={controls.primary} onClick={onSaveAnyway}>
            {t('app.slackBot.saveAnyway')}
          </button>
          <button type="button" className={controls.button} onClick={onDismiss}>
            {t('app.common.close')}
          </button>
        </span>
      </div>
    )
  }
  const { verdict } = view
  let message: string
  if (verdict.status === 'valid') {
    const bot = verdict.bot === undefined ? undefined : escapeInvisible(verdict.bot)
    const workspace = verdict.workspace === undefined ? undefined : escapeInvisible(verdict.workspace)
    if (bot !== undefined && workspace !== undefined) message = t('app.slackBot.connectedAs', { bot, workspace })
    else if (workspace !== undefined) message = t('app.slackBot.connectedWorkspace', { workspace })
    else if (bot !== undefined) message = t('app.slackBot.connectedBot', { bot })
    else message = t('app.slackBot.saved')
  } else if (verdict.status === 'unverified') {
    message = t('app.slackBot.unverified', { reason: t(REASON_KEYS[verdict.reason]) })
  } else {
    message = t('app.slackBot.savedAnyway', { reason: t(REASON_KEYS[verdict.reason]) })
  }
  return (
    <p ref={remember} className={verdict.status === 'valid' ? controls.ok : controls.warn} role="status" tabIndex={-1}>
      {message}
    </p>
  )
}

interface Bot {
  name: string
  token: string
  channel?: string
}

function SavedSlack({ entries, disabled, onRemove }: { entries: readonly ConnectionSummary[]; disabled: boolean; onRemove(name: string): void }) {
  const t = useT()
  if (entries.length === 0) return <p className={controls.note}>{t('app.slackBot.none')}</p>
  return (
    <>
      <ul className={controls.list} aria-label={t('app.slackBot.listTitle')}>
        {entries.map((entry) => (
          <li key={entry.name} className={styles.item}>
            <span className={styles.itemMain}>
              <strong>
                <SafeText text={entry.name} />
              </strong>
              <span className={controls.chip}>{entry.slack === undefined ? t('app.slackBot.chipWebhook') : t('app.slackBot.chipBot')}</span>
              {entry.slack === undefined || entry.slack.confirmed === true ? null : <span className={controls.chip}>{t('app.slackBot.notConfirmed')}</span>}
              {entry.slack?.account === undefined ? null : (
                <span className={controls.note}>
                  <SafeText text={entry.slack.account} />
                </span>
              )}
              {entry.slack?.channel === undefined ? null : (
                <span className={controls.note}>{t('app.slackBot.defaultChannel', { channel: escapeInvisible(entry.slack.channel) })}</span>
              )}
            </span>
            <button type="button" className={controls.button} disabled={disabled} aria-label={t('app.connections.removeLabel', { name: escapeInvisible(entry.name) })} onClick={() => onRemove(entry.name)}>
              {t('app.connections.remove')}
            </button>
          </li>
        ))}
      </ul>
      {entries.some((entry) => entry.slack === undefined) ? <p className={controls.note}>{t('app.slackBot.webhookNote')}</p> : null}
    </>
  )
}

export function SlackCard({ api, locked, full, onRemove }: { api: SettingsApi; locked: boolean; full: boolean; onRemove(name: string): void }) {
  const t = useT()
  const host = useHost()
  const action = useAction(slackErrorKey)
  const headingId = useId()
  const panelId = useId()
  const nameId = useId()
  const tokenId = useId()
  const channelId = useId()
  const noteId = useId()
  const hintId = useId()
  const replaceId = useId()
  const nameField = useRef<HTMLInputElement>(null)
  const tokenField = useRef<HTMLInputElement>(null)
  const channelField = useRef<HTMLInputElement>(null)
  const held = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  const submitting = useRef(false)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [channel, setChannel] = useState('')
  const [filled, setFilled] = useState(false)
  const [view, setView] = useState<SlackView>({ kind: 'idle' })
  const [problem, setProblem] = useState<MessageKey | undefined>(undefined)
  const { connections } = api.settings
  const slackEntries = connections.filter((entry) => entry.kind === 'slack')
  const connected = slackEntries.some((entry) => entry.slack?.confirmed === true)
  const unconfirmed = !connected && slackEntries.some((entry) => entry.slack !== undefined)
  const replacing = slackEntries.some((entry) => entry.name === name.trim())
  const off = locked || action.busy || full

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      held.current = undefined
    }
  }, [])

  function send(bot: Bot, saveAnyway: boolean): void {
    held.current = undefined
    setView({ kind: 'checking' })
    submitting.current = true
    void action
      .run(async () => {
        let verdict: SlackVerdict
        try {
          const call = saveAnyway ? host.secrets.setSlackBot(bot, { saveAnyway: true }) : host.secrets.setSlackBot(bot)
          const result = (await call) as { verdict?: SlackVerdict } | undefined
          verdict = result?.verdict ?? { status: 'unverified', reason: 'unexpected_status' }
        } catch (error) {
          if (hostErrorCode(error) === 'TOKEN_INVALID') {
            if (mounted.current) {
              held.current = bot.token
              setView({ kind: 'refused' })
            }
            return
          }
          setView({ kind: 'idle' })
          throw error
        }
        setName('')
        setChannel('')
        setView({ kind: 'checked', verdict })
        await api.reload()
      })
      .finally(() => {
        submitting.current = false
      })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const field = tokenField.current
    if (field === null || off || submitting.current) return
    const trimmed = name.trim()
    const refused = slackNameProblem(trimmed, connections)
    if (refused !== undefined) {
      setProblem(refused)
      nameField.current?.focus()
      return
    }
    const token = field.value.trim()
    if (token === '') return
    if (!isSlackToken(token)) {
      setProblem('app.slackBot.tokenShape')
      field.focus()
      return
    }
    const channelText = channel.trim()
    if (channelText !== '' && !isSlackChannel(channelText)) {
      setProblem('app.slackBot.channelInvalid')
      channelField.current?.focus()
      return
    }
    field.value = ''
    setFilled(false)
    setProblem(undefined)
    held.current = undefined
    send({ name: trimmed, token, ...(channelText === '' ? {} : { channel: channelText }) }, false)
  }

  function saveAnyway(): void {
    const token = held.current
    if (token === undefined || off || submitting.current) return
    const channelText = channel.trim()
    send({ name: name.trim(), token, ...(channelText === '' ? {} : { channel: channelText }) }, true)
  }

  function dismiss(): void {
    held.current = undefined
    setView({ kind: 'idle' })
    tokenField.current?.focus()
  }

  function edited(): void {
    setProblem(undefined)
    if (view.kind === 'refused') {
      held.current = undefined
      setView({ kind: 'idle' })
    }
  }

  return (
    <section className={look.group} aria-labelledby={headingId}>
      <h3 id={headingId} className={look.groupTitle}>
        {t('app.connections.provider.slack')}
      </h3>
      <div className={look.card}>
        <div className={look.cardHead}>
          <span className={styles.itemMain}>
            <span className={connected ? controls.chipOk : controls.chip}>
              {connected ? t('app.connections.account.connected') : unconfirmed ? t('app.slackBot.notConfirmed') : t('app.connections.account.notConnected')}
            </span>
          </span>
        </div>
        <p className={controls.note}>{t('app.slackBot.intro')}</p>
        <button type="button" className={`${controls.button} ${look.toggle}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
          {t('app.slackBot.stepsToggle')}
        </button>
        {open ? (
          <div id={panelId} className={look.advanced}>
            <ol className={look.steps} aria-label={t('app.slackBot.stepsToggle')}>
              <li>{t('app.slackBot.step1')}</li>
              <li>{t('app.slackBot.step2')}</li>
              <li>{t('app.slackBot.step3')}</li>
              <li>{t('app.slackBot.step4')}</li>
            </ol>
          </div>
        ) : null}
        <form className={look.customForm} onSubmit={submit} noValidate>
          <div className={look.fields}>
            <label className={`${controls.label} ${look.field}`} htmlFor={nameId}>
              {t('app.slackBot.name')}
              <input
                ref={nameField}
                id={nameId}
                className={controls.input}
                type="text"
                maxLength={MAX_NAME_LENGTH}
                autoComplete="off"
                value={name}
                disabled={off}
                aria-required="true"
                aria-describedby={replacing ? replaceId : undefined}
                onChange={(event) => {
                  setName(event.target.value)
                  edited()
                }}
              />
            </label>
            <label className={`${controls.label} ${look.field}`} htmlFor={tokenId}>
              {t('app.slackBot.token')}
              <input
                ref={tokenField}
                id={tokenId}
                className={controls.input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={220}
                aria-required="true"
                aria-describedby={noteId}
                disabled={off}
                onInput={(event) => {
                  setFilled(event.currentTarget.value.trim() !== '')
                  edited()
                }}
              />
            </label>
            <label className={`${controls.label} ${look.field}`} htmlFor={channelId}>
              {t('app.slackBot.channel')}
              <input
                ref={channelField}
                id={channelId}
                className={controls.input}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_SLACK_CHANNEL_LENGTH}
                aria-describedby={hintId}
                value={channel}
                disabled={off}
                onChange={(event) => {
                  setChannel(event.target.value)
                  edited()
                }}
              />
            </label>
          </div>
          {replacing ? (
            <p id={replaceId} className={controls.note}>
              {t('app.slackBot.replaceNote')}
            </p>
          ) : null}
          <p id={hintId} className={controls.note}>
            {t('app.slackBot.channelHint')}
          </p>
          <p id={noteId} className={controls.note}>
            {t('app.slackBot.checkNote')}
          </p>
          <button type="submit" className={controls.primary} disabled={off || !filled || name.trim() === ''}>
            {t('app.slackBot.save')}
          </button>
        </form>
        {problem === undefined ? null : (
          <p className={controls.error} role="alert">
            {t(problem)}
          </p>
        )}
        <SlackResult view={view} focusOnShow onSaveAnyway={saveAnyway} onDismiss={dismiss} />
        {action.error === undefined ? null : (
          <p className={controls.error} role="alert">
            {t(action.error)}
          </p>
        )}
        <SavedSlack entries={slackEntries} disabled={locked || action.busy} onRemove={onRemove} />
      </div>
    </section>
  )
}
