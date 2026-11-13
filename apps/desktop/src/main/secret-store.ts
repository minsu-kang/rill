import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import Value from 'typebox/value'
import { ensurePrivateDir, writeFileAtomic, type FsLike } from './config-store'
import {
  AUTH_TYPES,
  CONNECTION_KINDS,
  ConnectionNameSchema,
  MAX_SECRET_LENGTH,
  SlackSummarySchema,
  PROVIDER_IDS,
  findNameCollision,
  type AuthType,
  type ConnectionKind,
  type ConnectionSummary,
  type ProviderId,
  type SlackSummary,
  hasWholeText,
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
}

interface Loaded {
  state: State
  unreadable: boolean
}

const UNREADABLE_LOG = 'the secrets file could not be read'
const MAX_BACKUPS = 10
const MAX_HTTP_SECRET_LENGTH = 8192

function emptyState(): State {
  return { providerKeys: new Map(), connections: [] }
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

function parseState(text: string): State {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== 1) throw new Error('shape')
  const { providerKeys, connections } = data as { providerKeys?: unknown; connections?: unknown }
  if (!Array.isArray(providerKeys) || !Array.isArray(connections)) throw new Error('shape')
  const state = emptyState()
  for (const entry of providerKeys as Array<{ provider?: unknown; value?: unknown }>) {
    if (!isProvider(entry?.provider) || !validSecret(entry.value)) throw new Error('shape')
    state.providerKeys.set(entry.provider, entry.value)
  }
  for (const entry of connections as Array<{ name?: unknown; kind?: unknown; secret?: unknown; authType?: unknown; slack?: unknown }>) {
    if (!validConnection(entry ?? {})) throw new Error('shape')
    state.connections.push({
      name: entry.name as string,
      kind: entry.kind as ConnectionKind,
      secret: entry.secret as string,
      ...(entry.authType === undefined ? {} : { authType: entry.authType as AuthType }),
      ...(entry.slack === undefined ? {} : { slack: entry.slack as SlackSummary }),
    })
  }
  return state
}

function serializeState(state: State): string {
  return JSON.stringify({
    version: 1,
    providerKeys: PROVIDER_IDS.filter((id) => state.providerKeys.has(id)).map((provider) => ({ provider, value: state.providerKeys.get(provider) })),
    connections: state.connections,
  })
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
  }
}
