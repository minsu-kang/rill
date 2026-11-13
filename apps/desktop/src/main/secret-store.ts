import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import Value from 'typebox/value'
import { ensurePrivateDir, writeFileAtomic, type FsLike } from './config-store'
import {
  AUTH_TYPES,
  CONNECTION_KINDS,
  ConnectionNameSchema,
  MAX_SECRET_LENGTH,
  OAUTH_PROVIDERS,
  SlackSummarySchema,
  PROVIDER_IDS,
  findNameCollision,
  isAccountText,
  isOAuthApp,
  type AuthType,
  type ConnectionKind,
  type ConnectionSummary,
  type OAuthProvider,
  type ProviderId,
  type SlackSummary,
  hasWholeText,
  isReservedConnectionName,
} from '../shared/host-api'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface StoredConnection {
  name: string
  kind: ConnectionKind
  secret: string
  authType?: AuthType
  slack?: SlackSummary
}

export interface OAuthAppRecord {
  clientId: string
  clientSecret?: string
}

export interface OAuthAccountRecord {
  refreshToken?: string
  needsReconnect?: true
  scope: string
  account?: string
  connectedAt: number
}

export interface OAuthRecords {
  apps: Partial<Record<OAuthProvider, OAuthAppRecord>>
  accounts: Partial<Record<OAuthProvider, OAuthAccountRecord>>
}

export interface SecretStore {
  encryptionAvailable(): boolean
  unreadable(): Promise<boolean>
  configuredProviders(): Promise<ProviderId[]>
  getProviderKey(provider: ProviderId): Promise<string | undefined>
  setProviderKey(provider: ProviderId, value: string): Promise<boolean>
  clearProviderKey(provider: ProviderId): Promise<boolean>
  listConnections(): Promise<ConnectionSummary[]>
  getConnections(): Promise<StoredConnection[]>
  setConnection(connection: StoredConnection, options?: SetConnectionOptions): Promise<boolean>
  removeConnection(name: string): Promise<boolean>
  getOAuth(): Promise<OAuthRecords>
  setOAuthApp(provider: OAuthProvider, app: OAuthAppRecord): Promise<boolean>
  clearOAuthApp(provider: OAuthProvider): Promise<boolean>
  setOAuthAccount(provider: OAuthProvider, account: OAuthAccountRecord): Promise<boolean>
  clearOAuthAccount(provider: OAuthProvider): Promise<boolean>
}

export interface SetConnectionOptions {
  mayReplace?: (existing: StoredConnection) => boolean
}

export type SecretStoreErrorReason = 'no_keychain' | 'name_collision' | 'invalid_value' | 'write_failed'

export class SecretStoreError extends Error {
  readonly reason: SecretStoreErrorReason

  constructor(reason: SecretStoreErrorReason) {
    super(reason)
    this.name = 'SecretStoreError'
    this.reason = reason
  }
}

interface State {
  providerKeys: Map<ProviderId, string>
  connections: StoredConnection[]
  oauth: { apps: Map<OAuthProvider, OAuthAppRecord>; accounts: Map<OAuthProvider, OAuthAccountRecord> }
}

interface Loaded {
  state: State
  unreadable: boolean
}

const UNREADABLE_LOG = 'the secrets file could not be read'
const MAX_BACKUPS = 10
const MAX_HTTP_SECRET_LENGTH = 8192
const MAX_REFRESH_TOKEN_LENGTH = 4096
const MAX_SCOPE_LENGTH = 2000
const LEGACY_ACCOUNT_KINDS: readonly string[] = ['google', 'microsoft']

function emptyState(): State {
  return { providerKeys: new Map(), connections: [], oauth: { apps: new Map(), accounts: new Map() } }
}

function validSecret(value: unknown, limit = MAX_SECRET_LENGTH): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= limit && !value.includes('\u0000')
}

function secretLimit(kind: ConnectionKind): number {
  return kind === 'http' ? MAX_HTTP_SECRET_LENGTH : MAX_SECRET_LENGTH
}

