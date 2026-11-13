// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function lineCount(text: string): number {
  return text.trimEnd().split('\n').length
}

const PACKAGES = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'packages', entry.name, 'package.json')))
  .map((entry) => `packages/${entry.name}`)
const WORKSPACES = ['apps/desktop', ...PACKAGES]
const GUIDES = ['AGENTS.md', ...WORKSPACES.map((dir) => `${dir}/AGENTS.md`)]
const ROOT_SCRIPTS = new Set(Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts))

function scriptsOf(dir: string): Set<string> {
  const manifest = JSON.parse(read(`${dir}/package.json`)) as { scripts?: Record<string, string> }
  return new Set(Object.keys(manifest.scripts ?? {}))
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '')
}

function looksLikePath(span: string): boolean {
  if (span.includes(' ') || span.includes('<') || span.includes('*') || span.includes('://') || span.startsWith('@') || span.startsWith('pnpm')) return false
  return span.includes('/') || /^\.?[\w-]+(\.[\w-]+)*\.(md|ts|tsx|json|yml|yaml|mjs|css)$/.test(span)
}

function resolves(span: string, guide: string): boolean {
  const base = dirname(guide)
  return [span, join(base, span)].some((candidate) => existsSync(join(ROOT, candidate)))
}

describe('the agent guides', () => {
  it('exist in the root and in every workspace, and CLAUDE.md only imports the root guide', () => {
    expect(WORKSPACES).toHaveLength(9)
    for (const guide of GUIDES) expect(existsSync(join(ROOT, guide)), guide).toBe(true)
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n')
  })

  it('stay short: 80 lines for the root and 40 for a workspace', () => {
    for (const guide of GUIDES) expect(lineCount(read(guide)), guide).toBeLessThanOrEqual(guide === 'AGENTS.md' ? 80 : 40)
  })

  it('are listed in the root guide, each with a link to its own guide', () => {
    const root = read('AGENTS.md')
    for (const dir of WORKSPACES) {
      expect(root, dir).toContain(`\`${dir}\``)
      expect(root, dir).toContain(`(${dir}/AGENTS.md)`)
    }
  })

  it('name only paths that exist', () => {
    const missing: string[] = []
    for (const guide of GUIDES) {
      for (const span of codeSpans(read(guide))) if (looksLikePath(span) && !resolves(span, guide)) missing.push(`${guide}: ${span}`)
    }
    expect(missing).toEqual([])
  })

  it('name only commands that exist', () => {
    const problems: string[] = []
    for (const guide of GUIDES) {
      const dir = dirname(guide)
      const own = dir === '.' ? new Set<string>() : scriptsOf(dir)
      for (const span of codeSpans(read(guide))) {
        if (!span.startsWith('pnpm ') || span.includes('<')) continue
        const [first, second, third] = span.slice(5).split(' ')
        if (first === 'exec') {
          const target = span.split(' ').find((word) => word.includes('/'))
          if (second !== 'vitest' || third !== 'run' || target === undefined || !existsSync(join(ROOT, target))) problems.push(`${guide}: ${span}`)
        } else if (first === undefined || !(ROOT_SCRIPTS.has(first) || own.has(first))) problems.push(`${guide}: ${span}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('hold no private material, no local-only document and no character outside ASCII', () => {
    const forbidden = /integromat|make\.com|superpowers|gmail|\/Users\/(?!demo\b)|[\w.%+-]+@[\w-]+\.[a-z]{2,}/i
    for (const file of [...GUIDES, 'CONTRIBUTING.md', '.github/CODEOWNERS']) {
      const text = read(file)
      expect(forbidden.test(text), file).toBe(false)
      expect([...text].filter((char) => char.charCodeAt(0) > 127), file).toEqual([])
    }
  })

  it('name only the code owner as a person', () => {
    for (const guide of GUIDES) {
      const handles = [...read(guide).matchAll(/(^|[\s(])@([A-Za-z0-9][\w-]*)(?![\w/])/g)].map((match) => match[2])
      expect(handles.filter((handle) => handle !== 'minsu-kang' && handle !== 'AGENTS'), guide).toEqual([])
    }
  })
})

describe('the owner and contribution files', () => {
  it('give every path to one code owner', () => {
    const lines = read('.github/CODEOWNERS')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    expect(lines).toEqual(['* @minsu-kang'])
  })

  it('say that pull requests are open to collaborators only, in the contributing file, the root guide and the README', () => {
    expect(read('CONTRIBUTING.md')).toMatch(/Pull requests are open to collaborators only/)
    expect(read('AGENTS.md')).toMatch(/Pull requests are open to collaborators only and need the code owner's review \(@minsu-kang\)\. See CONTRIBUTING\.md\./)
    expect(read('README.md')).toMatch(/Pull requests are open to collaborators only\. See \[CONTRIBUTING\.md\]\(CONTRIBUTING\.md\)\./)
  })
})
