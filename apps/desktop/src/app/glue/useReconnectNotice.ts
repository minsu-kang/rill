import { useEffect, useRef } from 'react'
import { OAUTH_PROVIDERS, type OAuthAccount, type OAuthProvider, type OAuthStatus } from '../../shared/host-api'

export function useReconnectNotice(accounts: readonly OAuthAccount[] | undefined, onNeeded: (providers: OAuthProvider[]) => void): void {
  const last = useRef(new Map<OAuthProvider, OAuthStatus>())
  const latest = useRef(onNeeded)

  useEffect(() => {
    latest.current = onNeeded
  })

  useEffect(() => {
    if (accounts === undefined) return
    const waiting: OAuthProvider[] = []
    let arrived = false
    for (const provider of OAUTH_PROVIDERS) {
      const status = accounts.find((entry) => entry.provider === provider)?.status
      if (status === undefined) continue
      if (status === 'needs_reconnect') waiting.push(provider)
      if (status === 'connecting') continue
      if (status === 'needs_reconnect' && last.current.get(provider) !== 'needs_reconnect') arrived = true
      last.current.set(provider, status)
    }
    if (arrived) latest.current(waiting)
  }, [accounts])
}
