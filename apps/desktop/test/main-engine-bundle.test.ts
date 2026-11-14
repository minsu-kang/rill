// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RillClient } from '@rill/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, bundleEngine } from '../scripts/bundle-engine'

const TOKEN = 'bundle-token-0123456789abcdef'
let dir: string
let outFile: string
let text: string
let inputs: string[]
const children: ChildProcess[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rill-bundle-'))
  outFile = join(dir, 'out', 'rill-engine.mjs')
  const result = await bundleEngine({ outFile })
  inputs = result.inputs
  text = readFileSync(outFile, 'utf8')
}, 120_000)

afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

describe('the engine bundle', () => {
  it('is one .mjs file and nothing else', () => {
    expect(readdirSync(join(dir, 'out'))).toEqual(['rill-engine.mjs'])
  })

  it('does not pull in tsx or esbuild and leaves no absolute path of the build machine', () => {
    expect(inputs.length).toBeGreaterThan(50)
    expect(inputs.filter((input) => /node_modules\/(tsx|esbuild)\//.test(input) || /\/\.pnpm\/(tsx|esbuild)@/.test(input))).toEqual([])
    expect(text).not.toMatch(/--import\s+tsx|from\s+["']tsx["']|require\(["']tsx["']\)/)
    for (const absolute of [REPO_ROOT, homedir(), dir]) expect(text, absolute).not.toContain(absolute)
    expect(text).not.toContain('sourceMappingURL')
  })

  it('keeps node:sqlite external, so the runtime provides it', () => {
    expect(text).toMatch(/from\s*["']node:sqlite["']|require\(["']node:sqlite["']\)/)
  })

  it('starts with serve under plain Node from another folder, prints the listening line and answers ping', async () => {
    const child = spawn(
      process.execPath,
      [outFile, 'serve', '--db', join(dir, 'rill.db'), '--port', '0'],
      { cwd: dir, env: { PATH: process.env.PATH ?? '', RILL_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const deadline = Date.now() + 20_000
    while (!stdout.includes('\n') && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(stderr).toBe('')
    const line = JSON.parse(stdout.split('\n')[0]!) as { type: string; host: string; port: number; protocol: number; token?: string }
    expect(line).toMatchObject({ type: 'listening', host: '127.0.0.1', protocol: 1 })
    expect(line.token).toBeUndefined()
    const client = await RillClient.connect(`ws://127.0.0.1:${line.port}/`, TOKEN)
    const ping = await client.request('ping', {})
    expect(typeof ping.time).toBe('number')
    client.close()
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(existsSync(join(dir, 'rill.db'))).toBe(true)
  }, 60_000)
})
