import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathNotAllowedError, assertPathAllowed, expandHome } from '../src/guard'

let base: string
let root: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rill-guard-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(root, 'in.txt'), 'x')
  writeFileSync(join(outside, 'out.txt'), 'y')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('expandHome', () => {
  it('expands a leading tilde only', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/x/y')).toBe(join(homedir(), 'x/y'))
    expect(expandHome('/a/~/b')).toBe('/a/~/b')
  })
})

describe('assertPathAllowed', () => {
  it('allows everything when roots are undefined', () => {
    const path = join(outside, 'out.txt')
    expect(assertPathAllowed(path, undefined)).toBe(path)
  })

  it('allows an existing file inside a root', () => {
    const path = join(root, 'in.txt')
    expect(assertPathAllowed(path, [root])).toBe(path)
  })

  it('allows the root itself', () => {
    expect(assertPathAllowed(root, [root])).toBe(root)
  })

  it('allows a file that does not exist yet, even in missing subfolders', () => {
    const path = join(root, 'a', 'b', 'new.csv')
    expect(assertPathAllowed(path, [root])).toBe(path)
  })

  it('accepts a path that is inside any one of several roots', () => {
    const path = join(outside, 'out.txt')
    expect(assertPathAllowed(path, [root, outside])).toBe(path)
  })

  it('rejects a path outside every root', () => {
    expect(() => assertPathAllowed(join(outside, 'out.txt'), [root])).toThrow(PathNotAllowedError)
  })

  it('rejects a parent segment written out in the raw path', () => {
    expect(() => assertPathAllowed(`${root}/../outside/out.txt`, [root])).toThrow("must not contain '..'")
  })

  it('rejects a parent segment that comes after a symlink', () => {
    mkdirSync(join(outside, 'deep'))
    writeFileSync(join(outside, 'secret.txt'), 'SECRET')
    symlinkSync(join(outside, 'deep'), join(root, 'link'))
    expect(() => assertPathAllowed(`${root}/link/../secret.txt`, [root])).toThrow(PathNotAllowedError)
  })

  it('still rejects join-normalised escapes as outside the allowed folders', () => {
    expect(() => assertPathAllowed(join(root, '..', 'outside', 'out.txt'), [root])).toThrow(
      'outside the allowed folders',
    )
  })

  it('treats paths that differ only in case as the same folder on case-insensitive volumes', ({ skip }) => {
    mkdirSync(join(base, 'MixedCase'))
    writeFileSync(join(base, 'MixedCase', 'f.txt'), 'f')
    if (!existsSync(join(base, 'mixedcase'))) skip()
    expect(() => assertPathAllowed(join(base, 'mixedcase', 'f.txt'), [join(base, 'MixedCase')])).not.toThrow()
  })

  it('rejects a sibling folder that shares the root name as a prefix', () => {
    const sibling = join(base, 'root-evil')
    mkdirSync(sibling)
    expect(() => assertPathAllowed(join(sibling, 'x.txt'), [root])).toThrow(PathNotAllowedError)
  })

  it('rejects a symlink inside the root that points outside', () => {
    symlinkSync(outside, join(root, 'link'))
    expect(() => assertPathAllowed(join(root, 'link', 'out.txt'), [root])).toThrow(PathNotAllowedError)
  })

  it('rejects a dangling symlink', () => {
    symlinkSync(join(outside, 'ghost.txt'), join(root, 'dangling'))
    expect(() => assertPathAllowed(join(root, 'dangling'), [root])).toThrow('dangling symlink')
  })

  it('rejects everything when the root list is empty', () => {
    expect(() => assertPathAllowed(join(root, 'in.txt'), [])).toThrow(PathNotAllowedError)
  })

  it('names the offending path in the message', () => {
    const path = join(outside, 'out.txt')
    expect(() => assertPathAllowed(path, [root])).toThrow(`outside the allowed folders: ${path}`)
  })

  describe('relative paths', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('rejects a relative path when roots are defined, even when the working folder is inside a root', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(root)
      for (const path of ['in.txt', './in.txt', 'a/b/new.csv', '', '~other/x.csv', '.']) {
        expect(() => assertPathAllowed(path, [root]), path).toThrow(PathNotAllowedError)
        expect(() => assertPathAllowed(path, [root]), path).toThrow('path must be absolute')
      }
    })

    it('says which path it rejected and what is expected', () => {
      expect(() => assertPathAllowed('ledger/out.csv', [root])).toThrow('path must be absolute or start with ~/: ledger/out.csv')
    })

    it('rejects a relative path before the empty-roots check as well', () => {
      expect(() => assertPathAllowed('x.csv', [])).toThrow('path must be absolute')
    })

    it('judges the same path the same way wherever the process runs', () => {
      const verdicts = [root, outside, base].map((cwd) => {
        vi.spyOn(process, 'cwd').mockReturnValue(cwd)
        try {
          assertPathAllowed('in.txt', [root])
          return 'allowed'
        } catch (error) {
          return (error as Error).message
        }
      })
      expect(new Set(verdicts).size).toBe(1)
    })

    it('accepts a path that is absolute only after the home folder is expanded', () => {
      expect(assertPathAllowed('~/rill-guard-test/x.csv', [homedir()])).toBe(join(homedir(), 'rill-guard-test/x.csv'))
      expect(() => assertPathAllowed('~/x.csv', [root])).toThrow('outside the allowed folders')
    })

    it('leaves a relative path alone when there are no roots', () => {
      expect(assertPathAllowed('relative/x.csv', undefined)).toBe('relative/x.csv')
      expect(assertPathAllowed('', undefined)).toBe('')
    })
  })
})
