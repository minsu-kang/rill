// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const text = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { main: string; scripts: Record<string, string>; dependencies?: Record<string, string> }

function scalar(key: string, indent = ''): string | undefined {
  const match = new RegExp(`^${indent}${key}:\\s*(.+?)\\s*$`, 'm').exec(text)
  return match?.[1]
}

function list(key: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`)
  if (start === -1) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const item = /^\s+-\s+(.+?)\s*$/.exec(line)
    if (item) items.push(item[1]!.replace(/^['"]|['"]$/g, ''))
  }
  return items
}

describe('electron-builder configuration', () => {
  it('names the app and keeps the placeholder id', () => {
    expect(scalar('appId')).toBe('app.rill.desktop')
    expect(scalar('productName')).toBe('Rill')
    expect(text).toMatch(/placeholder/i)
  })

  it('builds a dmg and a zip for macOS, unsigned, without the hardened runtime, with asar', () => {
    expect(text).toMatch(/target:\s*\n\s+- dmg\n\s+- zip/)
    expect(scalar('identity', '  ')).toBe('null')
    expect(scalar('hardenedRuntime', '  ')).toBe('false')
    expect(scalar('asar')).toBe('true')
    expect(scalar('output', '  ')).toBe('release')
  })

  it('packs only the built app files, and none of the sources, tests, scripts, docs, maps or env files', () => {
    const files = list('files')
    expect(files.filter((pattern) => !pattern.startsWith('!')).sort()).toEqual(['dist/main/**', 'dist/preload/**', 'dist/renderer/**', 'package.json'])
    expect(files).toContain('!**/*.map')
    expect(files).toContain('!node_modules/**/*')
    for (const pattern of files.filter((entry) => !entry.startsWith('!'))) {
      expect(pattern, pattern).not.toMatch(/docs|test|scripts|src|\.env|node_modules|packages|stories/i)
    }
    expect(files.some((pattern) => pattern.includes('dist/engine'))).toBe(false)
  })

  it('keeps only English and Korean locale folders of Electron', () => {
    expect(list('electronLanguages')).toEqual(['en', 'ko'])
  })

  it('ships the engine bundle as an extra resource where the main process looks for it', () => {
    expect(text).toMatch(/extraResources:\s*\n\s+- from: dist\/engine\/rill-engine\.mjs\s*\n\s+to: engine\/rill-engine\.mjs/)
    expect(readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')).toContain("join(process.resourcesPath, 'engine', 'rill-engine.mjs')")
  })

  it('has an entry file inside the packed folders, and a dist script that builds first and then packs', () => {
    expect(pkg.main).toBe('dist/main/index.mjs')
    expect(pkg.scripts.dist).toMatch(/^pnpm build && electron-builder /)
    expect(pkg.scripts.dist).toContain('--publish never')
  })

  it('keeps the release folder out of git', () => {
    const ignore = readFileSync(join(ROOT, '../../.gitignore'), 'utf8').split('\n')
    expect(ignore).toContain('apps/desktop/release/')
  })
})
