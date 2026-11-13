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

export const AUTH_TYPES = ['none', 'apiKey', 'bearer', 'basic'] as const
export const AuthTypeSchema = Type.Union([Type.Literal('none'), Type.Literal('apiKey'), Type.Literal('bearer'), Type.Literal('basic')])
export type AuthType = Type.Static<typeof AuthTypeSchema>

export const OAUTH_PROVIDERS = ['google', 'microsoft'] as const
export const OAuthProviderSchema = Type.Union([Type.Literal('google'), Type.Literal('microsoft')])
export type OAuthProvider = Type.Static<typeof OAuthProviderSchema>

export const MAX_FOLDERS = 50
export const MAX_NAME_LENGTH = 64
export const MAX_SECRET_LENGTH = 2000
export const MAX_PATH_LENGTH = 1024
export const MAX_FILE_NAME_LENGTH = 255
export const MAX_BYTES_INPUT = 21 * 1024 * 1024
export const MAX_AUTH_NAME_LENGTH = 128
export const MAX_AUTH_VALUE_LENGTH = 2000
export const MAX_AUTH_USERNAME_LENGTH = 256
export const MAX_ACCOUNT_LENGTH = 200
export const MAX_SLACK_TEXT_LENGTH = 80
export const MAX_SLACK_CHANNEL_LENGTH = 80

const MODEL_PATTERN = '^[a-z0-9][a-z0-9._-]{1,63}$'
const NO_CONTROL = '^[^\\u0000-\\u001f\\u007f]+$'
const NO_CONTROL_AT_ALL = '^[^\\u0000-\\u001f\\u007f-\\u009f]+$'
const NO_CONTROL_OR_COLON = '^[^:\\u0000-\\u001f\\u007f-\\u009f]+$'
const NO_CONTROL_OR_NOTHING = '^[^\\u0000-\\u001f\\u007f-\\u009f]*$'
const SLACK_TOKEN_PATTERN = '^xoxb-[A-Za-z0-9-]{10,200}$'
const SLACK_CHANNEL_PATTERN = '^[^\\s\\u0000-\\u001f\\u007f-\\u009f]+$'
const HEADER_NAME = "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$"
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
export const FORBIDDEN_AUTH_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'set-cookie',
  'upgrade',
  'keep-alive',
  'expect',
  'te',
  'trailer',
  'proxy-connection',
  'idempotency-key',
  'content-type',
])

export const ConnectionNameSchema = Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH, pattern: NO_CONTROL })
export const SecretValueSchema = Type.String({ minLength: 1, maxLength: MAX_SECRET_LENGTH, pattern: '^[^\\u0000]+$' })
export const PathSchema = Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH })
export const ModelSchema = Type.String({ pattern: MODEL_PATTERN })
const FileNameSchema = Type.String({ minLength: 1, maxLength: MAX_FILE_NAME_LENGTH })
const AuthNameSchema = Type.String({ minLength: 1, maxLength: MAX_AUTH_NAME_LENGTH, pattern: HEADER_NAME })
const AuthValueSchema = Type.String({ minLength: 1, maxLength: MAX_AUTH_VALUE_LENGTH, pattern: NO_CONTROL_AT_ALL })

export const CustomAuthSchema = Type.Union([
  Type.Object({ type: Type.Literal('none') }, closed),
  Type.Object({ type: Type.Literal('apiKey'), in: Type.Union([Type.Literal('header'), Type.Literal('query')]), name: AuthNameSchema, value: AuthValueSchema }, closed),
  Type.Object({ type: Type.Literal('bearer'), token: AuthValueSchema }, closed),
  Type.Object(
    {
      type: Type.Literal('basic'),
      username: Type.String({ minLength: 1, maxLength: MAX_AUTH_USERNAME_LENGTH, pattern: NO_CONTROL_OR_COLON }),
      password: Type.String({ maxLength: MAX_AUTH_VALUE_LENGTH, pattern: NO_CONTROL_OR_NOTHING }),
    },
    closed,
  ),
])
export type CustomAuth = Type.Static<typeof CustomAuthSchema>

