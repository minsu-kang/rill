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
    const needed: OAuthProvider[] = []
    for (const provider of OAUTH_PROVIDERS) {
      const status = accounts.find((entry) => entry.provider === provider)?.status
      if (status === undefined || status === 'connecting') continue
      if (status === 'needs_reconnect' && last.current.get(provider) !== 'needs_reconnect') needed.push(provider)
      last.current.set(provider, status)
    }
    if (needed.length > 0) latest.current(needed)
  }, [accounts])
}
