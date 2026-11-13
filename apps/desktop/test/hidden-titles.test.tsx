import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { App, type AppProps } from '../src/app/App'
import { createFakeWorld } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { SettingsScreen } from '../src/app/settings/SettingsScreen'
import { SETTINGS_SECTIONS } from '../src/app/settings/types'
import { fakeSettings } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import visuallyHidden from '../src/ui/visuallyHidden.module.css'
import { violations } from './axe'
import { renderThemed } from './render'

const SRC = join(import.meta.dirname, '../src')
const READY = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'slack-ops', kind: 'slack' }] })

function css(path: string): string {
  return readFileSync(join(SRC, path), 'utf8')
}

function mount(initial: AppProps['initial'], locale: Locale = 'ko') {
  const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings: READY }, control: { stepIntervalMs: 0 } })
  const view = renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App initial={initial} />
    </HostProvider>,
    { locale },
  )
  return { view, user: userEvent.setup() }
}

const navButton = (locale: Locale, section: string) => within(screen.getByRole('navigation', { name: createTranslator(locale)('app.settings.nav') })).getByRole('button', { name: createTranslator(locale)(`app.settings.section.${section as 'folders'}`) })

async function neverTabsTo(user: ReturnType<typeof userEvent.setup>, element: HTMLElement): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await user.tab()
    expect(document.activeElement).not.toBe(element)
  }
}

describe('the visually hidden style that the titles reuse', () => {
  const rule = css('ui/visuallyHidden.module.css').match(/(?:^|\n)\.hidden\s*\{([^}]*)\}/)![1]!

  it('takes the element out of the flow and clips it to nothing, as the labels of the app already do', () => {
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).toMatch(/width:\s*1px/)
    expect(rule).toMatch(/height:\s*1px/)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toMatch(/clip-path:\s*inset\(50%\)/)
  })

  it('is the only style of the two titles, so no size or margin of their own can bring them back', () => {
    expect(css('recipes/RecipeGallery.module.css')).not.toMatch(/(?:^|\n)\.heading\s*\{/)
    expect(css('app/settings/Settings.module.css')).not.toMatch(/(?:^|\n)\.heading\b/)
  })
})

describe.each(['ko', 'en'] as const)('the Recipes screen (%s)', (locale) => {
  const t = createTranslator(locale)

  it('keeps its title for screen readers and for focus, and does not draw it', async () => {
    const { view, user } = mount({ tab: 'recipes' }, locale)
    const heading = await screen.findByRole('heading', { level: 2, name: t('recipes.heading') })
    expect(heading.textContent).toBe(t('recipes.heading'))
    expect(heading.className).toBe(visuallyHidden.hidden)
    expect(heading.className).not.toMatch(/heading/)
    expect(heading.tabIndex).toBe(-1)
    expect(screen.getByRole('region', { name: t('recipes.heading') })).toBe(heading.closest('section'))
    expect(within(view.container.querySelector('main')!).getAllByRole('heading', { level: 2 })).toEqual([heading])
    await screen.findAllByRole('article')
    await neverTabsTo(user, heading)
  })

  it('still takes the focus when the person comes back from the form', async () => {
    const { user } = mount({ tab: 'recipes' }, locale)
    const cards = await screen.findAllByRole('article')
    await user.click(within(cards[0]!).getByRole('button'))
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: t('recipes.heading') })).toBeNull())
    await user.click(screen.getByRole('button', { name: t('recipes.form.back') }))
    const heading = await screen.findByRole('heading', { level: 2, name: t('recipes.heading') })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(heading.className).toBe(visuallyHidden.hidden)
  })

  it('has no accessibility violations', async () => {
    const { view } = mount({ tab: 'recipes' }, locale)
    await screen.findAllByRole('article')
    expect(await violations(view.container)).toEqual([])
  })
})

