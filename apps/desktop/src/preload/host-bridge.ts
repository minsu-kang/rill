import {
  CHANNELS,
  ENGINE_STATUS_EVENT,
  HostError,
  hostErrorCode,
  validateArgs,
  validateResult,
  validateStatus,
  type Channel,
  type EngineStatus,
  type HostApi,
} from '../shared/host-api'

type StatusHandler = (event: unknown, payload: unknown) => void

export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, handler: StatusHandler): unknown
  removeListener(channel: string, handler: StatusHandler): unknown
}

export function createHostApi(ipc: IpcLike): HostApi {
  async function call<T>(channel: Channel, ...args: [] | [unknown]): Promise<T> {
    if (!validateArgs(channel, args[0])) throw new HostError('INVALID_ARGUMENTS')
    let result: unknown
    try {
      result = await ipc.invoke(channel, ...args)
    } catch (error) {
      throw new HostError(hostErrorCode(error))
    }
    if (!validateResult(channel, result)) throw new HostError('INTERNAL')
    return result as T
  }

  return {
    engine: {
      info: () => call(CHANNELS.engineInfo),
      restart: () => call(CHANNELS.engineRestart),
      onStatus(listener: (status: EngineStatus) => void) {
        const handler: StatusHandler = (_event, payload) => {
          if (validateStatus(payload)) listener(payload)
        }
        ipc.on(ENGINE_STATUS_EVENT, handler)
        let subscribed = true
        return () => {
          if (!subscribed) return
          subscribed = false
          ipc.removeListener(ENGINE_STATUS_EVENT, handler)
        }
      },
    },
    settings: {
      get: () => call(CHANNELS.settingsGet),
      update: (patch) => call(CHANNELS.settingsUpdate, patch),
    },
    secrets: {
      setProviderKey: (provider, value) => call(CHANNELS.secretsSetProviderKey, { provider, value }),
      clearProviderKey: (provider) => call(CHANNELS.secretsClearProviderKey, { provider }),
      setConnection: (connection) => call(CHANNELS.secretsSetConnection, { name: connection.name, kind: connection.kind, secret: connection.secret }),
      removeConnection: (name) => call(CHANNELS.secretsRemoveConnection, { name }),
    },
    dialogs: {
      pickFolder: () => call(CHANNELS.dialogsPickFolder),
      pickFile: (kind) => call(CHANNELS.dialogsPickFile, { kind }),
    },
    attachments: {
      addFromPath: (path) => call(CHANNELS.attachmentsAddFromPath, { path }),
      addFromBytes: (input) => call(CHANNELS.attachmentsAddFromBytes, { name: input.name, bytes: input.bytes }),
    },
    app: { quit: () => call(CHANNELS.appQuit) },
  }
}
