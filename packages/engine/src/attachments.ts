import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '@rill/nodes-core'

const ID = /^[A-Za-z0-9_-]{8,64}$/
const EXTENSION = /^[a-z0-9]{1,8}$/
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function findFile(root: string, id: string): string | undefined {
  const matches = readdirSync(root).filter((name) => name.startsWith(`${id}.`) && EXTENSION.test(name.slice(id.length + 1)))
  return matches.length === 1 ? join(root, matches[0]!) : undefined
}

function readRegularFile(path: string): Uint8Array | undefined {
  const fd = openSync(path, OPEN_FLAGS)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return undefined
    const buffer = Buffer.alloc(stat.size)
    let filled = 0
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, null)
      if (count === 0) break
      filled += count
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled)
  } finally {
    closeSync(fd)
  }
}

export interface FsAttachmentStore {
  read(id: string): Promise<Uint8Array | undefined>
}

export function createFsAttachmentStore(root: string): FsAttachmentStore {
  return {
    read: async (id) => {
      if (typeof id !== 'string' || !ID.test(id)) return undefined
      try {
        const path = findFile(root, id)
        return path === undefined ? undefined : readRegularFile(path)
      } catch {
        return undefined
      }
    },
  }
}
