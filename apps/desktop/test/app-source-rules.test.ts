// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = join(import.meta.dirname, '../src/app')
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML assignment', /\.outerHTML\s*=/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['eval(', /\beval\s*\(/],
  ['new Function(', /new\s+Function\s*\(/],
  ['document.write', /document\.write/],
  ['href', /\bhref\s*=/],
  ['anchor', /<a[\s>]/],
  ['inline style attribute', /\bsetAttribute\(\s*['"]style['"]/],
  ['style element', /createElement\(\s*['"]style['"]/],
  ['console', /\bconsole\.(log|info|warn|error|debug)\b/],
]

export function appFiles(dir: string = APP): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? appFiles(path) : /\.(ts|tsx|css)$/.test(entry.name) ? [path] : []
  })
}

describe('the sources under src/app', () => {
  const files = appFiles()

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('use no markup injection, no web storage, no eval, no links and no console', () => {
    const found: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [name, pattern] of FORBIDDEN) if (pattern.test(text)) found.push(`${relative(APP, file)}: ${name}`)
    }
    expect(found).toEqual([])
  })

  it('carry no code comment lines of their own', () => {
    const found: string[] = []
    for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) found.push(`${relative(APP, file)}:${index + 1}`)
        })
    }
    expect(found).toEqual([])
  })

  it('keep secrets out of component state: no useState holds a value called secret, key or password', () => {
    const found: string[] = []
    for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/const \[(\w+),\s*set\w+\]\s*=\s*useState/g)) {
        if (/^(secret|apiKey|key|password|token|value)s?$/i.test(match[1]!)) found.push(`${relative(APP, file)}: ${match[1]}`)
      }
    }
    expect(found).toEqual([])
  })
})
