import { AttachmentRefSchema, ProviderIdSchema, type AttachmentRef, type ProviderId } from '@rill/protocol'
import Type from 'typebox'
import Value from 'typebox/value'

export type { AttachmentRef, ProviderId }

const closed = { additionalProperties: false } as const

export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini', 'grok', 'meta']

export const PROVIDER_KEY_ENV: Readonly<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
  meta: 'META_API_KEY',
}

export const CONNECTION_KINDS = ['slack', 'http', 'webhookSecret'] as const
export const ConnectionKindSchema = Type.Union([Type.Literal('slack'), Type.Literal('http'), Type.Literal('webhookSecret')])
export type ConnectionKind = Type.Static<typeof ConnectionKindSchema>

export const MAX_FOLDERS = 50
export const MAX_NAME_LENGTH = 64
export const MAX_SECRET_LENGTH = 2000
export const MAX_PATH_LENGTH = 1024
export const MAX_FILE_NAME_LENGTH = 255
export const MAX_BYTES_INPUT = 21 * 1024 * 1024

const MODEL_PATTERN = '^[a-z0-9][a-z0-9._-]{1,63}$'
const NO_CONTROL = '^[^\\u0000-\\u001f\\u007f]+$'

export const ConnectionNameSchema = Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH, pattern: NO_CONTROL })
export const SecretValueSchema = Type.String({ minLength: 1, maxLength: MAX_SECRET_LENGTH, pattern: '^[^\\u0000]+$' })
export const PathSchema = Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH })
export const ModelSchema = Type.String({ pattern: MODEL_PATTERN })
const FileNameSchema = Type.String({ minLength: 1, maxLength: MAX_FILE_NAME_LENGTH })

export const EngineStateSchema = Type.Union([
  Type.Literal('starting'),
  Type.Literal('running'),
  Type.Literal('restarting'),
  Type.Literal('stopped'),
])
export const EngineErrorSchema = Type.Union([Type.Literal('crashed'), Type.Literal('start_timeout'), Type.Literal('no_keychain')])

export const EngineInfoSchema = Type.Object(
  { url: Type.String({ minLength: 1 }), token: Type.String({ minLength: 1 }), protocol: Type.Integer({ minimum: 1 }) },
  closed,
)
export const EngineStatusSchema = Type.Object(
  { state: EngineStateSchema, error: Type.Optional(EngineErrorSchema), restarts: Type.Integer({ minimum: 0 }) },
  closed,
)

export const ConnectionSummarySchema = Type.Object({ name: ConnectionNameSchema, kind: ConnectionKindSchema }, closed)

export const SettingsSchema = Type.Object(
  {
    allowedFolders: Type.Array(PathSchema, { maxItems: MAX_FOLDERS }),
    provider: ProviderIdSchema,
    model: Type.Optional(ModelSchema),
    openAtLogin: Type.Boolean(),
    configuredProviders: Type.Array(ProviderIdSchema, { maxItems: PROVIDER_IDS.length }),
    connections: Type.Array(ConnectionSummarySchema, { maxItems: 200 }),
    encryptionAvailable: Type.Boolean(),
  },
  closed,
)

export const SettingsPatchSchema = Type.Object(
  {
    allowedFolders: Type.Optional(Type.Array(PathSchema, { maxItems: MAX_FOLDERS })),
    provider: Type.Optional(ProviderIdSchema),
    model: Type.Optional(Type.Union([ModelSchema, Type.Null()])),
    openAtLogin: Type.Optional(Type.Boolean()),
  },
  closed,
)

export const SetProviderKeyArgsSchema = Type.Object({ provider: ProviderIdSchema, value: SecretValueSchema }, closed)
export const ClearProviderKeyArgsSchema = Type.Object({ provider: ProviderIdSchema }, closed)
export const SetConnectionArgsSchema = Type.Object(
  { name: ConnectionNameSchema, kind: ConnectionKindSchema, secret: SecretValueSchema },
  closed,
)
export const RemoveConnectionArgsSchema = Type.Object({ name: ConnectionNameSchema }, closed)
export const PickFileArgsSchema = Type.Object({ kind: Type.Union([Type.Literal('any'), Type.Literal('attachment')]) }, closed)
export const AddFromPathArgsSchema = Type.Object({ path: PathSchema }, closed)
export const AddFromBytesArgsSchema = Type.Object({ name: FileNameSchema, bytes: Type.Unknown() }, closed)

export function isByteInput(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]' && (value as Uint8Array).byteLength <= MAX_BYTES_INPUT
}

export type EngineInfo = Type.Static<typeof EngineInfoSchema>
export type EngineStatus = Type.Static<typeof EngineStatusSchema>
export type Settings = Type.Static<typeof SettingsSchema>
export type SettingsPatch = Type.Static<typeof SettingsPatchSchema>
export type ConnectionSummary = Type.Static<typeof ConnectionSummarySchema>
export type EngineState = EngineStatus['state']

