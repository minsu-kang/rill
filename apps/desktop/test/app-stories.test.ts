// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = join(import.meta.dirname, '../src/app')
const NO_STORY = new Set(['host.tsx'])
const NOT_COMPONENTS = /Stage\.tsx$|\.stories\.tsx$/

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

describe('stories of the app screen', () => {
  const all = files(APP)

  it('exist next to every component file', () => {
    const missing = all
      .filter((path) => path.endsWith('.tsx') && !NOT_COMPONENTS.test(path) && !NO_STORY.has(path.split('/').pop()!))
      .filter((path) => !existsSync(path.replace(/\.tsx$/, '.stories.tsx')))
      .map((path) => relative(APP, path))
    expect(missing).toEqual([])
  })

  it('carry a title in the App group and at least one story', () => {
    const stories = all.filter((path) => path.endsWith('.stories.tsx'))
    expect(stories.length).toBeGreaterThan(0)
    for (const path of stories) {
      const text = readFileSync(path, 'utf8')
      expect(text, relative(APP, path)).toMatch(/title: 'App\//)
      expect([...text.matchAll(/^export const \w+/gm)].length, relative(APP, path)).toBeGreaterThan(0)
    }
  })
})
