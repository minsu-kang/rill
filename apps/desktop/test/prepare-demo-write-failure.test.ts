// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failing = vi.hoisted(() => ({ remaining: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (target: unknown, data: Uint8Array, options?: unknown) => {
      if (typeof target === 'number' && failing.remaining > 0) {
        failing.remaining -= 1
        writeSync(target, data.subarray(0, 10))
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
      return (actual.writeFileSync as (...args: unknown[]) => void)(target, data, options)
    },
  }
})

const { DEMO_FILES, prepareDemo } = await import('../scripts/prepare-demo')

let dir: string
let home: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'rill-demo-fail-')))
  home = join(dir, 'home')
  mkdirSync(home)
  failing.remaining = 0
})

afterEach(() => {
  failing.remaining = 0
  rmSync(dir, { recursive: true, force: true })
})

describe('prepareDemo when a write fails half way', () => {
  it('removes the half-written file, passes the error on, and copies the file on the next run', () => {
    failing.remaining = 1
    expect(() => prepareDemo({ home })).toThrow(/no space left/)
    const receipts = join(home, 'Rill-Demo', 'Receipts')
    expect(existsSync(join(receipts, DEMO_FILES[0]!.name))).toBe(false)
    expect(readdirSync(receipts)).toEqual([])

    const again = prepareDemo({ home })
    expect(again.copied).toEqual(DEMO_FILES.map((file) => file.name))
    expect(again.skipped).toEqual([])
  })

  it('keeps the files that were written before the failure', () => {
    prepareDemo({ home })
    rmSync(join(home, 'Rill-Demo', 'Receipts', DEMO_FILES[2]!.name))
    failing.remaining = 1
    expect(() => prepareDemo({ home })).toThrow(/no space left/)
    expect(readdirSync(join(home, 'Rill-Demo', 'Receipts')).sort()).toEqual(DEMO_FILES.slice(0, 2).map((file) => file.name).sort())
  })
})
