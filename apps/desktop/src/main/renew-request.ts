import { OAUTH_PROVIDERS, type OAuthProvider } from '../shared/host-api'

export interface RenewRequest {
  type: 'connection.renew'
  name: OAuthProvider
}

export function parseRenewRequest(value: unknown): RenewRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('name')) return undefined
  const { type, name } = value as Record<string, unknown>
  if (type !== 'connection.renew') return undefined
  return OAUTH_PROVIDERS.find((provider) => provider === name) === undefined ? undefined : { type, name: name as OAuthProvider }
}
