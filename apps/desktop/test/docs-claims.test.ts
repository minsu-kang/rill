// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CSP } from '../src/main/csp'

const ROOT = resolve(import.meta.dirname, '../../..')
const DOCS = ['README.md', 'docs/demo.md', 'docs/security.md']

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`)
  if (start === -1) throw new Error(`no section ${heading}`)
  const rest = text.slice(start + heading.length + 2)
  const end = rest.search(/\n## /)
  return end === -1 ? rest : rest.slice(0, end)
}

function lineWith(text: string, needle: string): string {
  const found = text.split('\n').filter((line) => line.includes(needle))
  if (found.length !== 1) throw new Error(`expected one line with ${needle}, found ${found.length}`)
  return found[0]!
}

const readme = read('README.md')
const demo = read('docs/demo.md')
const security = read('docs/security.md')

describe('README', () => {
  it('describes the questions and the flags of the demo scene as conditional', () => {
    const scene = section(readme, '## The demo scene')
    expect(lineWith(scene, '2. ')).toMatch(/\bIf\b/)
    expect(lineWith(scene, '3. ')).toMatch(/flag/)
  })

  it('says a patch needs a selected node, as the planner does', () => {
    expect(read('packages/planner/src/plan.ts')).toContain("request.selection === undefined ? 'create' : 'patch'")
    expect(lineWith(readme, '| Planner |')).toMatch(/With a node selected, a request about an existing workflow produces a patch/)
  })

  it('says retries need a retry policy, as the executor defaults to one attempt', () => {
    expect(read('packages/engine/src/executor.ts')).toContain('node.retry?.maxAttempts ?? 1')
    expect(lineWith(readme, '| Durable engine |')).toMatch(/A node with a retry policy is retried/)
  })

  it('names the installer as signed ad hoc wherever it mentions signing', () => {
    const lines = DOCS.flatMap((path) => read(path).split('\n')).filter((line) => /unsigned/i.test(line))
    expect(lines).toEqual([])
    expect(readme).toMatch(/signed ad hoc and not notarized/)
  })

  it('does not call the secret store a keychain', () => {
    const phrases = [
      /live in the system keychain/i,
      /goes? to the system keychain/i,
      /\(the OS keychain\)/i,
      /secrets in the keychain/i,
      /OS keychain: safeStorage/i,
    ]
    for (const path of ['README.md', 'docs/security.md']) {
      for (const phrase of phrases) expect(read(path), `${path} ${phrase}`).not.toMatch(phrase)
    }
    expect(lineWith(readme, '1. Keys and connection secrets')).toMatch(/encrypted with Electron `safeStorage`, whose key is in the macOS keychain/)
    expect(lineWith(readme, '| Five providers |')).toMatch(/encrypted with Electron `safeStorage`/)
  })

  it('limits the random tags to what is wrapped in them', () => {
    const bullet = lineWith(readme, '7. Attachments')
    const sentence = bullet.split('. ').find((part) => part.includes('random tags'))!
    expect(sentence).toMatch(/^Attachments, notes, agent settings and run data are wrapped in random tags/)
    expect(sentence).not.toMatch(/web responses|model output/)
  })

  it('qualifies the content security policy by mode', () => {
    const bullet = lineWith(readme, '10. The window')
    expect(bullet).toMatch(/built app adds a strict content security policy/)
    expect(bullet).toMatch(/Development mode .* has no content security policy and keeps the developer tools on/)
  })
})

describe('security notes', () => {
  const notCovered = section(security, '## What is not covered')

  it('says development mode has no content security policy and shows the developer tools', () => {
    expect(read('apps/desktop/src/main/window.ts')).toContain('if (options.devUrl === undefined)')
    expect(read('apps/desktop/electron.vite.config.ts')).toContain("apply: 'build'")
    const item = lineWith(notCovered, '- **Development mode.**')
    expect(item).toMatch(/content security policy is not applied/)
    expect(item).toMatch(/developer tools are on/)
  })

  it('describes the policy as the built and packed app has it', () => {
    const row = lineWith(security, '| Content security policy |')
    expect(row).toMatch(/In the built and packed app/)
    expect(CSP).toContain("img-src 'self' data:")
    expect(row).toContain('images from the app and `data:` URLs')
  })

  it('says what is not encrypted at rest', () => {
    const item = lineWith(notCovered, '- **Data at rest.**')
    expect(item).toMatch(/Only the secrets are encrypted/)
    for (const name of ['rill.db', 'attachments/', 'config.json', 'any process that runs as your user']) {
      expect(item.toLowerCase(), name).toContain(name.toLowerCase())
    }
  })

  it('names the settings screens and the confirmation dialog as the places of those controls', () => {
    expect(lineWith(security, '| The window never holds a secret |')).toContain('apps/desktop/src/app/settings/KeysSection.tsx')
    expect(lineWith(security, '| The window never holds a secret |')).toContain('apps/desktop/src/app/settings/ConnectionsSection.tsx')
    expect(lineWith(security, '| Confirmations in the app |')).toContain('apps/desktop/src/app/workflows/ConfirmDialog.tsx')
  })

  it('calls the secret control by what it does', () => {
    expect(security).toContain('| Secrets encrypted with `safeStorage` |')
  })
})

describe('demo script', () => {
  const texts = section(demo, '## The texts')

  it('types the request with the three values in it', () => {
    const first = texts.match(/```\n([^\n]+)\n```/)![1]!
    for (const value of ['~/Rill-Demo/Inbox', '~/Rill-Demo/ledger.csv', 'demo-slack']) expect(first, value).toContain(value)
  })

  it('treats the questions card and the flag list as conditional', () => {
    expect(lineWith(demo, '| 0:20 |')).toMatch(/If a questions card/)
    expect(lineWith(demo, '| 0:35 |')).toMatch(/If the card lists items/)
    expect(demo).not.toContain('fewer items to confirm')
  })

  it('keeps the optional flag gate trigger marked as optional and uncertain', () => {
    expect(texts).toMatch(/Optional, to show the flag gate on purpose/)
    expect(texts).toMatch(/not certain/)
  })
})

describe('paths in the documents', () => {
  const appScreenLanded = existsSync(join(ROOT, 'apps/desktop/src/app'))
  const BUILD_OUTPUT = ['apps/desktop/release/']
  const PATH = /`((?:apps|packages|docs)\/[^`\s]+|eslint\.config\.js)`/g

  function repoPaths(text: string): string[] {
    return [...text.matchAll(PATH)].map((match) => match[1]!)
  }

  it('name files and folders that exist', () => {
    const missing: string[] = []
    for (const path of DOCS) {
      for (const named of repoPaths(read(path))) {
        if (BUILD_OUTPUT.includes(named)) continue
        if (!appScreenLanded && named.startsWith('apps/desktop/src/app/')) continue
        if (!existsSync(join(ROOT, named))) missing.push(`${path}: ${named}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('link to files that exist', () => {
    const missing: string[] = []
    for (const path of DOCS) {
      for (const match of read(path).matchAll(/\]\(((?!https?:|#)[^)\s#]+)(?:#[^)\s]*)?\)/g)) {
        if (!existsSync(resolve(ROOT, dirname(path), match[1]!))) missing.push(`${path}: ${match[1]}`)
      }
    }
    expect(missing).toEqual([])
  })
})
