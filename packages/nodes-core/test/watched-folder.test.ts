import { homedir } from 'node:os'
import { join } from 'node:path'
import { ISSUE_CODES, isWarningIssue, type Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import { createCoreRegistry } from '../src'
import { WATCHED_FOLDER_CODE, folderWatchSees, globToRegExp, watchedFolderIssues } from '../src/watched-folder'
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
    expect(globToRegExp('*.pdf').test('A.PDF')).toBe(true)
    expect(globToRegExp('*.pdf').test('a.pdf.txt')).toBe(false)
    expect(globToRegExp('r?.csv').test('r1.csv')).toBe(true)
    expect(globToRegExp('r?.csv').test('r12.csv')).toBe(false)
    expect(globToRegExp('*').test('a/b')).toBe(false)
    expect(globToRegExp('*').test('a\\b')).toBe(false)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
    expect(globToRegExp('(a)+[b]').test('(a)+[b]')).toBe(true)
  })

  it('skips hidden, editor lock, temporary and partial download names', () => {
    const all = globToRegExp('*')
    for (const name of ['.hidden', '~$lock.docx', 'draft~', 'a.tmp', 'a.PART', 'a.crdownload', 'a.Download']) expect(folderWatchSees(all, name), name).toBe(false)
    for (const name of ['ledger.csv', 'a.part.pdf', 'tmp', 'a~b']) expect(folderWatchSees(all, name), name).toBe(true)
  })

  it('compares composed and decomposed letters as the same name', () => {
    expect(folderWatchSees(globToRegExp('caf\u00e9.csv'), 'cafe\u0301.csv')).toBe(true)
  })
})
