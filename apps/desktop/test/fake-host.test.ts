import { describe, expect, it, vi } from 'vitest'
import { createFakeHost, fakeSettings } from '../src/engine/fake-host'
import { HostError, MAX_FOLDERS, MAX_SECRET_LENGTH, hostErrorCode, type EngineStatus, type KeyVerdict } from '../src/shared/host-api'

const MARKER = 'fake-secret-MARKER-0123456789'

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(HostError)
    return hostErrorCode(error)
  }
  throw new Error('expected a rejection')
}

describe('createFakeHost settings', () => {
  it('starts with the defaults and keeps what a patch changes', async () => {
    const host = createFakeHost()
    expect(await host.settings.get()).toEqual({ allowedFolders: [], provider: 'anthropic', openAtLogin: false, configuredProviders: [], connections: [], encryptionAvailable: true, oauth: { available: false, accounts: [] } })
    const next = await host.settings.update({ openAtLogin: true })
    expect(next.openAtLogin).toBe(true)
    expect((await host.settings.get()).openAtLogin).toBe(true)
  })

  it('returns copies, so a caller cannot change the state by editing a result', async () => {
    const host = createFakeHost({ settings: fakeSettings({ allowedFolders: ['/a'] }) })
    const first = await host.settings.get()
    first.allowedFolders.push('/b')
    expect((await host.settings.get()).allowedFolders).toEqual(['/a'])
    host.state().settings.allowedFolders.push('/c')
    expect((await host.settings.get()).allowedFolders).toEqual(['/a'])
  })

  it('accepts a folder only after the folder dialog returned it', async () => {
    const host = createFakeHost({ folderPicks: ['/Users/demo/Receipts'] })
    expect(await codeOf(host.settings.update({ allowedFolders: ['/Users/demo/Receipts'] }))).toBe('INVALID_SETTINGS')
    expect(await host.dialogs.pickFolder()).toBe('/Users/demo/Receipts')
    const next = await host.settings.update({ allowedFolders: ['/Users/demo/Receipts'] })
    expect(next.allowedFolders).toEqual(['/Users/demo/Receipts'])
    const removed = await host.settings.update({ allowedFolders: [] })
    expect(removed.allowedFolders).toEqual([])
  })

  it('answers a cancelled dialog with undefined, then walks through sample folders when nothing is queued', async () => {
    const host = createFakeHost({ folderPicks: [undefined] })
    expect(await host.dialogs.pickFolder()).toBeUndefined()
    const first = await host.dialogs.pickFolder()
    const second = await host.dialogs.pickFolder()
    expect(first).toMatch(/^\//)
    expect(second).not.toBe(first)
  })

  it('refuses more folders than the limit and a model that is not a model name', async () => {
    const folders = Array.from({ length: MAX_FOLDERS }, (_, index) => `/f${index}`)
    const host = createFakeHost({ settings: fakeSettings({ allowedFolders: folders }) })
    expect(await codeOf(host.settings.update({ allowedFolders: [...folders, '/extra'] }))).toBe('INVALID_SETTINGS')
    expect(await codeOf(host.settings.update({ model: 'Not A Model!' }))).toBe('INVALID_SETTINGS')
    expect(await codeOf(host.settings.update({ provider: 'openai' }))).toBe('INVALID_SETTINGS')
    const next = await host.settings.update({ provider: 'openai', model: 'gpt-5-mini' })
    expect([next.provider, next.model]).toEqual(['openai', 'gpt-5-mini'])
  })

  it('restarts the engine when the provider, the model or the folders change, and not for the login setting', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0 })
    await host.settings.update({ openAtLogin: true })
    expect(host.state().restartCalls).toBe(0)
    await host.settings.update({ model: 'claude-sonnet-5' })
    expect(host.state().restartCalls).toBe(1)
  })
})

