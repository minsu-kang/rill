import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_SCREEN, COMPONENT_DIRS, MODES, PLAYED, SHOWN, SRC, STORY_RENDER_PARTS, modules, stories, untranslated } from './stories-smoke-shared'

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

  it('name what every story of the app screen has to show, and every one of them is named', () => {
    const named = stories(MODES[0].globals)
      .filter((story) => story.file === APP_SCREEN)
      .map((story) => `${story.file} ${story.name}`)
      .sort()
    expect(Object.keys(SHOWN).sort()).toEqual(named)
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

describe('explain and recipe stories', () => {
  it('name every story that needs its play function and every one of them has one', () => {
    const all = stories(MODES[0].globals)
    const played = all.filter((story) => story.Story.play !== undefined).map((story) => `${story.file} ${story.name}`)
    for (const key of Object.keys(PLAYED)) expect(played, key).toContain(key)
    expect(played.filter((key) => key.startsWith('explain/') || key.startsWith('recipes/')).sort()).toEqual([...Object.keys(PLAYED), 'recipes/RecipeGallery.stories.tsx TagFilterOn'].sort())
  })

  it('hold the states of both panels: the notice, every cause, errors, loading, problems, preview and deploy', () => {
    const all = stories(MODES[0].globals)
    const count = (dir: string) => all.filter((story) => story.file.startsWith(`${dir}/`)).length
    expect(count('explain')).toBeGreaterThanOrEqual(50)
    expect(count('recipes')).toBeGreaterThanOrEqual(40)
    for (const name of ['CauseConfiguration', 'CauseUnknown', 'LightAndDarkSideBySide', 'HostileText']) {
      expect(all.some((story) => story.file === 'explain/ExplainCard.stories.tsx' && story.name === name), name).toBe(true)
    }
    for (const name of ['ErrorNotFound', 'ErrorBusy', 'ErrorOther', 'Loading', 'NoticeBeforeFirstRequest']) {
      expect(all.some((story) => story.file === 'explain/ExplainPanel.stories.tsx' && story.name === name), name).toBe(true)
    }
    for (const name of ['ProblemsAtFields', 'NoMatchingConnection', 'HostileRecipeText']) {
      expect(all.some((story) => story.file === 'recipes/RecipeForm.stories.tsx' && story.name === name), name).toBe(true)
    }
    for (const name of ['WithModelTransfer', 'Deployed', 'DeployFailed']) {
      expect(all.some((story) => story.file === 'recipes/DraftPreview.stories.tsx' && story.name === name), name).toBe(true)
    }
  })
})

describe('chat story files', () => {
  it('hold at least ninety stories in the Chat group, and a story file for each of the fifteen chat components', () => {
    const all = stories(MODES[0].globals)
    const chat = all.filter((story) => story.file.startsWith('chat/'))
    expect(chat.length).toBeGreaterThanOrEqual(90)
    expect(new Set(chat.map((story) => story.file)).size).toBeGreaterThanOrEqual(15)
    for (const [file, module] of Object.entries(modules)) {
      if (file.startsWith('../src/chat/')) expect(String(module.default.title), file).toMatch(/^Chat\//)
    }
  })
})

describe('the story render files', () => {
  it('are one per part, each one rendering its own part, so that every story is rendered once in each mode', () => {
    const names = readdirSync(import.meta.dirname).filter((name) => /^stories-smoke-render-\d+\.test\.tsx$/.test(name)).sort()
    expect(names).toEqual(Array.from({ length: STORY_RENDER_PARTS }, (_, part) => `stories-smoke-render-${part + 1}.test.tsx`))
    names.forEach((name, part) => {
      expect(readFileSync(join(import.meta.dirname, name), 'utf8'), name).toContain(`registerStoryRenders(${part})`)
    })
  })
})
