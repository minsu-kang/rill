import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import Value from 'typebox/value'
import { MAX_FOLDERS, MAX_PATH_LENGTH, ModelSchema, PROVIDER_IDS, type ProviderId, type SettingsPatch } from '../shared/host-api'

export type FsLike = Pick<typeof fsp, 'mkdir' | 'readFile' | 'writeFile' | 'rename' | 'rm' | 'chmod' | 'lstat' | 'open'>

export interface AppConfig {
  allowedFolders: string[]
  provider: ProviderId
  model: string | undefined
  openAtLogin: boolean
}

export interface ConfigStore {
  get(): Promise<AppConfig>
  update(patch: SettingsPatch): Promise<{ before: AppConfig; after: AppConfig }>
}

export type ConfigErrorReason = 'invalid_folder' | 'too_many_folders' | 'invalid_model' | 'model_required' | 'write_failed'

export class ConfigError extends Error {
  readonly reason: ConfigErrorReason

  constructor(reason: ConfigErrorReason) {
    super(reason)
    this.name = 'ConfigError'
    this.reason = reason
  }
}

export async function writeFileAtomic(fs: FsLike, path: string, data: string | Uint8Array, mode: number): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temp, data, { mode })
    await fs.chmod(temp, mode)
    await fs.rename(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function ensurePrivateDir(fs: FsLike, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
}

function defaults(): AppConfig {
  return { allowedFolders: [], provider: 'anthropic', model: undefined, openAtLogin: false }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeFolder(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH || value.includes('\u0000') || !isAbsolute(value)) {
    throw new ConfigError('invalid_folder')
  }
  if (value.split(/[\\/]/).includes('..')) throw new ConfigError('invalid_folder')
  const cleaned = normalize(value)
  return cleaned.length > 1 && cleaned.endsWith(sep) ? cleaned.slice(0, -1) : cleaned
}

function normalizeFolders(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ConfigError('invalid_folder')
  const folders = [...new Set(value.map(normalizeFolder))]
  if (folders.length > MAX_FOLDERS) throw new ConfigError('too_many_folders')
  return folders
}

function validated(config: AppConfig): AppConfig {
  if (config.model !== undefined && !Value.Check(ModelSchema, config.model)) throw new ConfigError('invalid_model')
  if (config.provider !== 'anthropic' && config.model === undefined) throw new ConfigError('model_required')
  return config
}

function fromStored(value: unknown): AppConfig {
  if (!isObject(value)) throw new ConfigError('invalid_folder')
  const config = defaults()
  if (value.allowedFolders !== undefined) config.allowedFolders = normalizeFolders(value.allowedFolders)
  if (value.provider !== undefined) {
    if (typeof value.provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(value.provider)) throw new ConfigError('invalid_model')
    config.provider = value.provider as ProviderId
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') throw new ConfigError('invalid_model')
    config.model = value.model
  }
  if (value.openAtLogin !== undefined) {
    if (typeof value.openAtLogin !== 'boolean') throw new ConfigError('invalid_model')
    config.openAtLogin = value.openAtLogin
  }
  return validated(config)
}

function serialize(config: AppConfig): string {
  return `${JSON.stringify({
    version: 1,
    allowedFolders: config.allowedFolders,
    provider: config.provider,
    ...(config.model === undefined ? {} : { model: config.model }),
    openAtLogin: config.openAtLogin,
  })}\n`
}

function same(a: AppConfig, b: AppConfig): boolean {
  return a.provider === b.provider && a.model === b.model && a.openAtLogin === b.openAtLogin && a.allowedFolders.length === b.allowedFolders.length && a.allowedFolders.every((folder, index) => folder === b.allowedFolders[index])
}

function copy(config: AppConfig): AppConfig {
  return { ...config, allowedFolders: [...config.allowedFolders] }
}

export function createConfigStore(deps: { dir: string; fs?: FsLike }): ConfigStore {
  const fs = deps.fs ?? fsp
  const path = join(deps.dir, 'config.json')
  let cache: AppConfig | undefined
  let queue: Promise<unknown> = Promise.resolve()

  async function load(): Promise<AppConfig> {
    if (cache !== undefined) return cache
    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch {
      cache = defaults()
      return cache
    }
    try {
      cache = fromStored(JSON.parse(text))
    } catch {
      await fs.rename(path, `${path}.bak`).catch(() => undefined)
      cache = defaults()
    }
    return cache
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    get: () => serial(async () => copy(await load())),
    update: (patch) =>
      serial(async () => {
        const before = await load()
        const next = copy(before)
        if (patch.allowedFolders !== undefined) next.allowedFolders = normalizeFolders(patch.allowedFolders)
        if (patch.provider !== undefined && patch.provider !== before.provider) {
          next.provider = patch.provider
          next.model = undefined
        }
        if (patch.model !== undefined) next.model = patch.model === null ? undefined : patch.model
        if (patch.openAtLogin !== undefined) next.openAtLogin = patch.openAtLogin
        validated(next)
        if (same(before, next)) return { before: copy(before), after: copy(before) }
        await ensurePrivateDir(fs, deps.dir)
        await writeFileAtomic(fs, path, serialize(next), 0o600)
        cache = next
        return { before: copy(before), after: copy(next) }
      }),
  }
}
