// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, createConfigStore, type FsLike } from '../src/main/config-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const file = () => join(dir, 'config.json')
const DEFAULTS = { allowedFolders: [], provider: 'anthropic', model: undefined, openAtLogin: false }

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof ConfigError ? error.reason : 'not a ConfigError'
  }
  return undefined
}

describe('config store: reading', () => {
  it('returns the defaults when there is no file, without creating one', async () => {
    const store = createConfigStore({ dir })
    expect(await store.get()).toEqual(DEFAULTS)
    expect(readdirSync(dir)).toEqual([])
  })

  it('reads a saved file and drops unknown keys', async () => {
    writeFileSync(file(), JSON.stringify({ allowedFolders: ['/a'], provider: 'openai', model: 'gpt-6.1-sol', openAtLogin: true, extra: 'x', apiKey: 'nope' }))
    const config = await createConfigStore({ dir }).get()
    expect(config).toEqual({ allowedFolders: ['/a'], provider: 'openai', model: 'gpt-6.1-sol', openAtLogin: true })
    expect(Object.keys(config).sort()).toEqual(['allowedFolders', 'model', 'openAtLogin', 'provider'])
  })

  it.each([['not json {'], ['[]'], ['"text"'], ['null'], [JSON.stringify({ provider: 'azure' })], [JSON.stringify({ allowedFolders: ['relative/path'] })], [JSON.stringify({ openAtLogin: 'yes' })], [JSON.stringify({ provider: 'openai' })]])(
    'falls back to the defaults for a corrupt or invalid file and keeps it as config.json.bak: %s',
    async (text) => {
      writeFileSync(file(), text)
      const config = await createConfigStore({ dir }).get()
      expect(config).toEqual(DEFAULTS)
      expect(readFileSync(join(dir, 'config.json.bak'), 'utf8')).toBe(text)
    },
  )
})

describe('config store: folders', () => {
  it('de-duplicates, removes trailing separators and keeps the order', async () => {
    const store = createConfigStore({ dir })
    const { after } = await store.update({ allowedFolders: ['/a/b/', '/c', '/a/b', '//a//b'] })
    expect(after.allowedFolders).toEqual(['/a/b', '/c'])
  })

  it('accepts exactly 50 folders and refuses 51', async () => {
    const store = createConfigStore({ dir })
    const fifty = Array.from({ length: 50 }, (_, i) => `/folder${i}`)
    expect((await store.update({ allowedFolders: fifty })).after.allowedFolders).toHaveLength(50)
    expect(await reason(store.update({ allowedFolders: [...fifty, '/one-more'] }))).toBe('too_many_folders')
    expect((await store.get()).allowedFolders).toHaveLength(50)
  })

  it('refuses relative folders, .. segments, NUL bytes and over-long paths, and changes nothing', async () => {
    const store = createConfigStore({ dir })
    await store.update({ allowedFolders: ['/keep'] })
    for (const bad of ['relative', './here', '~/docs', '/a/../b', '/a/..', '..', '/a\u0000b', `/${'x'.repeat(1030)}`, '']) {
      expect(await reason(store.update({ allowedFolders: ['/ok', bad] })), JSON.stringify(bad)).toBe('invalid_folder')
    }
    expect((await store.get()).allowedFolders).toEqual(['/keep'])
    expect(JSON.parse(readFileSync(file(), 'utf8')).allowedFolders).toEqual(['/keep'])
  })

  it('keeps a folder name that merely contains two dots', async () => {
    const { after } = await createConfigStore({ dir }).update({ allowedFolders: ['/a/b..c', '/a/..d'] })
    expect(after.allowedFolders).toEqual(['/a/b..c', '/a/..d'])
  })
})

describe('config store: folders that would widen access too far', () => {
  let home: string
  let data: string

  beforeEach(() => {
    home = join(dir, 'home')
    data = join(home, 'Library', 'Application Support', 'Rill')
    mkdirSync(data, { recursive: true })
  })

  const store = () => createConfigStore({ dir: data, homeDir: home })

  it.each([['/'], ['/System'], ['/Library'], ['/usr'], ['/bin'], ['/etc'], ['/Users'], ['/Applications'], ['/Volumes']])('refuses the system folder %s', async (folder) => {
    expect(await reason(store().update({ allowedFolders: [folder] }))).toBe('invalid_folder')
  })

  it('refuses the home folder, a folder above it, and the folders that hold or are the data folder', async () => {
    for (const folder of [home, dirname(home), join(home, 'Library'), join(home, 'Library', 'Application Support'), data]) {
      expect(await reason(store().update({ allowedFolders: [folder] })), folder).toBe('invalid_folder')
    }
    expect((await store().get()).allowedFolders).toEqual([])
  })

  it('refuses the home folder and the folders above it also when the data folder is somewhere else', async () => {
    const elsewhere = join(dir, 'elsewhere', 'data')
    const myHome = join(dir, 'people', 'me')
    mkdirSync(myHome, { recursive: true })
    const apart = createConfigStore({ dir: elsewhere, homeDir: myHome })
    for (const folder of [myHome, dirname(myHome)]) expect(await reason(apart.update({ allowedFolders: [folder] })), folder).toBe('invalid_folder')
    expect((await apart.update({ allowedFolders: [join(myHome, 'Documents')] })).after.allowedFolders).toEqual([join(myHome, 'Documents')])
  })

  it('refuses a link that leads to one of them', async () => {
    const link = join(dir, 'looks-harmless')
    symlinkSync(join(home, 'Library'), link)
    expect(await reason(store().update({ allowedFolders: [link] }))).toBe('invalid_folder')
    const toRoot = join(dir, 'to-root')
    symlinkSync('/', toRoot)
    expect(await reason(store().update({ allowedFolders: [toRoot] }))).toBe('invalid_folder')
  })

  it('refuses a folder that holds the data folder even when it does not exist yet', async () => {
    const fresh = createConfigStore({ dir: join(dir, 'not-there', 'data'), homeDir: join(dir, 'other-home') })
    expect(await reason(fresh.update({ allowedFolders: [join(dir, 'not-there')] }))).toBe('invalid_folder')
  })

  it('keeps the other folders of home, the attachment folder and folders that merely look similar', async () => {
    const folders = [join(home, 'Documents'), join(home, 'Library', 'Application Support', 'Rill', 'attachments'), `${data}-other`, join(home, 'Library', 'Application Support', 'Rill2'), '/usr/local/share/data']
    expect((await store().update({ allowedFolders: folders })).after.allowedFolders).toEqual(folders)
  })

  it('falls back to the defaults, keeping the file, when the saved file holds such a folder', async () => {
    const text = JSON.stringify({ version: 1, allowedFolders: ['/ok', '/'], provider: 'anthropic', openAtLogin: false })
    writeFileSync(join(data, 'config.json'), text)
    expect((await store().get()).allowedFolders).toEqual([])
    expect(readFileSync(join(data, 'config.json.bak'), 'utf8')).toBe(text)
  })
})

