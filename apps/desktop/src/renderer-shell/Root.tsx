import { App } from '../app/App'
import type { ConnectFn } from '../app/connection'
import { HostProvider } from '../app/host'
import type { HostApi } from '../shared/host-api'
import { NoHost } from './StatusPage'

export function Root({ host, connect }: { host: HostApi | undefined; connect?: ConnectFn }) {
  if (host === undefined) return <NoHost />
  return (
    <HostProvider host={host} connect={connect}>
      <App />
    </HostProvider>
  )
}
