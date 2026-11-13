// @vitest-environment node
import { PROVIDER_IDS as LLM_PROVIDER_IDS, providerDescriptor } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  CONNECTION_KINDS,
  CONTRACTS,
  ConnectionSummarySchema,
  EngineInfoSchema,
  EngineStatusSchema,
  HOST_API_METHODS,
  HOST_ERROR_CODES,
  HostError,
  MAX_BYTES_INPUT,
  PROVIDER_IDS,
  PROVIDER_KEY_ENV,
  SettingsPatchSchema,
  SettingsSchema,
  findNameCollision,
  foldName,
  hostErrorCode,
  isByteInput,
  validateArgs,
  validateResult,
  validateStatus,
  type ConnectionSummary,
  type Settings,
} from '../src/shared/host-api'

const SETTINGS: Settings = {
  allowedFolders: ['/Users/a/Documents'],
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  openAtLogin: false,
  configuredProviders: ['anthropic'],
  connections: [{ name: 'team', kind: 'slack' }],
  encryptionAvailable: true,
}

const REF = { id: 'abcdefgh1234', mediaType: 'text/plain', name: 'a.txt', bytes: 3 }

describe('channels and contracts', () => {
  it('give every channel a unique rill: name and a contract', () => {
    const names = Object.values(CHANNELS)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name.startsWith('rill:')).toBe(true)
      expect(CONTRACTS[name], name).toBeDefined()
    }
    expect(Object.keys(CONTRACTS).sort()).toEqual([...names].sort())
  })

  it('list one method for each channel plus the status subscription', () => {
    const methods = Object.values(HOST_API_METHODS).flatMap((group) => Object.keys(group))
    expect(methods).toHaveLength(Object.keys(CHANNELS).length + 1)
    expect(HOST_API_METHODS.engine.onStatus).toBe(true)
  })
})

