// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RELEASE = join(import.meta.dirname, '..', 'release')
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
const FUSES = ['runAsNode', 'enableCookieEncryption', 'enableNodeOptionsEnvironmentVariable', 'enableNodeCliInspectArguments', 'enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar', 'loadBrowserProcessSpecificV8Snapshot', 'grantFileProtocolExtraPrivileges'] as const

function packedApp(): string | undefined {
  if (!existsSync(RELEASE)) return undefined
  return readdirSync(RELEASE)
    .map((folder) => join(RELEASE, folder, 'Rill.app'))
    .find((path) => existsSync(path))
}

function readFuses(app: string): Record<string, string> {
  const binary = readFileSync(join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'))
  const start = binary.indexOf(SENTINEL)
  expect(start).toBeGreaterThan(0)
  const wire = binary.subarray(start + SENTINEL.length)
  expect(wire[0]).toBe(1)
  const length = wire[1]!
  expect(length).toBeGreaterThanOrEqual(FUSES.length)
  return Object.fromEntries(FUSES.map((name, index) => [name, { 0x30: 'off', 0x31: 'on', 0x72: 'removed' }[wire[2 + index]!] ?? 'unknown']))
}

const app = process.platform === 'darwin' ? packedApp() : undefined

describe.skipIf(app === undefined)('the packed app (checked only after pnpm dist has made one)', () => {
  it('has the Electron fuses set: no run-as-node, no inspect flags, no NODE_OPTIONS, asar only and checked, no file protocol extras', () => {
    expect(readFuses(app!)).toMatchObject({
      runAsNode: 'off',
      enableNodeOptionsEnvironmentVariable: 'off',
      enableNodeCliInspectArguments: 'off',
      enableEmbeddedAsarIntegrityValidation: 'on',
      onlyLoadAppFromAsar: 'on',
      grantFileProtocolExtraPrivileges: 'off',
    })
  })

  it('has a signature that verifies, so a downloaded copy is not reported as damaged', () => {
    expect(() => execFileSync('codesign', ['--verify', '--deep', '--strict', app!], { stdio: 'pipe' })).not.toThrow()
  })
})
