import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RillClient } from '@rill/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageError, loadConnections, parseConnections, prepareAttachmentsDir } from '../src/cli-config'
import { childEnvironment } from './llm-env'
import { exited, waitFor } from './process'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = join(root, 'packages/engine/src/cli.ts')
const TOKEN = 'cli-plan-token-0123456789abcdef'

let dir: string
const children: ChildProcess[] = []
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-cli-plan-'))
})

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const SECRET = 'TOP-SECRET-VALUE-4411'

describe('parseConnections', () => {
  it('reads plain secrets and secrets with a kind', () => {
    const { resolver, planConnections } = parseConnections(
      JSON.stringify({
        plain: 'https://example.test/hook',
        team: { secret: 'hooks.slack.test/abc', kind: 'slack' },
        api: { secret: 'token', kind: 'http' },
        signer: { secret: 'shh', kind: 'webhookSecret' },
      }),
    )
    expect(resolver.get('plain')).toBe('https://example.test/hook')
    expect(resolver.get('team')).toBe('hooks.slack.test/abc')
    expect(resolver.get('api')).toBe('token')
    expect(resolver.get('signer')).toBe('shh')
    expect(resolver.get('missing')).toBeUndefined()
    expect(planConnections).toEqual([
      { name: 'team', kind: 'slack' },
      { name: 'api', kind: 'http' },
      { name: 'signer', kind: 'webhookSecret' },
    ])
  })

  it('reads google and microsoft connections, tells their kind to the resolver and to the planner, and never offers the token', () => {
    const google = 'ya29.TOKENMARKER0123456789'
    const microsoft = 'eyJTOKENMARKER0123456789.payload.sig'
    const { resolver, planConnections } = parseConnections(
      JSON.stringify({ sheets: { secret: google, kind: 'google' }, drive: { secret: microsoft, kind: 'microsoft' }, api: { secret: 'k', kind: 'http' }, bare: 'plain-secret' }),
    )
    expect(resolver.get('sheets')).toBe(google)
    expect(resolver.get('drive')).toBe(microsoft)
    expect(resolver.kindOf?.('sheets')).toBe('google')
    expect(resolver.kindOf?.('drive')).toBe('microsoft')
    expect(resolver.kindOf?.('api')).toBe('http')
    expect(resolver.kindOf?.('bare')).toBeUndefined()
    expect(resolver.kindOf?.('missing')).toBeUndefined()
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) expect(resolver.kindOf?.(name), name).toBeUndefined()
    expect(planConnections).toEqual([
      { name: 'sheets', kind: 'google' },
      { name: 'drive', kind: 'microsoft' },
      { name: 'api', kind: 'http' },
    ])
    expect(JSON.stringify(planConnections)).not.toContain('TOKENMARKER')
  })

  it('tells the planner whether a slack connection is a webhook or a bot, and never offers the token', () => {
    const token = 'xoxb-SLACKTOKENMARKER0123'
    const { planConnections } = parseConnections(
      JSON.stringify({
        hook: { secret: 'https://hooks.slack.com/services/T000/B000/WEBHOOKMARKER', kind: 'slack' },
        bot: { secret: JSON.stringify({ rillSlack: 1, token, channel: '#alerts' }), kind: 'slack' },
        plainBot: { secret: token, kind: 'slack' },
        broken: { secret: 'not a hook', kind: 'slack' },
        brokenJson: { secret: JSON.stringify({ rillSlack: 1 }), kind: 'slack' },
        api: { secret: token, kind: 'http' },
      }),
    )
    expect(planConnections).toEqual([
      { name: 'hook', kind: 'slack', slack: 'webhook' },
      { name: 'bot', kind: 'slack', slack: 'bot' },
      { name: 'plainBot', kind: 'slack', slack: 'bot' },
      { name: 'broken', kind: 'slack' },
      { name: 'brokenJson', kind: 'slack' },
      { name: 'api', kind: 'http' },
    ])
    expect(JSON.stringify(planConnections)).not.toContain('SLACKTOKENMARKER')
    expect(JSON.stringify(planConnections)).not.toContain('WEBHOOKMARKER')
  })

  it('does not offer plain secrets to the planner and never offers a secret value', () => {
    const { planConnections } = parseConnections(JSON.stringify({ plain: SECRET, typed: { secret: SECRET, kind: 'http' } }))
    expect(planConnections).toEqual([{ name: 'typed', kind: 'http' }])
    expect(JSON.stringify(planConnections)).not.toContain(SECRET)
  })

  it('accepts an empty file object and keeps the order of the typed entries', () => {
    expect(parseConnections('{}')).toMatchObject({ planConnections: [] })
    const { planConnections } = parseConnections(
      JSON.stringify({ b: { secret: 'x', kind: 'http' }, a: { secret: 'y', kind: 'slack' } }),
    )
    expect(planConnections.map((c) => c.name)).toEqual(['b', 'a'])
  })

  it('only answers for names that are in the file', () => {
    const { resolver } = parseConnections(JSON.stringify({ own: 'x' }))
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(resolver.get(name), name).toBeUndefined()
    }
    const odd = parseConnections('{"__proto__": "shadow", "constructor": {"secret": "c", "kind": "http"}}')
    expect(odd.resolver.get('__proto__')).toBe('shadow')
    expect(odd.resolver.get('constructor')).toBe('c')
  })

  it('rejects a kind that is not slack, http, webhookSecret, google or microsoft, without echoing the secret', () => {
    for (const kind of ['discord', '', 'SLACK', 'Google', 'oauth', 'microsoft ', 3, null, undefined, ['slack']]) {
      const text = JSON.stringify({ team: { secret: SECRET, ...(kind === undefined ? {} : { kind }) } })
      let error: unknown
      try {
        parseConnections(text)
      } catch (caught) {
        error = caught
      }
      expect(error, String(kind)).toBeInstanceOf(UsageError)
      expect((error as Error).message).toContain('"team"')
      expect((error as Error).message).toContain('kind')
      expect((error as Error).message).not.toContain(SECRET)
    }
  })

  it('rejects a secret that is not a string, without echoing it', () => {
    for (const secret of [5, null, true, ['a'], { a: SECRET }, undefined]) {
      const text = JSON.stringify({ team: { ...(secret === undefined ? {} : { secret }), kind: 'slack' } })
      let error: unknown
      try {
        parseConnections(text)
      } catch (caught) {
        error = caught
      }
      expect(error, JSON.stringify(secret)).toBeInstanceOf(UsageError)
      expect((error as Error).message).toContain('"team"')
      expect((error as Error).message).toContain('secret')
      expect((error as Error).message).not.toContain(SECRET)
    }
  })

  it('rejects entries that are neither a string nor an object, and unknown keys', () => {
    for (const entry of [5, null, true, ['slack'], []]) {
      expect(() => parseConnections(JSON.stringify({ team: entry })), JSON.stringify(entry)).toThrow(UsageError)
    }
    expect(() => parseConnections(JSON.stringify({ team: { secret: 'x', kind: 'slack', note: 'hi' } }))).toThrow('"note"')
  })

  it('rejects a file that is not an object', () => {
    for (const text of ['[]', '"text"', 'null', '5', 'true']) expect(() => parseConnections(text), text).toThrow(UsageError)
  })

  it('lets invalid JSON through as a syntax error', () => {
    expect(() => parseConnections('{ nope')).toThrow(SyntaxError)
  })
})

