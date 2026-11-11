import { execFileSync } from 'node:child_process'
import {
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  type Mode,
  type OpenMode,
  type PathLike,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFsAttachmentStore } from '../src/attachments'

const spies = vi.hoisted(() => ({
  opened: [] as number[],
  closed: [] as number[],
  flags: [] as number[],
  readdirs: 0,
  failRead: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (path: PathLike, flags: OpenMode = 'r', mode?: Mode | null) => {
      const fd = actual.openSync(path, flags, mode)
      spies.opened.push(fd)
      spies.flags.push(Number(flags))
      return fd
    },
    closeSync: (fd: number) => {
      spies.closed.push(fd)
      return actual.closeSync(fd)
    },
    readdirSync: (...args: unknown[]) => {
      spies.readdirs++
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args)
    },
    readSync: (...args: unknown[]) => {
      if (spies.failRead) throw new Error('simulated read failure')
      return (actual.readSync as (...a: unknown[]) => unknown)(...args)
    },
  }
})

const ID = 'abcd1234'
let root: string
let outside: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'rill-att-'))
  root = join(base, 'attachments')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  spies.opened.length = 0
  spies.closed.length = 0
  spies.flags.length = 0
  spies.readdirs = 0
  spies.failRead = false
})

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true })
})

function expectEveryDescriptorClosed(): void {
  expect([...spies.closed].sort()).toEqual([...spies.opened].sort())
}

describe('createFsAttachmentStore: reading', () => {
  it('reads the bytes of a file named <id>.<ext>', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 0, 37, 80, 68, 70])
    writeFileSync(join(root, `${ID}.pdf`), bytes)
    const read = await createFsAttachmentStore(root).read(ID)
    expect(read).toBeInstanceOf(Uint8Array)
    expect(Array.from(read!)).toEqual(Array.from(bytes))
    expectEveryDescriptorClosed()
  })

  it('reads text, image and document extensions, and an empty file', async () => {
    for (const [index, ext] of ['txt', 'csv', 'md', 'png', 'jpg', 'gif', 'webp', 'pdf', 'x1'].entries()) {
      const id = `file-id-${index}`
      writeFileSync(join(root, `${id}.${ext}`), `content ${index}`)
      expect(new TextDecoder().decode(await createFsAttachmentStore(root).read(id))).toBe(`content ${index}`)
    }
    writeFileSync(join(root, 'empty-file.txt'), '')
    expect((await createFsAttachmentStore(root).read('empty-file'))?.byteLength).toBe(0)
  })

  it('accepts ids of 8 and 64 characters with dashes and underscores', async () => {
    const long = `A_-${'z'.repeat(61)}`
    writeFileSync(join(root, `${long}.txt`), 'long')
    writeFileSync(join(root, 'A_-b0Z9_.txt'), 'short')
    const store = createFsAttachmentStore(root)
    expect(long).toHaveLength(64)
    expect(new TextDecoder().decode(await store.read(long))).toBe('long')
    expect(new TextDecoder().decode(await store.read('A_-b0Z9_'))).toBe('short')
  })

  it('returns undefined for an id that is not there', async () => {
    writeFileSync(join(root, `${ID}.txt`), 'x')
    expect(await createFsAttachmentStore(root).read('zzzz9999')).toBeUndefined()
  })

  it('returns undefined when the root is missing or is not a directory', async () => {
    expect(await createFsAttachmentStore(join(root, 'nope')).read(ID)).toBeUndefined()
    writeFileSync(join(outside, 'file'), 'x')
    expect(await createFsAttachmentStore(join(outside, 'file')).read(ID)).toBeUndefined()
  })

  it('reads only what the root directory lists, not what sits in a subfolder', async () => {
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', `${ID}.txt`), 'nested')
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
  })
})

