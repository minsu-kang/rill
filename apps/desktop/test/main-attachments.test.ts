// @vitest-environment node
import { AttachmentRefSchema } from '@rill/protocol'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachmentError, MAX_FILES, MAX_TOTAL_BYTES, createAttachmentStore } from '../src/main/attachments'
import type { FsLike } from '../src/main/config-store'

const MIB = 1024 * 1024
const NAME = /^[A-Za-z0-9_-]{8,64}\.(pdf|png|jpg|gif|webp|txt|csv|md)$/

let root: string
let dir: string
let source: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rill-attach-'))
  dir = join(root, 'attachments')
  source = join(root, 'source')
  mkdirSync(source)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof AttachmentError ? error.reason : `not an AttachmentError: ${String(error)}`
  }
  return undefined
}

function listing(): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

function sparse(name: string, size: number): string {
  const path = join(source, name)
  writeFileSync(path, '')
  truncateSync(path, size)
  return path
}

describe('attachments: type detection', () => {
  it.each([
    ['a.pdf', 'application/pdf', 'pdf'],
    ['a.PDF', 'application/pdf', 'pdf'],
    ['a.png', 'image/png', 'png'],
    ['a.jpg', 'image/jpeg', 'jpg'],
    ['a.JPEG', 'image/jpeg', 'jpg'],
    ['a.gif', 'image/gif', 'gif'],
    ['a.webp', 'image/webp', 'webp'],
    ['a.txt', 'text/plain', 'txt'],
    ['a.csv', 'text/csv', 'csv'],
    ['a.md', 'text/markdown', 'md'],
    ['a.markdown', 'text/markdown', 'md'],
  ])('maps %s to %s and writes it as <id>.%s', async (name, mediaType, extension) => {
    const store = createAttachmentStore({ dir })
    const ref = await store.addFromBytes({ name, bytes: new Uint8Array([1, 2, 3]) })
    expect(ref).toMatchObject({ mediaType, name, bytes: 3 })
    expect(Value.Check(AttachmentRefSchema, ref)).toBe(true)
    expect(listing()).toEqual([`${ref.id}.${extension}`])
    expect([...readFileSync(join(dir, `${ref.id}.${extension}`))]).toEqual([1, 2, 3])
  })

  it('refuses a type that is not on the list, and takes the extension from the last dot only', async () => {
    const store = createAttachmentStore({ dir })
    for (const name of ['a.exe', 'a', 'a.', '.png.exe', 'a.txt.exe', 'a.svg', 'a.html', 'a.docx', '.txt']) {
      expect(await reason(store.addFromBytes({ name, bytes: new Uint8Array([1]) })), name).toBe('unsupported_type')
    }
    expect(listing().filter((entry) => !entry.startsWith('.'))).toEqual([])
  })

  it('never lets text from the user into the written file name', async () => {
    const store = createAttachmentStore({ dir })
    const ref = await store.addFromBytes({ name: '../../etc/passwd.txt', bytes: new Uint8Array([1]) })
    expect(ref.name).toBe('passwd.txt')
    expect(listing()).toHaveLength(1)
    expect(listing()[0]).toMatch(NAME)
  })

  it('cleans the display name of control characters and cuts it to 255 characters, keeping the extension', async () => {
    const store = createAttachmentStore({ dir })
    const odd = await store.addFromBytes({ name: 'a\u0000b\nc.txt', bytes: new Uint8Array([1]) })
    expect(odd.name).toBe('abc.txt')
    const long = await store.addFromBytes({ name: `${'a'.repeat(300)}.txt`, bytes: new Uint8Array([1]) })
    expect(long.name).toHaveLength(255)
    expect(long.name.endsWith('.txt')).toBe(true)
    expect(Value.Check(AttachmentRefSchema, long)).toBe(true)
  })
})

describe('attachments: size limits', () => {
  const cases = [
    ['PDF', 'a.pdf', 20 * MIB],
    ['image', 'a.png', 3_932_160],
    ['text', 'a.txt', 1 * MIB],
  ] as const

  it.each(cases)('%s: accepts exactly the limit and refuses one byte more, from bytes', async (_label, name, limit) => {
    const store = createAttachmentStore({ dir })
    expect((await store.addFromBytes({ name, bytes: new Uint8Array(limit) })).bytes).toBe(limit)
    expect(await reason(store.addFromBytes({ name, bytes: new Uint8Array(limit + 1) }))).toBe('too_large')
  })

  it.each(cases)('%s: accepts exactly the limit and refuses one byte more, from a path', async (_label, name, limit) => {
    const store = createAttachmentStore({ dir })
    const ref = await store.addFromPath(sparse(name, limit))
    expect(ref.bytes).toBe(limit)
    expect(statSync(join(dir, listing().find((entry) => entry.startsWith(ref.id))!)).size).toBe(limit)
    expect(await reason(store.addFromPath(sparse(`big-${name}`, limit + 1)))).toBe('too_large')
  })

  it('refuses an empty file and empty bytes', async () => {
    const store = createAttachmentStore({ dir })
    expect(await reason(store.addFromPath(sparse('empty.txt', 0)))).toBe('empty')
    expect(await reason(store.addFromBytes({ name: 'empty.txt', bytes: new Uint8Array(0) }))).toBe('empty')
  })

  it('leaves no file behind after a refusal', async () => {
    const store = createAttachmentStore({ dir })
    await reason(store.addFromPath(sparse('big.txt', MIB + 1)))
    await reason(store.addFromBytes({ name: 'big.txt', bytes: new Uint8Array(MIB + 1) }))
    expect(listing()).toEqual([])
  })
})

