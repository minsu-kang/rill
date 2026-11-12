import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '../i18n'
import type { EngineInfo, EngineStatus, HostApi } from '../shared/host-api'
import { createShellTranslator } from './messages'
import styles from './StatusPage.module.css'

export interface PingClient {
  request(method: 'ping', params: Record<string, never>): Promise<{ time: number }>
  close(): void
}

export interface StatusPageProps {
  host: Pick<HostApi, 'engine'> | undefined
  connect: (info: EngineInfo) => Promise<PingClient>
  now?: () => number
}

interface PingResult {
  key: string
  state: 'ok' | 'error'
  ms?: number
}

const DEFAULT_NOW = () => performance.now()

function useShellTranslator() {
  const locale = useLocale()
  return useMemo(() => createShellTranslator(locale), [locale])
}

export function StatusPage({ host, connect, now = DEFAULT_NOW }: StatusPageProps) {
  return host === undefined ? <NoHost /> : <Connected host={host} connect={connect} now={now} />
}

function NoHost() {
  const t = useShellTranslator()
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('shell.title')}</h1>
      <p className={styles.note}>{t('shell.noHost')}</p>
    </main>
  )
}

function Connected({ host, connect, now }: { host: Pick<HostApi, 'engine'>; connect: StatusPageProps['connect']; now: () => number }) {
  const t = useShellTranslator()
  const [status, setStatus] = useState<EngineStatus | undefined>(undefined)
  const [result, setResult] = useState<PingResult | undefined>(undefined)
  const running = status === undefined || status.state === 'running'
  const restarts = status?.restarts ?? 0
  const key = `${running ? 'run' : 'wait'}:${restarts}`

  useEffect(() => {
    let current = true
    let heard = false
    const off = host.engine.onStatus((next) => {
      heard = true
      setStatus(next)
    })
    host.engine.status().then(
      (known) => {
        if (current && !heard) setStatus(known)
      },
      () => undefined,
    )
    return () => {
      current = false
      off()
    }
  }, [host])

  useEffect(() => {
    if (!running) return
    let cancelled = false
    let client: Awaited<ReturnType<typeof connect>> | undefined
    void (async () => {
      try {
        const info = await host.engine.info()
        const opened = await connect(info)
        if (cancelled) {
          opened.close()
          return
        }
        client = opened
        const started = now()
        await opened.request('ping', {})
        if (!cancelled) setResult({ key, state: 'ok', ms: Math.round(now() - started) })
      } catch {
        if (!cancelled) setResult({ key, state: 'error' })
      } finally {
        client?.close()
      }
    })()
    return () => {
      cancelled = true
      client?.close()
    }
  }, [host, connect, now, running, key])

  const ping = result?.key === key ? result : undefined
  const state = status?.state ?? (ping?.state === 'ok' ? 'running' : 'starting')
  const pingState = ping?.state ?? 'pending'

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('shell.title')}</h1>
      <section className={styles.card} aria-label={t('shell.engine')}>
        <dl className={styles.list}>
          <div className={styles.row}>
            <dt>{t('shell.engine')}</dt>
            <dd aria-live="polite" data-state={state}>
              {t(`shell.state.${state}`)}
            </dd>
          </div>
          <div className={styles.row}>
            <dt>{t('shell.restarts')}</dt>
            <dd>{restarts}</dd>
          </div>
          <div className={styles.row}>
            <dt>{t('shell.ping')}</dt>
            <dd>
              <output data-rill-ping={pingState} {...(ping?.ms === undefined ? {} : { 'data-rill-ping-ms': ping.ms })}>
                {ping === undefined ? t('shell.ping.pending') : ping.state === 'ok' ? t('shell.ping.ok', { ms: ping.ms ?? 0 }) : t('shell.ping.error')}
              </output>
            </dd>
          </div>
        </dl>
        {status?.error === undefined ? null : <p className={styles.error}>{t(`shell.error.${status.error}`)}</p>}
      </section>
    </main>
  )
}
