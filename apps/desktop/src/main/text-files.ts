import { constants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { MAX_PATH_LENGTH, MAX_TEXT_FILE_BYTES, utf8Length } from '../shared/host-api'
import type { FsLike } from './config-store'

export type TextFileErrorReason = 'invalid_path' | 'too_large' | 'not_a_file' | 'symlink' | 'io'

export class TextFileError extends Error {
  readonly reason: TextFileErrorReason

  constructor(reason: TextFileErrorReason) {
    super(reason)
    this.name = 'TextFileError'
    this.reason = reason
  }
}

export interface TextFiles {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

function checkedPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\u0000') || !isAbsolute(path)) throw new TextFileError('invalid_path')
  return path
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

export function createTextFiles(deps: { fs?: FsLike } = {}): TextFiles {
  const fs = deps.fs ?? fsp

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof TextFileError) throw error
      if (isCode(error, 'ELOOP')) throw new TextFileError('symlink')
      throw new TextFileError('io')
    }
  }

  return {
    read: (given) =>
      guarded(async () => {
        const path = checkedPath(given)
        const entry = await fs.lstat(path)
        if (entry.isSymbolicLink()) throw new TextFileError('symlink')
        if (!entry.isFile()) throw new TextFileError('not_a_file')
        const handle = await fs.open(path, READ_FLAGS)
        try {
          const stat = await handle.stat()
          if (!stat.isFile()) throw new TextFileError('not_a_file')
          if (stat.size > MAX_TEXT_FILE_BYTES) throw new TextFileError('too_large')
          const buffer = Buffer.alloc(MAX_TEXT_FILE_BYTES + 1)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead > MAX_TEXT_FILE_BYTES) throw new TextFileError('too_large')
          return buffer.subarray(0, bytesRead).toString('utf8')
        } finally {
          await handle.close().catch(() => undefined)
        }
      }),

    write: (given, text) =>
      guarded(async () => {
        const path = checkedPath(given)
        if (typeof text !== 'string' || utf8Length(text) > MAX_TEXT_FILE_BYTES) throw new TextFileError('too_large')
        const existing = await fs.lstat(path).catch((error: unknown) => {
          if (isCode(error, 'ENOENT')) return undefined
          throw error
        })
        if (existing?.isSymbolicLink() === true) throw new TextFileError('symlink')
        if (existing !== undefined && !existing.isFile()) throw new TextFileError('not_a_file')
        const handle = await fs.open(path, WRITE_FLAGS, 0o644)
        try {
          await handle.writeFile(text, 'utf8')
        } finally {
          await handle.close().catch(() => undefined)
        }
      }),
  }
}
