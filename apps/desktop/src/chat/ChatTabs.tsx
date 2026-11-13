import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import { MAX_TABS, tabTitle, type ChatTab } from './model/tabs'
import styles from './ChatTabs.module.css'

export interface ChatTabsProps {
  tabs: readonly ChatTab[]
  activeId: string
  tabDomId(id: string): string
  panelDomId(id: string): string
  canOpen: boolean
  focusSignal: number
  onActivate(id: string): void
  onClose(id: string): void
  onOpen(): void
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M2 2l6 6M8 2 2 8" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 2v8M2 6h8" />
    </svg>
  )
}

export function ChatTabs({ tabs, activeId, tabDomId, panelDomId, canOpen, focusSignal, onActivate, onClose, onOpen }: ChatTabsProps) {
  const t = useT()
  const limitId = useId()
  const [focus, setFocus] = useState<{ id: string; forActive: string } | undefined>(undefined)
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const cells = useRef(new Map<string, HTMLDivElement>())
  const stopId = focus !== undefined && focus.forActive === activeId && tabs.some((tab) => tab.id === focus.id) ? focus.id : activeId

  useEffect(() => {
    refs.current.get(activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    cells.current.get(activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const handled = useRef(focusSignal)
  useEffect(() => {
    if (focusSignal === handled.current) return
    handled.current = focusSignal
    refs.current.get(activeId)?.focus()
  }, [focusSignal, activeId])

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = tabs.length - 1
    let target: number
    switch (event.key) {
      case 'ArrowRight':
        target = index === last ? 0 : index + 1
        break
      case 'ArrowLeft':
        target = index === 0 ? last : index - 1
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = last
        break
      case 'Delete':
        event.preventDefault()
        onClose(tabs[index]!.id)
        return
      default:
        return
    }
    event.preventDefault()
    refs.current.get(tabs[target]!.id)?.focus()
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.strip}>
        <div className={styles.scroller}>
          <div className={styles.list} role="tablist" aria-label={t('chat.tabs.label')}>
            {tabs.map((tab, index) => {
              const title = tabTitle(tab.firstMessage) ?? t('chat.tabs.empty')
              const domId = tabDomId(tab.id)
              const described = [tab.working ? `${domId}-working` : undefined, tab.unread ? `${domId}-unread` : undefined].filter((id) => id !== undefined).join(' ')
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    if (element === null) refs.current.delete(tab.id)
                    else refs.current.set(tab.id, element)
                  }}
                  type="button"
                  role="tab"
                  id={domId}
                  className={styles.tab}
                  style={{ gridColumn: index * 2 + 1 }}
                  data-selected={tab.id === activeId ? 'true' : 'false'}
                  aria-selected={tab.id === activeId}
                  aria-controls={panelDomId(tab.id)}
                  aria-describedby={described === '' ? undefined : described}
                  tabIndex={tab.id === stopId ? 0 : -1}
                  onFocus={() => setFocus({ id: tab.id, forActive: activeId })}
                  onClick={() => onActivate(tab.id)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                >
                  {title}
                </button>
              )
            })}
          </div>
          {tabs.map((tab, index) => {
            const title = tabTitle(tab.firstMessage) ?? t('chat.tabs.empty')
            const domId = tabDomId(tab.id)
            return (
              <div
                key={tab.id}
                ref={(element) => {
                  if (element === null) cells.current.delete(tab.id)
                  else cells.current.set(tab.id, element)
                }}
                className={styles.cell}
                style={{ gridColumn: index * 2 + 2 }} data-rill-cell={domId} data-selected={tab.id === activeId ? 'true' : 'false'}>
                {tab.working ? <span id={`${domId}-working`} className={styles.spinner} role="img" aria-label={t('chat.tabs.working')} /> : null}
                {tab.unread ? <span id={`${domId}-unread`} className={styles.unread} role="img" aria-label={t('chat.tabs.unread')} /> : null}
                <button type="button" className={styles.close} tabIndex={tab.id === stopId ? 0 : -1} aria-label={t('chat.tabs.close', { title })} onClick={() => onClose(tab.id)}>
                  <CloseIcon />
                </button>
              </div>
            )
          })}
        </div>
        <button type="button" className={styles.plus} data-rill-new-tab="" aria-label={t('chat.tabs.new')} aria-describedby={canOpen ? undefined : limitId} disabled={!canOpen} onClick={onOpen}>
          <PlusIcon />
        </button>
      </div>
      {canOpen ? null : (
        <p id={limitId} className={styles.limit}>
          {t('chat.tabs.limit', { max: MAX_TABS })}
        </p>
      )}
    </div>
  )
}
