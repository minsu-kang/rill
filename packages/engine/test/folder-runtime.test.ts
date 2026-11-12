import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PathNotAllowedError, compileGlob } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DuplicateFileError } from '../src/store'
import { FolderRuntime } from '../src/triggers/folder'
import { ManualClock } from './manual-clock'
import { createHost } from './trigger-helpers'

let dir: string
let folder: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-folder-'))
  folder = join(dir, 'in')
  mkdirSync(folder)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const names = (fired: Array<{ payload: unknown }>) => fired.map((f) => (f.payload as { name: string }).name).sort()

function setup(config: Partial<{ glob: string; pollMs: number; stableMs: number; includeExisting: boolean }> = {}) {
  const clock = new ManualClock(Date.UTC(2026, 10, 11, 10, 0, 0))
  const h = createHost(clock)
  const runtime = new FolderRuntime(h.workflowId, { folder, stableMs: 2000, ...config }, h.host, undefined)
  return { clock, h, runtime }
}

describe('compileGlob', () => {
  it('matches names case-insensitively with * and ?', () => {
    expect(compileGlob('*.pdf').test('A.PDF')).toBe(true)
    expect(compileGlob('*.pdf').test('a.pdf.part')).toBe(false)
    expect(compileGlob('rec?.txt').test('rec1.txt')).toBe(true)
    expect(compileGlob('rec?.txt').test('rec12.txt')).toBe(false)
    expect(compileGlob('a+b(1).txt').test('a+b(1).txt')).toBe(true)
    expect(compileGlob('a.b').test('axb')).toBe(false)
    expect(compileGlob('*').test('anything')).toBe(true)
  })

  it('compares names in NFC form', () => {
    expect(compileGlob('résumé*.txt'.normalize('NFD')).test('résumé 영수증.txt'.normalize('NFC'))).toBe(true)
  })
})

describe('FolderRuntime delivery', () => {
  it('fires once for a new file after it has stopped changing', () => {
    const { clock, h, runtime } = setup()
    runtime.start()
    const path = join(folder, 'a.pdf')
    writeFileSync(path, 'hello')
    runtime.scanOnce()
    expect(h.fired).toHaveLength(0)
    clock.jump(2000)
    runtime.scanOnce()
    expect(h.fired).toHaveLength(1)
    const stats = statSync(path)
    expect(h.fired[0]?.payload).toEqual({
      file: path,
      name: 'a.pdf',
      extension: '.pdf',
      bytes: 5,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
    })
    expect(h.fired[0]?.options?.fingerprint?.path).toBe(path)
    runtime.scanOnce()
    clock.jump(5000)
    runtime.scanOnce()
    expect(h.fired).toHaveLength(1)
    runtime.stop()
  })

  it('waits again while the file keeps growing', () => {
    const { clock, h, runtime } = setup()
    runtime.start()
    const path = join(folder, 'big.pdf')
    writeFileSync(path, 'a')
    runtime.scanOnce()
    clock.jump(1500)
    appendFileSync(path, 'bb')
    runtime.scanOnce()
    clock.jump(1000)
    runtime.scanOnce()
    expect(h.fired).toHaveLength(0)
    clock.jump(1100)
    runtime.scanOnce()
    expect(h.fired).toHaveLength(1)
    expect((h.fired[0]?.payload as { bytes: number }).bytes).toBe(3)
    runtime.stop()
  })

  it('delivers immediately when stableMs is 0', () => {
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    writeFileSync(join(folder, 'a.txt'), 'x')
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['a.txt'])
    runtime.stop()
  })

  it('matches the glob case-insensitively and ignores hidden, temporary and lock files', () => {
    const { h, runtime } = setup({ glob: '*.pdf*', stableMs: 0 })
    runtime.start()
    for (const name of [
      'A.PDF',
      'b.txt',
      '.hidden.pdf',
      'c.pdf.part',
      'd.pdf~',
      'e.pdf',
      'f.pdf.tmp',
      'g.pdf.crdownload',
      '~$lock.pdf',
    ]) {
      writeFileSync(join(folder, name), 'x')
    }
    mkdirSync(join(folder, 'sub.pdf'))
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['A.PDF', 'e.pdf'])
    runtime.stop()
  })

  it('matches an NFC glob against NFD file names', () => {
    const { h, runtime } = setup({ glob: 'résumé*.txt'.normalize('NFC'), stableMs: 0, includeExisting: true })
    writeFileSync(join(folder, 'résumé 영수증.txt'.normalize('NFD')), 'x')
    runtime.start()
    runtime.scanOnce()
    expect(h.fired).toHaveLength(1)
    runtime.stop()
  })

  it('treats a rewritten file with a new modification time as a new file', () => {
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    const path = join(folder, 'a.txt')
    writeFileSync(path, 'one')
    runtime.scanOnce()
    expect(h.fired).toHaveLength(1)
    writeFileSync(path, 'two!')
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    runtime.scanOnce()
    expect(h.fired).toHaveLength(2)
    runtime.stop()
  })

  it('never reads file contents, so a locked or huge file does not matter', () => {
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    writeFileSync(join(folder, 'locked.txt'), 'secret', { mode: 0o000 })
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['locked.txt'])
    expect(h.events).toEqual([])
    runtime.stop()
  })
})