function isAuthType(value: unknown): value is AuthType {
  return typeof value === 'string' && (AUTH_TYPES as readonly string[]).includes(value)
}

function validSlack(value: unknown): boolean {
  return Value.Check(SlackSummarySchema, value) && hasWholeText(value.channel) && hasWholeText(value.account)
}

function validConnection(connection: { name?: unknown; kind?: unknown; secret?: unknown; authType?: unknown; slack?: unknown }): boolean {
  if (typeof connection.name !== 'string' || !Value.Check(ConnectionNameSchema, connection.name) || !isKind(connection.kind)) return false
  if (!validSecret(connection.secret, secretLimit(connection.kind))) return false
  if (connection.slack !== undefined && (connection.kind !== 'slack' || !validSlack(connection.slack))) return false
  return connection.authType === undefined || (connection.kind === 'http' && isAuthType(connection.authType))
}

function summary({ name, kind, authType, slack }: StoredConnection): ConnectionSummary {
  return { name, kind, ...(authType === undefined ? {} : { authType }), ...(slack === undefined ? {} : { slack: { ...slack } }) }
}

function sameSlack(left: SlackSummary | undefined, right: SlackSummary | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

function isKind(value: unknown): value is ConnectionKind {
  return typeof value === 'string' && (CONNECTION_KINDS as readonly string[]).includes(value)
}

function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function validOAuthApp(provider: OAuthProvider, value: unknown): value is OAuthAppRecord {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['clientId', 'clientSecret'])) return false
  const { clientId, clientSecret } = value
  if (typeof clientId !== 'string' || (clientSecret !== undefined && typeof clientSecret !== 'string')) return false
  return isOAuthApp({ provider, clientId, ...(clientSecret === undefined ? {} : { clientSecret }) })
}

function validOAuthAccount(value: unknown): value is OAuthAccountRecord {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['refreshToken', 'needsReconnect', 'scope', 'account', 'connectedAt'])) return false
  const { refreshToken, needsReconnect, scope, account, connectedAt } = value
  if ((refreshToken === undefined) === (needsReconnect === undefined)) return false
  if (refreshToken !== undefined && !validSecret(refreshToken, MAX_REFRESH_TOKEN_LENGTH)) return false
  if (needsReconnect !== undefined && needsReconnect !== true) return false
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > MAX_SCOPE_LENGTH || scope.includes('\u0000')) return false
  if (account !== undefined && !isAccountText(account)) return false
  return typeof connectedAt === 'number' && Number.isSafeInteger(connectedAt) && connectedAt >= 0
}

function parseOAuth(value: unknown, state: State): void {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['apps', 'accounts']) || !isPlainObject(value.apps) || !isPlainObject(value.accounts)) throw new Error('shape')
  for (const [provider, app] of Object.entries(value.apps)) {
    if (!isOAuthProvider(provider) || !validOAuthApp(provider, app)) throw new Error('shape')
    state.oauth.apps.set(provider, { clientId: app.clientId, ...(app.clientSecret === undefined ? {} : { clientSecret: app.clientSecret }) })
  }
  for (const [provider, account] of Object.entries(value.accounts)) {
    if (!isOAuthProvider(provider) || !state.oauth.apps.has(provider) || !validOAuthAccount(account)) throw new Error('shape')
    state.oauth.accounts.set(provider, copyAccount(account))
  }
}

function copyAccount(account: OAuthAccountRecord): OAuthAccountRecord {
  return {
    ...(account.refreshToken === undefined ? {} : { refreshToken: account.refreshToken }),
    ...(account.needsReconnect === undefined ? {} : { needsReconnect: true as const }),
    scope: account.scope,
    ...(account.account === undefined ? {} : { account: account.account }),
    connectedAt: account.connectedAt,
  }
}

function hasOAuth(state: State): boolean {
  return state.oauth.apps.size > 0 || state.oauth.accounts.size > 0
}

