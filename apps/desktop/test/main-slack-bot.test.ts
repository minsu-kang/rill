// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSlackSecret } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../src/main/attachments'
import { createConfigStore } from '../src/main/config-store'
import { createIpcHandlers, type DialogLike } from '../src/main/ipc-handlers'
import { createSecretStore, type SafeStorageLike } from '../src/main/secret-store'
import type { SlackChecker } from '../src/main/slack-check'
import { createHostApi, type IpcLike } from '../src/preload/host-bridge'
import {
  CHANNELS,
  CONTRACTS,
  HOST_API_METHODS,
  HOST_ERROR_CODES,
  OAUTH_PROVIDERS,
  encodeSlackBot,
  hostErrorCode,
  isSlackVerdict,
  isValidSlackBot,
  slackAccountText,
  validateArgs,
  validateResult,
  type Channel,
  type EngineStatus,
  type Settings,
  type SlackVerdict,
} from '../src/shared/host-api'

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const OTHER_TOKEN = 'xoxb-SLACKTOKENMARKER9999'
const VALID: SlackVerdict = { status: 'valid', workspace: 'Acme', bot: 'rill-bot' }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-slack-bot-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function harness(options: { available?: boolean; verdict?: SlackVerdict; log?: (line: string) => void } = {}) {
  const safeStorage: SafeStorageLike & { available: boolean } = {
    available: options.available ?? true,
    isEncryptionAvailable: () => safeStorage.available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
  }
  const config = createConfigStore({ dir: join(dir, 'data') })
  const secrets = createSecretStore({ dir: join(dir, 'data'), safeStorage })
  const attachments = createAttachmentStore({ dir: join(dir, 'data', 'attachments') })
  const supervisor = {
    info: vi.fn(async () => ({ url: 'ws://127.0.0.1:1/', token: 'engine-token-0123456789', protocol: 1 })),
    restart: vi.fn(async () => undefined),
    status: vi.fn((): EngineStatus => ({ state: 'running', restarts: 0 })),
  }
  const dialog: DialogLike = { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) as DialogLike['showOpenDialog'] }
  const slackCheck = vi.fn<SlackChecker>(async () => options.verdict ?? VALID)
  const handlers = createIpcHandlers({
    config,
    secrets,
    supervisor,
    attachments,
    dialog,
    app: { quit: vi.fn() },
    loginItem: { set: vi.fn() },
    keyCheck: vi.fn(async () => ({ status: 'valid' as const })),
    slackCheck,
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  const call = (channel: Channel, args?: unknown) => handlers[channel](args)
  const setBot = (args: Record<string, unknown> = {}) => call(CHANNELS.secretsSetSlackBot, { name: 'alerts', token: TOKEN, ...args })
  const settings = async () => (await call(CHANNELS.settingsGet)) as Settings
  return { call, setBot, settings, supervisor, slackCheck, safeStorage, secrets, config }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

const code = (error: Error) => hostErrorCode(error)
const started = (h: { slackCheck: ReturnType<typeof vi.fn> }, calls: number) => vi.waitFor(() => expect(h.slackCheck).toHaveBeenCalledTimes(calls))

describe('host contract for Slack bots', () => {
  it('has the channel, the method and the error code, and no Slack OAuth provider', () => {
    expect(CHANNELS.secretsSetSlackBot).toBe('rill:secrets:set-slack-bot')
    expect(HOST_API_METHODS.secrets.setSlackBot).toBe(true)
    expect(CONTRACTS[CHANNELS.secretsSetSlackBot]).toBeDefined()
    expect(HOST_ERROR_CODES).toContain('TOKEN_INVALID')
    expect(hostErrorCode(new Error("Error invoking remote method 'rill:secrets:set-slack-bot': Error: TOKEN_INVALID xoxb-SECRET"))).toBe('TOKEN_INVALID')
    expect([...OAUTH_PROVIDERS]).toEqual(['google', 'microsoft'])
    expect(validateArgs(CHANNELS.oauthConnect, { provider: 'slack' })).toBe(false)
    expect(validateArgs(CHANNELS.oauthConnect, { provider: 'google' })).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, settingsWith({ provider: 'slack' }))).toBe(false)
  })

  function settingsWith(account: { provider: string }) {
    return { allowedFolders: [], provider: 'anthropic', openAtLogin: false, configuredProviders: [], connections: [], encryptionAvailable: true, oauth: { available: false, accounts: [account] } }
  }

  const GOOD: Array<[string, unknown]> = [
    ['a token and a name', { name: 'alerts', token: TOKEN }],
    ['a channel', { name: 'alerts', token: TOKEN, channel: '#alerts' }],
    ['options', { name: 'alerts', token: TOKEN, options: { saveAnyway: true } }],
    ['the longest token', { name: 'a', token: `xoxb-${'a'.repeat(200)}` }],
    ['the shortest token', { name: 'a', token: `xoxb-${'a'.repeat(10)}` }],
    ['a channel of 80 characters', { name: 'a', token: TOKEN, channel: '#'.padEnd(80, 'c') }],
  ]
  it.each(GOOD)('accepts %s', (_label, args) => {
    expect(validateArgs(CHANNELS.secretsSetSlackBot, args)).toBe(true)
  })

  const BAD: Array<[string, unknown]> = [
    ['no token', { name: 'alerts' }],
    ['no name', { token: TOKEN }],
    ['an empty name', { name: '', token: TOKEN }],
    ['a name with a control character', { name: 'a\nb', token: TOKEN }],
    ['a 65 character name', { name: 'n'.repeat(65), token: TOKEN }],
    ['a user token', { name: 'a', token: 'xoxp-SLACKTOKENMARKER0123' }],
    ['a short token', { name: 'a', token: 'xoxb-short' }],
    ['a token with a space', { name: 'a', token: 'xoxb-SLACKTOKEN MARKER' }],
    ['a token with a newline at the end', { name: 'a', token: `${TOKEN}\n` }],
    ['a 201 character token body', { name: 'a', token: `xoxb-${'a'.repeat(201)}` }],
    ['a token that is not a string', { name: 'a', token: 5 }],
    ['an empty channel', { name: 'a', token: TOKEN, channel: '' }],
    ['a channel with a space', { name: 'a', token: TOKEN, channel: '#a b' }],
    ['a channel with a tab', { name: 'a', token: TOKEN, channel: '#a\tb' }],
    ['a channel with a control character', { name: 'a', token: TOKEN, channel: '#a\u0085b' }],
    ['a channel of 81 characters', { name: 'a', token: TOKEN, channel: '#'.padEnd(81, 'c') }],
    ['a channel with a lone surrogate', { name: 'a', token: TOKEN, channel: '#a\uD800b' }],
    ['an extra key', { name: 'a', token: TOKEN, extra: 1 }],
    ['saveAnyway outside the options', { name: 'a', token: TOKEN, saveAnyway: true }],
    ['an unknown option', { name: 'a', token: TOKEN, options: { force: true } }],
    ['an option of the wrong type', { name: 'a', token: TOKEN, options: { saveAnyway: 'yes' } }],
    ['undefined', undefined],
  ]
  it.each(BAD)('refuses %s', (_label, args) => {
    expect(validateArgs(CHANNELS.secretsSetSlackBot, args)).toBe(false)
  })

  it('checks the bot object without the options', () => {
    expect(isValidSlackBot({ name: 'a', token: TOKEN })).toBe(true)
    expect(isValidSlackBot({ name: 'a', token: TOKEN, options: {} })).toBe(false)
  })

  it('checks verdicts and results', () => {
    for (const verdict of [VALID, { status: 'valid' }, { status: 'invalid', reason: 'unauthorized' }, { status: 'unverified', reason: 'rate_limited' }, { status: 'unverified', reason: 'forbidden' }]) {
      expect(isSlackVerdict(verdict)).toBe(true)
      expect(validateResult(CHANNELS.secretsSetSlackBot, { verdict })).toBe(true)
    }
    for (const verdict of [{ status: 'invalid', reason: 'rejected' }, { status: 'invalid', reason: 'malformed' }, { status: 'maybe' }, { status: 'valid', workspace: 5 }, { status: 'valid', token: TOKEN }, { status: 'valid', bot: 'a\nb' }, { status: 'valid', bot: 'x'.repeat(81) }, null]) {
      expect(isSlackVerdict(verdict)).toBe(false)
    }
    expect(validateResult(CHANNELS.secretsSetSlackBot, undefined)).toBe(false)
    expect(validateResult(CHANNELS.secretsSetSlackBot, { verdict: VALID, extra: 1 })).toBe(false)
  })

  it('builds the account text from the bot and the workspace', () => {
    expect(slackAccountText(VALID)).toBe('rill-bot in Acme')
    expect(slackAccountText({ status: 'valid', workspace: 'Acme' })).toBe('Acme')
    expect(slackAccountText({ status: 'valid', bot: 'rill-bot' })).toBe('rill-bot')
    expect(slackAccountText({ status: 'valid' })).toBeUndefined()
    expect(slackAccountText({ status: 'unverified', reason: 'timeout' })).toBeUndefined()
  })

  it('encodes the secret so the engine parser reads it back', () => {
    expect(parseSlackSecret(encodeSlackBot({ token: TOKEN, channel: '#alerts' }))).toEqual({ kind: 'bot', token: TOKEN, channel: '#alerts' })
    expect(parseSlackSecret(encodeSlackBot({ token: TOKEN }))).toEqual({ kind: 'bot', token: TOKEN })
    expect(JSON.parse(encodeSlackBot({ token: TOKEN }))).toEqual({ rillSlack: 1, token: TOKEN })
  })

  it('accepts in the summary and the settings only what the store holds', () => {
    const connection = (extra: object) => ({ allowedFolders: [], provider: 'anthropic', openAtLogin: false, configuredProviders: [], connections: [{ name: 'a', kind: 'slack', ...extra }], encryptionAvailable: true, oauth: { available: false, accounts: [] } })
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot', account: 'rill-bot in Acme', channel: '#a' } }))).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot' } }))).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot', confirmed: true } }))).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot', confirmed: false } }))).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot', confirmed: 'yes' } }))).toBe(false)
    expect(validateResult(CHANNELS.settingsGet, connection({}))).toBe(true)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot', token: TOKEN } }))).toBe(false)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'user' } }))).toBe(false)
    expect(validateResult(CHANNELS.settingsGet, connection({ slack: { mode: 'bot', account: 'x'.repeat(201) } }))).toBe(false)
  })
})

