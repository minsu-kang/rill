import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ISSUE_CODES, isWarningIssue, type Workflow } from '@rill/dsl'
import { afterAll, describe, expect, it } from 'vitest'
import { createCoreRegistry } from '../src'
import { WATCHED_FOLDER_CODE, WATCHED_FOLDER_HINT, compileGlob, folderWatchSees, watchedFolderIssues } from '../src/watched-folder'
import { validateWorkflow } from '../src/validate'

const registry = createCoreRegistry()

type Node = { id: string; type: string; config: Record<string, unknown> }
const watch = (config: Record<string, unknown>, id = 't1', type = 'trigger.folderWatch@1'): Node => ({ id, type, config })
const csv = (file: unknown, id = 'n2'): Node => ({ id, type: 'csv.append@1', config: { file, row: ['x'] } })
const found = (...nodes: Node[]) =>
  watchedFolderIssues({ schemaVersion: 1, name: 'x', nodes, edges: [] } as unknown as Workflow, registry).map((issue) => `${issue.code} at ${issue.pointer}`)

const LOOP = (index: number) => [`inside_watched_folder at /nodes/${index}/config/file`]

describe('watchedFolderIssues', () => {
  it('flags a file that a node writes into a watched folder when the pattern matches its name', () => {
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*.csv' }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(1))
  })

  it('names the position of the node that writes', () => {
    const other: Node = { id: 'n1', type: 'condition@1', config: { operator: 'exists' } }
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), other, csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(2))
  })

  it('does not flag a pattern that does not match, a hidden file, another folder or a file that is the folder itself', () => {
    const folder = '/Users/demo/Receipts'
    expect(found(watch({ folder, glob: '*.pdf' }), csv(`${folder}/ledger.csv`))).toEqual([])
    expect(found(watch({ folder, glob: '*' }), csv(`${folder}/.ledger.csv`))).toEqual([])
    expect(found(watch({ folder, glob: '*' }), csv(`${folder}/out/ledger.csv`))).toEqual([])
    expect(found(watch({ folder, glob: '*' }), csv('/Users/demo/ledger.csv'))).toEqual([])
    expect(found(watch({ folder, glob: '*' }), csv(folder))).toEqual([])
    expect(found(watch({ folder, glob: '*' }), csv('/Users/demo/Receipts2/ledger.csv'))).toEqual([])
  })

  it('compares whole folders and not the end of a path', () => {
    expect(found(watch({ folder: '/a/b', glob: '*' }), csv('/x/a/b/ledger.csv'))).toEqual([])
    expect(found(watch({ folder: '/x/a/b', glob: '*' }), csv('/a/b/ledger.csv'))).toEqual([])
    expect(found(watch({ folder: '/a/b', glob: '*' }), csv('/a/b/c/ledger.csv'))).toEqual([])
  })

  it('takes a watch without a pattern, or with one that is not text, as every file', () => {
    expect(found(watch({ folder: '/Users/demo/Receipts' }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: 5 }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(1))
  })

  it('looks at folder watch triggers only, of any version', () => {
    const config = { folder: '/Users/demo/Receipts', glob: '*' }
    expect(found(watch(config, 't1', 'trigger.manual@1'), csv('/Users/demo/Receipts/ledger.csv'))).toEqual([])
    expect(found(watch(config, 't1', 'trigger.cron@1'), csv('/Users/demo/Receipts/ledger.csv'))).toEqual([])
    expect(found(watch(config, 't1', 'trigger.folderWatch@2'), csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(1))
  })

  it('skips a watch whose folder is not text, a write whose path is not text and a node of an unknown type', () => {
    const unknown: Node = { id: 'x', type: 'nowhere@1', config: { file: '/Users/demo/Receipts/ledger.csv' } }
    expect(found(watch({ folder: 5, glob: '*' }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual([])
    expect(found(watch({ folder: null }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual([])
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), csv(5))).toEqual([])
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), csv(undefined))).toEqual([])
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), unknown)).toEqual([])
    expect(found(unknown)).toEqual([])
  })

  it('flags a write and not a read, since a read does not change the folder', () => {
    const read: Node = { id: 'n1', type: 'llm.extract@1', config: { file: '/Users/demo/Receipts/receipt.pdf', fields: [] } }
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), read)).toEqual([])
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: '*' }), read, csv('/Users/demo/Receipts/ledger.csv', 'n2'))).toEqual(LOOP(2))
  })

  it('flags every write that lands in any of several watched folders', () => {
    const a = watch({ folder: '/Users/demo/A', glob: '*' }, 't1')
    const b = watch({ folder: '/Users/demo/B', glob: '*.csv' }, 't2')
    expect(found(a, b, csv('/Users/demo/A/ledger.csv'))).toEqual(LOOP(2))
    expect(found(a, b, csv('/Users/demo/B/ledger.csv'))).toEqual(LOOP(2))
    expect(found(a, b, csv('/Users/demo/C/ledger.csv'))).toEqual([])
    expect(found(a, b, csv('/Users/demo/B/ledger.txt'))).toEqual([])
    expect(found(a, b, csv('/Users/demo/A/one.csv', 'n1'), csv('/Users/demo/B/two.csv', 'n2'))).toEqual(['inside_watched_folder at /nodes/2/config/file', 'inside_watched_folder at /nodes/3/config/file'])
  })

  it('sees the same folder behind ~/, a dot segment, a double slash, a trailing slash and a different case', () => {
    const home = homedir()
    expect(found(watch({ folder: '~/Receipts', glob: '*' }), csv(join(home, 'Receipts', 'ledger.csv')))).toEqual(LOOP(1))
    expect(found(watch({ folder: join(home, 'Receipts'), glob: '*' }), csv('~/Receipts/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/demo/Receipts/', glob: '*' }), csv('/Users/demo/Receipts/./ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/demo//Receipts', glob: '*' }), csv('/Users/demo/Receipts/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/DEMO/receipts', glob: '*' }), csv('/users/demo/RECEIPTS/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '~/Receipts', glob: '*' }), csv('~/Other/ledger.csv'))).toEqual([])
  })

  it('sees the same folder written with composed and with decomposed letters, as a desktop file system does', () => {
    expect(found(watch({ folder: '/Users/demo/Café', glob: '*' }), csv('/Users/demo/Café/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/demo/Café', glob: '*' }), csv('/Users/demo/Café/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/Users/demo/Receipts', glob: 'café.csv' }), csv('/Users/demo/Receipts/café.csv'))).toEqual(LOOP(1))
  })

  it('names the code and the position and carries a message that names no path', () => {
    const issues = watchedFolderIssues(
      { schemaVersion: 1, name: 'x', nodes: [watch({ folder: '/Users/demo/SECRET-FOLDER', glob: '*' }), csv('/Users/demo/SECRET-FOLDER/ledger.csv')], edges: [] } as unknown as Workflow,
      registry,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'inside_watched_folder', pointer: '/nodes/1/config/file', stage: 3 })
    expect(JSON.stringify(issues[0])).not.toContain('SECRET-FOLDER')
  })
})