describe('FolderRuntime failures', () => {
  it('retries a file when the run could not be created, and reports the failure once', () => {
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    writeFileSync(join(folder, 'a.txt'), 'x')
    h.failFires(true)
    runtime.scanOnce()
    runtime.scanOnce()
    expect(h.fired).toHaveLength(0)
    expect(h.events.filter((e) => e.type === 'trigger.error')).toHaveLength(1)
    h.failFires(false)
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['a.txt'])
    runtime.stop()
  })

  it('treats a file another writer already delivered as done without reporting an error', () => {
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    writeFileSync(join(folder, 'a.txt'), 'x')
    h.failFires(new DuplicateFileError('/x'))
    runtime.scanOnce()
    h.failFires(false)
    runtime.scanOnce()
    expect(h.events).toEqual([])
    expect(h.fired).toHaveLength(0)
    runtime.stop()
  })

  it('reports an unreadable folder and recovers when it comes back', () => {
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    rmSync(folder, { recursive: true })
    runtime.scanOnce()
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ type: 'trigger.error', workflowId: h.workflowId })
    mkdirSync(folder)
    writeFileSync(join(folder, 'back.txt'), 'x')
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['back.txt'])
    runtime.stop()
  })
})

describe('FolderRuntime activation rules', () => {
  it('does not deliver files that existed at the first activation, only new ones', () => {
    writeFileSync(join(folder, 'old.pdf'), 'old')
    const { h, runtime } = setup({ stableMs: 0 })
    runtime.start()
    runtime.scanOnce()
    expect(h.fired).toHaveLength(0)
    writeFileSync(join(folder, 'new.pdf'), 'new')
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['new.pdf'])
    runtime.stop()
  })

  it('delivers existing files at the first activation with includeExisting', () => {
    writeFileSync(join(folder, 'old.pdf'), 'old')
    const { h, runtime } = setup({ stableMs: 0, includeExisting: true })
    runtime.start()
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['old.pdf'])
    runtime.stop()
  })

  it('delivers files that arrived while stopped after a restart, but never twice', () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 11, 10, 0, 0))
    const h = createHost(clock)
    const config = { folder, stableMs: 0 }
    const first = new FolderRuntime(h.workflowId, config, h.host, undefined)
    first.start()
    writeFileSync(join(folder, 'a.txt'), 'a')
    first.scanOnce()
    first.stop()
    expect(names(h.fired)).toEqual(['a.txt'])

    writeFileSync(join(folder, 'b.txt'), 'b')
    const second = new FolderRuntime(h.workflowId, config, h.host, undefined)
    second.start()
    second.scanOnce()
    second.stop()
    expect(names(h.fired)).toEqual(['a.txt', 'b.txt'])
  })

  it('does not mark the first activation done until every existing file is recorded', () => {
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) writeFileSync(join(folder, name), 'x')
    const { h, runtime } = setup({ stableMs: 0 })
    const original = h.store.markFileSeen.bind(h.store)
    let calls = 0
    h.store.markFileSeen = (...args: Parameters<typeof original>): boolean => {
      calls += 1
      if (calls === 2) throw new Error('crash during baseline')
      return original(...args)
    }
    expect(() => runtime.start()).toThrow('crash during baseline')
    expect(h.store.getTriggerState(h.workflowId)).toBeUndefined()

    h.store.markFileSeen = original
    const retry = new FolderRuntime(h.workflowId, { folder, stableMs: 0 }, h.host, undefined)
    retry.start()
    retry.scanOnce()
    expect(h.fired).toHaveLength(0)
    expect(h.store.getTriggerState(h.workflowId)).toBeDefined()
    retry.stop()
  })
})

describe('FolderRuntime safety', () => {
  it('refuses a folder outside the allowed roots and a missing folder', () => {
    const h = createHost(new ManualClock(0))
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    expect(() => new FolderRuntime(h.workflowId, { folder }, h.host, [allowed])).toThrow(PathNotAllowedError)
    expect(() => new FolderRuntime(h.workflowId, { folder: join(dir, 'missing') }, h.host, undefined)).toThrow(
      'folder does not exist',
    )
    expect(() => new FolderRuntime(h.workflowId, { folder }, h.host, [dir])).not.toThrow()
  })

  it('refuses a relative folder when roots are set and leaves it alone when they are not', () => {
    const h = createHost(new ManualClock(0))
    expect(() => new FolderRuntime(h.workflowId, { folder: 'incoming' }, h.host, [dir])).toThrow('path must be absolute')
    expect(() => new FolderRuntime(h.workflowId, { folder: relative(process.cwd(), folder) }, h.host, undefined)).not.toThrow()
  })

  it('scans on the poll interval and delivers nothing after stop', () => {
    const { clock, h, runtime } = setup({ stableMs: 0, pollMs: 1000 })
    runtime.start()
    expect(clock.pending).toBe(1)
    writeFileSync(join(folder, 'a.txt'), 'x')
    clock.advance(1000)
    expect(names(h.fired)).toEqual(['a.txt'])
    expect(clock.pending).toBe(1)
    runtime.stop()
    expect(clock.pending).toBe(0)
    writeFileSync(join(folder, 'b.txt'), 'x')
    clock.advance(5000)
    runtime.scanOnce()
    expect(names(h.fired)).toEqual(['a.txt'])
  })
})