describe('createFsAttachmentStore: ids', () => {
  const SECRET = 'outside secret'

  it('rejects ids that could leave the folder or are not well formed, without touching the disk', async () => {
    writeFileSync(join(outside, `${ID}.txt`), SECRET)
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'target123.txt'), 'nested')
    const store = createFsAttachmentStore(root)
    const bad = [
      '',
      '../outside/abcd1234',
      '..',
      '../abcd1234',
      'sub/target123',
      `${ID}/..`,
      '%2e%2e%2fabcd1234',
      '%2e%2e%2e%2e',
      `${ID}\0`,
      `${ID}\0.txt`,
      `${ID}.txt`,
      'abcd 1234',
      'abcd1234\n',
      'abcd123',
      'a'.repeat(65),
      'ééééééééé',
      '..\\outside\\abcd1234',
    ]
    for (const id of bad) expect(await store.read(id), JSON.stringify(id)).toBeUndefined()
    expect(spies.readdirs).toBe(0)
    expect(spies.opened).toEqual([])
  })

  it('does not accept a non-string id', async () => {
    const store = createFsAttachmentStore(root)
    expect(await store.read(undefined as unknown as string)).toBeUndefined()
    expect(await store.read(12345678 as unknown as string)).toBeUndefined()
    expect(spies.opened).toEqual([])
  })

  it('needs an exact id, so a longer name that starts with it does not match', async () => {
    writeFileSync(join(root, `${ID}9.txt`), 'longer id')
    writeFileSync(join(root, `${ID}_x.txt`), 'suffix')
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
  })

  it('only matches extensions of 1 to 8 lowercase letters and digits', async () => {
    const store = createFsAttachmentStore(root)
    for (const name of [`${ID}`, `${ID}.`, `${ID}-txt`, `${ID}_txt`, `${ID}xtxt`, `${ID}.TXT`, `${ID}.tar.gz`, `${ID}.verylong9`, `${ID}.t-x`, `${ID}.t_x`, `${ID}.é`]) {
      writeFileSync(join(root, name), 'x')
      expect(await store.read(ID), name).toBeUndefined()
      rmSync(join(root, name))
    }
    writeFileSync(join(root, `${ID}.abcdefgh`), 'eight')
    expect(new TextDecoder().decode(await store.read(ID))).toBe('eight')
  })

  it('returns undefined when two files share the id', async () => {
    writeFileSync(join(root, `${ID}.txt`), 'one')
    writeFileSync(join(root, `${ID}.pdf`), 'two')
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
    expect(spies.opened).toEqual([])
  })
})

describe('createFsAttachmentStore: unsafe files', () => {
  it('does not follow a symlink named <id>.<ext>', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'outside secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, `${ID}.txt`))
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
    expectEveryDescriptorClosed()
  })

  it('does not follow a symlink to a file inside the folder either', async () => {
    writeFileSync(join(root, 'real-file1.txt'), 'inside')
    symlinkSync(join(root, 'real-file1.txt'), join(root, `${ID}.txt`))
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
    expect(new TextDecoder().decode(await createFsAttachmentStore(root).read('real-file1'))).toBe('inside')
  })

  it('does not follow a dangling symlink', async () => {
    symlinkSync(join(outside, 'gone.txt'), join(root, `${ID}.txt`))
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
  })

  it('still works when the root itself is reached through a symlink', async () => {
    const link = join(outside, 'link')
    symlinkSync(root, link)
    writeFileSync(join(root, `${ID}.txt`), 'via link')
    expect(new TextDecoder().decode(await createFsAttachmentStore(link).read(ID))).toBe('via link')
  })

  it('returns undefined for a directory named <id>.<ext> and closes it', async () => {
    mkdirSync(join(root, `${ID}.txt`))
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
    expect(spies.opened).toHaveLength(1)
    expectEveryDescriptorClosed()
  })

  it('opens read-only without following links and without blocking, and rejects a pipe', async () => {
    writeFileSync(join(root, 'plain-file.txt'), 'x')
    await createFsAttachmentStore(root).read('plain-file')
    const flags = spies.flags[0]!
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    expect(flags & (constants.O_WRONLY | constants.O_RDWR)).toBe(0)
    if (process.platform === 'win32') return
    execFileSync('mkfifo', [join(root, `${ID}.txt`)])
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
    expectEveryDescriptorClosed()
  })

  it('returns undefined above the size cap and reads a file at the cap', async () => {
    const big = join(root, `${ID}.pdf`)
    writeFileSync(big, '')
    truncateSync(big, MAX_DOCUMENT_BYTES + 1)
    expect(await createFsAttachmentStore(root).read(ID)).toBeUndefined()
    expectEveryDescriptorClosed()
    truncateSync(big, MAX_DOCUMENT_BYTES)
    expect((await createFsAttachmentStore(root).read(ID))?.byteLength).toBe(MAX_DOCUMENT_BYTES)
    expectEveryDescriptorClosed()
  })

  it('treats a failing read as not found and still closes the descriptor', async () => {
    writeFileSync(join(root, `${ID}.txt`), 'content')
    spies.failRead = true
    await expect(createFsAttachmentStore(root).read(ID)).resolves.toBeUndefined()
    expect(spies.opened).toHaveLength(1)
    expectEveryDescriptorClosed()
  })

  it('closes the descriptor after a normal read, once', async () => {
    writeFileSync(join(root, `${ID}.txt`), 'content')
    await createFsAttachmentStore(root).read(ID)
    expect(spies.opened).toHaveLength(1)
    expect(spies.closed).toEqual(spies.opened)
  })

  it('never puts a path in an error: every failure is a plain undefined', async () => {
    const store = createFsAttachmentStore(join(root, 'missing-root'))
    await expect(store.read(ID)).resolves.toBeUndefined()
  })
})
