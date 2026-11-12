import { composeStories, type Meta } from '@storybook/react-vite'
import { act, render } from '@testing-library/react'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import preview from '../.storybook/preview'

type StoryModule = { default: Meta } & Record<string, unknown>

const SRC = join(import.meta.dirname, '../src')
const COMPONENT_DIRS = ['graph', 'inspector', 'runs', 'workspace', 'ui']
const modules = import.meta.glob<StoryModule>('../src/**/*.stories.tsx', { eager: true })
const MODES = [
  { name: 'Korean, light', globals: { theme: 'light', locale: 'ko' } },
  { name: 'English, dark', globals: { theme: 'dark', locale: 'en' } },
] as const

const KEY_LIKE = /\b(?:app|status|run|badge|node|graph|inspector|json|history|time|workspace)\.[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*/g
const EVENT_NAMES = new Set(['run.started', 'run.finished'])

function untranslated(text: string): string[] {
  return (text.match(KEY_LIKE) ?? []).filter((found) => !EVENT_NAMES.has(found))
}

function stories(globals: Record<string, string>): Array<{ file: string; name: string; Story: ComponentType }> {
  const found: Array<{ file: string; name: string; Story: ComponentType }> = []
  for (const [file, module] of Object.entries(modules)) {
    const composed = composeStories(module, { ...preview, initialGlobals: globals } as never) as unknown as Record<string, ComponentType>
    for (const [name, Story] of Object.entries(composed)) found.push({ file: file.replace('../src/', ''), name, Story })
  }
  return found
}

describe('story files', () => {
  it('can tell a message key that was never translated from ordinary text', () => {
    expect(untranslated('x status.nope y and workspace.loadError')).toEqual(['status.nope', 'workspace.loadError'])
    expect(untranslated('run.started · check #1 and check.output.status and the status. Next')).toEqual([])
    expect(untranslated('select a node.Connections cannot be selected')).toEqual([])
  })

  it('exist for every component file of the screens', () => {
    const missing: string[] = []
    for (const dir of COMPONENT_DIRS) {
      for (const entry of readdirSync(join(SRC, dir))) {
        if (!entry.endsWith('.tsx') || entry.endsWith('.stories.tsx')) continue
        if (!existsSync(join(SRC, dir, entry.replace(/\.tsx$/, '.stories.tsx')))) missing.push(`${dir}/${entry}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('hold at least forty stories, and every story file has a title and at least one story', () => {
    const all = stories(MODES[0].globals)
    expect(all.length).toBeGreaterThanOrEqual(40)
    for (const [file, module] of Object.entries(modules)) {
      expect(typeof module.default.title, file).toBe('string')
      expect(all.some((story) => story.file === file.replace('../src/', '')), file).toBe(true)
    }
  })
})

describe.each(MODES)('every story renders without an error or a warning ($name)', (mode) => {
  let errors: ReturnType<typeof vi.spyOn>
  let warnings: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errors.mockRestore()
    warnings.mockRestore()
  })

  for (const { file, name, Story } of stories(mode.globals)) {
    it(`${file} ${name}`, async () => {
      const view = render(<Story />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      const text = view.container.textContent ?? ''
      const attributes = [...view.container.querySelectorAll('[aria-label], [title]')].map((item) => `${item.getAttribute('aria-label') ?? ''}\n${item.getAttribute('title') ?? ''}`).join('\n')
      const wrapper = view.container.querySelector('[data-theme]')
      const drawn = wrapper?.querySelectorAll('*').length ?? 0
      view.unmount()
      expect(drawn).toBeGreaterThan(0)
      expect(wrapper?.getAttribute('data-theme')).toBe(mode.globals.theme)
      expect(wrapper?.getAttribute('lang')).toBe(mode.globals.locale)
      expect(untranslated(text)).toEqual([])
      expect(untranslated(attributes)).toEqual([])
      expect(attributes).not.toMatch(/Edge from|Node from/)
      expect([...errors.mock.calls, ...warnings.mock.calls].map((call) => String(call[0]).slice(0, 300))).toEqual([])
    })
  }
})
