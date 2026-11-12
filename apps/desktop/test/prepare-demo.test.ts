// @vitest-environment node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FIXTURES_DIR,
  DEMO_FILES,
  DemoPrepareError,
  SAMPLE_PDF,
  formatNextSteps,
  prepareDemo,
} from '../scripts/prepare-demo'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const SCRIPT = join(REPO_ROOT, 'apps/desktop/scripts/prepare-demo.ts')

let dir: string
let home: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'rill-demo-test-')))
  home = join(dir, 'home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tree(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => `${relative(root, join(entry.parentPath, entry.name))}${entry.isDirectory() ? '/' : ''}`)
    .sort()
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function manifestFiles(fixturesDir: string): Array<{ seedId: string; kind: string; path: string; bytes: number; sha256: string }> {
  return JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8')).files
}

const EXPECTED_TREE = ['Rill-Demo/', 'Rill-Demo/Inbox/', 'Rill-Demo/Receipts/', ...DEMO_FILES.map((file) => `Rill-Demo/Receipts/${file.name}`)].sort()

describe('prepareDemo', () => {
  it('copies the three synthetic receipts and creates an empty inbox, and nothing else', () => {
    const result = prepareDemo({ home })
    expect(result.folder).toBe(join(home, 'Rill-Demo'))
    expect(result.receiptsDir).toBe(join(home, 'Rill-Demo', 'Receipts'))
    expect(result.inboxDir).toBe(join(home, 'Rill-Demo', 'Inbox'))
    expect(result.copied).toEqual(DEMO_FILES.map((file) => file.name))
    expect(result.skipped).toEqual([])
    expect(tree(home)).toEqual(EXPECTED_TREE)
    expect(readdirSync(result.inboxDir)).toEqual([])
  })

  it('writes the same bytes as the fixtures named in the manifest', () => {
    prepareDemo({ home })
    const entries = manifestFiles(DEFAULT_FIXTURES_DIR)
    for (const file of DEMO_FILES) {
      const entry = entries.find((candidate) => candidate.seedId === file.seedId && candidate.kind === file.kind)
      expect(entry).toBeDefined()
      const copy = join(home, 'Rill-Demo', 'Receipts', file.name)
      expect(sha(copy)).toBe(entry!.sha256)
      expect(readFileSync(copy).length).toBe(entry!.bytes)
    }
  })

  it('takes one PDF, one PNG and one text file, each from an easy Korean seed without an injection', () => {
    expect(DEMO_FILES.map((file) => file.kind).sort()).toEqual(['pdf', 'png', 'text'])
    const seeds = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/eval/src/suites/extract/data/seeds.json'), 'utf8')) as Array<{
      id: string
      difficulty: string
      language: string
      injection: unknown
    }>
    for (const file of DEMO_FILES) {
      const seed = seeds.find((candidate) => candidate.id === file.seedId)
      expect(seed, file.seedId).toBeDefined()
      expect(seed).toMatchObject({ difficulty: 'easy', language: 'ko', injection: null })
    }
    expect(DEMO_FILES.some((file) => file.name === SAMPLE_PDF && file.kind === 'pdf')).toBe(true)
  })

  it('creates folders and files with normal permissions', () => {
    prepareDemo({ home })
    for (const folder of ['Rill-Demo', 'Rill-Demo/Receipts', 'Rill-Demo/Inbox']) {
      const mode = lstatSync(join(home, folder)).mode & 0o777
      expect(mode & 0o700).toBe(0o700)
      expect(mode & 0o022).toBe(0)
    }
    for (const file of DEMO_FILES) {
      const mode = lstatSync(join(home, 'Rill-Demo/Receipts', file.name)).mode & 0o777
      expect(mode & 0o600).toBe(0o600)
      expect(mode & 0o133).toBe(0)
    }
  })

  it('can run again: nothing is copied twice and nothing changes', () => {
    prepareDemo({ home })
    const before = DEMO_FILES.map((file) => sha(join(home, 'Rill-Demo/Receipts', file.name)))
    const second = prepareDemo({ home })
    expect(second.copied).toEqual([])
    expect(second.skipped).toEqual(DEMO_FILES.map((file) => file.name))
    expect(DEMO_FILES.map((file) => sha(join(home, 'Rill-Demo/Receipts', file.name)))).toEqual(before)
    expect(tree(home)).toEqual(EXPECTED_TREE)
  })

  it('never overwrites an existing file, and still copies the others', () => {
    const receipts = join(home, 'Rill-Demo', 'Receipts')
    mkdirSync(receipts, { recursive: true })
    writeFileSync(join(receipts, SAMPLE_PDF), 'my own file')
    const result = prepareDemo({ home })
    expect(readFileSync(join(receipts, SAMPLE_PDF), 'utf8')).toBe('my own file')
    expect(result.skipped).toEqual([SAMPLE_PDF])
    expect(result.copied).toEqual(DEMO_FILES.filter((file) => file.name !== SAMPLE_PDF).map((file) => file.name))
  })

  it('does not follow or replace a symbolic link that sits where a file would go', () => {
    const receipts = join(home, 'Rill-Demo', 'Receipts')
    mkdirSync(receipts, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, join(receipts, SAMPLE_PDF))
    symlinkSync(join(dir, 'missing.txt'), join(receipts, 'receipt-pharmacy.txt'))
    const result = prepareDemo({ home })
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(existsSync(join(dir, 'missing.txt'))).toBe(false)
    expect(lstatSync(join(receipts, SAMPLE_PDF)).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(receipts, 'receipt-pharmacy.txt')).isSymbolicLink()).toBe(true)
    expect(result.skipped.sort()).toEqual([SAMPLE_PDF, 'receipt-pharmacy.txt'].sort())
    expect(result.copied).toEqual(['receipt-snack-bar.png'])
  })

  it('leaves an existing folder and its other files alone', () => {
    const inbox = join(home, 'Rill-Demo', 'Inbox')
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, 'mine.pdf'), 'mine')
    prepareDemo({ home })
    expect(readFileSync(join(inbox, 'mine.pdf'), 'utf8')).toBe('mine')
  })
})

