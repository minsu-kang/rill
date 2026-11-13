import Value from 'typebox/value'
import {
  CONNECTION_KINDS,
  ConnectionNameSchema,
  HostError,
  KeyVerdictSchema,
  MAX_FILE_NAME_LENGTH,
  MAX_FOLDERS,
  ModelSchema,
  PROVIDER_IDS,
  SecretValueSchema,
  SetProviderKeyOptionsSchema,
  findNameCollision,
  isByteInput,
  type AttachmentRef,
  type EngineInfo,
  type EngineStatus,
  type HostApi,
  type KeyVerdict,
  type ProviderId,
  type SetProviderKeyOptions,
  type Settings,
} from '../shared/host-api'

export interface FakeHostState {
  settings: Settings
  engine: EngineStatus
  attachments: AttachmentRef[]
  folderPicks: Array<string | undefined>
  filePicks: Array<string | undefined>
}

export interface FakeHostSnapshot extends FakeHostState {
  statusListeners: number
  restartCalls: number
}

export type FakeHost = HostApi & { state(): FakeHostSnapshot; setEngine(status: EngineStatus): void }

export type FakeKeyCheck = (provider: ProviderId, key: string) => KeyVerdict | Promise<KeyVerdict>

export interface FakeHostOptions {
  restartDelayMs?: number
  info?: EngineInfo
  keyChecks?: FakeKeyCheck
}

const MIB = 1024 * 1024
const MAX_FILES = 500
const MAX_TOTAL_BYTES = 512 * MIB
const MAX_CONNECTIONS = 200
const FAKE_FILE_BYTES = 2048

const TYPES: Readonly<Record<string, { mediaType: AttachmentRef['mediaType']; limit: number }>> = {
  pdf: { mediaType: 'application/pdf', limit: 20 * MIB },
  png: { mediaType: 'image/png', limit: 3_932_160 },
  jpg: { mediaType: 'image/jpeg', limit: 3_932_160 },
  jpeg: { mediaType: 'image/jpeg', limit: 3_932_160 },
  gif: { mediaType: 'image/gif', limit: 3_932_160 },
  webp: { mediaType: 'image/webp', limit: 3_932_160 },
  txt: { mediaType: 'text/plain', limit: MIB },
  csv: { mediaType: 'text/csv', limit: MIB },
  md: { mediaType: 'text/markdown', limit: MIB },
  markdown: { mediaType: 'text/markdown', limit: MIB },
}

const SAMPLE_FOLDERS = ['/Users/demo/Receipts', '/Users/demo/Documents', '/Users/demo/Downloads', '/Users/demo/Projects']
const SAMPLE_FILES = ['/Users/demo/Receipts/receipt-001.pdf', '/Users/demo/Receipts/receipt-002.png', '/Users/demo/Receipts/notes.txt']

export const FAKE_ENGINE_INFO: EngineInfo = { url: 'ws://127.0.0.1:1/', token: 'fake-engine-token', protocol: 1 }

export function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    allowedFolders: [],
    provider: 'anthropic',
    openAtLogin: false,
    configuredProviders: [],
    connections: [],
    encryptionAvailable: true,
    ...overrides,
  }
}

function invalid(): HostError {
  return new HostError('INVALID_SETTINGS')
}

function rejected(): HostError {
  return new HostError('ATTACHMENT_REJECTED')
}

function fileTypeOf(name: string): { name: string; type: (typeof TYPES)[string] } {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = Array.from(base)
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
  const dot = cleaned.lastIndexOf('.')
  const type = dot > 0 ? TYPES[cleaned.slice(dot + 1).toLowerCase()] : undefined
  if (type === undefined || cleaned.length > MAX_FILE_NAME_LENGTH) throw rejected()
  return { name: cleaned, type }
}

