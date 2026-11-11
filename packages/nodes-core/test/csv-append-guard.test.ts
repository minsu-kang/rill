import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathNotAllowedError } from '../src/guard'
import { csvAppend } from '../src/nodes/csv-append'
import { makeCtx, memoryJournal } from './helpers'

let base: string
let root: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rill-csvg-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
})

describe('csv.append@1 path confinement', () => {
  it('writes inside an allowed root', async () => {
    const file = join(root, 'ledger.csv')
    await csvAppend.execute({ file, row: ['a'] }, makeCtx({ allowedRoots: [root] }))
    expect(readFileSync(file, 'utf8')).toBe('a\n')
  })

  it('refuses to write outside the allowed roots and leaves no file behind', async () => {
    const file = join(outside, 'ledger.csv')
    await expect(csvAppend.execute({ file, row: ['a'] }, makeCtx({ allowedRoots: [root] }))).rejects.toThrow(
      PathNotAllowedError,
    )
    expect(existsSync(file)).toBe(false)
  })

  it('checks the path even in a dry run', async () => {
    const file = join(outside, 'ledger.csv')
    const ctx = makeCtx({ allowedRoots: [root], dryRun: true })
    await expect(csvAppend.execute({ file, row: ['a'] }, ctx)).rejects.toThrow(PathNotAllowedError)
  })

  it('refuses a relative path, whichever folder the process runs in, and writes nothing', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    await expect(csvAppend.execute({ file: 'ledger.csv', row: ['a'] }, makeCtx({ allowedRoots: [root] }))).rejects.toThrow('path must be absolute')
    expect(existsSync(join(root, 'ledger.csv'))).toBe(false)
  })

  it('refuses dot-dot escapes', async () => {
    const file = join(root, '..', 'outside', 'ledger.csv')
    await expect(csvAppend.execute({ file, row: ['a'] }, makeCtx({ allowedRoots: [root] }))).rejects.toThrow(
      PathNotAllowedError,
    )
  })

  it('writes every row exactly once when many executions overlap on one file', async () => {
    const file = join(root, 'many.csv')
    const journal = memoryJournal()
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        csvAppend.execute({ file, row: [i] }, makeCtx({ journal, idempotencyKey: `r${i}:n1`, allowedRoots: [root] })),
      ),
    )
    const lines = readFileSync(file, 'utf8').trim().split('\n').sort()
    expect(lines).toEqual(Array.from({ length: 25 }, (_, i) => String(i)).sort())
  })
})