describe('prepareDemo refusals', () => {
  it('refuses when Rill-Demo is a symbolic link to somewhere else, and writes nothing', () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(home, 'Rill-Demo'))
    expect(() => prepareDemo({ home })).toThrow(DemoPrepareError)
    expect(tree(elsewhere)).toEqual([])
  })

  it('refuses when Receipts is a symbolic link, and writes nothing', () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(home, 'Rill-Demo'))
    symlinkSync(elsewhere, join(home, 'Rill-Demo', 'Receipts'))
    expect(() => prepareDemo({ home })).toThrow(/symbolic link/)
    expect(tree(elsewhere)).toEqual([])
    expect(existsSync(join(home, 'Rill-Demo', 'Inbox'))).toBe(false)
  })

  it('refuses when Inbox is a symbolic link before it creates Receipts', () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(home, 'Rill-Demo'))
    symlinkSync(elsewhere, join(home, 'Rill-Demo', 'Inbox'))
    expect(() => prepareDemo({ home })).toThrow(/symbolic link/)
    expect(existsSync(join(home, 'Rill-Demo', 'Receipts'))).toBe(false)
  })

  it('refuses when a parent above the home folder is a symbolic link', () => {
    const real = join(dir, 'real')
    mkdirSync(join(real, 'home'), { recursive: true })
    symlinkSync(real, join(dir, 'link'))
    expect(() => prepareDemo({ home: join(dir, 'link', 'home') })).toThrow(/symbolic link/)
    expect(tree(real)).toEqual(['home/'])
  })

  it('refuses when the home folder itself is a symbolic link', () => {
    const linked = join(dir, 'linked-home')
    symlinkSync(home, linked)
    expect(() => prepareDemo({ home: linked })).toThrow(/symbolic link/)
    expect(tree(home)).toEqual([])
  })

  it('refuses when Rill-Demo is a plain file', () => {
    writeFileSync(join(home, 'Rill-Demo'), 'a file')
    expect(() => prepareDemo({ home })).toThrow(/not a folder/)
    expect(readFileSync(join(home, 'Rill-Demo'), 'utf8')).toBe('a file')
  })

  it('refuses a relative or missing home folder', () => {
    expect(() => prepareDemo({ home: 'relative/home' })).toThrow(/absolute/)
    expect(() => prepareDemo({ home: join(dir, 'nope') })).toThrow(/does not exist/)
  })

  it('refuses before writing anything when a fixture differs from the manifest', () => {
    const fixtures = join(dir, 'fixtures')
    cpSync(DEFAULT_FIXTURES_DIR, fixtures, { recursive: true })
    const entry = manifestFiles(fixtures).find((candidate) => candidate.seedId === DEMO_FILES[2]!.seedId && candidate.kind === 'text')!
    writeFileSync(join(fixtures, entry.path), 'tampered')
    expect(() => prepareDemo({ home, fixturesDir: fixtures })).toThrow(/does not match the manifest/)
    expect(tree(home)).toEqual([])
    const original = readFileSync(join(DEFAULT_FIXTURES_DIR, entry.path))
    const sameLength = Buffer.from(original)
    sameLength[0] = sameLength[0]! ^ 1
    writeFileSync(join(fixtures, entry.path), sameLength)
    expect(() => prepareDemo({ home, fixturesDir: fixtures })).toThrow(/does not match the manifest/)
    expect(tree(home)).toEqual([])
  })

  it('refuses when the manifest lacks a fixture or a fixture is a link', () => {
    const fixtures = join(dir, 'fixtures')
    mkdirSync(fixtures)
    writeFileSync(join(fixtures, 'manifest.json'), JSON.stringify({ files: [] }))
    expect(() => prepareDemo({ home, fixturesDir: fixtures })).toThrow(/no pdf fixture/)
    expect(() => prepareDemo({ home, fixturesDir: join(dir, 'no-such-folder') })).toThrow(/manifest/)

    const linked = join(dir, 'linked-fixtures')
    cpSync(DEFAULT_FIXTURES_DIR, linked, { recursive: true })
    const entry = manifestFiles(linked).find((candidate) => candidate.seedId === DEMO_FILES[0]!.seedId && candidate.kind === 'pdf')!
    const target = join(dir, 'outside.pdf')
    writeFileSync(target, readFileSync(join(linked, entry.path)))
    rmSync(join(linked, entry.path))
    symlinkSync(target, join(linked, entry.path))
    expect(() => prepareDemo({ home, fixturesDir: linked })).toThrow(/not a plain file/)
    expect(tree(home)).toEqual([])
  })

  it('refuses a manifest path that leaves the fixture folder', () => {
    const fixtures = join(dir, 'fixtures')
    mkdirSync(fixtures)
    const files = DEMO_FILES.map((file) => ({ seedId: file.seedId, kind: file.kind, path: '../escape.bin', bytes: 1, sha256: 'x' }))
    writeFileSync(join(fixtures, 'manifest.json'), JSON.stringify({ files }))
    expect(() => prepareDemo({ home, fixturesDir: fixtures })).toThrow(/leaves the fixture folder/)
  })
})