describe.each(['ko', 'en'] as const)('the Settings screen (%s)', (locale) => {
  const t = createTranslator(locale)

  it.each(SETTINGS_SECTIONS)('keeps the title of the %s section for screen readers and for focus, and does not draw it', async (section) => {
    const { view, user } = mount({ tab: 'settings', settingsSection: section }, locale)
    const name = t(`app.settings.section.${section}`)
    const heading = await screen.findByRole('heading', { level: 2, name })
    expect(heading.textContent).toBe(name)
    expect(heading.className).toBe(visuallyHidden.hidden)
    expect(heading.className).not.toMatch(/heading/)
    expect(heading.tabIndex).toBe(-1)
    expect(navButton(locale, section).getAttribute('aria-current')).toBe('page')
    expect(within(view.container.querySelector('main')!).getAllByRole('heading', { level: 2 })).toEqual([heading])
    await waitFor(() => expect(document.activeElement).toBe(heading))
    await neverTabsTo(user, heading)
  })

  it('moves the focus to the hidden title of the section that was chosen', async () => {
    const { user } = mount({ tab: 'settings' }, locale)
    await screen.findByRole('heading', { level: 2, name: t('app.settings.section.folders') })
    for (const section of ['keys', 'general', 'model', 'connections', 'folders'] as const) {
      await user.click(navButton(locale, section))
      const heading = await screen.findByRole('heading', { level: 2, name: t(`app.settings.section.${section}`) })
      await waitFor(() => expect(document.activeElement).toBe(heading))
      expect(heading.className).toBe(visuallyHidden.hidden)
    }
  })

  it('takes the focus at once when it opens with the settings already loaded and nothing holds the focus', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings: READY }, control: { stepIntervalMs: 0 } })
    const state = { settings: READY, failed: false, reload: async (): Promise<void> => undefined, apply: (): void => undefined }
    expect(document.activeElement).toBe(document.body)
    renderThemed(
      <HostProvider host={world.host} connect={world.connect}>
        <SettingsScreen state={state} client={undefined} connection={{ state: 'connected', status: { state: 'running', restarts: 0 } }} section="keys" />
      </HostProvider>,
      { locale },
    )
    const heading = screen.getByRole('heading', { level: 2, name: t('app.settings.section.keys') })
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it.each(SETTINGS_SECTIONS)('has no accessibility violations in the %s section', async (section) => {
    const { view } = mount({ tab: 'settings', settingsSection: section }, locale)
    await screen.findByRole('heading', { level: 2, name: t(`app.settings.section.${section}`) })
    expect(await violations(view.container)).toEqual([])
  })
})

describe.each(['ko', 'en'] as const)('the Agents tab (%s)', (locale) => {
  const t = createTranslator(locale)

  it.each([
    ['agents', 'agents.screen.title'],
    ['rules', 'rules.screen.title'],
    ['hooks', 'agents.hooks.screen.title'],
  ] as const)('keeps the title of the %s screen for screen readers and does not draw it, because the sub-navigation names it', async (section, key) => {
    const { view, user } = mount({ tab: 'agents', agentsSection: section }, locale)
    const heading = await screen.findByRole('heading', { level: 2, name: t(key) })
    expect(heading.textContent).toBe(t(key))
    expect(heading.className).toBe(visuallyHidden.hidden)
    expect(heading.className).not.toMatch(/title/)
    const subNav = within(view.container.querySelector('main')!).getByRole('navigation')
    expect(within(subNav).getByRole('button', { name: t(key) }).getAttribute('aria-current')).toBe('page')
    expect(heading.closest('section')).toBe(screen.getByRole('region', { name: t(key) }))
    await neverTabsTo(user, heading)
  })

  it.each([
    ['agents', 'agents.screen.title'],
    ['rules', 'rules.screen.title'],
    ['hooks', 'agents.hooks.screen.title'],
  ] as const)('has no accessibility violations on the %s screen', async (section, key) => {
    const { view } = mount({ tab: 'agents', agentsSection: section }, locale)
    await screen.findByRole('heading', { level: 2, name: t(key) })
    expect(await violations(view.container)).toEqual([])
  })

  it('has no style of its own for any of the titles', () => {
    expect(css('app/agents/AgentsScreen.module.css')).not.toMatch(/(?:^|\n)\.title\b/)
    expect(css('app/agents/RulesScreen.module.css')).not.toMatch(/(?:^|\n)\.title\b/)
    expect(css('app/agents/HooksScreen.module.css')).not.toMatch(/(?:^|\n)\.title\b/)
  })

  it('keeps the transfer mark on the same line as its sentence', () => {
    for (const file of ['app/agents/AgentsScreen.module.css', 'app/agents/HooksScreen.module.css']) {
      const rule = css(file).match(/(?:^|\n)\.transfer\s*\{([^}]*)\}/)![1]!
      expect(rule, file).toMatch(/display:\s*flex/)
      expect(rule, file).toMatch(/align-items:\s*baseline/)
    }
  })
})
