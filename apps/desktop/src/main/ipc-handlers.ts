import { ATTACHMENT_EXTENSIONS, AttachmentError, type AttachmentStore } from './attachments'
import { ConfigError, normalizeFolder, type ConfigStore } from './config-store'
import type { EngineSupervisor } from './engine-supervisor'
import type { KeyChecker } from './key-check'
import { SecretStoreError, type SecretStore } from './secret-store'
import type { SlackChecker } from './slack-check'
import {
  CHANNELS,
  HostError,
  isKeyVerdict,
  isSlackVerdict,
  encodeCustomAuth,
  encodeSlackBot,
  findNameCollision,
  foldName,
  slackAccountText,
  validateArgs,
  validateResult,
  type Channel,
  type CustomAuth,
  type ProviderId,
  type SetProviderKeyOptions,
  type SetSlackBotOptions,
  type Settings,
  type SettingsPatch,
} from '../shared/host-api'

export interface OpenDialogOptionsLike {
  properties: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface DialogLike {
  showOpenDialog(options: OpenDialogOptionsLike): Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface AppLike {
  quit(): void
}

export interface IpcDeps {
  config: ConfigStore
  secrets: SecretStore
  supervisor: Pick<EngineSupervisor, 'info' | 'restart' | 'status'>
  attachments: Pick<AttachmentStore, 'addFromPath' | 'addFromBytes'>
  dialog: DialogLike
  app: AppLike
  loginItem: { set(enabled: boolean): void }
  keyCheck: KeyChecker
  slackCheck: SlackChecker
  log?: (message: string) => void
}

export type IpcHandler = (args: unknown) => Promise<unknown>

const MAX_PICKED = 100

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error'
  const reason = (error as { reason?: unknown }).reason
  return typeof reason === 'string' ? `${error.name}:${reason}` : error.name
}

export function toHostError(error: unknown): HostError {
  if (error instanceof HostError) return error
  if (error instanceof ConfigError) return new HostError('INVALID_SETTINGS')
  if (error instanceof SecretStoreError) {
    if (error.reason === 'no_keychain') return new HostError('NO_KEYCHAIN')
    if (error.reason === 'name_collision') return new HostError('NAME_COLLISION')
    if (error.reason === 'invalid_value') return new HostError('INVALID_ARGUMENTS')
    return new HostError('INTERNAL')
  }
  if (error instanceof AttachmentError) return new HostError(error.reason === 'io' ? 'INTERNAL' : 'ATTACHMENT_REJECTED')
  return new HostError('INTERNAL')
}

function remember(set: Set<string>, value: string): void {
  if (set.size >= MAX_PICKED && !set.has(value)) set.delete(set.values().next().value as string)
  set.add(value)
}

function pickedFolder(path: string): string | undefined {
  try {
    return normalizeFolder(path)
  } catch {
    return undefined
  }
}

export function createIpcHandlers(deps: IpcDeps): Record<Channel, IpcHandler> {
  const picked = new Set<string>()
  const pickedFolders = new Set<string>()
  const keyGenerations = new Map<ProviderId, number>()
  const slackGenerations = new Map<string, number>()

  function supersede(provider: ProviderId): number {
    const generation = (keyGenerations.get(provider) ?? 0) + 1
    keyGenerations.set(provider, generation)
    return generation
  }

  function supersedeSlack(name: string): number {
    const key = foldName(name)
    const generation = (slackGenerations.get(key) ?? 0) + 1
    slackGenerations.set(key, generation)
    return generation
  }

  async function requireFreeSlackName(name: string): Promise<void> {
    const existing = await deps.secrets.listConnections()
    if (findNameCollision([...existing.map((entry) => entry.name), name]) !== undefined) throw new HostError('NAME_COLLISION')
    const same = existing.find((entry) => entry.name === name)
    if (same !== undefined && same.kind !== 'slack') throw new HostError('NAME_COLLISION')
  }

  function restartEngine(): void {
    deps.supervisor.restart().catch(() => deps.log?.('engine restart failed'))
  }

  async function currentSettings(): Promise<Settings> {
    const config = await deps.config.get()
    return {
      allowedFolders: config.allowedFolders,
      provider: config.provider,
      ...(config.model === undefined ? {} : { model: config.model }),
      openAtLogin: config.openAtLogin,
      language: config.language,
      configuredProviders: await deps.secrets.configuredProviders(),
      connections: await deps.secrets.listConnections(),
      encryptionAvailable: deps.secrets.encryptionAvailable(),
      oauth: { available: false, accounts: [] },
    }
  }

  async function keyChanged(provider: ProviderId, changed: boolean): Promise<void> {
    if (changed && (await deps.config.get()).provider === provider) restartEngine()
  }

  async function pick(properties: string[], filters?: OpenDialogOptionsLike['filters']): Promise<string | undefined> {
    const result = await deps.dialog.showOpenDialog({ properties, ...(filters === undefined ? {} : { filters }) })
    return result.canceled ? undefined : result.filePaths[0]
  }

  const run: Record<Channel, (args: never) => Promise<unknown>> = {
    [CHANNELS.engineInfo]: () => deps.supervisor.info(),
    [CHANNELS.engineStatus]: async () => deps.supervisor.status(),
    [CHANNELS.engineRestart]: async () => {
      await deps.supervisor.restart()
    },
    [CHANNELS.settingsGet]: currentSettings,
    [CHANNELS.settingsUpdate]: async (patch: SettingsPatch) => {
      if (patch.allowedFolders !== undefined) {
        const known = new Set((await deps.config.get()).allowedFolders)
        for (const folder of patch.allowedFolders) {
          const normalized = normalizeFolder(folder)
          if (!known.has(normalized) && !pickedFolders.has(normalized)) throw new HostError('INVALID_SETTINGS')
        }
      }
      const { before, after } = await deps.config.update(patch)
      if (before.openAtLogin !== after.openAtLogin) deps.loginItem.set(after.openAtLogin)
      const engineChanged =
        before.provider !== after.provider ||
        before.model !== after.model ||
        before.allowedFolders.length !== after.allowedFolders.length ||
        before.allowedFolders.some((folder, index) => folder !== after.allowedFolders[index])
      if (engineChanged) restartEngine()
      return currentSettings()
    },
    [CHANNELS.secretsSetProviderKey]: async ({ provider, value, options }: { provider: ProviderId; value: string; options?: SetProviderKeyOptions }) => {
      if (!deps.secrets.encryptionAvailable()) throw new HostError('NO_KEYCHAIN')
      const generation = supersede(provider)
      const verdict = await deps.keyCheck(provider, value)
      if (keyGenerations.get(provider) !== generation) throw new HostError('SUPERSEDED')
      if (!isKeyVerdict(verdict)) throw new HostError('INTERNAL')
      if (verdict.status === 'invalid' && verdict.reason === 'malformed') throw new HostError('KEY_MALFORMED')
      if (verdict.status === 'invalid' && options?.saveAnyway !== true) throw new HostError('KEY_INVALID')
      await keyChanged(provider, await deps.secrets.setProviderKey(provider, value))
      return { verdict }
    },
    [CHANNELS.secretsClearProviderKey]: async ({ provider }: { provider: ProviderId }) => {
      supersede(provider)
      await keyChanged(provider, await deps.secrets.clearProviderKey(provider))
    },
    [CHANNELS.secretsSetConnection]: async (connection: { name: string; kind: 'slack' | 'http' | 'webhookSecret' | 'google' | 'microsoft'; secret: string }) => {
      if (await deps.secrets.setConnection(connection)) restartEngine()
    },
    [CHANNELS.secretsSetCustomConnection]: async ({ name, auth }: { name: string; auth: CustomAuth }) => {
      const connection = { name, kind: 'http' as const, secret: encodeCustomAuth(auth), authType: auth.type }
      if (await deps.secrets.setConnection(connection, { mayReplace: (existing) => existing.kind === 'http' && existing.authType !== undefined })) restartEngine()
    },
    [CHANNELS.secretsSetSlackBot]: async ({ name, token, channel, options }: { name: string; token: string; channel?: string; options?: SetSlackBotOptions }) => {
      if (!deps.secrets.encryptionAvailable()) throw new HostError('NO_KEYCHAIN')
      await requireFreeSlackName(name)
      const generation = supersedeSlack(name)
      const verdict = await deps.slackCheck(token)
      if (slackGenerations.get(foldName(name)) !== generation) throw new HostError('SUPERSEDED')
      if (!isSlackVerdict(verdict)) throw new HostError('INTERNAL')
      if (verdict.status === 'invalid' && options?.saveAnyway !== true) throw new HostError('TOKEN_INVALID')
      const account = slackAccountText(verdict)
      const connection = {
        name,
        kind: 'slack' as const,
        secret: encodeSlackBot({ token, ...(channel === undefined ? {} : { channel }) }),
        slack: { mode: 'bot' as const, confirmed: verdict.status === 'valid', ...(account === undefined ? {} : { account }), ...(channel === undefined ? {} : { channel }) },
      }
      if (await deps.secrets.setConnection(connection, { mayReplace: (existing) => existing.kind === 'slack' })) restartEngine()
      return { verdict }
    },
    [CHANNELS.oauthConnect]: async () => {
      throw new HostError('OAUTH_UNAVAILABLE')
    },
    [CHANNELS.oauthDisconnect]: async () => undefined,
    [CHANNELS.secretsRemoveConnection]: async ({ name }: { name: string }) => {
      supersedeSlack(name)
      if (await deps.secrets.removeConnection(name)) restartEngine()
    },
    [CHANNELS.dialogsPickFolder]: async () => {
      const path = await pick(['openDirectory', 'createDirectory'])
      const folder = path === undefined ? undefined : pickedFolder(path)
      if (folder !== undefined) remember(pickedFolders, folder)
      return path
    },
    [CHANNELS.dialogsPickFile]: async ({ kind }: { kind: 'any' | 'attachment' }) => {
      const path = await pick(['openFile'], kind === 'attachment' ? [{ name: 'Attachments', extensions: [...ATTACHMENT_EXTENSIONS] }] : undefined)
      if (path !== undefined) remember(picked, path)
      return path
    },
    [CHANNELS.attachmentsAddFromPath]: async ({ path }: { path: string }) => {
      if (!picked.has(path)) throw new HostError('INVALID_ARGUMENTS')
      return deps.attachments.addFromPath(path)
    },
    [CHANNELS.attachmentsAddFromBytes]: (input: { name: string; bytes: Uint8Array }) => deps.attachments.addFromBytes(input),
    [CHANNELS.appQuit]: async () => {
      deps.app.quit()
    },
  }

  const handlers = {} as Record<Channel, IpcHandler>
  for (const channel of Object.values(CHANNELS)) {
    handlers[channel] = async (args) => {
      if (!validateArgs(channel, args)) throw new HostError('INVALID_ARGUMENTS')
      let result: unknown
      try {
        result = await run[channel](args as never)
      } catch (error) {
        const failed = toHostError(error)
        if (failed.code === 'INTERNAL') deps.log?.(`${channel} failed: ${describeError(error)}`)
        throw failed
      }
      if (!validateResult(channel, result)) {
        deps.log?.(`result of ${channel} did not match its schema`)
        throw new HostError('INTERNAL')
      }
      return result
    }
  }
  return handlers
}