describe('loadConnections', () => {
  it('returns nothing without a file and reads a file otherwise', () => {
    expect(loadConnections(undefined).resolver.get('x')).toBeUndefined()
    expect(loadConnections(undefined).planConnections).toEqual([])
    const file = join(dir, 'connections.json')
    writeFileSync(file, JSON.stringify({ team: { secret: 's', kind: 'slack' } }))
    const loaded = loadConnections(file)
    expect(loaded.resolver.get('team')).toBe('s')
    expect(loaded.planConnections).toEqual([{ name: 'team', kind: 'slack' }])
  })

  it('throws the file system error for a missing file', () => {
    expect(() => loadConnections(join(dir, 'nope.json'))).toThrow('ENOENT')
  })
})

describe('prepareAttachmentsDir', () => {
  it('creates a missing folder, including parents, readable only by the owner', () => {
    const target = join(dir, 'a', 'b', 'attachments')
    expect(prepareAttachmentsDir(target, undefined)).toBe(target)
    const mode = statSync(target).mode & 0o777
    expect(statSync(target).isDirectory()).toBe(true)
    expect(mode & 0o077).toBe(0)
    expect(mode & 0o700).toBe(0o700)
    expect(statSync(join(dir, 'a', 'b')).mode & 0o077).toBe(0)
  })

  it('leaves an existing folder and its files alone', () => {
    const target = join(dir, 'existing')
    mkdirSync(target)
    chmodSync(target, 0o755)
    writeFileSync(join(target, 'keep.txt'), 'x')
    expect(prepareAttachmentsDir(target, undefined)).toBe(target)
    expect(statSync(target).mode & 0o777).toBe(0o755)
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })

  it('resolves a relative path to an absolute one', () => {
    const target = join(dir, 'relative-target')
    expect(prepareAttachmentsDir(relative(process.cwd(), target), undefined)).toBe(target)
    expect(existsSync(target)).toBe(true)
  })

  it('refuses a path that is a file', () => {
    const file = join(dir, 'file')
    writeFileSync(file, 'x')
    expect(() => prepareAttachmentsDir(file, undefined)).toThrow()
  })

  it('accepts a folder inside an allowed folder and creates it', () => {
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    const target = join(allowed, 'attachments')
    expect(prepareAttachmentsDir(target, [allowed])).toBe(target)
    expect(existsSync(target)).toBe(true)
    expect(prepareAttachmentsDir(allowed, [allowed])).toBe(allowed)
  })

  it('refuses a folder outside every allowed folder and does not create it', () => {
    const allowed = join(dir, 'allowed')
    const other = join(dir, 'other')
    mkdirSync(allowed)
    const target = join(other, 'attachments')
    expect(() => prepareAttachmentsDir(target, [allowed])).toThrow(UsageError)
    expect(() => prepareAttachmentsDir(target, [allowed])).toThrow('--attachments-dir must be inside an --allow folder')
    expect(existsSync(other)).toBe(false)
  })

  it('refuses a folder that reaches outside through a symlink, and does not create it', () => {
    const allowed = join(dir, 'allowed')
    const outside = join(dir, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    symlinkSync(outside, join(allowed, 'link'))
    expect(() => prepareAttachmentsDir(join(allowed, 'link', 'attachments'), [allowed])).toThrow(UsageError)
    expect(existsSync(join(outside, 'attachments'))).toBe(false)
  })

  it('refuses a path with parent segments that lands outside', () => {
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    expect(() => prepareAttachmentsDir(join(allowed, '..', 'escape'), [allowed])).toThrow(UsageError)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })

  it('treats an empty allow list like no allow list', () => {
    const target = join(dir, 'anywhere')
    expect(prepareAttachmentsDir(target, [])).toBe(target)
  })
})

function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return childEnvironment({ RILL_TOKEN: TOKEN, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ...extra })
}

