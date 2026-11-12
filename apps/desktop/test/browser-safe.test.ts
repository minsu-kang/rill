import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../src/')
const BANNED = ['@rill/engine', '@rill/planner', '@rill/llm', '@rill/recipes', '@rill/eval']
const TYPE_ONLY = ['@rill/nodes-core']
const SPECIFIER = /\b(import|export)(\s+type)?\b([^'";]*?)\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

interface Found {
  file: string
  specifier: string
  typeOnly: boolean
}

function imports(): Found[] {
  const found: Found[] = []
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[4] ?? match[5] ?? match[6] ?? match[7]
      if (specifier === undefined) continue
      const typeOnly = match[4] !== undefined && match[2] !== undefined
      found.push({ file: file.slice(SRC.length), specifier, typeOnly })
    }
  }
  return found
}

describe('renderer sources stay browser-safe', () => {
  const found = imports()

  it('finds the imports it is meant to check', () => {
    expect(found.length).toBeGreaterThan(0)
  })

  it('import no node: module and no node built-in', () => {
    const builtins = new Set(builtinModules)
    const bad = found.filter((f) => f.specifier.startsWith('node:') || builtins.has(f.specifier) || builtins.has(f.specifier.split('/')[0]!))
    expect(bad.map((f) => `${f.file}: ${f.specifier}`)).toEqual([])
  })

  it('import none of the engine side packages', () => {
    const bad = found.filter((f) => BANNED.some((name) => f.specifier === name || f.specifier.startsWith(`${name}/`)))
    expect(bad.map((f) => `${f.file}: ${f.specifier}`)).toEqual([])
  })

  it('import @rill/nodes-core for types only', () => {
    const bad = found.filter((f) => TYPE_ONLY.some((name) => f.specifier === name || f.specifier.startsWith(`${name}/`)) && !f.typeOnly)
    expect(bad.map((f) => `${f.file}: ${f.specifier}`)).toEqual([])
  })

  it('never use innerHTML, dangerouslySetInnerHTML, eval or new Function', () => {
    const bad: string[] = []
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of [/dangerouslySetInnerHTML/, /\.innerHTML\b/, /\.outerHTML\s*=/, /\beval\s*\(/, /new\s+Function\s*\(/, /insertAdjacentHTML/]) {
        if (pattern.test(text)) bad.push(`${file.slice(SRC.length)}: ${pattern.source}`)
      }
    }
    expect(bad).toEqual([])
  })
})
