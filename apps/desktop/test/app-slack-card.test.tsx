import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostProvider } from '../src/app/host'
import { SlackCard, SlackResult, type SlackView } from '../src/app/settings/SlackCard'
import { SettingsScreen } from '../src/app/settings/SettingsScreen'
import { useSettings } from '../src/app/settings/useSettings'
import { createFakeHost, fakeSettings, type FakeHost, type FakeHostOptions, type FakeHostState } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import type { SettingsApi } from '../src/app/settings/types'
import { HostError, type SlackVerdict } from '../src/shared/host-api'
import { violations } from './axe'
import { renderThemed } from './render'

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const OTHER = 'xoxb-SLACKTOKENMARKER9999'
const CONNECTED = { state: 'connected', status: { state: 'running', restarts: 0 } } as const
const INVALID: SlackVerdict = { status: 'invalid', reason: 'unauthorized' }

interface Options {
  init?: Partial<FakeHostState>
  host?: FakeHost
  options?: FakeHostOptions
  locale?: Locale
}

function Harness({ host }: { host: FakeHost }) {
  const state = useSettings(host)
  return <SettingsScreen state={state} client={undefined} connection={CONNECTED} section="connections" />
}

async function open(options: Options = {}) {
  const host = options.host ?? createFakeHost(options.init ?? {}, { restartDelayMs: 0, ...options.options })
  const locale = options.locale ?? 'en'
  const view = renderThemed(
    <HostProvider host={host}>
      <Harness host={host} />
    </HostProvider>,
    { locale },
  )
  const t = createTranslator(locale)
  await screen.findByRole('navigation', { name: t('app.settings.nav') })
  return { host, view, t, user: userEvent.setup() }
}

type T = ReturnType<typeof createTranslator>

const slack = (t: T) => screen.getByRole('region', { name: t('app.connections.provider.slack') })
const field = (t: T, key: 'name' | 'token' | 'channel') => within(slack(t)).getByLabelText(t(`app.slackBot.${key}`)) as HTMLInputElement
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const save = (t: T) => within(slack(t)).getByRole('button', { name: t('app.slackBot.save') }) as HTMLButtonElement
const steps = (t: T) => within(slack(t)).getByRole('button', { name: t('app.slackBot.stepsToggle') })

async function fill(user: ReturnType<typeof userEvent.setup>, t: T, values: { name?: string; token?: string; channel?: string }) {
  if (values.name !== undefined) await user.type(field(t, 'name'), values.name)
  if (values.token !== undefined) await user.type(field(t, 'token'), values.token)
  if (values.channel !== undefined) await user.type(field(t, 'channel'), values.channel)
}

function nothingSecretShown(extra: unknown = ''): void {
  expect(document.body.innerHTML).not.toContain('SLACKTOKENMARKER')
  expect(document.body.textContent).not.toContain('SLACKTOKENMARKER')
  expect([...document.querySelectorAll('input, textarea, select')].every((item) => !(item as HTMLInputElement).value.includes('SLACKTOKENMARKER'))).toBe(true)
  expect(JSON.stringify(extra)).not.toContain('SLACKTOKENMARKER')
}

afterEach(() => vi.restoreAllMocks())

