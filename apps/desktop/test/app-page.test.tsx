import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { App, type AppProps } from '../src/app/App'
import { createFakeWorld } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { Page } from '../src/app/Page'
import { fakeSettings } from '../src/engine/fake-host'
import { createTranslator } from '../src/i18n'
import { renderThemed } from './render'

const t = createTranslator('en')
const READY = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'slack-ops', kind: 'slack' }] })
const SRC = join(import.meta.dirname, '../src/app')

function mount(initial: AppProps['initial'], options: { empty?: boolean } = {}) {
  const world = createFakeWorld({
    hostOptions: { restartDelayMs: 0 },
    ...(options.empty === true ? { workflows: [] } : { hostInit: { settings: READY } }),
    control: { stepIntervalMs: 0 },
  })
  const view = renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App initial={initial} />
    </HostProvider>,
    { locale: 'en' },
  )
  return { view, user: userEvent.setup() }
}

const main = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('main')!

describe('the page container', () => {
  it('wraps its children in an element that carries the page marker', () => {
    const view = renderThemed(
      <Page>
        <p>inside</p>
      </Page>,
    )
    const page = view.container.querySelector('[data-rill-page]')!
    expect(page.textContent).toBe('inside')
  })

  it('has one padding for every screen: 24px, 16px under 700px, content at most 1200px and centered', () => {
    const css = readFileSync(join(SRC, 'Page.module.css'), 'utf8')
    expect(css).toMatch(/--page-padding:\s*var\(--space-5\)/)
    expect(css).toMatch(/@container app \(max-width: 699px\)[^}]*\{[^}]*--page-padding:\s*var\(--space-4\)/s)
    expect(css).toMatch(/padding:\s*var\(--page-padding\)/)
    expect(css).toMatch(/max-width:\s*calc\(1200px \+ 2 \* var\(--page-padding\)\)/)
    expect(css).toMatch(/margin:\s*0 auto/)
  })
})

describe('every screen of the app sits inside the page container', () => {
  it('uses it on the Workflows screen, for a selected workflow and for the empty state', async () => {
    const full = mount({ tab: 'workflows' })
    await waitFor(() => expect(within(main(full.view.container)).getByRole('button', { name: t('app.wf.actions.dryRun') })).toBeTruthy())
    expect(main(full.view.container).children).toHaveLength(1)
    expect(main(full.view.container).firstElementChild?.hasAttribute('data-rill-page')).toBe(true)
    full.view.unmount()
    const empty = mount({ tab: 'workflows' }, { empty: true })
    await screen.findByRole('region', { name: t('app.firstRun.title') })
    expect(main(empty.view.container).children).toHaveLength(1)
    expect(main(empty.view.container).firstElementChild?.hasAttribute('data-rill-page')).toBe(true)
  })

  it('uses it on the Recipes screen, around the title and the search', async () => {
    const { view } = mount({ tab: 'recipes' })
    const heading = await screen.findByRole('heading', { name: t('recipes.heading') })
    const page = main(view.container).firstElementChild!
    expect(page.hasAttribute('data-rill-page')).toBe(true)
    expect(page.contains(heading)).toBe(true)
    expect(page.contains(await screen.findByLabelText(t('recipes.search')))).toBe(true)
  })

  it('uses it on the Settings screen, for every section', async () => {
    const { view, user } = mount({ tab: 'settings' })
    await screen.findByRole('navigation', { name: t('app.settings.nav') })
    expect(main(view.container).firstElementChild?.hasAttribute('data-rill-page')).toBe(true)
    for (const section of ['folders', 'model', 'keys', 'connections', 'general'] as const) {
      await user.click(within(screen.getByRole('navigation', { name: t('app.settings.nav') })).getByRole('button', { name: t(`app.settings.section.${section}`) }))
      expect(main(view.container).children).toHaveLength(1)
      expect(main(view.container).firstElementChild?.hasAttribute('data-rill-page')).toBe(true)
    }
  })

  it('uses it while the engine is not connected yet', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings: READY, engine: { state: 'stopped', error: 'crashed', restarts: 6 } } })
    const view = renderThemed(
      <HostProvider host={world.host} connect={world.connect}>
        <App initial={{ tab: 'recipes' }} />
      </HostProvider>,
      { locale: 'en' },
    )
    await waitFor(() => expect(main(view.container).firstElementChild?.hasAttribute('data-rill-page')).toBe(true))
  })

  it('leaves no screen with a padding of its own, so the page padding is the only one', () => {
    for (const file of ['settings/Settings.module.css', '../workspace/Workspace.module.css']) {
      const css = readFileSync(join(SRC, file), 'utf8')
      const root = css.match(/\.root\s*\{[^}]*\}/s)![0]
      expect(root, file).not.toMatch(/padding:/)
    }
  })
})