async function fakeAnthropic(): Promise<{ baseUrl: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      bodies.push(body)
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }
}

function sentText(body: string): string {
  const parsed = JSON.parse(body) as { messages: Array<{ content: string | Array<{ type: string; text?: string }> }> }
  return parsed.messages
    .flatMap((message) => (typeof message.content === 'string' ? [message.content] : message.content.map((part) => part.text ?? '')))
    .join('\n')
}

function runSync(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, encoding: 'utf8', env: cliEnv() })
}

async function startServe(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'serve', ...args], {
    cwd: root,
    env: cliEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  await waitFor(() => stdout.includes('\n') || child.exitCode !== null)
  const listening = JSON.parse(stdout.split('\n')[0]!) as { port: number }
  const client = await RillClient.connect(`ws://127.0.0.1:${listening.port}/`, TOKEN)
  return { child, client }
}

describe('rill-engine serve with the planner', () => {
  it('creates the attachments folder with mode 0700 and hands the connections, the folders and the attachment to the planner', async () => {
    const fake = await fakeAnthropic()
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    const attachments = join(allowed, 'att')
    const connections = join(dir, 'connections.json')
    writeFileSync(connections, JSON.stringify({ team: { secret: 'hook-secret-777', kind: 'slack' }, 'office-hook': 'plain-secret-888' }))
    const { child, client } = await startServe(
      ['--db', join(dir, 'serve.db'), '--allow', allowed, '--attachments-dir', attachments, '--connections', connections],
      { ANTHROPIC_API_KEY: 'dummy-key-for-the-local-fake', ANTHROPIC_BASE_URL: fake.baseUrl },
    )
    expect(statSync(attachments).isDirectory()).toBe(true)
    expect(statSync(attachments).mode & 0o077).toBe(0)

    writeFileSync(join(attachments, 'receipt1.txt'), 'Receipt total 12.50')
    const ref = { id: 'receipt1', mediaType: 'text/plain' as const, name: 'receipt.txt', bytes: 20 }
    const base = { text: 'Log the receipt', turns: [], effort: 'low' as const }
    await expect(client.request('plan', { ...base, planId: 'with-file', attachments: [ref] })).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    })
    expect(fake.bodies).toHaveLength(1)
    const sent = sentText(fake.bodies[0]!)
    expect(sent).toContain('"connections":[{"name":"team","kind":"slack"}]')
    expect(sent).toContain(`"allowedFolders":[${JSON.stringify(allowed)}]`)
    expect(sent).toContain('Receipt total 12.50')
    for (const hidden of ['office-hook', 'hook-secret-777', 'plain-secret-888']) expect(fake.bodies[0], hidden).not.toContain(hidden)

    await expect(client.request('plan', { ...base, planId: 'no-file', attachments: [{ ...ref, id: 'absent001' }] })).rejects.toMatchObject({
      code: 'ATTACHMENT_REJECTED',
      message: expect.stringContaining('was not found'),
    })
    expect(fake.bodies).toHaveLength(1)
    const { plans } = await client.request('listPlans', {})
    expect(plans.map((p) => [p.planId, p.status]).sort()).toEqual([
      ['no-file', 'failed'],
      ['with-file', 'failed'],
    ])
    expect((await client.request('getPlan', { planId: 'with-file' })).plan.attachments).toEqual([ref])
    expect(await client.request('cancelPlan', { planId: 'with-file' })).toEqual({ cancelled: false })

    child.kill('SIGTERM')
    expect(await exited(child)).toBe(0)
  })

  it('has no attachments folder unless one is given', async () => {
    const { child, client } = await startServe(['--db', join(dir, 'serve.db')])
    const ref = { id: 'receipt1', mediaType: 'text/plain' as const, name: 'receipt.txt', bytes: 20 }
    const error = await client
      .request('plan', { planId: 'p', text: 'Log it', turns: [], attachments: [ref], effort: 'low' })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'ATTACHMENT_REJECTED', message: expect.stringContaining('no attachment store') })
    child.kill('SIGTERM')
    expect(await exited(child)).toBe(0)
  })

  it('exits with a usage error and creates nothing when the folder is outside the allowed folders', () => {
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    const outside = join(dir, 'outside', 'att')
    const result = runSync('serve', '--db', join(dir, 'serve.db'), '--allow', allowed, '--attachments-dir', outside)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--attachments-dir must be inside an --allow folder')
    expect(existsSync(join(dir, 'outside'))).toBe(false)
    expect(existsSync(join(dir, 'serve.db'))).toBe(false)
  })

  it('refuses --attachments-dir for commands other than serve', () => {
    const result = runSync('recover', '--db', join(dir, 'r.db'), '--attachments-dir', join(dir, 'att'))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--attachments-dir')
    expect(existsSync(join(dir, 'att'))).toBe(false)
  })

  it('exits with a usage error for a bad connection entry and never prints the secret', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify({ team: { secret: SECRET, kind: 'discord' } }))
    const result = runSync('serve', '--db', join(dir, 'serve.db'), '--connections', file)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('"team"')
    expect(result.stderr).not.toContain(SECRET)
    expect(existsSync(join(dir, 'serve.db'))).toBe(false)
  })

  it('resolves both connection forms for nodes: a lookup that succeeds fails later, on the local connection', () => {
    const wf = join(dir, 'wf.json')
    writeFileSync(
      wf,
      JSON.stringify({
        schemaVersion: 1,
        name: 'slack',
        nodes: [
          { id: 't1', type: 'trigger.manual@1', config: {} },
          { id: 's1', type: 'notify.slack@1', config: { connection: 'typed', text: 'hi' } },
          { id: 's2', type: 'notify.slack@1', config: { connection: 'plain', text: 'hi' } },
        ],
        edges: [
          { from: 't1', to: 's1' },
          { from: 't1', to: 's2' },
        ],
      }),
    )
    const connections = join(dir, 'connections.json')
    writeFileSync(
      connections,
      JSON.stringify({ typed: { secret: 'http://127.0.0.1:9/hook', kind: 'slack' }, plain: 'http://127.0.0.1:9/hook' }),
    )
    const result = runSync('run', wf, '--db', join(dir, 'e.db'), '--connections', connections)
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('unknown connection')
    writeFileSync(join(dir, 'empty.json'), '{}')
    const unknown = runSync('run', wf, '--db', join(dir, 'u.db'), '--connections', join(dir, 'empty.json'))
    expect(unknown.status).toBe(1)
    expect(unknown.stdout).toContain('unknown connection')
  })

  it('documents the new option, the connection forms, --allow and the API key in the help text', () => {
    const result = runSync('--db', join(dir, 'h.db'))
    expect(result.status).toBe(2)
    for (const text of ['--attachments-dir', 'ANTHROPIC_API_KEY', '"kind"', 'slack', 'webhookSecret', 'google', 'microsoft', '--allow', '0700']) {
      expect(result.stderr, text).toContain(text)
    }
  })
})