describe('the Slack card: layout', () => {
  it('is its own part with a status chip, a collapsed steps part and the form, and no OAuth button or webhook form', async () => {
    const { t } = await open()
    const card = slack(t)
    expect(within(card).getByRole('heading', { name: t('app.connections.provider.slack'), level: 3 })).toBeTruthy()
    expect(within(card).getByText(t('app.connections.account.notConnected'))).toBeTruthy()
    expect(within(card).queryByRole('button', { name: t('app.connections.account.connectLabel', { provider: 'Slack' }) })).toBeNull()
    expect(screen.queryByText(/webhook url/i)).toBeNull()
    expect(screen.queryByText(t('app.slackBot.stepsTitle' as never))).toBeNull()
    expect(steps(t).getAttribute('aria-expanded')).toBe('false')
    expect(field(t, 'token').type).toBe('password')
    expect(field(t, 'name').type).toBe('text')
    expect(field(t, 'channel').type).toBe('text')
    expect(within(card).getByText(t('app.slackBot.checkNote'))).toBeTruthy()
    expect(within(card).getByText(t('app.slackBot.none'))).toBeTruthy()
    expect(save(t).disabled).toBe(true)
  })

  it('opens and closes the four steps, and the steps name the app page, the scopes and the token prefix', async () => {
    const { t, user } = await open()
    await user.click(steps(t))
    expect(steps(t).getAttribute('aria-expanded')).toBe('true')
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.stepsToggle') })
    const items = within(list).getAllByRole('listitem').map((item) => item.textContent ?? '')
    expect(items).toHaveLength(4)
    expect(items[0]).toContain('api.slack.com/apps')
    expect(items[1]).toContain('chat:write')
    expect(items[1]).toContain('chat:write.public')
    expect(items[2]).toMatch(/Install to Workspace/)
    expect(items[3]).toContain('xoxb-')
    await user.click(steps(t))
    expect(within(slack(t)).queryByRole('list', { name: t('app.slackBot.stepsToggle') })).toBeNull()
  })

  it('shows the Google and Microsoft cards unchanged next to it', async () => {
    const { t } = await open()
    const accounts = screen.getByRole('region', { name: t('app.connections.accounts.heading') })
    expect(within(accounts).getAllByRole('listitem')).toHaveLength(2)
    expect(within(accounts).queryByText(t('app.connections.provider.slack'))).toBeNull()
  })
})

describe('the Slack card: saving', () => {
  it('sends the name, the token and the channel once, shows who is connected and forgets the token', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'alerts', token: TOKEN, channel: '#alerts' })
    await user.click(save(t))
    expect(set).toHaveBeenCalledExactlyOnceWith({ name: 'alerts', token: TOKEN, channel: '#alerts' })
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(t('app.slackBot.connectedAs', { bot: 'rill-bot', workspace: 'Rill Team' }))
    expect(field(t, 'token').value).toBe('')
    expect(field(t, 'name').value).toBe('')
    expect(field(t, 'channel').value).toBe('')
    expect(within(slack(t)).getByText(t('app.connections.account.connected'))).toBeTruthy()
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })
    expect(list.textContent).toContain('alerts')
    expect(within(list).getByText(t('app.slackBot.chipBot'))).toBeTruthy()
    expect(within(list).getByText('rill-bot in Rill Team')).toBeTruthy()
    expect(within(list).getByText(t('app.slackBot.defaultChannel', { channel: '#alerts' }))).toBeTruthy()
    nothingSecretShown(host.state())
    expect(host.state().settings.connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Rill Team', channel: '#alerts' } }])
  })

  it('leaves the channel out of the call when it is empty, and trims what was typed', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: '  ops  ', token: `  ${TOKEN}  ` })
    await user.click(save(t))
    expect(set).toHaveBeenCalledExactlyOnceWith({ name: 'ops', token: TOKEN })
    await screen.findByRole('status')
  })

  it('moves focus to the result and announces it as a status', async () => {
    const { t, user } = await open()
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    const status = await screen.findByRole('status')
    await waitFor(() => expect(document.activeElement).toBe(status))
  })

  it('says only the workspace or only the bot when Slack tells just one of them, and a plain saved text when neither', async () => {
    const answers: Array<[SlackVerdict, string]> = [
      [{ status: 'valid', workspace: 'Acme' }, 'app.slackBot.connectedWorkspace'],
      [{ status: 'valid', bot: 'helper' }, 'app.slackBot.connectedBot'],
      [{ status: 'valid' }, 'app.slackBot.saved'],
    ]
    for (const [verdict, key] of answers) {
      const { t, user, view } = await open({ options: { slackChecks: () => verdict } })
      await fill(user, t, { name: 'alerts', token: TOKEN })
      await user.click(save(t))
      const status = await screen.findByRole('status')
      expect(status.textContent).toBe(t(key as never, { bot: 'helper', workspace: 'Acme' }))
      view.unmount()
    }
  })

  it('shows text from Slack as text only, with invisible characters made visible', async () => {
    const { t, user, host } = await open({ options: { slackChecks: () => ({ status: 'valid', workspace: '<img src=x onerror=alert(1)>', bot: 'a​b' }) } })
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    const status = await screen.findByRole('status')
    expect(status.querySelector('img')).toBeNull()
    expect(status.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(status.textContent).not.toContain('​')
    expect(document.querySelector('img')).toBeNull()
    expect(host.state().settings.connections).toHaveLength(1)
  })

  it('checks the token shape in the browser without calling the host and keeps what was typed', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'alerts', token: 'xoxp-not-a-bot-token-0123' })
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.slackBot.tokenShape'))
    expect(set).not.toHaveBeenCalled()
    expect(field(t, 'token').value).toBe('xoxp-not-a-bot-token-0123')
    expect(document.activeElement).toBe(field(t, 'token'))
  })

  it('refuses a channel with a space without calling the host, and focuses it', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'alerts', token: TOKEN, channel: '# alerts' })
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.slackBot.channelInvalid'))
    expect(set).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field(t, 'channel'))
  })

  it('refuses a name that another connection of any kind uses, in any case, without calling the host', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'Billing', kind: 'http', authType: 'bearer' }] }) } })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'billing', token: TOKEN })
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.duplicate'))
    expect(set).not.toHaveBeenCalled()
    expect(field(t, 'token').value).toBe(TOKEN)
    expect(document.activeElement).toBe(field(t, 'name'))
  })

  it('refuses an invalid name', async () => {
    const { t, user } = await open()
    fireEvent.change(field(t, 'name'), { target: { value: 'bad\u0007name' } })
    await user.type(field(t, 'token'), TOKEN)
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.nameInvalid'))
  })

  it('disables the form without a keychain', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ encryptionAvailable: false }) } })
    for (const key of ['name', 'token', 'channel'] as const) expect(field(t, key).disabled).toBe(true)
    expect(save(t).disabled).toBe(true)
  })

  it('disables the form at the 200 connections limit', async () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ name: `c${index}`, kind: 'http' as const, authType: 'none' as const }))
    const { t } = await open({ init: { settings: fakeSettings({ connections: many }) } })
    expect(field(t, 'token').disabled).toBe(true)
  })

  it('shows a host error as an alert with the fixed text and keeps the form usable', async () => {
    const { t, user, host } = await open()
    vi.spyOn(host.secrets, 'setSlackBot').mockRejectedValue(new HostError('NAME_COLLISION'))
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.NAME_COLLISION'))
    expect(screen.queryByText(t('app.slackBot.checking'))).toBeNull()
    nothingSecretShown()
  })

  it('shows a superseded call in its own words', async () => {
    const { t, user, host } = await open()
    vi.spyOn(host.secrets, 'setSlackBot').mockRejectedValue(new HostError('SUPERSEDED'))
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.slackBot.superseded'))
  })
})

