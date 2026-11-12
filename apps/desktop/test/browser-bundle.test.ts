// @vitest-environment node
import react from '@vitejs/plugin-react'
import { readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { build, type Plugin } from 'vite'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const PREVIEW = join(ROOT, '.storybook/preview.tsx')
const BUILTINS = new Set(builtinModules)

const NODE_SIDE = [join(SRC, 'main'), join(SRC, 'preload')]

function entries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (NODE_SIDE.includes(path)) return []
    if (entry.isDirectory()) return entries(path)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

function forbidNode(found: string[]): Plugin {
  return {
    name: 'forbid-node-modules',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.startsWith('node:') || BUILTINS.has(id.split('/')[0] ?? id)) found.push(`${id} imported by ${importer ?? 'an entry'}`)
      return null
    },
  }
}

describe('renderer bundle', () => {
  it('pulls no node module into a browser build of every source file and of the Storybook preview', async () => {
    const found: string[] = []
    const result = await build({
      root: ROOT,
      configFile: false,
      logLevel: 'silent',
      plugins: [forbidNode(found), react()],
      build: {
        write: false,
        minify: false,
        lib: { entry: [...entries(SRC), PREVIEW], formats: ['es'] },
        rolldownOptions: { external: [/^@storybook\//, /^storybook/] },
      },
    })
    expect(found).toEqual([])
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((one) => ('output' in one ? one.output : []))
    const code = outputs.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
    expect(code).toMatch(/class RillError|RillError = class/)
    expect(code).toContain('isTrigger')
  }, 120_000)

  it('keeps the fake host and the fixture data out of the bundle of the real renderer entry', async () => {
    const result = await build({
      root: ROOT,
      configFile: false,
      logLevel: 'silent',
      plugins: [react()],
      build: { write: false, minify: false, lib: { entry: [join(SRC, 'renderer-shell/main.tsx')], formats: ['es'] } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((one) => ('output' in one ? one.output : []))
    const code = outputs.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
    expect(code).toMatch(/class RillError|RillError = class/)
    expect(code).not.toContain('createFakeHost')
    expect(code).not.toContain('/Users/demo/Receipts')
  }, 120_000)
})