describe('argument schemas', () => {
  it('accept valid arguments for every channel', () => {
    const valid: Array<[string, unknown]> = [
      [CHANNELS.engineInfo, undefined],
      [CHANNELS.engineStatus, undefined],
      [CHANNELS.engineRestart, undefined],
      [CHANNELS.settingsGet, undefined],
      [CHANNELS.settingsUpdate, { allowedFolders: ['/a'], provider: 'openai', model: 'gpt-6.1-sol', openAtLogin: true }],
      [CHANNELS.settingsUpdate, { model: null }],
      [CHANNELS.settingsUpdate, {}],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k'.repeat(2000) }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: {} }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: { saveAnyway: true } }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: { saveAnyway: false } }],
      [CHANNELS.secretsClearProviderKey, { provider: 'grok' }],
      [CHANNELS.secretsSetConnection, { name: 'n'.repeat(64), kind: 'http', secret: 's' }],
      [CHANNELS.secretsRemoveConnection, { name: 'team' }],
      [CHANNELS.dialogsPickFolder, undefined],
      [CHANNELS.dialogsPickFile, { kind: 'attachment' }],
      [CHANNELS.attachmentsAddFromPath, { path: '/a'.padEnd(1024, 'b') }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'a.txt', bytes: new Uint8Array(MAX_BYTES_INPUT) }],
      [CHANNELS.appQuit, undefined],
    ]
    for (const [channel, args] of valid) expect(validateArgs(channel as never, args), `${channel} ${JSON.stringify(args)}`).toBe(true)
  })

  it('reject extra fields, wrong types and missing fields', () => {
    const invalid: Array<[string, unknown]> = [
      [CHANNELS.engineInfo, {}],
      [CHANNELS.engineStatus, {}],
      [CHANNELS.settingsUpdate, { openAtLogin: 'yes' }],
      [CHANNELS.settingsUpdate, { extra: 1 }],
      [CHANNELS.settingsUpdate, { provider: 'azure' }],
      [CHANNELS.settingsUpdate, { model: 'Has Spaces' }],
      [CHANNELS.settingsUpdate, { model: '' }],
      [CHANNELS.settingsUpdate, { allowedFolders: 'a' }],
      [CHANNELS.settingsUpdate, { allowedFolders: Array.from({ length: 51 }, (_, i) => `/f${i}`) }],
      [CHANNELS.settingsUpdate, { allowedFolders: [''] }],
      [CHANNELS.settingsUpdate, null],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic' }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 5 }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'a\u0000b' }],
      [CHANNELS.secretsSetConnection, { name: 'team', kind: 'http', secret: 'a\u0000b' }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', extra: true }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: { force: true } }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: { saveAnyway: 'true' } }],
      [CHANNELS.secretsSetProviderKey, { provider: 'anthropic', value: 'k', options: null }],
      [CHANNELS.secretsClearProviderKey, { provider: 'anthropic', value: 'k' }],
      [CHANNELS.secretsSetConnection, { name: 'team', kind: 'discord', secret: 's' }],
      [CHANNELS.secretsSetConnection, { name: 'team', secret: 's' }],
      [CHANNELS.secretsRemoveConnection, {}],
      [CHANNELS.dialogsPickFile, { kind: 'folder' }],
      [CHANNELS.dialogsPickFile, undefined],
      [CHANNELS.attachmentsAddFromPath, { path: 5 }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'a.txt' }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'a.txt', bytes: [1, 2, 3] }],
      [CHANNELS.attachmentsAddFromBytes, { name: 'a.txt', bytes: 'text' }],
      [CHANNELS.appQuit, 1],
    ]
    for (const [channel, args] of invalid) expect(validateArgs(channel as never, args), `${channel} ${JSON.stringify(args)}`).toBe(false)
  })

  it('reject oversize strings and byte arrays at the boundary', () => {
    const connection = (patch: object) => ({ name: 'team', kind: 'slack', secret: 's', ...patch })
    expect(validateArgs(CHANNELS.secretsSetConnection, connection({ name: 'n'.repeat(65) }))).toBe(false)
    expect(validateArgs(CHANNELS.secretsSetConnection, connection({ name: '' }))).toBe(false)
    expect(validateArgs(CHANNELS.secretsSetConnection, connection({ secret: 's'.repeat(2001) }))).toBe(false)
    expect(validateArgs(CHANNELS.secretsSetConnection, connection({ secret: '' }))).toBe(false)
    expect(validateArgs(CHANNELS.secretsSetProviderKey, { provider: 'openai', value: 'k'.repeat(2001) })).toBe(false)
    expect(validateArgs(CHANNELS.attachmentsAddFromPath, { path: 'p'.repeat(1025) })).toBe(false)
    expect(validateArgs(CHANNELS.attachmentsAddFromPath, { path: '' })).toBe(false)
    expect(validateArgs(CHANNELS.attachmentsAddFromBytes, { name: 'a'.repeat(256), bytes: new Uint8Array(1) })).toBe(false)
    expect(validateArgs(CHANNELS.attachmentsAddFromBytes, { name: 'a', bytes: new Uint8Array(MAX_BYTES_INPUT + 1) })).toBe(false)
    expect(MAX_BYTES_INPUT).toBe(21 * 1024 * 1024)
  })

  it('reject connection names with control characters', () => {
    for (const name of ['a\nb', 'a\u0000b', '\u007f', 'tab\tname']) {
      expect(validateArgs(CHANNELS.secretsSetConnection, { name, kind: 'slack', secret: 's' }), JSON.stringify(name)).toBe(false)
    }
  })

  it('recognise a byte array from another realm and a Buffer, and nothing else', () => {
    expect(isByteInput(new Uint8Array(2))).toBe(true)
    expect(isByteInput(Buffer.from('ab'))).toBe(true)
    expect(isByteInput(new Uint16Array(2))).toBe(false)
    expect(isByteInput(new ArrayBuffer(2))).toBe(false)
    expect(isByteInput({ length: 2 })).toBe(false)
    expect(isByteInput(undefined)).toBe(false)
  })
})

