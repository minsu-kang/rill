import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-cli-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, encoding: 'utf8' })
}

describe('rill-engine cli', () => {
  it('runs a workflow file end to end', () => {
    const csv = join(dir, 'out.csv')
    const file = join(dir, 'wf.json')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        name: 'cli-test',
        nodes: [
          { id: 't1', type: 'trigger.manual@1', config: {} },
          { id: 'n1', type: 'transform@1', config: { values: { amount: '{{t1.output.amount}}' } } },
          { id: 'n2', type: 'csv.append@1', config: { file: csv, row: ['{{n1.output.amount}}'] } },
        ],
        edges: [
          { from: 't1', to: 'n1' },
          { from: 'n1', to: 'n2' },
        ],
      }),
    )
    const result = run('run', file, '--db', join(dir, 'rill.db'), '--payload', '{"amount": 7}')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).status).toBe('succeeded')
    expect(readFileSync(csv, 'utf8')).toBe('7\n')
  })

  it('exits 1 with a message for an invalid workflow', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify({ nope: true }))
    const result = run('run', file, '--db', join(dir, 'rill.db'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid workflow')
  })

  it('exits 2 and prints usage for an unknown command', () => {
    const result = run('explode', '--db', join(dir, 'rill.db'))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })

  it('recover reports an empty list when nothing is pending', () => {
    const result = run('recover', '--db', join(dir, 'rill.db'))
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([])
  })
})
