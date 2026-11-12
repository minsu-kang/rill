import { MEMORY_MAX_INPUT_CHARS, MEMORY_MAX_ITEMS, type MemoryItem } from '@rill/protocol'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { EngineClient } from '../engine/client'
import { useT, type MessageKey } from '../i18n'
import { ClampedText } from './ClampedText'
import { ErrorNotice } from './ErrorNotice'
import { ExternalTransferNotice } from './ExternalTransferNotice'
import { plainText } from './model/clamp'
import { memoryErrorKey, planErrorKey } from './model/errors'
import styles from './MemoryPanel.module.css'

export interface MemoryPanelProps {
  client: EngineClient
}

type Load = { status: 'loading' } | { status: 'ready'; items: MemoryItem[] } | { status: 'error'; key: MessageKey }

export function MemoryPanel({ client }: MemoryPanelProps) {
  const t = useT()
  const titleId = useId()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [error, setError] = useState<MessageKey | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    client.request('listMemory', {}).then(
      (result) => {
        if (live) setLoad({ status: 'ready', items: result.items })
      },
      (failure: unknown) => {
        if (live) setLoad({ status: 'error', key: planErrorKey(failure) })
      },
    )
    return () => {
      live = false
    }
  }, [client, attempt])

  const ready = load.status === 'ready'
  const items = load.status === 'ready' ? load.items : []
  const full = items.length >= MEMORY_MAX_ITEMS

  function change(update: (previous: MemoryItem[]) => MemoryItem[]): void {
    setLoad((previous) => (previous.status === 'ready' ? { status: 'ready', items: update(previous.items) } : previous))
  }

  async function run(job: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await job()
    } catch (failure) {
      if (alive.current) setError(memoryErrorKey(failure))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  function add(event: FormEvent): void {
    event.preventDefault()
    if (!ready || draft.trim() === '' || full) return
    void run(async () => {
      const { item } = await client.request('saveMemory', { text: draft })
      if (!alive.current) return
      change((previous) => [...previous, item])
      setDraft('')
    })
  }

  function saveEdit(): void {
    if (editing === undefined) return
    const target = editing
    void run(async () => {
      const { item } = await client.request('saveMemory', { id: target.id, text: target.text })
      if (!alive.current) return
      change((previous) => previous.map((entry) => (entry.id === item.id ? item : entry)))
      setEditing(undefined)
    })
  }

  function remove(id: string): void {
    void run(async () => {
      await client.request('deleteMemory', { id })
      if (!alive.current) return
      change((previous) => previous.filter((entry) => entry.id !== id))
      setConfirming(undefined)
    })
  }

  return (
    <section className={styles.root} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h3 id={titleId} className={styles.title}>
          {t('chat.memory.title')}
        </h3>
        {load.status === 'ready' ? <span className={styles.count}>{t('chat.memory.count', { count: items.length, max: MEMORY_MAX_ITEMS })}</span> : null}
      </header>
      <p className={styles.text}>{t('chat.memory.intro')}</p>
      <p className={styles.text}>{t('chat.memory.rule')}</p>
      <ExternalTransferNotice items={['memory']} />
      <p className={styles.text}>{t('chat.memory.transfer')}</p>
      <form className={styles.form} onSubmit={add}>
        <input
          type="text"
          className={styles.input}
          aria-label={t('chat.memory.inputLabel')}
          placeholder={t('chat.memory.placeholder')}
          maxLength={MEMORY_MAX_INPUT_CHARS}
          disabled={!ready}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={styles.primary} disabled={!ready || busy || full || draft.trim() === ''}>
          {t('chat.memory.save')}
        </button>
      </form>
      {full ? <p className={styles.full}>{t('chat.memory.full')}</p> : null}
      {error === undefined ? null : <ErrorNotice messageKey={error} onDismiss={() => setError(undefined)} />}
      {load.status === 'loading' ? <p className={styles.text}>{t('chat.memory.loading')}</p> : null}
      {load.status === 'error' ? (
        <div className={styles.retry}>
          <ErrorNotice messageKey={load.key} />
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setLoad({ status: 'loading' })
              setAttempt((count) => count + 1)
            }}
          >
            {t('chat.panel.retry')}
          </button>
        </div>
      ) : null}
      {load.status === 'ready' && items.length === 0 ? <p className={styles.text}>{t('chat.memory.empty')}</p> : null}
      {items.length > 0 ? (
        <ul className={styles.list} aria-label={t('chat.memory.list')}>
          {items.map((item) => (
            <li key={item.id} className={styles.row}>
              {editing?.id === item.id ? (
                <>
                  <input
                    type="text"
                    className={styles.input}
                    aria-label={t('chat.memory.editLabel')}
                    maxLength={MEMORY_MAX_INPUT_CHARS}
                    value={editing.text}
                    onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                  />
                  <button type="button" className={styles.primary} disabled={busy} onClick={saveEdit}>
                    {t('chat.memory.save')}
                  </button>
                  <button type="button" className={styles.secondary} onClick={() => setEditing(undefined)}>
                    {t('chat.memory.cancel')}
                  </button>
                </>
              ) : confirming === item.id ? (
                <>
                  <span className={styles.note}>
                    <ClampedText text={item.text} max={320} />
                  </span>
                  <span className={styles.ask}>{t('chat.memory.confirmDelete')}</span>
                  <button type="button" className={styles.danger} disabled={busy} onClick={() => remove(item.id)}>
                    {t('chat.memory.confirmYes')}
                  </button>
                  <button type="button" className={styles.secondary} onClick={() => setConfirming(undefined)}>
                    {t('chat.memory.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <span className={styles.note}>
                    <ClampedText text={item.text} max={320} />
                  </span>
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-label={t('chat.memory.editFor', { text: plainText(item.text, 40) })}
                    onClick={() => {
                      setConfirming(undefined)
                      setEditing({ id: item.id, text: item.text })
                    }}
                  >
                    {t('chat.memory.edit')}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-label={t('chat.memory.deleteFor', { text: plainText(item.text, 40) })}
                    onClick={() => {
                      setEditing(undefined)
                      setConfirming(item.id)
                    }}
                  >
                    {t('chat.memory.delete')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
