import { ATTACHMENT_EXTENSIONS, AttachmentError, type AttachmentStore } from './attachments'
import { ConfigError, type ConfigStore } from './config-store'
import type { EngineSupervisor } from './engine-supervisor'
import { SecretStoreError, type SecretStore } from './secret-store'
import {
  CHANNELS,
  HostError,
  validateArgs,
  validateResult,
  type Channel,
  type ProviderId,
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
  supervisor: Pick<EngineSupervisor, 'info' | 'restart'>
  attachments: AttachmentStore
  dialog: DialogLike
  app: AppLike
  loginItem: { set(enabled: boolean): void }
  log?: (message: string) => void
}

export type IpcHandler = (args: unknown) => Promise<unknown>

const MAX_PICKED = 100

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

export function createIpcHandlers(deps: IpcDeps): Record<Channel, IpcHandler> {
  const picked = new Set<string>()

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
      configuredProviders: await deps.secrets.configuredProviders(),
      connections: await deps.secrets.listConnections(),
      encryptionAvailable: deps.secrets.encryptionAvailable(),
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
    [CHANNELS.engineRestart]: async () => {
      await deps.supervisor.restart()
    },
    [CHANNELS.settingsGet]: currentSettings,
    [CHANNELS.settingsUpdate]: async (patch: SettingsPatch) => {
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
    [CHANNELS.secretsSetProviderKey]: async ({ provider, value }: { provider: ProviderId; value: string }) => {
      await keyChanged(provider, await deps.secrets.setProviderKey(provider, value))
    },
    [CHANNELS.secretsClearProviderKey]: async ({ provider }: { provider: ProviderId }) => {
      await keyChanged(provider, await deps.secrets.clearProviderKey(provider))
    },
    [CHANNELS.secretsSetConnection]: async (connection: { name: string; kind: 'slack' | 'http' | 'webhookSecret'; secret: string }) => {
      if (await deps.secrets.setConnection(connection)) restartEngine()
    },
    [CHANNELS.secretsRemoveConnection]: async ({ name }: { name: string }) => {
      if (await deps.secrets.removeConnection(name)) restartEngine()
    },
    [CHANNELS.dialogsPickFolder]: () => pick(['openDirectory', 'createDirectory']),
    [CHANNELS.dialogsPickFile]: async ({ kind }: { kind: 'any' | 'attachment' }) => {
      const path = await pick(['openFile'], kind === 'attachment' ? [{ name: 'Attachments', extensions: [...ATTACHMENT_EXTENSIONS] }] : undefined)
      if (path !== undefined) {
        if (picked.size >= MAX_PICKED) picked.delete(picked.values().next().value as string)
        picked.add(path)
      }
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
        throw toHostError(error)
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

