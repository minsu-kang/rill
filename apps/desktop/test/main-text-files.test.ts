// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FsLike } from '../src/main/config-store'
import { TextFileError, createTextFiles } from '../src/main/text-files'
import { MAX_TEXT_FILE_BYTES } from '../src/shared/host-api'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-text-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof TextFileError ? error.reason : `not a TextFileError: ${String(error)}`
  }
  return undefined
}

describe('text files: read', () => {
  it('returns the text of a regular file exactly as it is', async () => {
    const path = join(dir, 'a.md')
    const text = '---\nname: x\n---\n\n# Persona\r\n\ttab { "json": true }\n\ufeff한글 👍\n'
    writeFileSync(path, text)
    expect(await createTextFiles().read(path)).toBe(text)
  })

  it('reads an empty file as an empty text', async () => {
    const path = join(dir, 'empty.md')
    writeFileSync(path, '')
    expect(await createTextFiles().read(path)).toBe('')
  })

  it('does not interpret the bytes: text that is not valid UTF-8 comes back with replacement characters', async () => {
    const path = join(dir, 'binary.md')
    writeFileSync(path, Buffer.from([0x61, 0xff, 0xfe, 0x62]))
    expect(await createTextFiles().read(path)).toBe('a\ufffd\ufffdb')
  })

  it('accepts a file of exactly 64 KiB and refuses one byte more', async () => {
    const exact = join(dir, 'exact.md')
    writeFileSync(exact, 'a'.repeat(MAX_TEXT_FILE_BYTES))
    expect((await createTextFiles().read(exact)).length).toBe(MAX_TEXT_FILE_BYTES)
    const over = join(dir, 'over.md')
    writeFileSync(over, 'a'.repeat(MAX_TEXT_FILE_BYTES + 1))
    expect(await reason(createTextFiles().read(over))).toBe('too_large')
  })

  it('refuses a huge file from its size, without reading it', async () => {
    const path = join(dir, 'huge.md')
    writeFileSync(path, '')
    truncateSync(path, 8 * 1024 * 1024 * 1024)
    const started = Date.now()
    expect(await reason(createTextFiles().read(path))).toBe('too_large')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('reads at most 64 KiB plus one byte of a file that grew after it was measured', async () => {
    const path = join(dir, 'grows.md')
    writeFileSync(path, 'small')
    const reads: number[] = []
    const fs: FsLike = {
      ...fsp,
      open: async (target: Parameters<FsLike['open']>[0], flags?: Parameters<FsLike['open']>[1], mode?: Parameters<FsLike['open']>[2]) => {
        const handle = await fsp.open(target, flags, mode)
        const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>
        handle.read = (async (...args: unknown[]) => {
          reads.push(args[2] as number)
          writeFileSync(path, 'b'.repeat(MAX_TEXT_FILE_BYTES * 3))
          return read(...args)
        }) as typeof handle.read
        return handle
      },
    } as FsLike
    expect(await reason(createTextFiles({ fs }).read(path))).toBe('too_large')
    expect(reads).toEqual([MAX_TEXT_FILE_BYTES + 1])
  })

  it('refuses a symbolic link, also one to a regular file', async () => {
    const target = join(dir, 'target.md')
    writeFileSync(target, 'text')
    const link = join(dir, 'link.md')
    symlinkSync(target, link)
    expect(await reason(createTextFiles().read(link))).toBe('symlink')
    symlinkSync(join(dir, 'missing.md'), join(dir, 'dangling.md'))
    expect(await reason(createTextFiles().read(join(dir, 'dangling.md')))).toBe('symlink')
  })

  it('refuses a link that appears after the check, because the file is opened without following links', async () => {
    const target = join(dir, 'secret.md')
    writeFileSync(target, 'secret')
    const link = join(dir, 'swapped.md')
    symlinkSync(target, link)
    const regular = join(dir, 'regular.md')
    writeFileSync(regular, 'regular')
    const fs: FsLike = { ...fsp, lstat: (async () => fsp.lstat(regular)) as unknown as FsLike['lstat'] } as FsLike
    expect(await reason(createTextFiles({ fs }).read(link))).toBe('symlink')
  })

  it('refuses a folder and a special file', async () => {
    mkdirSync(join(dir, 'folder'))
    expect(await reason(createTextFiles().read(join(dir, 'folder')))).toBe('not_a_file')
    expect(await reason(createTextFiles().read('/dev/null'))).toBe('not_a_file')
  })

  it('reports a missing file, an unreadable file and a bad path without naming them', async () => {
    expect(await reason(createTextFiles().read(join(dir, 'missing.md')))).toBe('io')
    const locked = join(dir, 'locked.md')
    writeFileSync(locked, 'x')
    chmodSync(locked, 0)
    if (process.getuid?.() !== 0) expect(await reason(createTextFiles().read(locked))).toBe('io')
    for (const bad of ['relative.md', '', 'a\u0000b', '/'.padEnd(2000, 'a')]) expect(await reason(createTextFiles().read(bad)), JSON.stringify(bad)).toBe('invalid_path')
    expect(await reason(createTextFiles().read(5 as never))).toBe('invalid_path')
  })

  it('never puts the path or the text into the error', async () => {
    const path = join(dir, 'MARKER-file.md')
    writeFileSync(path, 'a'.repeat(MAX_TEXT_FILE_BYTES + 1))
    const error = await createTextFiles().read(path).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TextFileError)
    expect(JSON.stringify({ message: (error as Error).message, name: (error as Error).name })).not.toContain('MARKER')
  })
})

describe('text files: write', () => {
  it('creates a file with the text and the mode of a normal document', async () => {
    const path = join(dir, 'out.md')
    const text = '---\nname: 친절한\n---\n\n# Persona\n\nx\n'
    await createTextFiles().write(path, text)
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(statSync(path).mode & 0o777).toBe(0o644 & ~process.umask())
  })

  it('replaces an existing file completely', async () => {
    const path = join(dir, 'again.md')
    writeFileSync(path, 'old text that is longer than the new one')
    await createTextFiles().write(path, 'new')
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it('accepts exactly 64 KiB and refuses one byte more, by bytes', async () => {
    const path = join(dir, 'size.md')
    await createTextFiles().write(path, 'a'.repeat(MAX_TEXT_FILE_BYTES))
    expect(statSync(path).size).toBe(MAX_TEXT_FILE_BYTES)
    expect(await reason(createTextFiles().write(join(dir, 'over.md'), 'a'.repeat(MAX_TEXT_FILE_BYTES + 1)))).toBe('too_large')
    expect(await reason(createTextFiles().write(join(dir, 'wide.md'), 'é'.repeat(MAX_TEXT_FILE_BYTES / 2 + 1)))).toBe('too_large')
  })

  it('refuses to write through a link, dangling or not, and into a folder', async () => {
    const target = join(dir, 'target.md')
    writeFileSync(target, 'keep')
    symlinkSync(target, join(dir, 'link.md'))
    symlinkSync(join(dir, 'nowhere.md'), join(dir, 'dangling.md'))
    mkdirSync(join(dir, 'folder'))
    expect(await reason(createTextFiles().write(join(dir, 'link.md'), 'x'))).toBe('symlink')
    expect(await reason(createTextFiles().write(join(dir, 'dangling.md'), 'x'))).toBe('symlink')
    expect(await reason(createTextFiles().write(join(dir, 'folder'), 'x'))).toBe('not_a_file')
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it('refuses a link that appears after the check', async () => {
    const target = join(dir, 'target.md')
    writeFileSync(target, 'keep')
    const link = join(dir, 'swapped.md')
    symlinkSync(target, link)
    const fs: FsLike = { ...fsp, lstat: (async () => fsp.lstat(join(dir, 'target.md'))) as unknown as FsLike['lstat'] } as FsLike
    expect(await reason(createTextFiles({ fs }).write(link, 'x'))).toBe('symlink')
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it('reports a write that cannot happen as io and a bad path as invalid_path', async () => {
    expect(await reason(createTextFiles().write(join(dir, 'missing-folder', 'a.md'), 'x'))).toBe('io')
    expect(await reason(createTextFiles().write('relative.md', 'x'))).toBe('invalid_path')
    expect(await reason(createTextFiles().write(join(dir, 'a.md'), 5 as never))).toBe('too_large')
  })
})

describe('text files: the module does not interpret the text', () => {
  it('has no parser, no JSON and no normalisation in it', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/main/text-files.ts'), 'utf8')
    expect(source).not.toMatch(/JSON\.|\.normalize\(|agent-file|@rill\/protocol|split\(|RegExp|\.match\(|\.replace\(/)
  })
})