describe('the Slack card: replacing a Slack connection', () => {
  const saved = () => ({ settings: fakeSettings({ connections: [{ name: 'alerts', kind: 'slack' as const, slack: { mode: 'bot' as const, confirmed: true, account: 'old-bot in Acme', channel: '#old' } }] }) })

  it('accepts the exact name of a saved Slack connection, says it replaces it and saves the new token', async () => {
    const { t, user, host } = await open({ init: saved() })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await user.type(field(t, 'name'), 'alerts')
    const note = within(slack(t)).getByText(t('app.slackBot.replaceNote'))
    expect(field(t, 'name').getAttribute('aria-describedby')).toContain(note.id)
    await fill(user, t, { token: OTHER, channel: '#new' })
    await user.click(save(t))
    expect(set).toHaveBeenCalledExactlyOnceWith({ name: 'alerts', token: OTHER, channel: '#new' })
    expect((await screen.findByRole('status')).textContent).toBe(t('app.slackBot.connectedAs', { bot: 'rill-bot', workspace: 'Rill Team' }))
    expect(screen.queryByText(t('app.connections.duplicate'))).toBeNull()
    expect(host.state().settings.connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Rill Team', channel: '#new' } }])
    expect(within(slack(t)).queryByText(t('app.slackBot.replaceNote'))).toBeNull()
    nothingSecretShown(host.state())
  })

  it('turns a saved webhook of the same name into a bot', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'old-hook', kind: 'slack' }] }) } })
    await fill(user, t, { name: 'old-hook', token: TOKEN })
    expect(within(slack(t)).getByText(t('app.slackBot.replaceNote'))).toBeTruthy()
    await user.click(save(t))
    await screen.findByRole('status')
    expect(host.state().settings.connections).toEqual([{ name: 'old-hook', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Rill Team' } }])
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })
    expect(within(list).getByText(t('app.slackBot.chipBot'))).toBeTruthy()
    expect(within(list).queryByText(t('app.slackBot.chipWebhook'))).toBeNull()
  })

  it('still refuses a name that differs from a Slack connection only in case', async () => {
    const { t, user, host } = await open({ init: saved() })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await user.type(field(t, 'name'), 'Alerts')
    expect(within(slack(t)).queryByText(t('app.slackBot.replaceNote'))).toBeNull()
    await fill(user, t, { token: TOKEN })
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.duplicate'))
    expect(set).not.toHaveBeenCalled()
  })

  it('still refuses the exact name of a connection of another kind', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'billing', kind: 'http', authType: 'bearer' }] }) } })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'billing', token: TOKEN })
    expect(within(slack(t)).queryByText(t('app.slackBot.replaceNote'))).toBeNull()
    await user.click(save(t))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.duplicate'))
    expect(set).not.toHaveBeenCalled()
  })

  it('shows no replace note for a new name, and drops it when the name changes', async () => {
    const { t, user } = await open({ init: saved() })
    await user.type(field(t, 'name'), 'other')
    expect(within(slack(t)).queryByText(t('app.slackBot.replaceNote'))).toBeNull()
    await user.clear(field(t, 'name'))
    await user.type(field(t, 'name'), 'alerts')
    expect(within(slack(t)).getByText(t('app.slackBot.replaceNote'))).toBeTruthy()
    await user.type(field(t, 'name'), '2')
    expect(within(slack(t)).queryByText(t('app.slackBot.replaceNote'))).toBeNull()
  })
})