describe('ipc handler: setSlackBot', () => {
  it('checks once with the token, saves a valid bot and returns the verdict with the workspace and the bot', async () => {
    const h = harness()
    expect(await h.setBot({ channel: '#alerts' })).toEqual({ verdict: VALID })
    expect(h.slackCheck).toHaveBeenCalledTimes(1)
    expect(h.slackCheck).toHaveBeenCalledWith(TOKEN)
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    expect((await h.settings()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Acme', channel: '#alerts' } }])
  })

  it('stores a secret that the engine parser reads as a bot, with and without a default channel', async () => {
    const h = harness()
    await h.setBot({ channel: '#alerts' })
    await h.setBot({ name: 'plain' })
    const stored = await h.secrets.getConnections()
    expect(parseSlackSecret(stored.find((entry) => entry.name === 'alerts')!.secret)).toEqual({ kind: 'bot', token: TOKEN, channel: '#alerts' })
    expect(parseSlackSecret(stored.find((entry) => entry.name === 'plain')!.secret)).toEqual({ kind: 'bot', token: TOKEN })
    expect(stored.find((entry) => entry.name === 'plain')!.slack).toEqual({ mode: 'bot', confirmed: true, account: 'rill-bot in Acme' })
  })

  it('saves an unverified token without an account and returns the reason', async () => {
    const h = harness({ verdict: { status: 'unverified', reason: 'timeout' } })
    expect(await h.setBot()).toEqual({ verdict: { status: 'unverified', reason: 'timeout' } })
    expect((await h.settings()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: false } }])
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('marks a valid token as confirmed even when Slack names neither workspace nor bot', async () => {
    const h = harness({ verdict: { status: 'valid' } })
    await h.setBot()
    expect((await h.settings()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true } }])
  })

  it('records a later confirmation of the same token and restarts the engine for it', async () => {
    const h = harness({ verdict: { status: 'unverified', reason: 'network' } })
    await h.setBot()
    h.slackCheck.mockResolvedValueOnce(VALID)
    await h.setBot()
    expect((await h.settings()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Acme' } }])
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
  })

  it('refuses an invalid token with TOKEN_INVALID, saves nothing and does not restart the engine', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    const error = await failure(h.setBot())
    expect(code(error)).toBe('TOKEN_INVALID')
    expect(error.message).toBe('TOKEN_INVALID')
    expect((await h.settings()).connections).toEqual([])
    expect(await h.secrets.getConnections()).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('keeps an earlier bot of the same name when the new token is refused', async () => {
    const h = harness()
    await h.setBot({ channel: '#a' })
    h.slackCheck.mockResolvedValueOnce({ status: 'invalid', reason: 'unauthorized' })
    expect(code(await failure(h.setBot({ token: OTHER_TOKEN })))).toBe('TOKEN_INVALID')
    const [stored] = await h.secrets.getConnections()
    expect(parseSlackSecret(stored!.secret)).toEqual({ kind: 'bot', token: TOKEN, channel: '#a' })
  })

  it('saves a refused token when saveAnyway is true, and returns the invalid verdict', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect(await h.setBot({ options: { saveAnyway: true } })).toEqual({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect(h.slackCheck).toHaveBeenCalledTimes(1)
    expect((await h.settings()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: false } }])
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('refuses a refused token again when saveAnyway is false or empty', async () => {
    const h = harness({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect(code(await failure(h.setBot({ options: { saveAnyway: false } })))).toBe('TOKEN_INVALID')
    expect(code(await failure(h.setBot({ options: {} })))).toBe('TOKEN_INVALID')
  })

  it('does not restart the engine when the same bot is saved again', async () => {
    const h = harness()
    await h.setBot({ channel: '#a' })
    await h.setBot({ channel: '#a' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    await h.setBot({ channel: '#b' })
    expect(h.supervisor.restart).toHaveBeenCalledTimes(2)
  })

  it('does not check or send anything without a keychain', async () => {
    const h = harness({ available: false })
    const error = await failure(h.setBot())
    expect(code(error)).toBe('NO_KEYCHAIN')
    expect(h.slackCheck).not.toHaveBeenCalled()
  })

  it('rejects invalid arguments before any check', async () => {
    const h = harness()
    for (const args of [{ token: 'xoxp-abcdefghijklmnop' }, { channel: 'a b' }, { name: '' }, { extra: 1 }, { options: { force: 1 } }]) {
      expect(code(await failure(h.setBot(args)))).toBe('INVALID_ARGUMENTS')
    }
    expect(h.slackCheck).not.toHaveBeenCalled()
    expect(h.supervisor.restart).not.toHaveBeenCalled()
  })

  it('refuses a name that clashes with another connection of any kind, ignoring case, before the check', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'Alerts', kind: 'http', secret: 'abc' })
    expect(code(await failure(h.setBot({ name: 'alerts' })))).toBe('NAME_COLLISION')
    expect(code(await failure(h.setBot({ name: 'Alerts' })))).toBe('NAME_COLLISION')
    await h.call(CHANNELS.secretsSetConnection, { name: 'Hook', kind: 'webhookSecret', secret: 'abc' })
    expect(code(await failure(h.setBot({ name: 'hook' })))).toBe('NAME_COLLISION')
    expect(h.slackCheck).not.toHaveBeenCalled()
    expect((await h.secrets.getConnections()).map((entry) => entry.name)).toEqual(['Alerts', 'Hook'])
  })

  it('replaces a saved Slack webhook connection of the same name', async () => {
    const h = harness()
    await h.call(CHANNELS.secretsSetConnection, { name: 'team', kind: 'slack', secret: 'https://hooks.example.test/x' })
    await h.setBot({ name: 'team', channel: '#a' })
    expect((await h.settings()).connections).toEqual([{ name: 'team', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Acme', channel: '#a' } }])
  })

  it('turns a failing checker or a checker answer that is not a verdict into INTERNAL, and saves nothing', async () => {
    const logs: string[] = []
    const h = harness({ log: (line) => logs.push(line) })
    h.slackCheck.mockRejectedValueOnce(new Error(`checker broke ${TOKEN}`))
    const error = await failure(h.setBot())
    expect(code(error)).toBe('INTERNAL')
    expect(String(error.stack)).not.toContain('SLACKTOKENMARKER')
    h.slackCheck.mockResolvedValueOnce({ status: 'maybe' } as never)
    expect(code(await failure(h.setBot()))).toBe('INTERNAL')
    expect(await h.secrets.getConnections()).toEqual([])
    expect(h.supervisor.restart).not.toHaveBeenCalled()
    expect(JSON.stringify(logs)).not.toContain('SLACKTOKENMARKER')
  })

  describe('races', () => {
    function gated(h: ReturnType<typeof harness>, tokens: string[]): Record<string, (verdict?: SlackVerdict) => void> {
      const gates: Record<string, (verdict?: SlackVerdict) => void> = {}
      h.slackCheck.mockImplementation(
        (token) =>
          new Promise<SlackVerdict>((resolve) => {
            if (!tokens.includes(token)) return resolve(VALID)
            gates[token] = (verdict = VALID) => resolve(verdict)
          }),
      )
      return gates
    }

    it('keeps the newer token when an older slow check ends after it, and tells the older call it was superseded', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN])
      const first = h.setBot()
      await started(h, 1)
      expect(await h.setBot({ token: OTHER_TOKEN })).toEqual({ verdict: VALID })
      gates[TOKEN]!()
      const error = await failure(first)
      expect(code(error)).toBe('SUPERSEDED')
      expect(error.message).toBe('SUPERSEDED')
      const [stored] = await h.secrets.getConnections()
      expect(parseSlackSecret(stored!.secret)).toEqual({ kind: 'bot', token: OTHER_TOKEN })
      expect(h.supervisor.restart).toHaveBeenCalledTimes(1)
    })

    it('supersedes the older call even when it ends first and even when it was a refusal', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN, OTHER_TOKEN])
      const first = h.setBot()
      await started(h, 1)
      const second = h.setBot({ token: OTHER_TOKEN })
      await started(h, 2)
      gates[TOKEN]!({ status: 'invalid', reason: 'unauthorized' })
      expect(code(await failure(first))).toBe('SUPERSEDED')
      expect(await h.secrets.getConnections()).toEqual([])
      gates[OTHER_TOKEN]!()
      await second
      expect(await h.secrets.getConnections()).toHaveLength(1)
    })

    it('treats names that differ only by case as the same name', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN])
      const first = h.setBot({ name: 'Alerts' })
      await started(h, 1)
      const second = h.setBot({ name: 'Alerts', token: OTHER_TOKEN })
      await second
      gates[TOKEN]!()
      expect(code(await failure(first))).toBe('SUPERSEDED')
    })

    it('does not supersede a call for another name', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN])
      const first = h.setBot({ name: 'one' })
      await started(h, 1)
      await h.setBot({ name: 'two', token: OTHER_TOKEN })
      gates[TOKEN]!()
      await first
      expect((await h.secrets.getConnections()).map((entry) => entry.name).sort()).toEqual(['one', 'two'])
    })

    it('does not bring back a connection that was removed while its check was running', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN])
      const pending = h.setBot()
      await started(h, 1)
      await h.call(CHANNELS.secretsRemoveConnection, { name: 'alerts' })
      gates[TOKEN]!()
      expect(code(await failure(pending))).toBe('SUPERSEDED')
      expect(await h.secrets.getConnections()).toEqual([])
    })

    it('lets a later call save normally after a superseded one', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN])
      const first = h.setBot()
      await started(h, 1)
      await h.setBot({ token: OTHER_TOKEN })
      gates[TOKEN]!()
      await failure(first)
      expect(await h.setBot({ token: OTHER_TOKEN, channel: '#x' })).toEqual({ verdict: VALID })
    })

    it('does not count a call that fails before any check, such as one without a keychain', async () => {
      const h = harness()
      const gates = gated(h, [TOKEN])
      const first = h.setBot()
      await started(h, 1)
      h.safeStorage.available = false
      await failure(h.setBot({ token: OTHER_TOKEN }))
      h.safeStorage.available = true
      gates[TOKEN]!()
      await first
      expect(await h.secrets.getConnections()).toHaveLength(1)
    })
  })

  it('puts the token nowhere that leaves the host: results, errors, logs, settings and engine calls', async () => {
    const logs: string[] = []
    const h = harness({ log: (line) => logs.push(line) })
    const seen: unknown[] = []
    const verdicts: SlackVerdict[] = [VALID, { status: 'unverified', reason: 'network' }, { status: 'invalid', reason: 'unauthorized' }]
    for (const verdict of verdicts) {
      h.slackCheck.mockResolvedValueOnce(verdict)
      seen.push(await h.setBot({ name: verdict.status, channel: '#alerts' }).then((result) => result, (error: Error) => ({ message: error.message, stack: error.stack })))
    }
    seen.push(await h.settings())
    seen.push(await h.call(CHANNELS.engineInfo))
    expect(JSON.stringify([seen, logs, h.supervisor.restart.mock.calls, h.supervisor.info.mock.calls])).not.toContain('SLACKTOKENMARKER')
    expect(validateResult(CHANNELS.secretsSetSlackBot, seen[0])).toBe(true)
  })

  it('writes the token only inside the encrypted file', async () => {
    const h = harness()
    await h.setBot({ channel: '#alerts' })
    const files = readdirSync(join(dir, 'data'), { recursive: true }).map(String)
    for (const file of files) {
      let content: Buffer
      try {
        content = readFileSync(join(dir, 'data', file))
      } catch {
        continue
      }
      expect(content.toString('utf8'), file).not.toContain('SLACKTOKENMARKER')
    }
    expect(files.some((file) => file.endsWith('secrets.bin'))).toBe(true)
  })
})