function parseState(text: string): State {
  const data: unknown = JSON.parse(text)
  const version = typeof data === 'object' && data !== null ? (data as { version?: unknown }).version : undefined
  if (version !== 1 && version !== 2) throw new Error('shape')
  const { providerKeys, connections, oauth } = data as { providerKeys?: unknown; connections?: unknown; oauth?: unknown }
  if (!Array.isArray(providerKeys) || !Array.isArray(connections)) throw new Error('shape')
  if ((version === 2) !== (oauth !== undefined)) throw new Error('shape')
  const state = emptyState()
  for (const entry of providerKeys as Array<{ provider?: unknown; value?: unknown }>) {
    if (!isProvider(entry?.provider) || !validSecret(entry.value)) throw new Error('shape')
    state.providerKeys.set(entry.provider, entry.value)
  }
  for (const entry of connections as Array<{ name?: unknown; kind?: unknown; secret?: unknown; authType?: unknown; slack?: unknown }>) {
    if (LEGACY_ACCOUNT_KINDS.includes(entry?.kind as string)) continue
    if (!validConnection(entry ?? {})) throw new Error('shape')
    state.connections.push({
      name: entry.name as string,
      kind: entry.kind as ConnectionKind,
      secret: entry.secret as string,
      ...(entry.authType === undefined ? {} : { authType: entry.authType as AuthType }),
      ...(entry.slack === undefined ? {} : { slack: entry.slack as SlackSummary }),
    })
  }
  if (version === 2) parseOAuth(oauth, state)
  return state
}

function oauthRecord<T>(map: Map<OAuthProvider, T>): Partial<Record<OAuthProvider, T>> {
  return Object.fromEntries(OAUTH_PROVIDERS.filter((id) => map.has(id)).map((id) => [id, map.get(id)]))
}

function serializeState(state: State): string {
  const base = {
    providerKeys: PROVIDER_IDS.filter((id) => state.providerKeys.has(id)).map((provider) => ({ provider, value: state.providerKeys.get(provider) })),
    connections: state.connections,
  }
  if (!hasOAuth(state)) return JSON.stringify({ version: 1, ...base })
  return JSON.stringify({ version: 2, ...base, oauth: { apps: oauthRecord(state.oauth.apps), accounts: oauthRecord(state.oauth.accounts) } })
}