describe('result schemas', () => {
  it('accept the results the handlers return', () => {
    expect(validateResult(CHANNELS.engineInfo, { url: 'ws://127.0.0.1:1/', token: 't', protocol: 1 })).toBe(true)
    expect(validateResult(CHANNELS.engineStatus, { state: 'stopped', error: 'crashed', restarts: 5 })).toBe(true)
    expect(validateResult(CHANNELS.engineStatus, { state: 'stopped', error: 'crashed', restarts: 5, token: 't' })).toBe(false)
    expect(validateResult(CHANNELS.engineStatus, { state: 'paused', restarts: 0 })).toBe(false)
    expect(validateResult(CHANNELS.settingsGet, SETTINGS)).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, { ...SETTINGS, model: undefined })).toBe(true)
    expect(validateResult(CHANNELS.attachmentsAddFromPath, REF)).toBe(true)
    expect(validateResult(CHANNELS.dialogsPickFolder, undefined)).toBe(true)
    expect(validateResult(CHANNELS.dialogsPickFolder, '/a')).toBe(true)
    expect(validateResult(CHANNELS.secretsSetProviderKey, { verdict: { status: 'valid' } })).toBe(true)
    expect(validateResult(CHANNELS.secretsClearProviderKey, undefined)).toBe(true)
  })

  it('reject results with extra fields, such as a secret', () => {
    expect(validateResult(CHANNELS.settingsGet, { ...SETTINGS, apiKey: 'x' })).toBe(false)
    expect(validateResult(CHANNELS.settingsGet, { ...SETTINGS, connections: [{ name: 'team', kind: 'slack', secret: 'x' }] })).toBe(false)
    expect(validateResult(CHANNELS.secretsSetConnection, { stored: true })).toBe(false)
    expect(validateResult(CHANNELS.engineInfo, { url: 'ws://x', token: 't', protocol: 1, key: 'k' })).toBe(false)
    expect(validateResult(CHANNELS.attachmentsAddFromPath, { ...REF, path: '/etc/passwd' })).toBe(false)
  })

  it('validate engine status events', () => {
    expect(validateStatus({ state: 'running', restarts: 0 })).toBe(true)
    expect(validateStatus({ state: 'stopped', error: 'crashed', restarts: 5 })).toBe(true)
    expect(validateStatus({ state: 'stopped', error: 'no_keychain', restarts: 0 })).toBe(true)
    expect(validateStatus({ state: 'paused', restarts: 0 })).toBe(false)
    expect(validateStatus({ state: 'running', restarts: -1 })).toBe(false)
    expect(validateStatus({ state: 'running', restarts: 0, log: 'x' })).toBe(false)
    expect(validateStatus({ state: 'stopped', error: 'boom', restarts: 0 })).toBe(false)
  })
})

describe('no secret can appear in a result type', () => {
  const SECRETISH = /key|secret|token|value|password|credential/i

  it('has no secret-like field in Settings or its connection summary, at runtime', () => {
    expect(Object.keys(SettingsSchema.properties).filter((name) => SECRETISH.test(name) && name !== 'encryptionAvailable')).toEqual([])
    expect(Object.keys(ConnectionSummarySchema.properties)).toEqual(['name', 'kind'])
    expect(Object.keys(SettingsPatchSchema.properties).filter((name) => SECRETISH.test(name))).toEqual([])
    expect(Object.keys(EngineStatusSchema.properties)).toEqual(['state', 'error', 'restarts'])
    expect(Object.keys(EngineInfoSchema.properties)).toEqual(['url', 'token', 'protocol'])
  })

  it('has no secret-like field in Settings or its connection summary, in the types', () => {
    type Leaky = Extract<keyof Settings | keyof ConnectionSummary, 'apiKey' | 'key' | 'secret' | 'value' | 'keys' | 'providerKeys'>
    const none: [Leaky] extends [never] ? true : false = true
    expect(none).toBe(true)
  })
})

describe('connection names', () => {
  it('fold case and compatibility forms before comparing', () => {
    expect(foldName('Slack')).toBe('slack')
    expect(foldName('ＳＬＡＣＫ')).toBe('slack')
  })

  it('find a name that collides with an earlier one after folding, and ignore an exact repeat', () => {
    expect(findNameCollision(['team', 'Team'])).toBe('Team')
    expect(findNameCollision(['team', 'TEAM', 'other'])).toBe('TEAM')
    expect(findNameCollision(['team', 'other'])).toBeUndefined()
    expect(findNameCollision(['team', 'team'])).toBeUndefined()
    expect(findNameCollision([])).toBeUndefined()
  })
})

