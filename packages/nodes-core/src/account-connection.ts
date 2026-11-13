import { isSlackBotSecret } from './slack-connection'
import type { ConnectionResolver } from './types'

export const ACCOUNT_KINDS = ['google', 'microsoft'] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]

const LABELS: Readonly<Record<AccountKind, string>> = { google: 'Google', microsoft: 'Microsoft' }
const ACCESS_TOKEN = /^[A-Za-z0-9\-._~+/]{8,8192}={0,3}$/

export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(value)
}

export function accountLabel(kind: AccountKind): string {
  return LABELS[kind]
}

export function accessTokenOf(connections: ConnectionResolver, name: string, kind: AccountKind): string {
  const secret = connections.get(name)
  if (secret === undefined) throw new Error(`unknown connection: ${name}`)
  const actual = connections.kindOf?.(name)
  if (actual !== undefined && actual !== kind) throw new Error(`connection ${name} is a ${actual} connection, not a ${kind} connection`)
  if (isSlackBotSecret(secret)) throw new Error(`connection ${name} is a Slack connection`)
  if (!ACCESS_TOKEN.test(secret)) throw new Error('the connection does not hold an access token')
  return secret
}
