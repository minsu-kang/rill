// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const CHAT = join(ROOT, 'src/chat')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : []
  })
}

const ALL = files(CHAT)
const COMPONENTS = ALL.filter((file) => file.endsWith('.tsx') && !file.endsWith('.stories.tsx'))

function offenders(list: string[], pattern: RegExp): string[] {
  return list.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file))
}

describe('chat sources', () => {
  it('finds the files it is meant to check', () => {
    expect(ALL.length).toBeGreaterThan(40)
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(15)
    expect(ALL.some((file) => file.endsWith('model/conversation.ts'))).toBe(true)
  })

  it('never use dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, localStorage or sessionStorage', () => {
    for (const pattern of [/dangerouslySetInnerHTML/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /localStorage/, /sessionStorage/, /indexedDB/]) {
      expect(offenders(ALL, pattern), pattern.source).toEqual([])
    }
  })

  it('make no anchor, no href and no src from anything in the components', () => {
    expect(offenders(COMPONENTS.filter((file) => !file.endsWith('.stories.tsx')), /<a[\s>]|\bhref\s*=|\bsrc\s*=|<img[\s>]|<iframe[\s>]/)).toEqual([])
  })

  it('open no connection of their own', () => {
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /navigator\.sendBeacon/, /window\.open/]) {
      expect(offenders(ALL, pattern), pattern.source).toEqual([])
    }
  })

  it('import neither the engine side packages nor the planner', () => {
    expect(offenders(ALL, /from\s+['"]@rill\/(engine|planner|llm|recipes|eval)/)).toEqual([])
  })
})