describe('the Slack card: the status chip', () => {
  const bot = (name: string, confirmed?: boolean) => ({ name, kind: 'slack' as const, slack: { mode: 'bot' as const, ...(confirmed === undefined ? {} : { confirmed }) } })

  it('says Connected only for a bot that Slack confirmed', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ connections: [bot('a', true)] }) } })
    expect(within(slack(t)).getAllByText(t('app.connections.account.connected'))).toHaveLength(1)
    expect(within(slack(t)).queryByText(t('app.slackBot.notConfirmed'))).toBeNull()
  })

  it.each([false, undefined])('says Not confirmed and not Connected for a bot saved with confirmed %s', async (confirmed) => {
    const { t } = await open({ init: { settings: fakeSettings({ connections: [bot('a', confirmed)] }) } })
    expect(within(slack(t)).queryByText(t('app.connections.account.connected'))).toBeNull()
    expect(within(slack(t)).queryByText(t('app.connections.account.notConnected'))).toBeNull()
    expect(within(slack(t)).getAllByText(t('app.slackBot.notConfirmed'))).toHaveLength(2)
  })

  it('says Connected when one bot is confirmed and another is not, and marks the unconfirmed row', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ connections: [bot('a', false), bot('b', true)] }) } })
    expect(within(slack(t)).getAllByText(t('app.connections.account.connected'))).toHaveLength(1)
    const rows = within(within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })).getAllByRole('listitem')
    expect(within(rows[0]!).getByText(t('app.slackBot.notConfirmed'))).toBeTruthy()
    expect(within(rows[1]!).queryByText(t('app.slackBot.notConfirmed'))).toBeNull()
  })

  it('does not say Connected after a token that Slack rejected was saved anyway', async () => {
    const { t, user } = await open({ options: { slackChecks: () => INVALID } })
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: t('app.slackBot.saveAnyway') }))
    await screen.findByText(t('app.slackBot.savedAnyway', { reason: t('app.slackBot.reason.unauthorized') }))
    expect(within(slack(t)).queryByText(t('app.connections.account.connected'))).toBeNull()
    expect(within(slack(t)).getAllByText(t('app.slackBot.notConfirmed')).length).toBeGreaterThan(0)
  })

  it('does not say Connected after a token that Slack could not check', async () => {
    const { t, user } = await open({ options: { slackChecks: () => ({ status: 'unverified', reason: 'timeout' }) } })
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    await screen.findByRole('status')
    expect(within(slack(t)).queryByText(t('app.connections.account.connected'))).toBeNull()
  })

  it('shows Not connected while only an old webhook is saved, and no Not confirmed text for it', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'old', kind: 'slack' }] }) } })
    expect(within(slack(t)).getByText(t('app.connections.account.notConnected'))).toBeTruthy()
    expect(within(slack(t)).queryByText(t('app.slackBot.notConfirmed'))).toBeNull()
  })
})

