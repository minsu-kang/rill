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

describe('the workflows', () => {
  const FILES = readdirSync(join(ROOT, '.github/workflows')).filter((name) => name.endsWith('.yml'))
  const CI = read('.github/workflows/ci.yml')

  it('pin every action to a full commit', () => {
    expect(FILES).toContain('ci.yml')
    for (const name of FILES) {
      const uses = [...read(`.github/workflows/${name}`).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1] ?? '')
      expect(uses.length, name).toBeGreaterThan(0)
      for (const action of uses) expect(action, name).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it('run for the default branch only, with read-only access to the repository', () => {
    expect(CI).toMatch(/push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]/)
    expect(CI).toMatch(/\npermissions:\n {2}contents: read\n/)
  })

  it('run lint, the type check, both vitest projects and the build as separate jobs', () => {
    const projects = read('vitest.config.ts').match(/name: '(\w+)'/g) ?? []
    expect(projects).toEqual(["name: 'packages'"])
    expect(read('apps/desktop/vitest.config.ts')).toContain("name: 'desktop'")
    for (const job of ['lint', 'typecheck', 'unit-packages', 'unit-desktop', 'build']) expect(CI, job).toMatch(new RegExp(`\\n  ${job}:\\n`))
    expect(CI).toContain('pnpm lint')
    expect(CI).toContain('pnpm typecheck')
    expect(CI).toContain('pnpm exec vitest run --project packages')
    expect(CI).toContain('pnpm exec vitest run --project desktop')
    expect(CI).toContain('pnpm --filter @rill/desktop build')
    expect(CI).toContain('pnpm install --frozen-lockfile')
  })
})

describe('the release setup', () => {
  const config = JSON.parse(read('release-please-config.json')) as {
    'include-component-in-tag': boolean
    packages: Record<string, { 'release-type': string; 'extra-files': { type: string; path: string; jsonpath: string }[] }>
  }
  const version = (path: string): string => (JSON.parse(read(path)) as { version: string }).version

  it('releases the root package under a plain v tag and writes the version to the desktop app too', () => {
    expect(Object.keys(config.packages)).toEqual(['.'])
    expect(config.packages['.']?.['release-type']).toBe('node')
    expect(config['include-component-in-tag']).toBe(false)
    expect(config.packages['.']?.['extra-files']).toEqual([{ type: 'json', path: 'apps/desktop/package.json', jsonpath: '$.version' }])
  })

  it('keeps the manifest, the root package and the desktop app at the same version', () => {
    const manifest = JSON.parse(read('.release-please-manifest.json')) as Record<string, string>
    expect(Object.keys(manifest)).toEqual(['.'])
    expect(version('package.json')).toBe(manifest['.'])
    expect(version('apps/desktop/package.json')).toBe(manifest['.'])
  })

  it('builds the app from the release tag with a script and an output folder that exist', () => {
    const release = read('.github/workflows/release-please.yml')
    expect(release).toMatch(/push:\n {4}branches: \[main\]/)
    expect(release).toContain('googleapis/release-please-action@')
    expect(release).toContain('pnpm --filter @rill/desktop dist')
    expect(release).toContain('apps/desktop/release/*.dmg')
    const scripts = (JSON.parse(read('apps/desktop/package.json')) as { scripts: Record<string, string> }).scripts
    expect(scripts['dist']).toContain('electron-builder')
    expect(read('apps/desktop/electron-builder.yml')).toMatch(/output: release/)
  })

  it('checks the title of a pull request against the types that release-please reads', () => {
    const validate = read('.github/workflows/pr-validate.yml')
    expect(validate).toContain('amannn/action-semantic-pull-request@')
    expect(validate).toMatch(/branches: \[main\]/)
    for (const type of ['feat', 'fix']) expect(validate).toMatch(new RegExp(`\\n {12}${type}\\n`))
  })
})

describe('the license', () => {
  it('is the MIT License of the maintainer, named in the license file, the root package and the README', () => {
    const license = read('LICENSE')
    expect(license.startsWith('MIT License\n')).toBe(true)
    expect(license).toContain('Copyright (c) 2026 Minsu Kang')
    expect(license).toContain('Permission is hereby granted, free of charge')
    expect((JSON.parse(read('package.json')) as { license: string }).license).toBe('MIT')
    expect(read('README.md')).toMatch(/## License\n\nMIT\. See \[LICENSE\]\(LICENSE\)\./)
  })

  it('says in the README that the project is unrelated to Rill Data and that product names belong to their owners', () => {
    const readme = read('README.md')
    expect(readme).toContain('unrelated to Rill Data, Inc. and its open-source BI tool of the same name')
    expect(readme).toContain('are trademarks of their owners')
  })
})
