// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const DIRS = ['src/explain', 'src/recipes']
const SPECIFIER = /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g
const FORBIDDEN_TEXT: ReadonlyArray<[string, RegExp]> = [
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML assignment', /\.outerHTML\s*=/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['eval(', /\beval\s*\(/],
  ['new Function(', /new\s+Function\s*\(/],
]
const BANNED_IMPORTS = ['@rill/recipes', '@rill/planner']

export function problemsIn(text: string): string[] {
  const found = FORBIDDEN_TEXT.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    if (BANNED_IMPORTS.some((name) => specifier === name || specifier.startsWith(`${name}/`))) found.push(`import of ${specifier}`)
  }
  return found
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : /\.(ts|tsx|css)$/.test(entry.name) ? [path] : []
  })
}

describe('the scanner', () => {
  it('finds each banned construct and each banned import form', () => {
    expect(problemsIn('<div dangerouslySetInnerHTML={{ __html: x }} />')).toEqual(['dangerouslySetInnerHTML'])
    expect(problemsIn('el.innerHTML = x')).toEqual(['innerHTML'])
    expect(problemsIn('el.outerHTML = x')).toEqual(['outerHTML assignment'])
    expect(problemsIn('el.insertAdjacentHTML("beforeend", x)')).toEqual(['insertAdjacentHTML'])
    expect(problemsIn('localStorage.setItem("a", "b")')).toEqual(['localStorage'])
    expect(problemsIn('window.sessionStorage')).toEqual(['sessionStorage'])
    expect(problemsIn('eval("1")')).toEqual(['eval('])
    expect(problemsIn('new Function("return 1")')).toEqual(['new Function('])
    for (const code of [
      "import { RECIPES } from '@rill/recipes'",
      "import type { X } from '@rill/recipes'",
      "export * from '@rill/planner'",
      "const x = await import('@rill/planner/capabilities')",
      "import '@rill/recipes'",
      "const x = require('@rill/recipes')",
    ]) {
      expect(problemsIn(code), code).toHaveLength(1)
    }
  })

  it('leaves ordinary code and the allowed packages alone', () => {
    expect(problemsIn("import { RillError } from '@rill/protocol'\nimport { isTrigger } from '@rill/dsl'\nconst evaluation = 1\nconst text = 'a retrieval'")).toEqual([])
  })
})

describe.each(DIRS)('%s', (dir) => {
  const all = files(join(ROOT, dir))

  it('has sources to check', () => {
    expect(all.length).toBeGreaterThan(10)
  })

  it('has none of the banned constructs and imports', () => {
    const bad: string[] = []
    for (const file of all) {
      const text = readFileSync(file, 'utf8')
      for (const problem of problemsIn(text)) bad.push(`${relative(ROOT, file)}: ${problem}`)
    }
    expect(bad).toEqual([])
  })
})