describe('createFakeHost secrets', () => {
  it('keeps only flags and names, and exposes no way to read a secret back', async () => {
    const host = createFakeHost()
    await host.secrets.setProviderKey('anthropic', MARKER)
    await host.secrets.setConnection({ name: 'team-alerts', kind: 'slack', secret: `https://hooks.example.com/${MARKER}` })
    const settings = await host.settings.get()
    expect(settings.configuredProviders).toEqual(['anthropic'])
    expect(settings.connections).toEqual([{ name: 'team-alerts', kind: 'slack' }])
    const everything = JSON.stringify([settings, host.state(), Object.keys(host), Object.keys(host.secrets), String(host.secrets.setProviderKey)])
    expect(everything).not.toContain(MARKER)
    expect(everything).not.toContain('MARKER')
    expect(Object.keys(host.secrets).sort()).toEqual(['clearProviderKey', 'removeConnection', 'setConnection', 'setCustomConnection', 'setProviderKey', 'setSlackBot'])
  })

  it('clears a provider key and removes a connection, and refuses when there is no keychain', async () => {
    const host = createFakeHost()
    await host.secrets.setProviderKey('openai', MARKER)
    await host.secrets.clearProviderKey('openai')
    expect((await host.settings.get()).configuredProviders).toEqual([])
    await host.secrets.setConnection({ name: 'a', kind: 'http', secret: MARKER })
    await host.secrets.removeConnection('a')
    expect((await host.settings.get()).connections).toEqual([])
    const locked = createFakeHost({ settings: fakeSettings({ encryptionAvailable: false }) })
    expect(await codeOf(locked.secrets.setProviderKey('anthropic', MARKER))).toBe('NO_KEYCHAIN')
    expect(await codeOf(locked.secrets.setConnection({ name: 'a', kind: 'http', secret: MARKER }))).toBe('NO_KEYCHAIN')
  })

  it('refuses an empty secret, a connection name that differs only in case, and a kind it does not know', async () => {
    const host = createFakeHost()
    expect(await codeOf(host.secrets.setProviderKey('anthropic', ''))).toBe('INVALID_ARGUMENTS')
    await host.secrets.setConnection({ name: 'Team-Alerts', kind: 'slack', secret: MARKER })
    expect(await codeOf(host.secrets.setConnection({ name: 'team-alerts', kind: 'slack', secret: MARKER }))).toBe('NAME_COLLISION')
    expect(await codeOf(host.secrets.setConnection({ name: 'x', kind: 'ftp' as 'slack', secret: MARKER }))).toBe('INVALID_ARGUMENTS')
  })

  it('restarts the engine when the key of the chosen provider changes', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0 })
    await host.secrets.setProviderKey('openai', MARKER)
    expect(host.state().restartCalls).toBe(0)
    await host.secrets.setProviderKey('anthropic', MARKER)
    expect(host.state().restartCalls).toBe(1)
  })
})

describe('createFakeHost key checks', () => {
  it('answers valid by default and saves the key', async () => {
    const host = createFakeHost()
    expect(await host.secrets.setProviderKey('anthropic', MARKER)).toEqual({ verdict: { status: 'valid' } })
    expect((await host.settings.get()).configuredProviders).toEqual(['anthropic'])
  })

  it('asks the check function with the provider and the key, once per call', async () => {
    const keyChecks = vi.fn((): KeyVerdict => ({ status: 'unverified', reason: 'network' }))
    const host = createFakeHost({}, { keyChecks })
    expect(await host.secrets.setProviderKey('gemini', MARKER)).toEqual({ verdict: { status: 'unverified', reason: 'network' } })
    expect(keyChecks).toHaveBeenCalledTimes(1)
    expect(keyChecks).toHaveBeenCalledWith('gemini', MARKER)
    expect((await host.settings.get()).configuredProviders).toEqual(['gemini'])
  })

  it('waits for a check function that answers later', async () => {
    const host = createFakeHost({}, { keyChecks: async () => ({ status: 'valid' }) })
    expect(await host.secrets.setProviderKey('openai', MARKER)).toEqual({ verdict: { status: 'valid' } })
  })

  it('refuses an invalid key with KEY_INVALID and saves nothing, unless saveAnyway is true', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0, keyChecks: () => ({ status: 'invalid', reason: 'unauthorized' }) })
    expect(await codeOf(host.secrets.setProviderKey('anthropic', MARKER))).toBe('KEY_INVALID')
    expect(await codeOf(host.secrets.setProviderKey('anthropic', MARKER, { saveAnyway: false }))).toBe('KEY_INVALID')
    expect((await host.settings.get()).configuredProviders).toEqual([])
    expect(host.state().restartCalls).toBe(0)
    expect(await host.secrets.setProviderKey('anthropic', MARKER, { saveAnyway: true })).toEqual({ verdict: { status: 'invalid', reason: 'unauthorized' } })
    expect((await host.settings.get()).configuredProviders).toEqual(['anthropic'])
    expect(host.state().restartCalls).toBe(1)
  })

  it('refuses a malformed key with KEY_MALFORMED even with saveAnyway, and saves nothing', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0, keyChecks: () => ({ status: 'invalid', reason: 'malformed' }) })
    expect(await codeOf(host.secrets.setProviderKey('anthropic', MARKER))).toBe('KEY_MALFORMED')
    expect(await codeOf(host.secrets.setProviderKey('anthropic', MARKER, { saveAnyway: true }))).toBe('KEY_MALFORMED')
    expect((await host.settings.get()).configuredProviders).toEqual([])
    expect(host.state().restartCalls).toBe(0)
  })

  it('mirrors the real argument checks: unknown option, wrong type, over-long key, and no check before them', async () => {
    const keyChecks = vi.fn((): KeyVerdict => ({ status: 'valid' }))
    const host = createFakeHost({}, { keyChecks })
    expect(await codeOf(host.secrets.setProviderKey('anthropic', MARKER, { force: true } as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.secrets.setProviderKey('anthropic', MARKER, { saveAnyway: 'yes' } as never))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.secrets.setProviderKey('anthropic', 'k'.repeat(MAX_SECRET_LENGTH + 1)))).toBe('INVALID_ARGUMENTS')
    expect(await codeOf(host.secrets.setProviderKey('nope' as never, MARKER))).toBe('INVALID_ARGUMENTS')
    expect(keyChecks).not.toHaveBeenCalled()
  })

  it('does not check a key when there is no keychain, and refuses a function that does not return a verdict', async () => {
    const keyChecks = vi.fn((): KeyVerdict => ({ status: 'valid' }))
    const locked = createFakeHost({ settings: fakeSettings({ encryptionAvailable: false }) }, { keyChecks })
    expect(await codeOf(locked.secrets.setProviderKey('anthropic', MARKER))).toBe('NO_KEYCHAIN')
    expect(keyChecks).not.toHaveBeenCalled()
    const odd = createFakeHost({}, { keyChecks: () => ({ status: 'maybe' }) as never })
    expect(await codeOf(odd.secrets.setProviderKey('anthropic', MARKER))).toBe('INTERNAL')
    expect((await odd.settings.get()).configuredProviders).toEqual([])
  })
})