describe('config store: update', () => {
  it('reports the state before and after and saves the file with mode 0600 in a 0700 folder', async () => {
    const sub = join(dir, 'nested', 'data')
    const store = createConfigStore({ dir: sub })
    const { before, after } = await store.update({ openAtLogin: true })
    expect(before.openAtLogin).toBe(false)
    expect(after.openAtLogin).toBe(true)
    expect(statSync(join(sub, 'config.json')).mode & 0o777).toBe(0o600)
    expect(statSync(sub).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(join(sub, 'config.json'), 'utf8'))).toEqual({ version: 1, allowedFolders: [], provider: 'anthropic', openAtLogin: true })
  })

  it('does not write when nothing changes', async () => {
    const store = createConfigStore({ dir })
    await store.update({ openAtLogin: true })
    const writes: string[] = []
    const spying = createConfigStore({ dir, fs: { ...fsp, writeFile: ((path: string, ...rest: unknown[]) => (writes.push(path), (fsp.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest))) as FsLike['writeFile'] } })
    const result = await spying.update({ openAtLogin: true, provider: 'anthropic' })
    expect(result.before).toEqual(result.after)
    expect(writes).toEqual([])
  })

  it('clears the model with null, and clears the model when the provider changes without one', async () => {
    const store = createConfigStore({ dir })
    expect((await store.update({ model: 'claude-haiku-5-5' })).after.model).toBe('claude-haiku-5-5')
    expect((await store.update({ model: null })).after.model).toBeUndefined()
    await store.update({ model: 'claude-haiku-5-5' })
    expect((await store.update({ provider: 'openai', model: 'gpt-6.1-sol' })).after).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol' })
    expect((await store.update({ provider: 'anthropic' })).after).toMatchObject({ provider: 'anthropic', model: undefined })
  })

  it('refuses a provider other than anthropic without a model, and a bad model id', async () => {
    const store = createConfigStore({ dir })
    expect(await reason(store.update({ provider: 'gemini' }))).toBe('model_required')
    expect(await reason(store.update({ provider: 'gemini', model: 'Not A Model' }))).toBe('invalid_model')
    expect(await reason(store.update({ model: null, provider: 'meta' }))).toBe('model_required')
    expect((await store.get()).provider).toBe('anthropic')
  })

  it('keeps the old file when the rename fails, as after a crash between the temporary file and the rename', async () => {
    const good = createConfigStore({ dir })
    await good.update({ allowedFolders: ['/old'] })
    const before = readFileSync(file(), 'utf8')
    const crashing = createConfigStore({
      dir,
      fs: {
        ...fsp,
        rename: (async () => {
          throw new Error('power cut')
        }) as FsLike['rename'],
      },
    })
    await expect(crashing.update({ allowedFolders: ['/new'] })).rejects.toThrow('power cut')
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['config.json'])
    expect((await createConfigStore({ dir }).get()).allowedFolders).toEqual(['/old'])
    expect((await crashing.get()).allowedFolders).toEqual(['/old'])
  })

  it('serialises concurrent updates so none is lost', async () => {
    const store = createConfigStore({ dir })
    await Promise.all([store.update({ allowedFolders: ['/a'] }), store.update({ openAtLogin: true }), store.update({ provider: 'openai', model: 'gpt-6.1-sol' })])
    const read = JSON.parse(readFileSync(file(), 'utf8'))
    expect(read).toMatchObject({ allowedFolders: ['/a'], openAtLogin: true, provider: 'openai', model: 'gpt-6.1-sol' })
  })

  it('never stores anything that looks like a secret', async () => {
    mkdirSync(dir, { recursive: true })
    const store = createConfigStore({ dir })
    await store.update({ allowedFolders: ['/a'], provider: 'openai', model: 'gpt-6.1-sol', openAtLogin: true })
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8'))).sort()).toEqual(['allowedFolders', 'model', 'openAtLogin', 'provider', 'version'])
  })
})