describe('the Slack card: while Slack is asked', () => {
  function pending() {
    let release: (verdict: SlackVerdict) => void = () => undefined
    const slackChecks = () => new Promise<SlackVerdict>((resolve) => (release = resolve))
    return { slackChecks, release: (verdict: SlackVerdict) => release(verdict) }
  }

  it('says it is checking, disables the form and sends a double submit once', async () => {
    const gate = pending()
    const { t, user, host } = await open({ options: { slackChecks: gate.slackChecks } })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.dblClick(save(t))
    expect((await screen.findByRole('status')).textContent).toBe(t('app.slackBot.checking'))
    expect(set).toHaveBeenCalledTimes(1)
    expect(save(t).disabled).toBe(true)
    for (const key of ['name', 'token', 'channel'] as const) expect(field(t, key).disabled).toBe(true)
    nothingSecretShown()
    await act(async () => gate.release({ status: 'valid' }))
    await screen.findByText(t('app.slackBot.saved'))
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('ignores a second submit that comes before the first result', async () => {
    const gate = pending()
    const { t, user, host } = await open({ options: { slackChecks: gate.slackChecks } })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'alerts', token: TOKEN })
    const form = field(t, 'token').closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    expect(set).toHaveBeenCalledTimes(1)
    await act(async () => gate.release({ status: 'valid' }))
  })
})

describe('the Slack card: results', () => {
  it('saves a token that Slack could not confirm and says why in plain words', async () => {
    const { t, user, host } = await open({ options: { slackChecks: () => ({ status: 'unverified', reason: 'network' }) } })
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(t('app.slackBot.unverified', { reason: t('app.slackBot.reason.network') }))
    expect(host.state().settings.connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: false } }])
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })
    expect(within(list).getByText(t('app.slackBot.chipBot'))).toBeTruthy()
    nothingSecretShown()
  })

  it('refuses a token that Slack rejects, keeps nothing and offers save anyway', async () => {
    const { t, user, host } = await open({ options: { slackChecks: () => INVALID } })
    await fill(user, t, { name: 'alerts', token: TOKEN, channel: '#a' })
    await user.click(save(t))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('app.error.host.TOKEN_INVALID'))
    expect(within(alert).getAllByRole('button').map((item) => item.textContent)).toEqual([t('app.slackBot.saveAnyway'), t('app.common.close')])
    await waitFor(() => expect(document.activeElement).toBe(alert))
    expect(host.state().settings.connections).toEqual([])
    expect(field(t, 'token').value).toBe('')
    expect(field(t, 'name').value).toBe('alerts')
    expect(field(t, 'channel').value).toBe('#a')
    nothingSecretShown()
  })

  it('saves anyway with the held token and then says it was saved as it is', async () => {
    const { t, user, host } = await open({ options: { slackChecks: () => INVALID } })
    const set = vi.spyOn(host.secrets, 'setSlackBot')
    await fill(user, t, { name: 'alerts', token: TOKEN, channel: '#a' })
    await user.click(save(t))
    const alert = await screen.findByRole('alert')
    await user.click(within(alert).getByRole('button', { name: t('app.slackBot.saveAnyway') }))
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[1]).toEqual([{ name: 'alerts', token: TOKEN, channel: '#a' }, { saveAnyway: true }])
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(t('app.slackBot.savedAnyway', { reason: t('app.slackBot.reason.unauthorized') }))
    expect(host.state().settings.connections).toEqual([{ name: 'alerts', kind: 'slack', slack: { mode: 'bot', confirmed: false, channel: '#a' } }])
    expect(screen.queryByRole('alert')).toBeNull()
    nothingSecretShown(host.state())
  })

  it('clears the held token when the notice is closed, and save anyway is gone', async () => {
    const { t, user } = await open({ options: { slackChecks: () => INVALID } })
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    const alert = await screen.findByRole('alert')
    await user.click(within(alert).getByRole('button', { name: t('app.common.close') }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: t('app.slackBot.saveAnyway') })).toBeNull()
    expect(document.activeElement).toBe(field(t, 'token'))
  })

  it.each(['name', 'token', 'channel'] as const)('clears the held token and closes the notice when the %s is edited', async (key) => {
    const { t, user } = await open({ options: { slackChecks: () => INVALID } })
    await fill(user, t, { name: 'alerts', token: TOKEN })
    await user.click(save(t))
    await screen.findByRole('alert')
    await user.type(field(t, key), 'x')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: t('app.slackBot.saveAnyway') })).toBeNull()
  })

  it('adds nothing to the saved connections when the token is refused', async () => {
    const { t, user, host } = await open({
      init: { settings: fakeSettings({ connections: [{ name: 'other', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'x in y' } }] }) },
      options: { slackChecks: () => INVALID },
    })
    await fill(user, t, { name: 'alerts', token: OTHER })
    await user.click(save(t))
    await screen.findByRole('alert')
    expect(host.state().settings.connections.map((entry) => entry.name)).toEqual(['other'])
  })
})

