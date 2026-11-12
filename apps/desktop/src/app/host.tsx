import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { createFakeHost } from '../engine/fake-host'
import type { HostApi } from '../shared/host-api'
import type { ConnectFn } from './connection'

const HostContext = createContext<HostApi | undefined>(undefined)
const ConnectContext = createContext<ConnectFn | undefined>(undefined)

export interface HostProviderProps {
  host?: HostApi
  connect?: ConnectFn
  children: ReactNode
}

export function HostProvider({ host, connect, children }: HostProviderProps) {
  const chosen = useMemo(() => host ?? (typeof window === 'undefined' ? undefined : (window as { rill?: HostApi }).rill) ?? createFakeHost(), [host])
  return (
    <HostContext.Provider value={chosen}>
      <ConnectContext.Provider value={connect}>{children}</ConnectContext.Provider>
    </HostContext.Provider>
  )
}

export function useHost(): HostApi {
  const host = useContext(HostContext)
  if (host === undefined) throw new Error('useHost needs a HostProvider above it')
  return host
}

export function useConnect(): ConnectFn | undefined {
  return useContext(ConnectContext)
}
