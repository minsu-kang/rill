import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWorld } from '../src/app/fake-world'
import { fakeSettings } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import { LiveRoot } from '../src/renderer-shell/LiveRoot'
import { createShellTranslator } from '../src/renderer-shell/messages'
import { HostError, type HostApi, type Language, type Settings } from '../src/shared/host-api'

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
})

const en = createTranslator('en')
const ko = createTranslator('ko')

function start(options: { language?: Language; system?: string; wrap?: (host: HostApi) => HostApi; withHost?: boolean } = {}) {
  const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings: fakeSettings({ language: options.language ?? 'system' }) } })
  const host = options.wrap === undefined ? world.host : options.wrap(world.host)
  const view = render(<LiveRoot host={options.withHost === false ? undefined : host} connect={world.connect} theme="light" systemLanguage={options.system ?? 'en-US'} />)
  return { world, host, view, user: userEvent.setup() }
}

async function openGeneral(user: ReturnType<typeof userEvent.setup>, t: (key: 'app.tab.settings' | 'app.settings.section.general') => string) {
  await user.click(await screen.findByRole('button', { name: t('app.tab.settings') }))
  await user.click(await screen.findByRole('button', { name: t('app.settings.section.general') }))
}

const languageSelect = (t: ReturnType<typeof createTranslator>) => screen.findByRole('combobox', { name: t('app.general.language') }) as Promise<HTMLSelectElement>
const htmlLang = () => document.documentElement.lang

describe('LiveRoot locale', () => {
  it('starts from the system language and sets <html lang> in the first render', () => {
    start({ system: 'en-US' })
    expect(htmlLang()).toBe('en')
    expect(screen.getByRole('button', { name: en('app.tab.recipes') })).toBeTruthy()
  })

  it('follows a Korean system language while the setting is system', async () => {
    start({ system: 'ko-KR' })
    expect(htmlLang()).toBe('ko')
    expect(await screen.findByRole('button', { name: ko('app.tab.recipes') })).toBeTruthy()
    expect(htmlLang()).toBe('ko')
  })

  it('switches to the saved language as soon as the settings load', async () => {
    start({ language: 'ko', system: 'en-US' })
    expect(htmlLang()).toBe('en')
    await waitFor(() => expect(htmlLang()).toBe('ko'))
    expect(await screen.findByRole('button', { name: ko('app.tab.recipes') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en('app.tab.recipes') })).toBeNull()
  })

  it('lets a saved English win over a Korean system language', async () => {
    start({ language: 'en', system: 'ko-KR' })
    await waitFor(() => expect(htmlLang()).toBe('en'))
    expect(await screen.findByRole('button', { name: en('app.tab.recipes') })).toBeTruthy()
  })

  it('keeps the system language when the settings cannot be read', async () => {
    const wrap = (host: HostApi): HostApi => ({ ...host, settings: { ...host.settings, get: () => Promise.reject(new HostError('INTERNAL')) } })
    start({ language: 'ko', system: 'en-US', wrap })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(htmlLang()).toBe('en')
    expect(screen.getByRole('button', { name: en('app.tab.recipes') })).toBeTruthy()
  })

  it('keeps the system language when the host sends something that is not a language', async () => {
    const wrap = (host: HostApi): HostApi => ({ ...host, settings: { ...host.settings, get: async () => ({ ...(await host.settings.get()), language: 'fr' }) as unknown as Settings } })
    start({ language: 'ko', system: 'en-US', wrap })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(htmlLang()).toBe('en')
  })

  it('switches at once when the user picks a language, keeps the screen and does not read the settings again', async () => {
    const { world, user } = start({ system: 'en-US' })
    const get = vi.spyOn(world.host.settings, 'get')
    await openGeneral(user, en)
    const select = await languageSelect(en)
    const reads = get.mock.calls.length
    await user.selectOptions(select, 'ko')
    await waitFor(() => expect(htmlLang()).toBe('ko'))
    expect(await screen.findByRole('combobox', { name: ko('app.general.language') })).toBeTruthy()
    expect(screen.getByRole('button', { name: ko('app.settings.section.general') }).getAttribute('aria-current')).toBe('page')
    expect(world.host.state().settings.language).toBe('ko')
    expect(get.mock.calls.length).toBe(reads)
    await user.selectOptions(screen.getByRole('combobox', { name: ko('app.general.language') }), 'system')
    await waitFor(() => expect(htmlLang()).toBe('en'))
    expect(await screen.findByRole('combobox', { name: en('app.general.language') })).toBeTruthy()
  })

  it('keeps the language and shows the error when saving fails', async () => {
    const wrap = (host: HostApi): HostApi => ({ ...host, settings: { ...host.settings, update: () => Promise.reject(new HostError('INTERNAL')) } })
    const { user } = start({ system: 'en-US', wrap })
    await openGeneral(user, en)
    await user.selectOptions(await languageSelect(en), 'ko')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(htmlLang()).toBe('en')
    expect(((await languageSelect(en)) as HTMLSelectElement).value).toBe('system')
  })

  it('does not let a slow read that started before a change undo the change', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reads = 0
    const wrap = (host: HostApi): HostApi => ({
      ...host,
      settings: {
        ...host.settings,
        get: async () => {
          reads += 1
          const answer = await host.settings.get()
          if (reads === 1) await gate
          return answer
        },
      },
    })
    const { user } = start({ system: 'en-US', wrap })
    await openGeneral(user, en)
    await user.selectOptions(await languageSelect(en), 'ko')
    await waitFor(() => expect(htmlLang()).toBe('ko'))
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(htmlLang()).toBe('ko')
  })

  it('shows the no-host page in the system language and still sets <html lang>', () => {
    const { view } = start({ system: 'ko-KR', withHost: false })
    expect(htmlLang()).toBe('ko')
    expect(view.container.querySelector('[data-rill-app]')).toBeNull()
    expect(within(view.container).getByText(createShellTranslator('ko')('shell.noHost'))).toBeTruthy()
  })

  it.each([['ko-KR', 'ko'], ['en-GB', 'en'], ['fr', 'en']] as Array<[string, Locale]>)('maps the system language %s to %s', (system, locale) => {
    start({ system })
    expect(htmlLang()).toBe(locale)
  })
})
