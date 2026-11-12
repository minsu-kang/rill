import { RillClient } from '@rill/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client'
import type { EngineStatus, HostApi } from '../shared/host-api'

export interface ConnectedClient extends EngineClient {
  onClose?(listener: (code: number, reason: string) => void): () => void
  close?(code?: number, reason?: string): void
}

export type ConnectFn = (url: string, token: string) => Promise<ConnectedClient>

export interface ClockLike {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ConnectionState {
  state: 'connecting' | 'connected' | 'reconnecting' | 'engine_stopped' | 'no_host'
  client?: EngineClient
  previous?: EngineClient
  status?: EngineStatus
  attempt: number
}

export interface ConnectDeps {
  connect?: ConnectFn
  clock?: ClockLike
}

const BACKOFF_MS = [1000, 2000, 4000] as const
const STEADY_MS = 10_000

const DEFAULT_CLOCK: ClockLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const defaultConnect: ConnectFn = (url, token) => RillClient.connect(url, token)

export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[attempt - 1] ?? STEADY_MS
}

interface Link {
  key: string
  client: ConnectedClient | undefined
  attempt: number
  last: ConnectedClient | undefined
}

export function useEngineConnection(host: HostApi | undefined, deps: ConnectDeps = {}): ConnectionState {
  const [status, setStatus] = useState<EngineStatus | undefined>(undefined)
  const [link, setLink] = useState<Link | undefined>(undefined)
  const latest = useRef<Required<ConnectDeps>>({ connect: deps.connect ?? defaultConnect, clock: deps.clock ?? DEFAULT_CLOCK })

  useLayoutEffect(() => {
    latest.current = { connect: deps.connect ?? defaultConnect, clock: deps.clock ?? DEFAULT_CLOCK }
  })

  useEffect(() => {
    if (host === undefined) return undefined
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

  const key = host === undefined ? 'none' : status === undefined ? 'unknown' : status.state === 'running' ? `run:${status.restarts}` : status.state

  useEffect(() => {
    if (host === undefined || !key.startsWith('run:')) return undefined
    const { connect, clock } = latest.current
    let cancelled = false
    let attempt = 0
    let timer: unknown
    let client: ConnectedClient | undefined
    let offClose: (() => void) | undefined

    const publish = (next: ConnectedClient | undefined): void => {
      const at = attempt
      setLink((previous) => ({ key, client: next, attempt: at, last: next ?? previous?.last }))
    }

    const schedule = (): void => {
      attempt += 1
      publish(undefined)
      timer = clock.setTimeout(() => {
        void open()
      }, backoffDelay(attempt))
    }

    async function open(): Promise<void> {
      try {
        const info = await host!.engine.info()
        if (cancelled) return
        const opened = await connect(info.url, info.token)
        if (cancelled) {
          opened.close?.()
          return
        }
        client = opened
        attempt = 0
        publish(opened)
        offClose = opened.onClose?.(() => {
          if (cancelled || client !== opened) return
          client = undefined
          opened.close?.()
          schedule()
        })
      } catch {
        if (!cancelled) schedule()
      }
    }

    void open()
    return () => {
      cancelled = true
      if (timer !== undefined) clock.clearTimeout(timer)
      offClose?.()
      client?.close?.()
    }
  }, [host, key])

  if (host === undefined) return { state: 'no_host', attempt: 0 }
  const previous = link?.last
  const base = { ...(status === undefined ? {} : { status }), ...(previous === undefined ? {} : { previous }) }
  if (status?.state === 'stopped') return { state: 'engine_stopped', attempt: 0, ...base }
  const current = link !== undefined && link.key === key ? link : undefined
  if (current?.client !== undefined) return { state: 'connected', client: current.client, attempt: 0, ...base }
  const again = previous !== undefined || (current?.attempt ?? 0) > 0
  return { state: again ? 'reconnecting' : 'connecting', attempt: current?.attempt ?? 0, ...base }
}
