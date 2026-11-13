import { describe, expect, it } from 'vitest'
import { createFakeHost, fakeSettings } from '../src/engine/fake-host'
import { HostError, hostErrorCode, type CustomAuth } from '../src/shared/host-api'

const MARKER = 'CONN-SECRET-MARKER'

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(HostError)
    return hostErrorCode(error)
  }
  throw new Error('expected a rejection')
}

const AUTHS: CustomAuth[] = [
  { type: 'none' },
  { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: MARKER },
  { type: 'apiKey', in: 'query', name: 'api_key', value: MARKER },
  { type: 'bearer', token: MARKER },
  { type: 'basic', username: 'someone', password: MARKER },
]

describe('createFakeHost custom connections', () => {
  it.each(AUTHS)('keeps only the name, the http kind and the auth type of %j', async (auth) => {
    const host = createFakeHost()
    await host.secrets.setCustomConnection({ name: 'My API', auth })
    expect((await host.settings.get()).connections).toEqual([{ name: 'My API', kind: 'http', authType: auth.type }])
    expect(JSON.stringify([await host.settings.get(), host.state()])).not.toContain(MARKER)
    expect(host.state().restartCalls).toBe(1)
  })

  it('replaces a custom connection of the same name and keeps one entry', async () => {
    const host = createFakeHost()
    await host.secrets.setCustomConnection({ name: 'My API', auth: AUTHS[3]! })
    await host.secrets.setCustomConnection({ name: 'My API', auth: AUTHS[4]! })
    expect((await host.settings.get()).connections).toEqual([{ name: 'My API', kind: 'http', authType: 'basic' }])
  })

  it('refuses a name that collides with a connection of any kind, in any case', async () => {
    const host = createFakeHost()
    await host.secrets.setConnection({ name: 'Team', kind: 'slack', secret: 'https://hooks.example.test/x' })
    await host.secrets.setCustomConnection({ name: 'My API', auth: AUTHS[3]! })
    for (const name of ['Team', 'team', 'MY API']) expect(await codeOf(host.secrets.setCustomConnection({ name, auth: AUTHS[3]! }))).toBe('NAME_COLLISION')
    expect((await host.settings.get()).connections).toHaveLength(2)
  })

  it('refuses invalid auth, unknown fields and a missing keychain', async () => {
    const host = createFakeHost()
    for (const connection of [
      { name: 'a', auth: { type: 'apiKey', in: 'header', name: 'Host', value: 'v' } },
      { name: 'a', auth: { type: 'bearer', token: '' } },
      { name: 'a', auth: { type: 'basic', username: 'a:b', password: 'x' } },
      { name: 'a', auth: { type: 'bearer', token: 'x', extra: 1 } },
      { name: 'a', auth: AUTHS[3], kind: 'slack' },
      { name: '', auth: AUTHS[3] },
      { name: 'a' },
    ]) {
      expect(await codeOf(host.secrets.setCustomConnection(connection as never))).toBe('INVALID_ARGUMENTS')
    }
    expect((await host.settings.get()).connections).toEqual([])
    const locked = createFakeHost({ settings: fakeSettings({ encryptionAvailable: false }) })
    expect(await codeOf(locked.secrets.setCustomConnection({ name: 'a', auth: AUTHS[3]! }))).toBe('NO_KEYCHAIN')
  })
})

describe('createFakeHost oauth', () => {
  it('starts unavailable and rejects connect with OAUTH_UNAVAILABLE', async () => {
    const host = createFakeHost()
    expect((await host.settings.get()).oauth).toEqual({ available: false, accounts: [] })
    expect(await codeOf(host.oauth.connect('google'))).toBe('OAUTH_UNAVAILABLE')
    await host.oauth.disconnect('google')
    expect((await host.settings.get()).oauth).toEqual({ available: false, accounts: [] })
  })

  it('simulates a connect and a disconnect when it is available', async () => {
    const host = createFakeHost({ settings: fakeSettings({ oauth: { available: true, accounts: [] } }) })
    await host.oauth.connect('google')
    await host.oauth.connect('slack')
    await host.oauth.connect('google')
    const accounts = (await host.settings.get()).oauth.accounts
    expect(accounts.map((entry) => entry.provider)).toEqual(['google', 'slack'])
    expect(accounts.every((entry) => typeof entry.account === 'string' && entry.account.length > 0)).toBe(true)
    await host.oauth.disconnect('google')
    expect((await host.settings.get()).oauth.accounts.map((entry) => entry.provider)).toEqual(['slack'])
    await host.oauth.disconnect('microsoft')
    expect((await host.settings.get()).oauth.accounts).toHaveLength(1)
  })

  it('refuses an unknown provider', async () => {
    const host = createFakeHost({ settings: fakeSettings({ oauth: { available: true, accounts: [] } }) })
    expect(await codeOf(host.oauth.connect('github' as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.oauth.disconnect('github' as never))).toBe('INVALID_ARGUMENTS')
  })
})
