import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-cli2-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, encoding: 'utf8' })
}

function writeWorkflow(name: string, workflow: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(workflow))
  return file
}

const branching = (csv: string) => ({
  schemaVersion: 1,
  name: 'cli-branching',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'c1', type: 'condition@1', config: { left: '{{t1.output.amount}}', operator: 'gt', right: 100 } },
    { id: 'big', type: 'csv.append@1', config: { file: csv, row: ['{{t1.output.amount}}'] } },
    { id: 'small', type: 'transform@1', config: { values: { note: 'small' } } },
  ],
  edges: [
    { from: 't1', to: 'c1' },
    { from: 'c1', to: 'big', when: 'true' },
    { from: 'c1', to: 'small', when: 'false' },
  ],
})

describe('rill-engine cli branching', () => {
  it('takes the true branch', () => {
    const csv = join(dir, 'out.csv')
    const file = writeWorkflow('wf.json', branching(csv))
    const result = run('run', file, '--db', join(dir, 'a.db'), '--payload', '{"amount": 150}')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.outputs).not.toHaveProperty('small')
    expect(readFileSync(csv, 'utf8')).toBe('150\n')
  })

  it('takes the false branch and skips the csv write', () => {
    const csv = join(dir, 'out.csv')
    const file = writeWorkflow('wf.json', branching(csv))
    const result = run('run', file, '--db', join(dir, 'b.db'), '--payload', '{"amount": 50}')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).outputs.small).toEqual({ note: 'small' })
    expect(existsSync(csv)).toBe(false)
  })

  it('confines file writes with --allow', () => {
    const allowed = join(dir, 'allowed')
    const other = join(dir, 'other')
    mkdirSync(allowed)
    mkdirSync(other)
    const inside = run('run', writeWorkflow('in.json', branching(join(allowed, 'out.csv'))), '--db', join(dir, 'c.db'), '--payload', '{"amount": 150}', '--allow', allowed)
    expect(inside.status).toBe(0)
    expect(existsSync(join(allowed, 'out.csv'))).toBe(true)

    const payload = JSON.stringify({ amount: 150, file: join(other, 'out.csv') })
    const outside = run('run', writeWorkflow('out.json', branching('{{t1.output.file}}')), '--db', join(dir, 'd.db'), '--payload', payload, '--allow', allowed)
    expect(outside.status).toBe(1)
    expect(JSON.parse(outside.stdout).error).toContain('outside the allowed folders')
    expect(existsSync(join(other, 'out.csv'))).toBe(false)
  })

  it('reads connections from a file and reports unknown ones', () => {
    const wf = writeWorkflow('slack.json', {
      schemaVersion: 1,
      name: 'slack',
      nodes: [
        { id: 't1', type: 'trigger.manual@1', config: {} },
        { id: 's1', type: 'notify.slack@1', config: { connection: 'slack', text: 'hi' } },
      ],
      edges: [{ from: 't1', to: 's1' }],
    })
    const connections = join(dir, 'connections.json')
    writeFileSync(connections, JSON.stringify({ other: 'https://example.test/hook' }))
    const result = run('run', wf, '--db', join(dir, 'e.db'), '--connections', connections)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).error).toContain('unknown connection: slack')
  })

  it('exits 1 with a message when the connections file is missing', () => {
    const wf = writeWorkflow('wf.json', branching(join(dir, 'out.csv')))
    const result = run('run', wf, '--db', join(dir, 'f.db'), '--connections', join(dir, 'nope.json'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ENOENT')
  })
})