export interface HostApi {
  engine: {
    info(): Promise<EngineInfo>
    status(): Promise<EngineStatus>
    restart(): Promise<void>
    onStatus(listener: (status: EngineStatus) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
  }
  secrets: {
    setProviderKey(provider: ProviderId, value: string): Promise<void>
    clearProviderKey(provider: ProviderId): Promise<void>
    setConnection(connection: { name: string; kind: ConnectionKind; secret: string }): Promise<void>
    removeConnection(name: string): Promise<void>
  }
  dialogs: {
    pickFolder(): Promise<string | undefined>
    pickFile(kind: 'any' | 'attachment'): Promise<string | undefined>
  }
  attachments: {
    addFromPath(path: string): Promise<AttachmentRef>
    addFromBytes(input: { name: string; bytes: Uint8Array }): Promise<AttachmentRef>
  }
  app: { quit(): Promise<void> }
}

export const HOST_API_METHODS = {
  engine: { info: true, status: true, restart: true, onStatus: true },
  settings: { get: true, update: true },
  secrets: { setProviderKey: true, clearProviderKey: true, setConnection: true, removeConnection: true },
  dialogs: { pickFolder: true, pickFile: true },
  attachments: { addFromPath: true, addFromBytes: true },
  app: { quit: true },
} satisfies { [Group in keyof HostApi]: Record<keyof HostApi[Group], true> }

export const CHANNELS = {
  engineInfo: 'rill:engine:info',
  engineStatus: 'rill:engine:get-status',
  engineRestart: 'rill:engine:restart',
  settingsGet: 'rill:settings:get',
  settingsUpdate: 'rill:settings:update',
  secretsSetProviderKey: 'rill:secrets:set-provider-key',
  secretsClearProviderKey: 'rill:secrets:clear-provider-key',
  secretsSetConnection: 'rill:secrets:set-connection',
  secretsRemoveConnection: 'rill:secrets:remove-connection',
  dialogsPickFolder: 'rill:dialogs:pick-folder',
  dialogsPickFile: 'rill:dialogs:pick-file',
  attachmentsAddFromPath: 'rill:attachments:add-from-path',
  attachmentsAddFromBytes: 'rill:attachments:add-from-bytes',
  appQuit: 'rill:app:quit',
} as const

export const ENGINE_STATUS_EVENT = 'rill:engine:status'

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

const OptionalPath = Type.Union([PathSchema, Type.Undefined()])

export const CONTRACTS: Record<Channel, { args: Type.TSchema; result: Type.TSchema }> = {
  [CHANNELS.engineInfo]: { args: Type.Undefined(), result: EngineInfoSchema },
  [CHANNELS.engineStatus]: { args: Type.Undefined(), result: EngineStatusSchema },
  [CHANNELS.engineRestart]: { args: Type.Undefined(), result: Type.Undefined() },
  [CHANNELS.settingsGet]: { args: Type.Undefined(), result: SettingsSchema },
  [CHANNELS.settingsUpdate]: { args: SettingsPatchSchema, result: SettingsSchema },
  [CHANNELS.secretsSetProviderKey]: { args: SetProviderKeyArgsSchema, result: Type.Undefined() },
  [CHANNELS.secretsClearProviderKey]: { args: ClearProviderKeyArgsSchema, result: Type.Undefined() },
  [CHANNELS.secretsSetConnection]: { args: SetConnectionArgsSchema, result: Type.Undefined() },
  [CHANNELS.secretsRemoveConnection]: { args: RemoveConnectionArgsSchema, result: Type.Undefined() },
  [CHANNELS.dialogsPickFolder]: { args: Type.Undefined(), result: OptionalPath },
  [CHANNELS.dialogsPickFile]: { args: PickFileArgsSchema, result: OptionalPath },
  [CHANNELS.attachmentsAddFromPath]: { args: AddFromPathArgsSchema, result: AttachmentRefSchema },
  [CHANNELS.attachmentsAddFromBytes]: { args: AddFromBytesArgsSchema, result: AttachmentRefSchema },
  [CHANNELS.appQuit]: { args: Type.Undefined(), result: Type.Undefined() },
}

export function validateArgs(channel: Channel, args: unknown): boolean {
  if (!Value.Check(CONTRACTS[channel].args, args)) return false
  if (channel === CHANNELS.attachmentsAddFromBytes) return isByteInput((args as { bytes: unknown }).bytes)
  return true
}

export function validateResult(channel: Channel, result: unknown): boolean {
  return Value.Check(CONTRACTS[channel].result, result)
}

export function validateStatus(value: unknown): value is EngineStatus {
  return Value.Check(EngineStatusSchema, value)
}

export function foldName(name: string): string {
  return name.normalize('NFKC').toLowerCase()
}

export function findNameCollision(names: readonly string[]): string | undefined {
  const seen = new Map<string, string>()
  for (const name of names) {
    const key = foldName(name)
    const earlier = seen.get(key)
    if (earlier !== undefined && earlier !== name) return name
    seen.set(key, name)
  }
  return undefined
}

export const HOST_ERROR_CODES = [
  'INVALID_ARGUMENTS',
  'INVALID_SETTINGS',
  'NO_KEYCHAIN',
  'NAME_COLLISION',
  'SECRETS_UNREADABLE',
  'ENGINE_UNAVAILABLE',
  'ATTACHMENT_REJECTED',
  'INTERNAL',
] as const
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number]

export class HostError extends Error {
  readonly code: HostErrorCode

  constructor(code: HostErrorCode) {
    super(code)
    this.name = 'HostError'
    this.code = code
  }
}

export function hostErrorCode(error: unknown): HostErrorCode {
  if (error instanceof HostError) return error.code
  const message = error instanceof Error ? error.message : ''
  return HOST_ERROR_CODES.find((code) => new RegExp(`(^|[^A-Z_])${code}($|[^A-Z_])`).test(message)) ?? 'INTERNAL'
}
