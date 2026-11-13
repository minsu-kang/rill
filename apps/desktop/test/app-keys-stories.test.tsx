import { composeStories } from '@storybook/react-vite'
import type { ComponentType } from 'react'
import { act, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import preview from '../.storybook/preview'
import * as keyStories from '../src/app/settings/KeysSection.stories'
import { createTranslator, type Locale } from '../src/i18n'
import { KEY_INVALID_REASONS, KEY_UNVERIFIED_REASONS } from '../src/shared/host-api'
import { violations } from './axe'

const MODES = [
  { locale: 'ko', theme: 'light' },
  { locale: 'en', theme: 'dark' },
] as const

function compose(mode: (typeof MODES)[number]) {
  return composeStories(keyStories, { ...preview, initialGlobals: { theme: mode.theme, locale: mode.locale } } as never) as unknown as Record<
    string,
    ComponentType & { play?: (context: { canvasElement: HTMLElement; canvas: ReturnType<typeof within>; userEvent: ReturnType<typeof userEvent.setup> }) => Promise<void> }
  >
}

async function show(name: string, mode: (typeof MODES)[number]) {
  const Story = compose(mode)[name]!
  const view = render(<Story />)
  await Story.play?.({ canvasElement: view.container, canvas: within(view.container), userEvent: userEvent.setup() })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { view, t: createTranslator(mode.locale as Locale) }
}

describe.each(MODES)('key check stories ($locale, $theme)', (mode) => {
  it('has one story for each state of the flow and the static overviews', () => {
    expect(Object.keys(compose(mode)).sort()).toEqual([
      'Checking',
      'Empty',
      'EveryResult',
      'KoreanAndEnglishSideBySide',
      'LightAndDarkSideBySide',
      'NoKeychain',
      'ProviderAcceptsTheKey',
      'RefusedWithSaveAnyway',
      'SavedAnywayAfterRefusal',
      'SavedButNotConfirmed',
      'SomeConfigured',
    ])
  })

  it('Checking shows that the provider is being asked', async () => {
    const { view, t } = await show('Checking', mode)
    expect(within(view.container).getByRole('status').textContent).toBe(t('app.keys.checking'))
    view.unmount()
  })

  it('ProviderAcceptsTheKey says the provider accepts the key', async () => {
    const { view, t } = await show('ProviderAcceptsTheKey', mode)
    await waitFor(() => expect(within(view.container).getByText(t('app.keys.saved'))).toBeTruthy())
    expect(view.container.textContent).not.toContain('demo-key')
    view.unmount()
  })

  it('SavedButNotConfirmed gives the reason in plain words', async () => {
    const { view, t } = await show('SavedButNotConfirmed', mode)
    await waitFor(() => expect(within(view.container).getByText(t('app.keys.unverified', { reason: t('app.keys.reason.network') }))).toBeTruthy())
    view.unmount()
  })

  it('RefusedWithSaveAnyway shows the refusal with both buttons and no key', async () => {
    const { view, t } = await show('RefusedWithSaveAnyway', mode)
    const alert = await within(view.container).findByRole('alert')
    expect(alert.textContent).toContain(t('app.error.host.KEY_INVALID'))
    expect(within(alert).getAllByRole('button').map((button) => button.textContent)).toEqual([t('app.keys.saveAnyway'), t('app.common.close')])
    expect(view.container.innerHTML).not.toContain('demo-key')
    expect(await violations(view.container)).toEqual([])
    view.unmount()
  })

  it('SavedAnywayAfterRefusal says the key was saved as it is', async () => {
    const { view, t } = await show('SavedAnywayAfterRefusal', mode)
    await waitFor(() => expect(within(view.container).getByText(t('app.keys.savedAnyway', { reason: t('app.keys.reason.unauthorized') }))).toBeTruthy())
    expect(within(view.container).queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('EveryResult shows every state and every reason as text', async () => {
    const { view, t } = await show('EveryResult', mode)
    const text = view.container.textContent ?? ''
    for (const phrase of [t('app.keys.checking'), t('app.keys.saved'), t('app.error.host.KEY_INVALID'), t('app.keys.saveAnyway'), t('app.keys.removed')]) {
      expect(text, phrase).toContain(phrase)
    }
    for (const reason of KEY_UNVERIFIED_REASONS) expect(text, reason).toContain(t(`app.keys.reason.${reason}`))
    for (const reason of KEY_INVALID_REASONS) expect(text, reason).toContain(t(`app.keys.reason.${reason}`))
    expect(await violations(view.container)).toEqual([])
    view.unmount()
  })

  it('the side by side stories draw both themes and both languages', async () => {
    const themes = await show('LightAndDarkSideBySide', mode)
    expect([...themes.view.container.querySelectorAll('[data-theme]')].map((node) => node.getAttribute('data-theme'))).toEqual(expect.arrayContaining(['light', 'dark']))
    themes.view.unmount()
    const languages = await show('KoreanAndEnglishSideBySide', mode)
    expect([...languages.view.container.querySelectorAll('[lang]')].map((node) => node.getAttribute('lang'))).toEqual(expect.arrayContaining(['ko', 'en']))
    const text = languages.view.container.textContent ?? ''
    expect(text).toContain(createTranslator('ko')('app.error.host.KEY_INVALID'))
    expect(text).toContain(createTranslator('en')('app.error.host.KEY_INVALID'))
    languages.view.unmount()
  })
})