describe('the Slack card: the saved list', () => {
  const connections = [
    { name: 'team', kind: 'slack' as const, slack: { mode: 'bot' as const, confirmed: true, account: 'rill-bot in Acme', channel: '#alerts' } },
    { name: 'no-account', kind: 'slack' as const, slack: { mode: 'bot' as const, confirmed: false } },
    { name: 'old-hook', kind: 'slack' as const },
    { name: 'billing', kind: 'http' as const, authType: 'bearer' as const },
  ]

  it('lists a bot with its account and channel, and an old webhook with its own chip', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ connections }) } })
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('team')
    expect(within(rows[0]!).getByText(t('app.slackBot.chipBot'))).toBeTruthy()
    expect(within(rows[0]!).getByText('rill-bot in Acme')).toBeTruthy()
    expect(within(rows[0]!).getByText(t('app.slackBot.defaultChannel', { channel: '#alerts' }))).toBeTruthy()
    expect(within(rows[1]!).getByText(t('app.slackBot.chipBot'))).toBeTruthy()
    expect(within(rows[1]!).queryByText(/Default channel|기본 채널/)).toBeNull()
    expect(within(rows[2]!).getByText(t('app.slackBot.chipWebhook'))).toBeTruthy()
    expect(within(rows[2]!).queryByText(t('app.slackBot.chipBot'))).toBeNull()
    expect(within(slack(t)).getByText(t('app.connections.account.connected'))).toBeTruthy()
  })

  it('shows Not connected while only an old webhook is saved', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'old-hook', kind: 'slack' }] }) } })
    expect(within(slack(t)).getByText(t('app.connections.account.notConnected'))).toBeTruthy()
    expect(within(slack(t)).getByText(t('app.slackBot.chipWebhook'))).toBeTruthy()
  })

  it('shows names and Slack text as text with invisible characters made visible', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'a‮b', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: '<b>x</b>​' } }] }) } })
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })
    expect(list.querySelector('b')).toBeNull()
    expect(list.textContent).toContain('<b>x</b>')
    expect(list.textContent).not.toContain('‮')
    expect(list.querySelectorAll('[data-invisible]').length).toBeGreaterThan(0)
  })

  it('removes a connection after the existing confirmation that names it', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ connections }) } })
    const list = within(slack(t)).getByRole('list', { name: t('app.slackBot.listTitle') })
    const trigger = within(list).getByRole('button', { name: t('app.connections.removeLabel', { name: 'old-hook' }) })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: t('app.connections.removeTitle') })
    expect(dialog.textContent).toContain(t('app.connections.removeConfirm', { name: 'old-hook' }))
    await user.click(within(dialog).getByRole('button', { name: t('app.common.cancel') }))
    expect(host.state().settings.connections).toHaveLength(4)
    await user.click(trigger)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.connections.removeAction') }))
    await waitFor(() => expect(host.state().settings.connections.map((entry) => entry.name)).toEqual(['team', 'no-account', 'billing']))
  })
})