export function createSecretStore(deps: { dir: string; safeStorage: SafeStorageLike; fs?: FsLike; log?: (message: string) => void }): SecretStore {
  const fs = deps.fs ?? fsp
  const path = join(deps.dir, 'secrets.bin')
  const safeStorage = deps.safeStorage
  let warned = false
  let queue: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  async function read(): Promise<Loaded> {
    if (!safeStorage.isEncryptionAvailable()) return { state: emptyState(), unreadable: false }
    let bytes: Buffer
    try {
      bytes = await fs.readFile(path)
    } catch {
      return { state: emptyState(), unreadable: false }
    }
    try {
      const state = parseState(safeStorage.decryptString(bytes))
      return { state, unreadable: false }
    } catch {
      if (!warned) {
        warned = true
        deps.log?.(UNREADABLE_LOG)
      }
      return { state: emptyState(), unreadable: true }
    }
  }

  async function keepUnreadable(): Promise<void> {
    for (let index = 0; index < MAX_BACKUPS; index++) {
      const backup = index === 0 ? `${path}.bak` : `${path}.bak.${index}`
      if (await fs.lstat(backup).then(() => true, () => false)) continue
      await fs.rename(path, backup)
      return
    }
    throw new Error('no free backup name')
  }

  async function mutate(change: (state: State) => boolean): Promise<boolean> {
    if (!safeStorage.isEncryptionAvailable()) throw new SecretStoreError('no_keychain')
    return serial(async () => {
      const loaded = await read()
      const changed = change(loaded.state)
      if (!changed && !loaded.unreadable) return false
      try {
        await ensurePrivateDir(fs, deps.dir)
        if (loaded.unreadable) await keepUnreadable()
        await writeFileAtomic(fs, path, safeStorage.encryptString(serializeState(loaded.state)), 0o600)
      } catch {
        throw new SecretStoreError('write_failed')
      }
      warned = false
      return changed
    })
  }

  return {
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    unreadable: () => serial(async () => (await read()).unreadable),
    configuredProviders: () => serial(async () => {
      const { providerKeys } = (await read()).state
      return PROVIDER_IDS.filter((id) => providerKeys.has(id))
    }),
    getProviderKey: (provider) => serial(async () => (await read()).state.providerKeys.get(provider)),
    setProviderKey: (provider, value) => {
      if (!validSecret(value)) return Promise.reject(new SecretStoreError('invalid_value'))
      return mutate((state) => {
        if (state.providerKeys.get(provider) === value) return false
        state.providerKeys.set(provider, value)
        return true
      })
    },
    clearProviderKey: (provider) => mutate((state) => state.providerKeys.delete(provider)),
    listConnections: () => serial(async () => (await read()).state.connections.map(summary)),
    getConnections: () => serial(async () => (await read()).state.connections.map((connection) => ({ ...connection }))),
    setConnection: (connection, options) => {
      if (!validConnection(connection)) return Promise.reject(new SecretStoreError('invalid_value'))
      if (isReservedConnectionName(connection.name)) return Promise.reject(new SecretStoreError('name_collision'))
      return mutate((state) => {
        const existing = state.connections.findIndex((entry) => entry.name === connection.name)
        if (existing === -1) {
          if (findNameCollision([...state.connections.map((entry) => entry.name), connection.name]) !== undefined) throw new SecretStoreError('name_collision')
          state.connections.push({ ...connection })
          return true
        }
        const current = state.connections[existing]!
        if (options?.mayReplace?.(current) === false) throw new SecretStoreError('name_collision')
        if (current.kind === connection.kind && current.secret === connection.secret && current.authType === connection.authType && sameSlack(current.slack, connection.slack)) return false
        state.connections[existing] = { ...connection }
        return true
      })
    },
    removeConnection: (name) =>
      mutate((state) => {
        const index = state.connections.findIndex((entry) => entry.name === name)
        if (index === -1) return false
        state.connections.splice(index, 1)
        return true
      }),
    getOAuth: () =>
      serial(async () => {
        const { apps, accounts } = (await read()).state.oauth
        return {
          apps: Object.fromEntries([...apps].map(([provider, app]) => [provider, { ...app }])),
          accounts: Object.fromEntries([...accounts].map(([provider, account]) => [provider, copyAccount(account)])),
        }
      }),
    setOAuthApp: (provider, app) => {
      if (!isOAuthProvider(provider) || !validOAuthApp(provider, app)) return Promise.reject(new SecretStoreError('invalid_value'))
      return mutate((state) => {
        state.oauth.apps.set(provider, { clientId: app.clientId, ...(app.clientSecret === undefined ? {} : { clientSecret: app.clientSecret }) })
        state.oauth.accounts.delete(provider)
        return true
      })
    },
    clearOAuthApp: (provider) =>
      mutate((state) => {
        const removedApp = state.oauth.apps.delete(provider)
        const removedAccount = state.oauth.accounts.delete(provider)
        return removedApp || removedAccount
      }),
    setOAuthAccount: (provider, account) => {
      if (!isOAuthProvider(provider) || !validOAuthAccount(account)) return Promise.reject(new SecretStoreError('invalid_value'))
      return mutate((state) => {
        if (!state.oauth.apps.has(provider)) throw new SecretStoreError('invalid_value')
        const current = state.oauth.accounts.get(provider)
        if (current !== undefined && JSON.stringify(copyAccount(current)) === JSON.stringify(copyAccount(account))) return false
        state.oauth.accounts.set(provider, copyAccount(account))
        return true
      })
    },
    clearOAuthAccount: (provider) => mutate((state) => state.oauth.accounts.delete(provider)),
  }
}