export function createFakeHost(init: Partial<FakeHostState> = {}, options: FakeHostOptions = {}): FakeHost {
  let settings = structuredClone(init.settings ?? fakeSettings())
  let engine: EngineStatus = { ...(init.engine ?? { state: 'running', restarts: 0 }) }
  const attachments: AttachmentRef[] = structuredClone(init.attachments ?? [])
  const folderPicks = [...(init.folderPicks ?? [])]
  const filePicks = [...(init.filePicks ?? [])]
  const pickedFolders = new Set<string>()
  const pickedFiles = new Set<string>()
  const listeners = new Set<(status: EngineStatus) => void>()
  const delay = options.restartDelayMs ?? 150
  const info = options.info ?? FAKE_ENGINE_INFO
  const keyChecks: FakeKeyCheck = options.keyChecks ?? (() => ({ status: 'valid' }))
  let restartCalls = 0
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let folderSerial = 0
  let fileSerial = 0
  let attachmentSerial = 0

  function publish(next: EngineStatus): void {
    engine = { ...next }
    for (const listener of [...listeners]) {
      try {
        listener({ ...engine })
      } catch {
        continue
      }
    }
  }

  function restart(): Promise<void> {
    restartCalls += 1
    if (restartTimer !== undefined) clearTimeout(restartTimer)
    publish({ state: 'restarting', restarts: engine.restarts })
    return new Promise<void>((resolve) => {
      restartTimer = setTimeout(() => {
        restartTimer = undefined
        publish({ state: 'running', restarts: engine.restarts + 1 })
        resolve()
      }, delay)
    })
  }

  function engineChanged(): void {
    void restart()
  }

  function requireKeychain(): void {
    if (!settings.encryptionAvailable) throw new HostError('NO_KEYCHAIN')
  }

  function snapshot(): Settings {
    return structuredClone(settings)
  }

  function addAttachment(name: string, bytes: number, limit: number, type: AttachmentRef['mediaType']): AttachmentRef {
    if (bytes === 0 || bytes > limit) throw rejected()
    const total = attachments.reduce((sum, item) => sum + item.bytes, 0)
    if (attachments.length >= MAX_FILES || total + bytes > MAX_TOTAL_BYTES) throw rejected()
    attachmentSerial += 1
    const ref: AttachmentRef = { id: `att-fake-${String(attachmentSerial).padStart(6, '0')}`, mediaType: type, name, bytes }
    attachments.push(ref)
    return { ...ref }
  }

  return {
    engine: {
      info: async () => ({ ...info }),
      status: async () => ({ ...engine }),
      restart,
      onStatus(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    settings: {
      get: async () => snapshot(),
      async update(patch) {
        const before = settings
        const next = structuredClone(settings)
        if (patch.allowedFolders !== undefined) {
          const folders = [...new Set(patch.allowedFolders)]
          if (folders.length > MAX_FOLDERS) throw invalid()
          const known = new Set(before.allowedFolders)
          if (folders.some((folder) => !known.has(folder) && !pickedFolders.has(folder))) throw invalid()
          next.allowedFolders = folders
        }
        if (patch.provider !== undefined) next.provider = patch.provider
        if (patch.model !== undefined) {
          if (patch.model === null) delete next.model
          else if (Value.Check(ModelSchema, patch.model)) next.model = patch.model
          else throw invalid()
        }
        if (next.provider !== 'anthropic' && next.model === undefined) throw invalid()
        if (patch.openAtLogin !== undefined) next.openAtLogin = patch.openAtLogin
        settings = next
        const changed =
          before.provider !== next.provider ||
          before.model !== next.model ||
          before.allowedFolders.length !== next.allowedFolders.length ||
          before.allowedFolders.some((folder, index) => folder !== next.allowedFolders[index])
        if (changed) engineChanged()
        return snapshot()
      },
    },
    secrets: {
      async setProviderKey(provider: ProviderId, value: string, options?: SetProviderKeyOptions) {
        if (
          !PROVIDER_IDS.includes(provider) ||
          !Value.Check(SecretValueSchema, value) ||
          (options !== undefined && !Value.Check(SetProviderKeyOptionsSchema, options))
        ) {
          throw new HostError('INVALID_ARGUMENTS')
        }
        requireKeychain()
        const verdict = await keyChecks(provider, value)
        if (!Value.Check(KeyVerdictSchema, verdict)) throw new HostError('INTERNAL')
        if (verdict.status === 'invalid' && verdict.reason === 'malformed') throw new HostError('KEY_MALFORMED')
        if (verdict.status === 'invalid' && options?.saveAnyway !== true) throw new HostError('KEY_INVALID')
        if (!settings.configuredProviders.includes(provider)) settings.configuredProviders = [...settings.configuredProviders, provider]
        if (settings.provider === provider) engineChanged()
        return { verdict }
      },
      async clearProviderKey(provider) {
        requireKeychain()
        if (!settings.configuredProviders.includes(provider)) return
        settings.configuredProviders = settings.configuredProviders.filter((item) => item !== provider)
        if (settings.provider === provider) engineChanged()
      },
      async setConnection(connection) {
        requireKeychain()
        if (
          !Value.Check(ConnectionNameSchema, connection.name) ||
          !(CONNECTION_KINDS as readonly string[]).includes(connection.kind) ||
          !Value.Check(SecretValueSchema, connection.secret)
        ) {
          throw new HostError('INVALID_ARGUMENTS')
        }
        if (findNameCollision([...settings.connections.map((entry) => entry.name), connection.name]) !== undefined) throw new HostError('NAME_COLLISION')
        const known = settings.connections.some((entry) => entry.name === connection.name)
        if (!known && settings.connections.length >= MAX_CONNECTIONS) throw new HostError('INVALID_ARGUMENTS')
        settings.connections = [...settings.connections.filter((entry) => entry.name !== connection.name), { name: connection.name, kind: connection.kind }]
        engineChanged()
      },
      async removeConnection(name) {
        requireKeychain()
        if (!settings.connections.some((entry) => entry.name === name)) return
        settings.connections = settings.connections.filter((entry) => entry.name !== name)
        engineChanged()
      },
    },
    dialogs: {
      async pickFolder() {
        const path = folderPicks.length > 0 ? folderPicks.shift() : (SAMPLE_FOLDERS[folderSerial++] ?? `/Users/demo/Folder-${folderSerial}`)
        if (path !== undefined) pickedFolders.add(path)
        return path
      },
      async pickFile() {
        const path = filePicks.length > 0 ? filePicks.shift() : (SAMPLE_FILES[fileSerial++] ?? `/Users/demo/Receipts/file-${fileSerial}.txt`)
        if (path !== undefined) pickedFiles.add(path)
        return path
      },
    },
    attachments: {
      async addFromPath(path) {
        if (!pickedFiles.has(path)) throw new HostError('INVALID_ARGUMENTS')
        const { name, type } = fileTypeOf(path)
        return addAttachment(name, FAKE_FILE_BYTES, type.limit, type.mediaType)
      },
      async addFromBytes(input) {
        if (typeof input.name !== 'string' || !isByteInput(input.bytes)) throw new HostError('INVALID_ARGUMENTS')
        const { name, type } = fileTypeOf(input.name)
        return addAttachment(name, input.bytes.byteLength, type.limit, type.mediaType)
      },
    },
    app: { quit: async () => undefined },
    state: () => ({
      settings: snapshot(),
      engine: { ...engine },
      attachments: structuredClone(attachments),
      folderPicks: [...folderPicks],
      filePicks: [...filePicks],
      statusListeners: listeners.size,
      restartCalls,
    }),
    setEngine: publish,
  }
}