describe('attachments: paths', () => {
  it('copies a regular file with its content', async () => {
    const path = join(source, 'receipt.csv')
    writeFileSync(path, 'a,b\n1,2\n')
    const ref = await createAttachmentStore({ dir }).addFromPath(path)
    expect(ref).toMatchObject({ mediaType: 'text/csv', name: 'receipt.csv', bytes: 8 })
    expect(readFileSync(join(dir, `${ref.id}.csv`), 'utf8')).toBe('a,b\n1,2\n')
    expect(readFileSync(path, 'utf8')).toBe('a,b\n1,2\n')
  })

  it('refuses a symbolic link, a directory and a device', async () => {
    const store = createAttachmentStore({ dir })
    const real = join(source, 'real.txt')
    writeFileSync(real, 'x')
    symlinkSync(real, join(source, 'link.txt'))
    symlinkSync('/dev/null', join(source, 'null.txt'))
    mkdirSync(join(source, 'folder.txt'))
    expect(await reason(store.addFromPath(join(source, 'link.txt')))).toBe('symlink')
    expect(await reason(store.addFromPath(join(source, 'null.txt')))).toBe('symlink')
    expect(await reason(store.addFromPath(join(source, 'folder.txt')))).toBe('not_a_file')
    expect(listing()).toEqual([])
  })

  it('refuses a missing file, a relative path, an empty path and a NUL byte', async () => {
    const store = createAttachmentStore({ dir })
    expect(await reason(store.addFromPath(join(source, 'missing.txt')))).toBe('io')
    expect(await reason(store.addFromPath('relative/a.txt'))).toBe('invalid_path')
    expect(await reason(store.addFromPath(''))).toBe('invalid_path')
    expect(await reason(store.addFromPath(`${join(source, 'a.txt')}\u0000.png`))).toBe('invalid_path')
    expect(await reason(store.addFromPath(5 as unknown as string))).toBe('invalid_path')
  })

  it('refuses an unsupported type before touching the file', async () => {
    const reads: string[] = []
    const store = createAttachmentStore({ dir, fs: { ...fsp, lstat: ((path: string) => (reads.push(path), fsp.lstat(path))) as FsLike['lstat'] } })
    expect(await reason(store.addFromPath(join(source, 'secret.pem')))).toBe('unsupported_type')
    expect(reads).toEqual([])
  })
})

describe('attachments: folder and files', () => {
  it('creates the folder with mode 0700 and writes files with mode 0600, also when the folder existed with wider rights', async () => {
    mkdirSync(dir, { mode: 0o755 })
    const store = createAttachmentStore({ dir })
    const ref = await store.addFromBytes({ name: 'a.txt', bytes: new Uint8Array([1]) })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, `${ref.id}.txt`)).mode & 0o777).toBe(0o600)
    const fresh = join(root, 'a', 'b', 'attachments')
    writeFileSync(join(source, 'real.txt'), 'x')
    const second = await createAttachmentStore({ dir: fresh }).addFromPath(join(source, 'real.txt'))
    expect(statSync(fresh).mode & 0o777).toBe(0o700)
    expect(statSync(join(fresh, `${second.id}.txt`)).mode & 0o777).toBe(0o600)
  })

  it('gives every file a new id that matches the pattern the engine reads', async () => {
    const store = createAttachmentStore({ dir })
    const refs = await Promise.all(Array.from({ length: 20 }, () => store.addFromBytes({ name: 'a.txt', bytes: new Uint8Array([1]) })))
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(20)
    for (const ref of refs) expect(ref.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(listing().sort()).toEqual(refs.map((ref) => `${ref.id}.txt`).sort())
  })

  it('refuses an id from the generator that does not match the pattern', async () => {
    for (const id of ['short', '../escape-id', 'a b c d e f g h', 'x'.repeat(65), '']) {
      const store = createAttachmentStore({ dir, randomId: () => id })
      expect(await reason(store.addFromBytes({ name: 'a.txt', bytes: new Uint8Array([1]) })), id).toBe('io')
    }
    expect(listing()).toEqual([])
  })

  it('does not overwrite an existing file when an id repeats', async () => {
    const store = createAttachmentStore({ dir, randomId: () => 'fixed-id-0001' })
    await store.addFromBytes({ name: 'a.txt', bytes: new Uint8Array([1]) })
    expect(await reason(store.addFromBytes({ name: 'b.txt', bytes: new Uint8Array([2]) }))).toBe('io')
    expect([...readFileSync(join(dir, 'fixed-id-0001.txt'))]).toEqual([1])
  })
})

