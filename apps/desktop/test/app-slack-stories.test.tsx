import { composeStories } from '@storybook/react-vite'
import type { ComponentType } from 'react'
import { act, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import preview from '../.storybook/preview'
import * as slackStories from '../src/app/settings/SlackCard.stories'
import { createTranslator, type Locale } from '../src/i18n'
import { violations } from './axe'

const MODES = [
  { locale: 'ko', theme: 'light' },
  { locale: 'en', theme: 'dark' },
] as const

function compose(mode: (typeof MODES)[number]) {
  return composeStories(slackStories, { ...preview, initialGlobals: { theme: mode.theme, locale: mode.locale } } as never) as unknown as Record<
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

describe.each(MODES)('Slack card stories ($locale, $theme)', (mode) => {
  it('has one story for each state and the static overviews', () => {
    expect(Object.keys(compose(mode)).sort()).toEqual([
      'Checking',
      'Confirmed',
      'Empty',
      'EveryResult',
      'FilledForm',
      'KoreanAndEnglishSideBySide',
      'LightAndDarkSideBySide',
      'NoKeychain',
      'RefusedWithSaveAnyway',
      'SavedAnywayAfterRefusal',
      'SavedBotsAndAnOldWebhook',
      'SavedButNotConfirmed',
      'StepsOpen',
    ])
  })

  it('StepsOpen shows the four steps', async () => {
    const { view, t } = await show('StepsOpen', mode)
    for (const step of [1, 2, 3, 4] as const) expect(within(view.container).getByText(t(`app.slackBot.step${step}`))).toBeTruthy()
    expect(await violations(view.container)).toEqual([])
    view.unmount()
  })

  it('FilledForm shows a filled form and no token text', async () => {
    const { view } = await show('FilledForm', mode)
    expect(view.container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toContain('xoxb-')
    expect(view.container.textContent).not.toContain('demo-token-not-real')
    view.unmount()
  })

  it('Checking says Slack is being asked', async () => {
    const { view, t } = await show('Checking', mode)
    expect(within(view.container).getByRole('status').textContent).toBe(t('app.slackBot.checking'))
    view.unmount()
  })

  it('Confirmed says who is connected and shows the saved bot', async () => {
    const { view, t } = await show('Confirmed', mode)
    await waitFor(() => expect(within(view.container).getByText(t('app.slackBot.connectedAs', { bot: 'rill-bot', workspace: 'Rill Team' }))).toBeTruthy())
    expect(view.container.innerHTML).not.toContain('demo-token-not-real')
    expect(await violations(view.container)).toEqual([])
    view.unmount()
  })

  it('SavedButNotConfirmed gives the reason in plain words', async () => {
    const { view, t } = await show('SavedButNotConfirmed', mode)
    await waitFor(() => expect(within(view.container).getByText(t('app.slackBot.unverified', { reason: t('app.slackBot.reason.network') }))).toBeTruthy())
    view.unmount()
  })

  it('RefusedWithSaveAnyway shows the refusal with both buttons and no token', async () => {
    const { view, t } = await show('RefusedWithSaveAnyway', mode)
    const alert = await within(view.container).findByRole('alert')
    expect(alert.textContent).toContain(t('app.error.host.TOKEN_INVALID'))
    expect(within(alert).getAllByRole('button').map((button) => button.textContent)).toEqual([t('app.slackBot.saveAnyway'), t('app.common.close')])
    expect(view.container.innerHTML).not.toContain('demo-token-not-real')
    expect(await violations(view.container)).toEqual([])
    view.unmount()
  })

  it('SavedAnywayAfterRefusal says the token was saved as it is', async () => {
    const { view, t } = await show('SavedAnywayAfterRefusal', mode)
    await waitFor(() => expect(within(view.container).getByText(t('app.slackBot.savedAnyway', { reason: t('app.slackBot.reason.unauthorized') }))).toBeTruthy())
    expect(within(view.container).queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('SavedBotsAndAnOldWebhook lists the chips, and NoKeychain disables the form', async () => {
    const saved = await show('SavedBotsAndAnOldWebhook', mode)
    expect(within(saved.view.container).getAllByText(saved.t('app.slackBot.chipBot'))).toHaveLength(2)
    expect(within(saved.view.container).getByText(saved.t('app.slackBot.chipWebhook'))).toBeTruthy()
    expect(await violations(saved.view.container)).toEqual([])
    saved.view.unmount()
    const none = await show('NoKeychain', mode)
    expect(none.view.container.querySelector<HTMLInputElement>('input[type="password"]')!.disabled).toBe(true)
    none.view.unmount()
  })

  it('EveryResult shows every state and every reason as text', async () => {
    const { view, t } = await show('EveryResult', mode)
    const text = view.container.textContent ?? ''
    for (const phrase of [t('app.slackBot.checking'), t('app.slackBot.saved'), t('app.error.host.TOKEN_INVALID'), t('app.slackBot.saveAnyway')]) expect(text, phrase).toContain(phrase)
    for (const reason of ['unauthorized', 'forbidden', 'rate_limited', 'server_error', 'network', 'timeout', 'unexpected_status'] as const) expect(text, reason).toContain(t(`app.slackBot.reason.${reason}`))
    expect(await violations(view.container)).toEqual([])
    view.unmount()
  })

  it('the side by side stories draw both themes and both languages', async () => {
    const themes = await show('LightAndDarkSideBySide', mode)
    expect([...themes.view.container.querySelectorAll('[data-theme]')].map((node) => node.getAttribute('data-theme'))).toEqual(expect.arrayContaining(['light', 'dark']))
    themes.view.unmount()
    const languages = await show('KoreanAndEnglishSideBySide', mode)
    expect([...languages.view.container.querySelectorAll('[lang]')].map((node) => node.getAttribute('lang'))).toEqual(expect.arrayContaining(['ko', 'en']))
    languages.view.unmount()
  })
})