function withinUnits(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && !LONE_SURROGATE.test(value)
}

export function isValidCustomAuth(value: unknown): value is CustomAuth {
  if (!Value.Check(CustomAuthSchema, value)) return false
  switch (value.type) {
    case 'none':
      return true
    case 'apiKey':
      return withinUnits(value.name, 1, MAX_AUTH_NAME_LENGTH) && !FORBIDDEN_AUTH_NAMES.has(value.name.toLowerCase()) && withinUnits(value.value, 1, MAX_AUTH_VALUE_LENGTH)
    case 'bearer':
      return withinUnits(value.token, 1, MAX_AUTH_VALUE_LENGTH)
    case 'basic':
      return withinUnits(value.username, 1, MAX_AUTH_USERNAME_LENGTH) && withinUnits(value.password, 0, MAX_AUTH_VALUE_LENGTH)
  }
}

export function encodeCustomAuth(auth: CustomAuth): string {
  return JSON.stringify({ rillAuth: 1, ...auth })
}

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

export const SlackTokenSchema = Type.String({ pattern: SLACK_TOKEN_PATTERN })
export const SlackChannelSchema = Type.String({ minLength: 1, maxLength: MAX_SLACK_CHANNEL_LENGTH, pattern: SLACK_CHANNEL_PATTERN })
const SlackTextSchema = Type.String({ minLength: 1, maxLength: MAX_SLACK_TEXT_LENGTH, pattern: NO_CONTROL_AT_ALL })

export const SlackSummarySchema = Type.Object(
  {
    mode: Type.Literal('bot'),
    account: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ACCOUNT_LENGTH, pattern: NO_CONTROL_AT_ALL })),
    channel: Type.Optional(SlackChannelSchema),
  },
  closed,
)

export const ConnectionSummarySchema = Type.Object(
  { name: ConnectionNameSchema, kind: ConnectionKindSchema, authType: Type.Optional(AuthTypeSchema), slack: Type.Optional(SlackSummarySchema) },
  closed,
)

export const OAuthAccountSchema = Type.Object(
  { provider: OAuthProviderSchema, account: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ACCOUNT_LENGTH, pattern: NO_CONTROL })) },
  closed,
)
export const OAuthStateSchema = Type.Object(
  { available: Type.Boolean(), accounts: Type.Array(OAuthAccountSchema, { maxItems: OAUTH_PROVIDERS.length }) },
  closed,
)