describe('attachments: streaming and cleanup', () => {
  it('copies a large file without reading it into memory', async () => {
    const calls: string[] = []
    const spying: FsLike = {
      ...fsp,
      readFile: ((...args: unknown[]) => {
        calls.push('readFile')
        return (fsp.readFile as (...a: unknown[]) => Promise<unknown>)(...args)
      }) as FsLike['readFile'],
    }
    const store = createAttachmentStore({ dir, fs: spying })
    const ref = await store.addFromPath(sparse('large.pdf', 19 * MIB))
    expect(ref.bytes).toBe(19 * MIB)
    expect(calls).toEqual([])
    expect(statSync(join(dir, `${ref.id}.pdf`)).size).toBe(19 * MIB)
  })

  it('removes the partial file when the rename fails', async () => {
    const store = createAttachmentStore({ dir, fs: { ...fsp, rename: (async () => { throw new Error('disk full') }) as FsLike['rename'] } })
    const path = join(source, 'a.txt')
    writeFileSync(path, 'hello')
    expect(await reason(store.addFromPath(path))).toBe('io')
    expect(await reason(store.addFromBytes({ name: 'a.txt', bytes: new Uint8Array([1]) }))).toBe('io')
    expect(listing()).toEqual([])
  })

  it('stops and removes the partial file when the file turns out larger than its size said', async () => {
    const path = join(source, 'grows.txt')
    writeFileSync(path, Buffer.alloc(2 * MIB, 97))
    const lying: FsLike = {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args)
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'stat') return async () => ({ ...(await target.stat()), size: 100, isFile: () => true })
            const value = Reflect.get(target, key) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      }) as FsLike['open'],
    }
    const store = createAttachmentStore({ dir, fs: lying })
    expect(await reason(store.addFromPath(path))).toBe('too_large')
    expect(listing()).toEqual([])
  })
})

describe('attachments: the folder has a size and a count limit', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7)

  it('refuses a new file that would take the folder over the total size, and keeps what is there', async () => {
    const store = createAttachmentStore({ dir, maxTotalBytes: 100 })
    await store.addFromBytes({ name: 'a.txt', bytes: bytes(60) })
    await store.addFromBytes({ name: 'b.txt', bytes: bytes(40) })
    expect(await reason(store.addFromBytes({ name: 'c.txt', bytes: bytes(1) }))).toBe('quota')
    expect(await reason(store.addFromPath(sparse('d.txt', 1)))).toBe('quota')
    expect(listing()).toHaveLength(2)
  })

  it('accepts a file that brings the folder exactly to the limit', async () => {
    const store = createAttachmentStore({ dir, maxTotalBytes: 100 })
    await store.addFromBytes({ name: 'a.txt', bytes: bytes(99) })
    await store.addFromBytes({ name: 'b.txt', bytes: bytes(1) })
    expect(listing()).toHaveLength(2)
  })

  it('refuses a new file when the folder holds the most files', async () => {
    const store = createAttachmentStore({ dir, maxFiles: 3 })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await store.addFromBytes({ name, bytes: bytes(1) })
    expect(await reason(store.addFromBytes({ name: 'd.txt', bytes: bytes(1) }))).toBe('quota')
    expect(listing()).toHaveLength(3)
  })

  it('counts every file in the folder, also files that were not made by this store', async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'foreign.bin'), bytes(95))
    const store = createAttachmentStore({ dir, maxTotalBytes: 100 })
    expect(await reason(store.addFromBytes({ name: 'a.txt', bytes: bytes(6) }))).toBe('quota')
    await store.addFromBytes({ name: 'a.txt', bytes: bytes(5) })
  })

  it('does not let parallel adds slip past the limit together', async () => {
    const store = createAttachmentStore({ dir, maxTotalBytes: 100 })
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => store.addFromBytes({ name: `p${i}.txt`, bytes: bytes(30) })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    expect(listing()).toHaveLength(3)
  })

  it('has defaults of 500 files and 512 MiB', () => {
    expect(MAX_FILES).toBe(500)
    expect(MAX_TOTAL_BYTES).toBe(512 * MIB)
  })

  it('removes leftover .partial files at start, and nothing else', async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, '.partial-abcdefgh1234'), 'half')
    writeFileSync(join(dir, '.partial-zzzzzzzz9999'), 'half')
    writeFileSync(join(dir, 'abcdefgh1234.txt'), 'kept')
    writeFileSync(join(dir, '.keep'), 'kept')
    await createAttachmentStore({ dir }).sweepPartials()
    expect(readdirSync(dir).sort()).toEqual(['.keep', 'abcdefgh1234.txt'])
  })

  it('does not fail when the folder does not exist yet', async () => {
    await createAttachmentStore({ dir }).sweepPartials()
    expect(existsSync(dir)).toBe(false)
  })
})