describe('templates in the written file name', () => {
  const folder = '/Users/demo/Receipts'

  it('reads a template as ordinary text', () => {
    expect(found(watch({ folder, glob: '*' }), csv(`${folder}/ledger-{{t1.output.name}}.csv`))).toEqual(LOOP(1))
    expect(found(watch({ folder, glob: '*.csv' }), csv(`${folder}/{{t1.output.name}}.csv`))).toEqual(LOOP(1))
    expect(found(watch({ folder, glob: '*.pdf' }), csv(`${folder}/{{t1.output.name}}.csv`))).toEqual([])
    expect(found(watch({ folder, glob: 'ledger.csv' }), csv(`${folder}/{{t1.output.name}}.csv`))).toEqual([])
    expect(found(watch({ folder, glob: '*' }), csv('{{t1.output.dir}}/ledger.csv'))).toEqual([])
  })
})

describe('validateWorkflow', () => {
  const workflow = (glob: string, file: string) =>
    ({
      schemaVersion: 1,
      name: 'ledger',
      nodes: [watch({ folder: '/Users/demo/Receipts', glob }, 't1'), csv(file, 'n2')],
      edges: [{ from: 't1', to: 'n2' }],
    }) as unknown as Workflow

  it('reports the loop as an error in stage 3', () => {
    const issues = validateWorkflow(workflow('*', '/Users/demo/Receipts/ledger.csv'), { registry })
    const hit = issues.find((issue) => issue.code === 'inside_watched_folder')
    expect(hit).toMatchObject({ stage: 3, pointer: '/nodes/1/config/file' })
    expect(isWarningIssue(hit!)).toBe(false)
  })

  it('is silent for a pattern that does not match and when stage 3 is not asked for', () => {
    expect(validateWorkflow(workflow('*.pdf', '/Users/demo/Receipts/ledger.csv'), { registry })).toEqual([])
    expect(validateWorkflow(workflow('*', '/Users/demo/Receipts/ledger.csv'), { registry, stages: [1, 2] })).toEqual([])
  })

  it('exports one code that the issue list knows', () => {
    expect(WATCHED_FOLDER_CODE).toBe('inside_watched_folder')
    expect(ISSUE_CODES).toContain(WATCHED_FOLDER_CODE)
  })
})