describe('secret store: Slack metadata', () => {
  function stores() {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x33)),
      decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x33)).toString('utf8'),
    }
    const logs: string[] = []
    return { safeStorage, logs, open: () => createSecretStore({ dir, safeStorage, log: (line) => logs.push(line) }) }
  }
  const secret = encodeSlackBot({ token: TOKEN, channel: '#a' })

  it('keeps the metadata across a reload and puts it in the summary without the token', async () => {
    const { open } = stores()
    await open().setConnection({ name: 'alerts', kind: 'slack', secret, slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Acme', channel: '#a' } })
    const reopened = open()
    expect(await reopened.listConnections()).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Acme', channel: '#a' } }])
    expect(JSON.stringify(await reopened.listConnections())).not.toContain('SLACKTOKENMARKER')
    expect((await reopened.getConnections())[0]!.slack).toEqual({ mode: 'bot', confirmed: true, account: 'rill-bot in Acme', channel: '#a' })
  })

  it('loads a file written before the metadata existed, as a webhook without it', async () => {
    const { safeStorage, open } = stores()
    const legacy = JSON.stringify({ version: 1, providerKeys: [], connections: [{ name: 'team', kind: 'slack', secret: 'https://hooks.example.test/x' }] })
    writeFileSync(join(dir, 'secrets.bin'), safeStorage.encryptString(legacy))
    expect(await open().listConnections()).toEqual([{ name: 'team', kind: 'slack' }])
  })

  it('treats a file with malformed metadata as unreadable', async () => {
    const { safeStorage, open, logs } = stores()
    for (const slack of [{ mode: 'user' }, { mode: 'bot', confirmed: 'yes' }, { mode: 'bot', token: TOKEN }, { mode: 'bot', channel: 'a b' }, { mode: 'bot', account: 'x'.repeat(201) }, 'bot']) {
      writeFileSync(join(dir, 'secrets.bin'), safeStorage.encryptString(JSON.stringify({ version: 1, providerKeys: [], connections: [{ name: 'a', kind: 'slack', secret, slack }] })))
      const store = open()
      expect(await store.unreadable()).toBe(true)
      expect(await store.listConnections()).toEqual([])
    }
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain('SLACKTOKENMARKER')
  })

  it('refuses metadata on a connection that is not a Slack one, or metadata that is not valid', async () => {
    const { open } = stores()
    const store = open()
    await expect(store.setConnection({ name: 'a', kind: 'http', secret: 'x', slack: { mode: 'bot' } })).rejects.toMatchObject({ reason: 'invalid_value' })
    await expect(store.setConnection({ name: 'a', kind: 'slack', secret, slack: { mode: 'user' } as never })).rejects.toMatchObject({ reason: 'invalid_value' })
    await expect(store.setConnection({ name: 'a', kind: 'slack', secret, slack: { mode: 'bot', account: 'a\nb' } })).rejects.toMatchObject({ reason: 'invalid_value' })
    expect(await store.listConnections()).toEqual([])
  })

  it('counts a changed account as a change and an identical entry as none', async () => {
    const { open } = stores()
    const store = open()
    const base = { name: 'a', kind: 'slack' as const, secret }
    expect(await store.setConnection({ ...base, slack: { mode: 'bot', account: 'one' } })).toBe(true)
    expect(await store.setConnection({ ...base, slack: { mode: 'bot', account: 'one' } })).toBe(false)
    expect(await store.setConnection({ ...base, slack: { mode: 'bot', account: 'two' } })).toBe(true)
    expect(await store.setConnection({ ...base, slack: { mode: 'bot' } })).toBe(true)
    expect(await store.setConnection({ ...base, slack: { mode: 'bot', confirmed: false } })).toBe(true)
    expect(await store.setConnection({ ...base, slack: { mode: 'bot', confirmed: false } })).toBe(false)
    expect(await store.setConnection({ ...base, slack: { mode: 'bot', confirmed: true } })).toBe(true)
    expect(await store.setConnection({ ...base })).toBe(true)
    expect(await store.listConnections()).toEqual([{ name: 'a', kind: 'slack' }])
  })
})

