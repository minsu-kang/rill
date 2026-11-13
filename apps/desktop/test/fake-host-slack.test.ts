import { describe, expect, it, vi } from 'vitest'
import { createFakeHost, fakeSettings, type FakeSlackCheck } from '../src/engine/fake-host'
import { HostError, hostErrorCode, type SlackVerdict } from '../src/shared/host-api'

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const OTHER = 'xoxb-SLACKTOKENMARKER9999'

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(HostError)
    return hostErrorCode(error)
  }
  throw new Error('expected a rejection')
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createFakeHost setSlackBot', () => {
  it('checks with the default valid verdict, keeps only the summary and restarts the engine', async () => {
    const host = createFakeHost()
    expect(await host.secrets.setSlackBot({ name: 'alerts', token: TOKEN, channel: '#alerts' })).toEqual({
      verdict: { status: 'valid', workspace: 'Rill Team', bot: 'rill-bot' },
    })
    expect((await host.settings.get()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', account: 'rill-bot in Rill Team', channel: '#alerts' } }])
    expect(JSON.stringify([await host.settings.get(), host.state()])).not.toContain('SLACKTOKENMARKER')
    expect(host.state().restartCalls).toBe(1)
  })

  it('asks the slackChecks function with the token and saves an unverified result without an account', async () => {
    const slackChecks = vi.fn<FakeSlackCheck>(() => ({ status: 'unverified', reason: 'network' }))
    const host = createFakeHost({}, { slackChecks })
    expect(await host.secrets.setSlackBot({ name: 'alerts', token: TOKEN })).toEqual({ verdict: { status: 'unverified', reason: 'network' } })
    expect(slackChecks).toHaveBeenCalledWith(TOKEN)
    expect((await host.settings.get()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot' } }])
  })

  it('refuses an invalid token with TOKEN_INVALID and saves nothing, unless saveAnyway is true', async () => {
    const host = createFakeHost({}, { slackChecks: () => ({ status: 'invalid', reason: 'unauthorized' }) })
    expect(await codeOf(host.secrets.setSlackBot({ name: 'alerts', token: TOKEN }))).toBe('TOKEN_INVALID')
    expect(await codeOf(host.secrets.setSlackBot({ name: 'alerts', token: TOKEN }, { saveAnyway: false }))).toBe('TOKEN_INVALID')
    expect((await host.settings.get()).connections).toEqual([])
    expect(host.state().restartCalls).toBe(0)
    expect(await host.secrets.setSlackBot({ name: 'alerts', token: TOKEN }, { saveAnyway: true })).toEqual({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect((await host.settings.get()).connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot' } }])
  })

  it('validates the arguments like the real host', async () => {
    const host = createFakeHost()
    const bad: unknown[] = [
      { name: '', token: TOKEN },
      { name: 'a', token: 'xoxp-abcdefghijklmnop' },
      { name: 'a', token: TOKEN, channel: 'a b' },
      { name: 'a', token: TOKEN, channel: '' },
      { name: 'a', token: TOKEN, channel: '#a\uD800' },
      { name: 'a', token: TOKEN, extra: 1 },
    ]
    for (const args of bad) expect(await codeOf(host.secrets.setSlackBot(args as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.secrets.setSlackBot({ name: 'a', token: TOKEN }, { force: true } as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.secrets.setSlackBot({ name: 'a', token: TOKEN }, { saveAnyway: 'yes' } as never))).toBe('INVALID_ARGUMENTS')
  })

  it('needs a keychain and checks nothing without one', async () => {
    const slackChecks = vi.fn<FakeSlackCheck>(() => ({ status: 'valid' }))
    const host = createFakeHost({ settings: fakeSettings({ encryptionAvailable: false }) }, { slackChecks })
    expect(await codeOf(host.secrets.setSlackBot({ name: 'a', token: TOKEN }))).toBe('NO_KEYCHAIN')
    expect(slackChecks).not.toHaveBeenCalled()
  })

  it('refuses a name of another kind or one that differs only by case, and replaces a Slack connection', async () => {
    const host = createFakeHost()
    await host.secrets.setConnection({ name: 'Api', kind: 'http', secret: 'abc' })
    expect(await codeOf(host.secrets.setSlackBot({ name: 'api', token: TOKEN }))).toBe('NAME_COLLISION')
    expect(await codeOf(host.secrets.setSlackBot({ name: 'Api', token: TOKEN }))).toBe('NAME_COLLISION')
    await host.secrets.setConnection({ name: 'team', kind: 'slack', secret: 'https://hooks.example.test/x' })
    await host.secrets.setSlackBot({ name: 'team', token: TOKEN, channel: '#a' })
    expect((await host.settings.get()).connections.find((entry) => entry.name === 'team')).toEqual({ name: 'team', kind: 'slack', slack: { mode: 'bot', account: 'rill-bot in Rill Team', channel: '#a' } })
  })

  it('answers a verdict that is not one with INTERNAL', async () => {
    const host = createFakeHost({}, { slackChecks: () => ({ status: 'maybe' }) as never })
    expect(await codeOf(host.secrets.setSlackBot({ name: 'a', token: TOKEN }))).toBe('INTERNAL')
  })

  it('lets a newer call for the same name win over an older slow one', async () => {
    const gates: Record<string, (verdict: SlackVerdict) => void> = {}
    const slackChecks: FakeSlackCheck = (token) => (token === TOKEN ? new Promise<SlackVerdict>((resolve) => (gates[token] = resolve)) : { status: 'valid' })
    const host = createFakeHost({}, { slackChecks })
    const first = host.secrets.setSlackBot({ name: 'alerts', token: TOKEN })
    await tick()
    await host.secrets.setSlackBot({ name: 'ALERTS', token: OTHER }).catch(() => undefined)
    gates[TOKEN]!({ status: 'valid' })
    expect(await codeOf(first)).toBe('SUPERSEDED')
    expect((await host.settings.get()).connections).toHaveLength(1)
  })

  it('does not bring back a connection removed while its check ran', async () => {
    let release: (verdict: SlackVerdict) => void = () => undefined
    const host = createFakeHost({}, { slackChecks: () => new Promise<SlackVerdict>((resolve) => (release = resolve)) })
    const pending = host.secrets.setSlackBot({ name: 'alerts', token: TOKEN })
    await tick()
    await host.secrets.removeConnection('alerts')
    release({ status: 'valid' })
    expect(await codeOf(pending)).toBe('SUPERSEDED')
    expect((await host.settings.get()).connections).toEqual([])
  })

  it('has no Slack OAuth account any more', async () => {
    const host = createFakeHost({ settings: fakeSettings({ oauth: { available: true, accounts: [] } }) })
    expect(await codeOf(host.oauth.connect('slack' as never))).toBe('INVALID_ARGUMENTS')
    await host.oauth.connect('google')
    await host.oauth.connect('microsoft')
    expect((await host.settings.get()).oauth.accounts.map((entry) => entry.provider)).toEqual(['google', 'microsoft'])
  })
})