describe('createFakeHost engine', () => {
  it('reports status, notifies listeners and stops notifying after unsubscribe', async () => {
    const host = createFakeHost()
    const heard: EngineStatus[] = []
    const off = host.engine.onStatus((status) => heard.push(status))
    expect(host.state().statusListeners).toBe(1)
    host.setEngine({ state: 'stopped', error: 'crashed', restarts: 5 })
    expect(await host.engine.status()).toEqual({ state: 'stopped', error: 'crashed', restarts: 5 })
    off()
    expect(host.state().statusListeners).toBe(0)
    host.setEngine({ state: 'running', restarts: 6 })
    expect(heard).toEqual([{ state: 'stopped', error: 'crashed', restarts: 5 }])
  })

  it('walks from restarting to running with one more restart on restart()', async () => {
    vi.useFakeTimers()
    try {
      const host = createFakeHost({}, { restartDelayMs: 100 })
      const seen: string[] = []
      host.engine.onStatus((status) => seen.push(`${status.state}:${status.restarts}`))
      const done = host.engine.restart()
      expect(seen).toEqual(['restarting:0'])
      await vi.advanceTimersByTimeAsync(100)
      await done
      expect(seen).toEqual(['restarting:0', 'running:1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands out an address and a token for the fake world, never a real one', async () => {
    const info = await createFakeHost().engine.info()
    expect(info.url).toMatch(/^ws:\/\/127\.0\.0\.1:/)
    expect(info.token.length).toBeGreaterThan(0)
    expect(info.protocol).toBeGreaterThanOrEqual(1)
  })
})

describe('createFakeHost attachments', () => {
  it('keeps references in memory with the limits of the real store', async () => {
    const host = createFakeHost()
    const ref = await host.attachments.addFromBytes({ name: 'receipt.pdf', bytes: new Uint8Array([1, 2, 3]) })
    expect(ref).toMatchObject({ mediaType: 'application/pdf', name: 'receipt.pdf', bytes: 3 })
    expect(ref.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(host.state().attachments).toEqual([ref])
    expect(await codeOf(host.attachments.addFromBytes({ name: 'tool.exe', bytes: new Uint8Array([1]) }))).toBe('ATTACHMENT_REJECTED')
    expect(await codeOf(host.attachments.addFromBytes({ name: 'empty.txt', bytes: new Uint8Array() }))).toBe('ATTACHMENT_REJECTED')
    expect(await codeOf(host.attachments.addFromBytes({ name: 'big.txt', bytes: new Uint8Array(1024 * 1024 + 1) }))).toBe('ATTACHMENT_REJECTED')
    expect(await codeOf(host.attachments.addFromBytes({ name: 'x.png', bytes: 'not bytes' as unknown as Uint8Array }))).toBe('INVALID_ARGUMENTS')
  })

  it('adds a file by path only after the file dialog returned that path', async () => {
    const host = createFakeHost({ filePicks: ['/Users/demo/Receipts/a.png'] })
    expect(await codeOf(host.attachments.addFromPath('/Users/demo/Receipts/a.png'))).toBe('INVALID_ARGUMENTS')
    const path = await host.dialogs.pickFile('attachment')
    expect(path).toBe('/Users/demo/Receipts/a.png')
    const ref = await host.attachments.addFromPath(path!)
    expect(ref).toMatchObject({ mediaType: 'image/png', name: 'a.png' })
  })

  it('stops at the file count of the real store', async () => {
    const host = createFakeHost()
    for (let index = 0; index < 500; index += 1) await host.attachments.addFromBytes({ name: `f${index}.txt`, bytes: new Uint8Array([1]) })
    expect(await codeOf(host.attachments.addFromBytes({ name: 'one-more.txt', bytes: new Uint8Array([1]) }))).toBe('ATTACHMENT_REJECTED')
  })

  it('has an app.quit that does nothing', async () => {
    await expect(createFakeHost().app.quit()).resolves.toBeUndefined()
  })
})
