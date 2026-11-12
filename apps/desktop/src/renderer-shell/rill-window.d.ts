import type { HostApi } from '../shared/host-api'

declare global {
  interface Window {
    rill?: HostApi
  }
}

export {}