export const SettingsSchema = Type.Object(
  {
    allowedFolders: Type.Array(PathSchema, { maxItems: MAX_FOLDERS }),
    provider: ProviderIdSchema,
    model: Type.Optional(ModelSchema),
    openAtLogin: Type.Boolean(),
    configuredProviders: Type.Array(ProviderIdSchema, { maxItems: PROVIDER_IDS.length }),
    connections: Type.Array(ConnectionSummarySchema, { maxItems: 200 }),
    encryptionAvailable: Type.Boolean(),
    oauth: OAuthStateSchema,
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

export const KEY_INVALID_REASONS = ['unauthorized', 'rejected', 'malformed'] as const
export const KEY_UNVERIFIED_REASONS = ['forbidden', 'rate_limited', 'server_error', 'network', 'timeout', 'unexpected_status'] as const

const InvalidReasonSchema = Type.Union([Type.Literal('unauthorized'), Type.Literal('rejected'), Type.Literal('malformed')])
const UnverifiedReasonSchema = Type.Union([
  Type.Literal('forbidden'),
  Type.Literal('rate_limited'),
  Type.Literal('server_error'),
  Type.Literal('network'),
  Type.Literal('timeout'),
  Type.Literal('unexpected_status'),
])

export const KeyVerdictSchema = Type.Union([
  Type.Object({ status: Type.Literal('valid') }, closed),
  Type.Object({ status: Type.Literal('invalid'), reason: InvalidReasonSchema }, closed),
  Type.Object({ status: Type.Literal('unverified'), reason: UnverifiedReasonSchema }, closed),
])
export const SetProviderKeyOptionsSchema = Type.Object({ saveAnyway: Type.Optional(Type.Boolean()) }, closed)
export const SetProviderKeyArgsSchema = Type.Object(
  { provider: ProviderIdSchema, value: SecretValueSchema, options: Type.Optional(SetProviderKeyOptionsSchema) },
  closed,
)
export const SetProviderKeyResultSchema = Type.Object({ verdict: KeyVerdictSchema }, closed)
export const SlackVerdictSchema = Type.Union([
  Type.Object({ status: Type.Literal('valid'), workspace: Type.Optional(SlackTextSchema), bot: Type.Optional(SlackTextSchema) }, closed),
  Type.Object({ status: Type.Literal('invalid'), reason: Type.Literal('unauthorized') }, closed),
  Type.Object({ status: Type.Literal('unverified'), reason: UnverifiedReasonSchema }, closed),
])
export const SetSlackBotOptionsSchema = Type.Object({ saveAnyway: Type.Optional(Type.Boolean()) }, closed)
export const SlackBotSchema = Type.Object({ name: ConnectionNameSchema, token: SlackTokenSchema, channel: Type.Optional(SlackChannelSchema) }, closed)
export const SetSlackBotArgsSchema = Type.Object(
  { name: ConnectionNameSchema, token: SlackTokenSchema, channel: Type.Optional(SlackChannelSchema), options: Type.Optional(SetSlackBotOptionsSchema) },
  closed,
)
export const SetSlackBotResultSchema = Type.Object({ verdict: SlackVerdictSchema }, closed)
export const ClearProviderKeyArgsSchema = Type.Object({ provider: ProviderIdSchema }, closed)
export const SetConnectionArgsSchema = Type.Object(
  { name: ConnectionNameSchema, kind: ConnectionKindSchema, secret: SecretValueSchema },
  closed,
)
export const SetCustomConnectionArgsSchema = Type.Object({ name: ConnectionNameSchema, auth: CustomAuthSchema }, closed)
export const OAuthArgsSchema = Type.Object({ provider: OAuthProviderSchema }, closed)
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
export type OAuthAccount = Type.Static<typeof OAuthAccountSchema>
export type OAuthState = Type.Static<typeof OAuthStateSchema>
export type EngineState = EngineStatus['state']
export type KeyVerdict = Type.Static<typeof KeyVerdictSchema>
export type KeyInvalidReason = Type.Static<typeof InvalidReasonSchema>
export type KeyUnverifiedReason = Type.Static<typeof UnverifiedReasonSchema>
export type SetProviderKeyOptions = Type.Static<typeof SetProviderKeyOptionsSchema>
export type SetProviderKeyResult = Type.Static<typeof SetProviderKeyResultSchema>
export type SlackSummary = Type.Static<typeof SlackSummarySchema>
export type SlackVerdict = Type.Static<typeof SlackVerdictSchema>
export type SlackBot = Type.Static<typeof SlackBotSchema>
export type SetSlackBotOptions = Type.Static<typeof SetSlackBotOptionsSchema>
export type SetSlackBotResult = Type.Static<typeof SetSlackBotResultSchema>

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
    setProviderKey(provider: ProviderId, value: string, options?: SetProviderKeyOptions): Promise<SetProviderKeyResult>
    clearProviderKey(provider: ProviderId): Promise<void>
    setConnection(connection: { name: string; kind: ConnectionKind; secret: string }): Promise<void>
    setCustomConnection(connection: { name: string; auth: CustomAuth }): Promise<void>
    setSlackBot(bot: { name: string; token: string; channel?: string }, options?: SetSlackBotOptions): Promise<SetSlackBotResult>
    removeConnection(name: string): Promise<void>
  }
  oauth: {
    connect(provider: OAuthProvider): Promise<void>
    disconnect(provider: OAuthProvider): Promise<void>
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
  secrets: { setProviderKey: true, clearProviderKey: true, setConnection: true, setCustomConnection: true, setSlackBot: true, removeConnection: true },
  oauth: { connect: true, disconnect: true },
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
  secretsSetCustomConnection: 'rill:secrets:set-custom-connection',
  secretsSetSlackBot: 'rill:secrets:set-slack-bot',
  secretsRemoveConnection: 'rill:secrets:remove-connection',
  oauthConnect: 'rill:oauth:connect',
  oauthDisconnect: 'rill:oauth:disconnect',
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
  [CHANNELS.secretsSetProviderKey]: { args: SetProviderKeyArgsSchema, result: SetProviderKeyResultSchema },
  [CHANNELS.secretsClearProviderKey]: { args: ClearProviderKeyArgsSchema, result: Type.Undefined() },
  [CHANNELS.secretsSetConnection]: { args: SetConnectionArgsSchema, result: Type.Undefined() },
  [CHANNELS.secretsSetCustomConnection]: { args: SetCustomConnectionArgsSchema, result: Type.Undefined() },
  [CHANNELS.secretsSetSlackBot]: { args: SetSlackBotArgsSchema, result: SetSlackBotResultSchema },
  [CHANNELS.secretsRemoveConnection]: { args: RemoveConnectionArgsSchema, result: Type.Undefined() },
  [CHANNELS.oauthConnect]: { args: OAuthArgsSchema, result: Type.Undefined() },
  [CHANNELS.oauthDisconnect]: { args: OAuthArgsSchema, result: Type.Undefined() },
  [CHANNELS.dialogsPickFolder]: { args: Type.Undefined(), result: OptionalPath },
  [CHANNELS.dialogsPickFile]: { args: PickFileArgsSchema, result: OptionalPath },
  [CHANNELS.attachmentsAddFromPath]: { args: AddFromPathArgsSchema, result: AttachmentRefSchema },
  [CHANNELS.attachmentsAddFromBytes]: { args: AddFromBytesArgsSchema, result: AttachmentRefSchema },
  [CHANNELS.appQuit]: { args: Type.Undefined(), result: Type.Undefined() },
}

export function validateArgs(channel: Channel, args: unknown): boolean {
  if (!Value.Check(CONTRACTS[channel].args, args)) return false
  if (channel === CHANNELS.attachmentsAddFromBytes) return isByteInput((args as { bytes: unknown }).bytes)
  if (channel === CHANNELS.secretsSetCustomConnection) return isValidCustomAuth((args as { auth: unknown }).auth)
  if (channel === CHANNELS.secretsSetSlackBot) return hasWholeText((args as { channel?: string }).channel)
  return true
}

export function validateResult(channel: Channel, result: unknown): boolean {
  return Value.Check(CONTRACTS[channel].result, result)
}

export function isKeyVerdict(value: unknown): value is KeyVerdict {
  return Value.Check(KeyVerdictSchema, value)
}

export function isSlackVerdict(value: unknown): value is SlackVerdict {
  return Value.Check(SlackVerdictSchema, value)
}

export function hasWholeText(value: string | undefined): boolean {
  return value === undefined || !LONE_SURROGATE.test(value)
}

export function isValidSlackBot(value: unknown): value is SlackBot {
  return Value.Check(SlackBotSchema, value) && hasWholeText(value.channel)
}

export function encodeSlackBot(bot: { token: string; channel?: string }): string {
  return JSON.stringify({ rillSlack: 1, token: bot.token, ...(bot.channel === undefined ? {} : { channel: bot.channel }) })
}

export function slackAccountText(verdict: SlackVerdict): string | undefined {
  if (verdict.status !== 'valid') return undefined
  if (verdict.bot !== undefined && verdict.workspace !== undefined) return `${verdict.bot} in ${verdict.workspace}`
  return verdict.bot ?? verdict.workspace
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
  'KEY_INVALID',
  'KEY_MALFORMED',
  'TOKEN_INVALID',
  'SUPERSEDED',
  'OAUTH_UNAVAILABLE',
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