describe('provider table', () => {
  it('covers every provider the engine knows, with the variable the engine reads', () => {
    expect([...PROVIDER_IDS]).toEqual([...LLM_PROVIDER_IDS])
    for (const id of LLM_PROVIDER_IDS) expect(PROVIDER_KEY_ENV[id], id).toBe(providerDescriptor(id).keyEnv)
  })

  it('lists the three connection kinds the engine accepts', () => {
    expect([...CONNECTION_KINDS]).toEqual(['slack', 'http', 'webhookSecret'])
  })
})

describe('key check contract', () => {
  const result = (verdict: unknown) => validateResult(CHANNELS.secretsSetProviderKey, { verdict })

  it('accepts exactly the three verdicts with their reasons', () => {
    expect(result({ status: 'valid' })).toBe(true)
    for (const reason of ['unauthorized', 'rejected', 'malformed']) expect(result({ status: 'invalid', reason }), reason).toBe(true)
    for (const reason of ['forbidden', 'rate_limited', 'server_error', 'network', 'timeout', 'unexpected_status']) {
      expect(result({ status: 'unverified', reason }), reason).toBe(true)
    }
  })

  it('rejects another status, a reason of the other kind, a missing reason and extra fields', () => {
    expect(result({ status: 'maybe' })).toBe(false)
    expect(result({ status: 'invalid' })).toBe(false)
    expect(result({ status: 'unverified' })).toBe(false)
    expect(result({ status: 'invalid', reason: 'timeout' })).toBe(false)
    expect(result({ status: 'unverified', reason: 'unauthorized' })).toBe(false)
    expect(result({ status: 'valid', reason: 'network' })).toBe(false)
    expect(result({ status: 'unverified', reason: 'network', body: 'text' })).toBe(false)
    expect(result(undefined)).toBe(false)
    expect(validateResult(CHANNELS.secretsSetProviderKey, undefined)).toBe(false)
    expect(validateResult(CHANNELS.secretsSetProviderKey, { verdict: { status: 'valid' }, key: 'k' })).toBe(false)
  })

  it('names KEY_INVALID among the host error codes and reads it out of a remote error', () => {
    expect(HOST_ERROR_CODES).toContain('KEY_INVALID')
    expect(hostErrorCode(new Error("Error invoking remote method 'rill:secrets:set-provider-key': Error: KEY_INVALID"))).toBe('KEY_INVALID')
    expect(hostErrorCode(new Error('KEY_INVALIDS'))).toBe('INTERNAL')
  })

  it('names KEY_MALFORMED and SUPERSEDED among the host error codes and reads them out of a remote error', () => {
    for (const code of ['KEY_MALFORMED', 'SUPERSEDED']) {
      expect(HOST_ERROR_CODES).toContain(code)
      expect(hostErrorCode(new Error(`Error invoking remote method 'rill:secrets:set-provider-key': Error: ${code}`))).toBe(code)
      expect(hostErrorCode(new Error(`${code}S`))).toBe('INTERNAL')
    }
  })
})

describe('host errors', () => {
  it('carry a fixed code as their message', () => {
    for (const code of HOST_ERROR_CODES) {
      const error = new HostError(code)
      expect(error.code).toBe(code)
      expect(error.message).toBe(code)
      expect(hostErrorCode(error)).toBe(code)
    }
  })

  it('read the code out of an Electron remote method error and fall back to INTERNAL', () => {
    expect(hostErrorCode(new Error("Error invoking remote method 'rill:secrets:set-connection': Error: NO_KEYCHAIN"))).toBe('NO_KEYCHAIN')
    expect(hostErrorCode(new Error('NO_KEYCHAINS'))).toBe('INTERNAL')
    expect(hostErrorCode(new Error('something broke with a sk-secret'))).toBe('INTERNAL')
    expect(hostErrorCode('INVALID_ARGUMENTS')).toBe('INTERNAL')
    expect(hostErrorCode(undefined)).toBe('INTERNAL')
  })
})
