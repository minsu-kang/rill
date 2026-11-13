import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { useT } from '../i18n'
import styles from './Layout.module.css'

export interface LayoutProps {
  topBar: ReactNode
  chat: ReactNode
  main: ReactNode
  notice?: ReactNode
  chatOpen: boolean
  onCloseChat(): void
  chatRef?: Ref<HTMLElement>
}

export function Layout({ topBar, chat, main, notice, chatOpen, onCloseChat, chatRef }: LayoutProps) {
  const t = useT()

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape' && chatOpen) {
      event.stopPropagation()
      onCloseChat()
    }
  }

  return (
    <div className={styles.app} data-rill-app="ready">
      {topBar}
      <div className={styles.body}>
        <main className={styles.main} data-rill-region="workspace" aria-label={t('app.region.main')}>
          {main}
        </main>
        <aside ref={chatRef} className={styles.chat} data-open={chatOpen} data-rill-region="chat" aria-label={t('app.region.chat')} onKeyDown={onKeyDown}>
          {chat}
        </aside>
      </div>
      {notice}
    </div>
  )
}