describe('formatNextSteps', () => {
  it('names the folders, the values to answer with and the demo script', () => {
    const text = formatNextSteps(prepareDemo({ home })).join('\n')
    expect(text).toContain(`Demo folder: ${join(home, 'Rill-Demo')}`)
    expect(text).toContain(`folder      ${join(home, 'Rill-Demo', 'Inbox')}`)
    expect(text).toContain(`CSV file    ${join(home, 'Rill-Demo', 'ledger.csv')}`)
    expect(text).toContain('demo-slack')
    expect(text).toContain(join(home, 'Rill-Demo', 'Receipts', SAMPLE_PDF))
    expect(text).toContain('docs/demo.md')
    for (const file of DEMO_FILES) expect(text).toContain(file.name)
  })

  it('sends the request that carries the values first and offers the answers only as a fallback', () => {
    const lines = formatNextSteps(prepareDemo({ home }))
    const send = lines.findIndex((line) => line.includes('send the request in docs/demo.md that names the folder, the CSV file and the connection'))
    const fallback = lines.findIndex((line) => line.includes('If the planner asks questions anyway, answer with:'))
    const folder = lines.findIndex((line) => line.includes(`folder      ${join(home, 'Rill-Demo', 'Inbox')}`))
    expect(send).toBeGreaterThan(-1)
    expect(fallback).toBe(send + 1)
    expect(folder).toBeGreaterThan(fallback)
  })

  it('reports files that were already there', () => {
    prepareDemo({ home })
    const text = formatNextSteps(prepareDemo({ home })).join('\n')
    expect(text).toContain('Already there, left untouched')
    expect(text).not.toContain('Copied:')
  })
})

describe('the command', () => {
  function run(homeFolder: string) {
    return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: homeFolder },
      encoding: 'utf8',
      timeout: 25_000,
    })
  }

  it('prepares the demo in the home folder it is given and prints the next steps', () => {
    const first = run(home)
    expect(first.status).toBe(0)
    expect(first.stdout).toContain(`Demo folder: ${join(home, 'Rill-Demo')}`)
    expect(first.stdout).toContain('Next steps')
    expect(tree(home)).toEqual(EXPECTED_TREE)
    const second = run(home)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('Already there, left untouched')
    expect(tree(home)).toEqual(EXPECTED_TREE)
  })

  it('asks for no more than the usual permissions even when the umask allows everything', () => {
    const result = spawnSync('/bin/sh', ['-c', 'umask 0 && exec "$0" "$@"', process.execPath, '--import', 'tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 25_000,
    })
    expect(result.status).toBe(0)
    for (const folder of ['Rill-Demo', 'Rill-Demo/Receipts', 'Rill-Demo/Inbox']) {
      expect(lstatSync(join(home, folder)).mode & 0o777).toBe(0o755)
    }
    for (const file of DEMO_FILES) {
      expect(lstatSync(join(home, 'Rill-Demo/Receipts', file.name)).mode & 0o777).toBe(0o644)
    }
  })

  it('stops with a message and a failing exit code when the demo folder is a link', () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(home, 'Rill-Demo'))
    const result = run(home)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('demo:prepare stopped')
    expect(result.stderr).toContain('symbolic link')
    expect(tree(elsewhere)).toEqual([])
  })
})