describe('the Slack card: the result part alone', () => {
  function Show({ view }: { view: SlackView }) {
    return <SlackResult view={view} />
  }

  const reasons = ['unauthorized', 'forbidden', 'rate_limited', 'server_error', 'network', 'timeout', 'unexpected_status'] as const

  it.each(['ko', 'en'] as const)('has a sentence for every verdict and reason in %s', (locale) => {
    const t = createTranslator(locale)
    for (const reason of reasons) {
      const verdict: SlackVerdict = reason === 'unauthorized' ? { status: 'invalid', reason } : { status: 'unverified', reason }
      const view = renderThemed(<Show view={{ kind: 'checked', verdict }} />, { locale })
      expect(view.container.textContent).toContain(t(`app.slackBot.reason.${reason}`))
      expect(view.container.textContent).not.toMatch(/\bapp\.[a-z]+\./)
      view.unmount()
    }
  })
})

describe('the Slack card: held token', () => {
  it('does not keep a refused token after the card went away during the check', async () => {
    let release: (verdict: SlackVerdict) => void = () => undefined
    const host = createFakeHost({}, { slackChecks: () => new Promise((resolve) => (release = resolve)) })
    const api: SettingsApi = { settings: fakeSettings(), apply: () => undefined, reload: async () => undefined }
    const view = renderThemed(
      <HostProvider host={host}>
        <SlackCard api={api} locked={false} full={false} onRemove={() => undefined} />
      </HostProvider>,
      { locale: 'en' },
    )
    const t = createTranslator('en')
    const user = userEvent.setup()
    await user.type(field(t, 'name'), 'alerts')
    await user.type(field(t, 'token'), `${TOKEN}{Enter}`)
    view.unmount()
    await act(async () => release(INVALID))
    expect(document.body.textContent).not.toContain('SLACKTOKENMARKER')
  })
})

describe('the Slack card: a reload that fails after the save', () => {
  it('still shows the saved result and empties the fields, and shows the error as well', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0 })
    const api: SettingsApi = { settings: fakeSettings(), apply: () => undefined, reload: () => Promise.reject(new Error('reload broke')) }
    renderThemed(
      <HostProvider host={host}>
        <SlackCard api={api} locked={false} full={false} onRemove={() => undefined} />
      </HostProvider>,
      { locale: 'en' },
    )
    const t = createTranslator('en')
    const user = userEvent.setup()
    await fill(user, t, { name: 'alerts', token: TOKEN, channel: '#a' })
    await user.click(save(t))
    expect((await screen.findByRole('status')).textContent).toBe(t('app.slackBot.connectedAs', { bot: 'rill-bot', workspace: 'Rill Team' }))
    expect(screen.queryByText(t('app.slackBot.checking'))).toBeNull()
    expect(field(t, 'name').value).toBe('')
    expect(field(t, 'channel').value).toBe('')
    expect(field(t, 'token').value).toBe('')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(host.state().settings.connections.map((entry) => entry.name)).toEqual(['alerts'])
    nothingSecretShown(host.state())
  })
})

describe('the Slack card: languages and accessibility', () => {
  it.each(['ko', 'en'] as const)('renders every part in %s without a missing key', async (locale) => {
    const { t, user } = await open({ locale, init: { settings: fakeSettings({ connections: [{ name: 'team', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'a in b', channel: '#c' } }, { name: 'old', kind: 'slack' }, { name: 'shaky', kind: 'slack', slack: { mode: 'bot', confirmed: false } }] }) } })
    await user.click(steps(t))
    expect(document.body.textContent).not.toMatch(/\bapp\.[a-z]+\./)
    expect(slack(t)).toBeTruthy()
  })

  it('has no axe violations idle, with the steps open, refused and confirmed', async () => {
    const { t, user, view } = await open({ options: { slackChecks: (token) => (token === OTHER ? INVALID : { status: 'valid', workspace: 'Acme', bot: 'bot' }) }, init: { settings: fakeSettings({ connections: [{ name: 'old', kind: 'slack' }] }) } })
    expect(await violations(view.container)).toEqual([])
    await user.click(steps(t))
    expect(await violations(view.container)).toEqual([])
    await fill(user, t, { name: 'alerts', token: OTHER })
    await user.click(save(t))
    await screen.findByRole('alert')
    expect(await violations(view.container)).toEqual([])
    await user.click(button(t('app.common.close')))
    await fill(user, t, { token: TOKEN })
    await user.click(save(t))
    await screen.findByRole('status')
    expect(await violations(view.container)).toEqual([])
  })
})
