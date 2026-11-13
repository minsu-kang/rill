import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageError, resolveConnections } from '../src/cli-config'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')
const SECRET = 'ENV-SECRET-MARKER-7712'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-conn-env-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[], env: Record<string, string>) {
  const clean: NodeJS.ProcessEnv = { ...process.env }
  delete clean.RILL_CONNECTIONS
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: root,
    env: { ...clean, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
}

function slackWorkflow(connection: string): string {
  const file = join(dir, 'wf.json')
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      name: 'slack',
      nodes: [
        { id: 't1', type: 'trigger.manual@1', config: {} },
        { id: 's1', type: 'notify.slack@1', config: { connection, text: 'hi' } },
      ],
      edges: [{ from: 't1', to: 's1' }],
    }),
  )
  return file
}

describe('resolveConnections with RILL_CONNECTIONS', () => {
  it('reads both forms like the file does and offers only the typed one to the planner', () => {
    const env: Record<string, string | undefined> = {
      RILL_CONNECTIONS: JSON.stringify({ plain: SECRET, team: { secret: `${SECRET}-2`, kind: 'slack' } }),
    }
    const loaded = resolveConnections({ file: undefined, env })
    expect(loaded.resolver.get('plain')).toBe(SECRET)
    expect(loaded.resolver.get('team')).toBe(`${SECRET}-2`)
    expect(loaded.planConnections).toEqual([{ name: 'team', kind: 'slack' }])
    expect(JSON.stringify(loaded.planConnections)).not.toContain(SECRET)
  })

  it('gives the same result as the file for the same text', () => {
    const text = JSON.stringify({ a: 'x', b: { secret: 'y', kind: 'http' } })
    const file = join(dir, 'connections.json')
    writeFileSync(file, text)
    const fromFile = resolveConnections({ file, env: {} })
    const fromEnv = resolveConnections({ file: undefined, env: { RILL_CONNECTIONS: text } })
    expect(fromEnv.planConnections).toEqual(fromFile.planConnections)
    expect(fromEnv.resolver.get('a')).toBe(fromFile.resolver.get('a'))
    expect(fromEnv.resolver.get('b')).toBe(fromFile.resolver.get('b'))
  })

  it('removes the variable from the environment it was read from, even when the value is bad', () => {
    const good: Record<string, string | undefined> = { RILL_CONNECTIONS: '{}' }
    resolveConnections({ file: undefined, env: good })
    expect('RILL_CONNECTIONS' in good).toBe(false)
    const bad: Record<string, string | undefined> = { RILL_CONNECTIONS: `{ ${SECRET}` }
    expect(() => resolveConnections({ file: undefined, env: bad })).toThrow(UsageError)
    expect('RILL_CONNECTIONS' in bad).toBe(false)
  })

  it('treats an empty variable as not set and falls back to the file', () => {
    const file = join(dir, 'connections.json')
    writeFileSync(file, JSON.stringify({ viaFile: 'v' }))
    const env: Record<string, string | undefined> = { RILL_CONNECTIONS: '' }
    expect(resolveConnections({ file, env }).resolver.get('viaFile')).toBe('v')
    expect(resolveConnections({ file: undefined, env: {} }).planConnections).toEqual([])
  })

  it('refuses an invalid value with a usage error that names the variable and never prints the content', () => {
    for (const value of [`{ ${SECRET}`, JSON.stringify([SECRET]), JSON.stringify(SECRET), 'null', JSON.stringify({ team: { secret: SECRET, kind: 'discord' } }), JSON.stringify({ team: { secret: 5, kind: 'slack', note: SECRET } })]) {
      let error: unknown
      try {
        resolveConnections({ file: undefined, env: { RILL_CONNECTIONS: value } })
      } catch (caught) {
        error = caught
      }
      expect(error, value).toBeInstanceOf(UsageError)
      expect((error as Error).message).toContain('RILL_CONNECTIONS')
      expect((error as Error).message).not.toContain(SECRET)
    }
  })

  it('refuses the variable together with a connections file, naming both', () => {
    const file = join(dir, 'connections.json')
    writeFileSync(file, '{}')
    let error: unknown
    try {
      resolveConnections({ file, env: { RILL_CONNECTIONS: '{}' } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(UsageError)
    expect((error as Error).message).toContain('RILL_CONNECTIONS')
    expect((error as Error).message).toContain('--connections')
  })

  it('keeps the file behaviour: a missing file is a file system error', () => {
    expect(() => resolveConnections({ file: join(dir, 'nope.json'), env: {} })).toThrow('ENOENT')
  })
})

describe('rill-engine with RILL_CONNECTIONS', () => {
  it('lets a node resolve a connection from the variable, and fails on the unknown one without it', () => {
    const wf = slackWorkflow('typed')
    const known = runCli(['run', wf, '--db', join(dir, 'a.db')], {
      RILL_CONNECTIONS: JSON.stringify({ typed: { secret: 'http://127.0.0.1:9/hook', kind: 'slack' } }),
    })
    expect(known.status).toBe(1)
    expect(known.stdout).not.toContain('unknown connection')
    const unknown = runCli(['run', wf, '--db', join(dir, 'b.db')], {})
    expect(unknown.status).toBe(1)
    expect(unknown.stdout).toContain('unknown connection')
  })

  it('exits with a usage error for a bad value, names the variable, prints no content and opens no database', () => {
    const result = runCli(['serve', '--db', join(dir, 'c.db')], { RILL_CONNECTIONS: `{"x": "${SECRET}" oops` })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('RILL_CONNECTIONS')
    expect(result.stderr + result.stdout).not.toContain(SECRET)
    expect(existsSync(join(dir, 'c.db'))).toBe(false)
  })

  it('exits with a usage error when both the variable and --connections are given', () => {
    const file = join(dir, 'connections.json')
    writeFileSync(file, '{}')
    const result = runCli(['serve', '--db', join(dir, 'd.db'), '--connections', file], { RILL_CONNECTIONS: '{}' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('RILL_CONNECTIONS')
    expect(result.stderr).toContain('--connections')
  })

  it('documents the variable in the help text', () => {
    const result = runCli(['--db', join(dir, 'e.db')], {})
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('RILL_CONNECTIONS')
  })
})

describe('rill-engine with an account connection', () => {
  const TOKEN = 'ya29.TOKENMARKER0123456789'
  const workflow = (node: Record<string, unknown>): string => {
    const file = join(dir, 'account.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: 'account', nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }, { id: 'n1', ...node }], edges: [{ from: 't1', to: 'n1' }] }))
    return file
  }
  const httpStep = (connection: string) => ({ type: 'http.request@1', config: { url: 'http://127.0.0.1:9/ingest', method: 'POST', body: { a: 1 }, auth: { connection } } })

  it('refuses a plain http.request that names a google entry of the connections file, before any request', () => {
    const connections = join(dir, 'connections.json')
    writeFileSync(connections, JSON.stringify({ sheets: { secret: TOKEN, kind: 'google' }, drive: { secret: 'eyJTOKENMARKER0123456789.payload.sig', kind: 'microsoft' } }))
    for (const [name, label] of [['sheets', 'Google'], ['drive', 'Microsoft']] as const) {
      const result = runCli(['run', workflow(httpStep(name)), '--db', join(dir, `${name}.db`), '--connections', connections], {})
      expect(result.status, name).toBe(1)
      expect(result.stdout).toContain(`connection ${name} is a ${label} connection`)
      expect(result.stdout).not.toContain('network error')
      expect(result.stdout + result.stderr).not.toContain('TOKENMARKER')
    }
  })

  it('refuses the same through RILL_CONNECTIONS, and sends nothing with an entry that has no kind', () => {
    const refused = runCli(['run', workflow(httpStep('sheets')), '--db', join(dir, 'r1.db')], { RILL_CONNECTIONS: JSON.stringify({ sheets: { secret: TOKEN, kind: 'google' } }) })
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain('connection sheets is a Google connection')
    const untyped = runCli(['run', workflow(httpStep('sheets')), '--db', join(dir, 'r2.db')], { RILL_CONNECTIONS: JSON.stringify({ sheets: TOKEN }) })
    expect(untyped.status).toBe(1)
    expect(untyped.stdout).toContain('network error')
    expect(untyped.stdout).not.toContain('is a Google connection')
  })

  it('fails a google step with an unknown connection without touching the network', () => {
    const step = { type: 'google.sheets.append@1', config: { connection: 'nobody', spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', values: ['a'] } }
    const result = runCli(['run', workflow(step), '--db', join(dir, 'u.db')], {})
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unknown connection: nobody')
  })
})