describe('what a folder watch sees', () => {
  it('matches the whole name, case-insensitively, with * and ? that never cross a separator', () => {
    expect(compileGlob('*.pdf').test('A.PDF')).toBe(true)
    expect(compileGlob('*.pdf').test('a.pdf.txt')).toBe(false)
    expect(compileGlob('r?.csv').test('r1.csv')).toBe(true)
    expect(compileGlob('r?.csv').test('r12.csv')).toBe(false)
    expect(compileGlob('*').test('a/b')).toBe(false)
    expect(compileGlob('*').test('a\\b')).toBe(false)
    expect(compileGlob('a.b').test('axb')).toBe(false)
    expect(compileGlob('(a)+[b]').test('(a)+[b]')).toBe(true)
  })

  it('skips hidden, editor lock, temporary and partial download names', () => {
    const all = compileGlob('*')
    for (const name of ['.hidden', '~$lock.docx', 'draft~', 'a.tmp', 'a.PART', 'a.crdownload', 'a.Download']) expect(folderWatchSees(all, name), name).toBe(false)
    for (const name of ['ledger.csv', 'a.part.pdf', 'tmp', 'a~b']) expect(folderWatchSees(all, name), name).toBe(true)
  })

  it('compares composed and decomposed letters as the same name', () => {
    expect(folderWatchSees(compileGlob('caf\u00e9.csv'), 'cafe\u0301.csv')).toBe(true)
  })
})