describe('preload: setSlackBot', () => {
  function fakeIpc(results: Record<string, unknown> = {}) {
    const calls: Array<[string, ...unknown[]]> = []
    const ipc: IpcLike = {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        calls.push([channel, ...args])
        const value = results[channel]
        if (value instanceof Error) throw value
        return value
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    }
    return { ipc, calls }
  }

  it('sends the contract shape, with the options only when given', async () => {
    const { ipc, calls } = fakeIpc({ [CHANNELS.secretsSetSlackBot]: { verdict: VALID } })
    const api = createHostApi(ipc)
    expect(await api.secrets.setSlackBot({ name: 'alerts', token: TOKEN })).toEqual({ verdict: VALID })
    await api.secrets.setSlackBot({ name: 'alerts', token: TOKEN, channel: '#a' }, { saveAnyway: true })
    expect(calls).toEqual([
      [CHANNELS.secretsSetSlackBot, { name: 'alerts', token: TOKEN }],
      [CHANNELS.secretsSetSlackBot, { name: 'alerts', token: TOKEN, channel: '#a', options: { saveAnyway: true } }],
    ])
  })

  it('refuses invalid arguments before they leave the preload', async () => {
    const { ipc, calls } = fakeIpc()
    const api = createHostApi(ipc)
    const attempts = [
      api.secrets.setSlackBot({ name: 'a', token: 'xoxp-abcdefghijklmnop' }),
      api.secrets.setSlackBot({ name: 'a', token: TOKEN, channel: 'a b' }),
      api.secrets.setSlackBot({ name: 'a', token: TOKEN }, { force: true } as never),
    ]
    for (const attempt of attempts) expect(hostErrorCode(await attempt.then(() => undefined, (error: unknown) => error))).toBe('INVALID_ARGUMENTS')
    expect(calls).toEqual([])
  })

  it('lets TOKEN_INVALID cross as the code only, and rejects a result that is not a result', async () => {
    const refused = new Error(`Error invoking remote method 'rill:secrets:set-slack-bot': Error: TOKEN_INVALID ${TOKEN}`)
    const error = await createHostApi(fakeIpc({ [CHANNELS.secretsSetSlackBot]: refused }).ipc).secrets.setSlackBot({ name: 'a', token: TOKEN }).catch((caught: Error) => caught)
    expect(hostErrorCode(error)).toBe('TOKEN_INVALID')
    expect((error as Error).message).toBe('TOKEN_INVALID')
    expect(String((error as Error).stack)).not.toContain('SLACKTOKENMARKER')
    const wrong = await createHostApi(fakeIpc({ [CHANNELS.secretsSetSlackBot]: { verdict: { status: 'maybe' } } }).ipc).secrets.setSlackBot({ name: 'a', token: TOKEN }).catch((caught: Error) => caught)
    expect(hostErrorCode(wrong)).toBe('INTERNAL')
  })
})
