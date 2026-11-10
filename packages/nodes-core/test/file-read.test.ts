import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathNotAllowedError, createCoreRegistry } from '../src/index'
import { fileRead } from '../src/nodes/file-read'
import { makeCtx } from './helpers'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-read-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('file.read@1', () => {
  it('is a registered pure node', () => {
    expect(fileRead.sideEffect).toBe('none')
    expect(createCoreRegistry().has('file.read@1')).toBe(true)
  })

  it('returns the text of a text file with metadata', async () => {
    const path = join(dir, 'notes.MD')
    writeFileSync(path, '# hello')
    expect(await fileRead.execute({ path }, makeCtx())).toEqual({
      path,
      name: 'notes.MD',
      extension: '.md',
      bytes: 7,
      kind: 'text',
      mime: 'text/markdown',
      text: '# hello',
    })
  })

  it('returns metadata only for binary files', async () => {
    const path = join(dir, 'receipt.pdf')
    writeFileSync(path, Buffer.from([0x25, 0x50, 0x44, 0x46]))
    expect(await fileRead.execute({ path }, makeCtx())).toEqual({
      path,
      name: 'receipt.pdf',
      extension: '.pdf',
      bytes: 4,
      kind: 'binary',
      mime: 'application/pdf',
    })
  })

  it('falls back to a generic mime type for unknown extensions', async () => {
    const path = join(dir, 'data.xyz')
    writeFileSync(path, 'abc')
    const output = (await fileRead.execute({ path }, makeCtx())) as { kind: string; mime: string }
    expect(output).toMatchObject({ kind: 'binary', mime: 'application/octet-stream' })
  })

  it('refuses text files larger than the limit', async () => {
    const path = join(dir, 'big.txt')
    writeFileSync(path, 'x'.repeat(100))
    await expect(fileRead.execute({ path, maxBytes: 50 }, makeCtx())).rejects.toThrow('larger than maxBytes (100 > 50)')
    await expect(fileRead.execute({ path }, makeCtx())).resolves.toMatchObject({ kind: 'text' })
  })

  it('fails for directories and missing files', async () => {
    mkdirSync(join(dir, 'sub'))
    await expect(fileRead.execute({ path: join(dir, 'sub') }, makeCtx())).rejects.toThrow('not a file')
    await expect(fileRead.execute({ path: join(dir, 'missing.txt') }, makeCtx())).rejects.toThrow('ENOENT')
  })

  it('refuses paths outside the allowed roots', async () => {
    const inside = join(dir, 'root')
    mkdirSync(inside)
    const outside = join(dir, 'secret.txt')
    writeFileSync(outside, 'nope')
    const ctx = makeCtx({ allowedRoots: [inside] })
    await expect(fileRead.execute({ path: outside }, ctx)).rejects.toThrow(PathNotAllowedError)
  })

  it('reads inside the allowed roots', async () => {
    const path = join(dir, 'ok.txt')
    writeFileSync(path, 'fine')
    const output = await fileRead.execute({ path }, makeCtx({ allowedRoots: [dir] }))
    expect(output).toMatchObject({ text: 'fine' })
  })
})
