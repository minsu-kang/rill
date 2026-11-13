// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const DIRECTORIES = ['packages/protocol/src', 'packages/engine/src', 'packages/planner/src', 'apps/desktop/src/app', 'apps/desktop/src/engine/agents.ts', 'apps/desktop/src/engine/fake-agents.ts',
  'apps/desktop/src/engine/hook-store.ts',
  'apps/desktop/src/engine/fake-hooks.ts',
  'apps/desktop/src/fixtures/hooks.ts',
  'apps/desktop/test/hooks-model.test.ts',
  'apps/desktop/test/hooks-screen.test.tsx',
]
const HIDDEN = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}\ufffd]/u

function sources(path: string): string[] {
  if (statSync(path).isDirectory()) return readdirSync(path).flatMap((name) => sources(join(path, name)))
  return /\.tsx?$/.test(path) && !path.endsWith('.stories.tsx') ? [path] : []
}

describe('the sources of the app logic', () => {
  const files = DIRECTORIES.flatMap((name) => sources(join(ROOT, name)))

  it('exist', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('hold no bidirectional, invisible or replacement character as a raw character, so that a reader sees what a pattern holds', () => {
    const found: string[] = []
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (HIDDEN.test(line)) found.push(`${relative(ROOT, file)}:${index + 1}`)
        })
    }
    expect(found).toEqual([])
  })
})
