import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AttachmentRef } from '@rill/protocol'
import { MAX_FILE_NAME_LENGTH, MAX_PATH_LENGTH } from '../shared/host-api'
import { ensurePrivateDir, type FsLike } from './config-store'

export interface AttachmentStore {
  addFromPath(path: string): Promise<AttachmentRef>
  addFromBytes(input: { name: string; bytes: Uint8Array }): Promise<AttachmentRef>
}

export type AttachmentErrorReason = 'invalid_path' | 'unsupported_type' | 'too_large' | 'empty' | 'not_a_file' | 'symlink' | 'io'

export class AttachmentError extends Error {
  readonly reason: AttachmentErrorReason

  constructor(reason: AttachmentErrorReason) {
    super(reason)
    this.name = 'AttachmentError'
    this.reason = reason
  }
}

const MIB = 1024 * 1024
export const MAX_PDF_BYTES = 20 * MIB
export const MAX_IMAGE_BYTES = 3_932_160
export const MAX_TEXT_BYTES = 1 * MIB

interface TypeInfo {
  mediaType: AttachmentRef['mediaType']
  extension: string
  limit: number
}

const TYPES: Readonly<Record<string, TypeInfo>> = {
  pdf: { mediaType: 'application/pdf', extension: 'pdf', limit: MAX_PDF_BYTES },
  png: { mediaType: 'image/png', extension: 'png', limit: MAX_IMAGE_BYTES },
  jpg: { mediaType: 'image/jpeg', extension: 'jpg', limit: MAX_IMAGE_BYTES },
  jpeg: { mediaType: 'image/jpeg', extension: 'jpg', limit: MAX_IMAGE_BYTES },
  gif: { mediaType: 'image/gif', extension: 'gif', limit: MAX_IMAGE_BYTES },
  webp: { mediaType: 'image/webp', extension: 'webp', limit: MAX_IMAGE_BYTES },
  txt: { mediaType: 'text/plain', extension: 'txt', limit: MAX_TEXT_BYTES },
  csv: { mediaType: 'text/csv', extension: 'csv', limit: MAX_TEXT_BYTES },
  md: { mediaType: 'text/markdown', extension: 'md', limit: MAX_TEXT_BYTES },
  markdown: { mediaType: 'text/markdown', extension: 'md', limit: MAX_TEXT_BYTES },
}

export const ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(TYPES)

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function displayName(raw: string): { name: string; type: TypeInfo } {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = Array.from(base)
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
  const dot = cleaned.lastIndexOf('.')
  const type = dot > 0 ? TYPES[cleaned.slice(dot + 1).toLowerCase()] : undefined
  if (type === undefined) throw new AttachmentError('unsupported_type')
  const extension = cleaned.slice(dot)
  const stem = cleaned.slice(0, dot)
  const name = cleaned.length > MAX_FILE_NAME_LENGTH ? `${stem.slice(0, MAX_FILE_NAME_LENGTH - extension.length)}${extension}` : cleaned
  return { name, type }
}

export function createAttachmentStore(deps: { dir: string; fs?: FsLike; randomId?: () => string }): AttachmentStore {
  const fs = deps.fs ?? fsp
  const randomId = deps.randomId ?? (() => randomBytes(16).toString('base64url'))

  function newId(): string {
    const id = randomId()
    if (!ID_PATTERN.test(id)) throw new AttachmentError('io')
    return id
  }

  async function finish(id: string, type: TypeInfo, temp: string, name: string, bytes: number): Promise<AttachmentRef> {
    const final = join(deps.dir, `${id}.${type.extension}`)
    if (await fs.lstat(final).then(() => true, () => false)) throw new AttachmentError('io')
    await fs.chmod(temp, 0o600)
    await fs.rename(temp, final)
    return { id, mediaType: type.mediaType, name, bytes }
  }

  async function guarded<T>(temp: string | undefined, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (temp !== undefined) await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error instanceof AttachmentError ? error : new AttachmentError('io')
    }
  }

  return {
    async addFromBytes(input) {
      if (typeof input.name !== 'string') throw new AttachmentError('invalid_path')
      const { name, type } = displayName(input.name)
      const size = input.bytes.byteLength
      if (size === 0) throw new AttachmentError('empty')
      if (size > type.limit) throw new AttachmentError('too_large')
      const id = newId()
      const temp = join(deps.dir, `.partial-${id}`)
      return guarded(temp, async () => {
        await ensurePrivateDir(fs, deps.dir)
        await fs.writeFile(temp, input.bytes, { mode: 0o600, flag: 'wx' })
        return finish(id, type, temp, name, size)
      })
    },

    async addFromPath(path) {
      if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\u0000') || !isAbsolute(path)) {
        throw new AttachmentError('invalid_path')
      }
      const { name, type } = displayName(basename(path))
      const id = newId()
      const temp = join(deps.dir, `.partial-${id}`)
      return guarded(temp, async () => {
        const entry = await fs.lstat(path)
        if (entry.isSymbolicLink()) throw new AttachmentError('symlink')
        if (!entry.isFile()) throw new AttachmentError('not_a_file')
        let source: Awaited<ReturnType<FsLike['open']>>
        try {
          source = await fs.open(path, OPEN_FLAGS)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new AttachmentError('symlink')
          throw error
        }
        try {
          const stat = await source.stat()
          if (!stat.isFile()) throw new AttachmentError('not_a_file')
          if (stat.size === 0) throw new AttachmentError('empty')
          if (stat.size > type.limit) throw new AttachmentError('too_large')
          await ensurePrivateDir(fs, deps.dir)
          const target = await fs.open(temp, 'wx', 0o600)
          let total = 0
          try {
            await pipeline(
              source.createReadStream(),
              new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  total += chunk.length
                  if (total > type.limit) callback(new AttachmentError('too_large'))
                  else callback(null, chunk)
                },
              }),
              target.createWriteStream(),
            )
          } finally {
            await target.close().catch(() => undefined)
          }
          if (total === 0) throw new AttachmentError('empty')
          return await finish(id, type, temp, name, total)
        } finally {
          await source.close().catch(() => undefined)
        }
      })
    },
  }
}