function legacyRegExp(glob: string): RegExp {
  let source = ''
  for (const char of glob.normalize('NFC')) {
    if (char === '*') source += '[^/\\\\]*'
    else if (char === '?') source += '[^/\\\\]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

describe('the glob matcher', () => {
  it('answers as the regular expression it replaced on 20000 random globs and names', () => {
    const alphabet = ['a', 'b', 'A', 'B', '.', '+', '(', '[', '\\', '/', '\n', 'é', 'É', 'ß', 'ſ', 'K', 'k', 'K', 'İ', 'ı', '\ud83d', '\ude00']
    let seed = 12345
    const next = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor(seed / 65536) % limit
    }
    const word = (extra: string[], max: number): string => {
      const pool = [...alphabet, ...extra]
      return Array.from({ length: next(max) }, () => pool[next(pool.length)] as string).join('')
    }
    let matched = 0
    for (let round = 0; round < 20000; round += 1) {
      const glob = word(['*', '*', '?'], 8)
      const name = word([], 8)
      const expected = legacyRegExp(glob).test(name)
      if (expected) matched += 1
      expect(compileGlob(glob).test(name), JSON.stringify({ glob, name })).toBe(expected)
    }
    expect(matched).toBeGreaterThan(300)
  })

  it('answers as the old expression on named cases', () => {
    const cases: [string, string][] = [['*a*b', 'xxaxxb'], ['*a*b', 'a/ab'], ['a*', 'a/b'], ['?', '/'], ['?', '\\'], ['*', ''], ['', ''], ['', 'a'], ['**', 'abc'], ['a**b', 'ab'], ['*?*', 'a'], ['*?*', ''], ['ß', 'SS'], ['ß', 'ẞ'], ['K', 'K'], ['ſ', 's'], ['\u{1f600}x', '\u{1f600}x'], ['\u{1f600}', '\ud83d'], ['?', '\u{1f600}'], ['??', '\u{1f600}']]
    for (const [glob, name] of cases) expect(compileGlob(glob).test(name), `${glob} ${name}`).toBe(legacyRegExp(glob).test(name))
  })

  it('stays fast on a glob that made the old expression crawl', () => {
    const matcher = compileGlob(`${'*a'.repeat(40)}b`)
    const started = Date.now()
    expect(matcher.test('a'.repeat(250))).toBe(false)
    expect(compileGlob(`${'*'.repeat(200)}a`).test('b'.repeat(2000))).toBe(false)
    expect(compileGlob(`${'*'.repeat(200)}a`).test(`${'b'.repeat(2000)}a`)).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('a write that starts from the file of the trigger', () => {
  const folder = '/Users/demo/Receipts'
  const one = (glob: string | undefined, file: string, id = 't1') => found(watch(glob === undefined ? { folder } : { folder, glob }, id), csv(file))

  it('flags the file that started the run and a file named after it in the same folder', () => {
    expect(one('*', '{{t1.output.file}}')).toEqual(LOOP(1))
    expect(one('*.pdf', '{{ t1.output.file }}')).toEqual(LOOP(1))
    expect(one('*', '{{t1.output.file}}.csv')).toEqual(LOOP(1))
    expect(one(undefined, '{{t1.output.file}}.csv')).toEqual(LOOP(1))
    expect(one('*.csv', '{{t1.output.file}}.csv')).toEqual(LOOP(1))
  })

  it('leaves a file that the trigger would not see, a path that goes elsewhere and another trigger alone', () => {
    expect(one('*.pdf', '{{t1.output.file}}.csv')).toEqual([])
    expect(one('*', '{{t1.output.file}}.tmp')).toEqual([])
    expect(one('*', '{{t1.output.file}}/ledger.csv')).toEqual([])
    expect(one('*', '{{t1.output.file}}\\ledger.csv')).toEqual([])
    expect(one('*', '{{t2.output.file}}.csv')).toEqual([])
    expect(one('*', '{{t1.output.name}}.csv')).toEqual([])
    expect(one('*', 'x{{t1.output.file}}.csv')).toEqual([])
  })

  it('skips a relative path that holds a template, since it depends on the folder the engine runs in', () => {
    expect(found(watch({ folder: process.cwd(), glob: '*' }), csv('{{t1.output.name}}.csv'))).toEqual([])
    expect(found(watch({ folder: process.cwd(), glob: '*' }), csv('ledger.csv'))).toEqual(LOOP(1))
  })
})

describe('the same folder behind a symbolic link', () => {
  const base = mkdtempSync(join(tmpdir(), 'rill-watched-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const real = join(base, 'real')
  const link = join(base, 'link')
  mkdirSync(real)
  symlinkSync(real, link)

  it('sees the real folder and the link as one folder, in either order and for a file that does not exist yet', () => {
    expect(found(watch({ folder: link, glob: '*' }), csv(join(real, 'ledger.csv')))).toEqual(LOOP(1))
    expect(found(watch({ folder: real, glob: '*' }), csv(join(link, 'ledger.csv')))).toEqual(LOOP(1))
    expect(found(watch({ folder: realpathSync(base), glob: '*' }), csv(join(link, 'ledger.csv')))).toEqual([])
    expect(found(watch({ folder: join(link, 'later'), glob: '*' }), csv(join(real, 'later', 'ledger.csv')))).toEqual(LOOP(1))
  })

  it('compares the written spelling when the link points nowhere', () => {
    const dangling = join(base, 'dangling')
    symlinkSync(join(base, 'missing'), dangling)
    expect(found(watch({ folder: dangling, glob: '*' }), csv(join(dangling, 'ledger.csv')))).toEqual(LOOP(1))
    expect(found(watch({ folder: dangling, glob: '*' }), csv(join(real, 'ledger.csv')))).toEqual([])
  })

  it('compares the written spelling when the folder does not exist at all', () => {
    expect(found(watch({ folder: '/rill-nowhere/in', glob: '*' }), csv('/rill-nowhere/in/ledger.csv'))).toEqual(LOOP(1))
    expect(found(watch({ folder: '/rill-nowhere/in', glob: '*' }), csv('/rill-nowhere/out/ledger.csv'))).toEqual([])
  })
})

describe('the issue the planner sees', () => {
  it('carries the fix as a fixed hint and no path in the message', () => {
    const [issue] = watchedFolderIssues(
      { schemaVersion: 1, name: 'x', nodes: [watch({ folder: '/Users/demo/SECRET-FOLDER', glob: '*' }), csv('/Users/demo/SECRET-FOLDER/ledger.csv')], edges: [] } as unknown as Workflow,
      registry,
    )
    expect(issue!.hint).toBe(WATCHED_FOLDER_HINT)
    expect(WATCHED_FOLDER_HINT).toBe('write the file to another folder or narrow the trigger pattern')
    expect(JSON.stringify(issue)).not.toContain('SECRET-FOLDER')
  })
})
