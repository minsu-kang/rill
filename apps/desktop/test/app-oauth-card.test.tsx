import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostProvider } from '../src/app/host'
import { SettingsScreen } from '../src/app/settings/SettingsScreen'
import { useSettings, withOAuthChange } from '../src/app/settings/useSettings'
import { createFakeHost, fakeSettings, type FakeHost, type FakeHostOptions, type FakeHostState } from '../src/engine/fake-host'
import { createTranslator, type Locale, type MessageKey } from '../src/i18n'
import { HostError, type OAuthAccount, type OAuthProvider, type OAuthStatus } from '../src/shared/host-api'
import { violations } from './axe'
import { renderThemed } from './render'

const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const MICROSOFT_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const SECRET = 'GOCSPX-CLIENTSECRETMARKER0123456789'
const CONNECTED = { state: 'connected', status: { state: 'running', restarts: 0 } } as const

interface Options {
  init?: Partial<FakeHostState>
  host?: FakeHost
  hostOptions?: FakeHostOptions
  locale?: Locale
}

function Harness({ host }: { host: FakeHost }) {
  const state = useSettings(host)
  return <SettingsScreen state={state} client={undefined} connection={CONNECTED} section="connections" />
}

async function open(options: Options = {}) {
  const host = options.host ?? createFakeHost(options.init ?? {}, { restartDelayMs: 0, ...options.hostOptions })
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
type User = ReturnType<typeof userEvent.setup>

interface Row {
  provider: OAuthProvider
  status?: OAuthStatus
  account?: string
  clientId?: string
  hasSecret?: boolean
}

function settingsWith(rows: Row[], extra: Parameters<typeof fakeSettings>[0] = {}) {
  const accounts: OAuthAccount[] = rows.filter((row) => row.status !== undefined).map((row) => ({ provider: row.provider, status: row.status!, ...(row.account === undefined ? {} : { account: row.account }) }))
  const apps = rows.filter((row) => row.clientId !== undefined).map((row) => ({ provider: row.provider, clientId: row.clientId!, hasSecret: row.hasSecret ?? false }))
  return fakeSettings({ oauth: { available: true, accounts, apps }, ...extra })
}

const googleSetUp: Row = { provider: 'google', clientId: GOOGLE_ID, status: 'not_connected' }
const microsoftSetUp: Row = { provider: 'microsoft', clientId: MICROSOFT_ID, status: 'not_connected' }

const card = (t: T, provider: OAuthProvider) => screen.getByRole('region', { name: t(`app.connections.provider.${provider}`) })
const label = (t: T, provider: OAuthProvider) => t(`app.connections.provider.${provider}`)
const chip = (t: T, provider: OAuthProvider, status: OAuthStatus) => within(card(t, provider)).getByText(t(`app.oauth.status.${status}`))
const button = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name }) as HTMLButtonElement
const toggle = (t: T, provider: OAuthProvider) => button(card(t, provider), t('app.oauth.setupLabel', { provider: label(t, provider) }))
const connectButton = (t: T, provider: OAuthProvider) => button(card(t, provider), t('app.oauth.connectLabel', { provider: label(t, provider) }))
const clientIdField = (t: T, provider: OAuthProvider) => within(card(t, provider)).getByLabelText(t(`app.oauth.clientId.${provider}`)) as HTMLInputElement
const secretField = (t: T) => within(card(t, 'google')).getByLabelText(t('app.oauth.secret.label')) as HTMLInputElement
const saveButton = (t: T, provider: OAuthProvider) => button(card(t, provider), t('app.oauth.save'))

async function expand(user: User, t: T, provider: OAuthProvider) {
  if (toggle(t, provider).getAttribute('aria-expanded') === 'false') await user.click(toggle(t, provider))
}

async function save(user: User, t: T, provider: OAuthProvider, id: string, secret?: string) {
  await expand(user, t, provider)
  await user.type(clientIdField(t, provider), id)
  if (secret !== undefined) await user.type(secretField(t), secret)
  await user.click(saveButton(t, provider))
}

function stubClipboard(write: () => Promise<void>) {
  const writeText = vi.fn(write)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const originalExec = document.execCommand

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.execCommand = originalExec
})

describe('the account cards: states and chips', () => {
  it('shows a card for Google and one for Microsoft, each with its own intro, title and status chip', async () => {
    const { t } = await open()
    for (const provider of ['google', 'microsoft'] as const) {
      expect(within(card(t, provider)).getByRole('heading', { name: label(t, provider), level: 3 })).toBeTruthy()
      expect(within(card(t, provider)).getByText(t(`app.oauth.${provider}.intro`))).toBeTruthy()
      expect(chip(t, provider, 'not_configured')).toBeTruthy()
    }
  })

  it('is not set up: Connect is disabled and points at the hint, and the Set up part is closed', async () => {
    const { t, host } = await open()
    const connect = connectButton(t, 'google')
    expect(connect.disabled).toBe(true)
    const hint = document.getElementById(connect.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toBe(t('app.error.host.OAUTH_NOT_CONFIGURED'))
    expect(toggle(t, 'google').getAttribute('aria-expanded')).toBe('false')
    expect(host.state().settings.oauth.accounts.map((entry) => entry.status)).toEqual(['not_configured', 'not_configured'])
  })

  it('is set up and not connected: the chip says so, Connect works and the Set up part starts closed', async () => {
    const { t } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) } })
    expect(chip(t, 'google', 'not_connected')).toBeTruthy()
    expect(connectButton(t, 'google').disabled).toBe(false)
    expect(toggle(t, 'google').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(t('app.oauth.clientId.google'))).toBeNull()
  })

  it('shows the saved Client ID, and whether a secret is saved, without the secret', async () => {
    const { t } = await open({ init: { settings: settingsWith([{ ...googleSetUp, hasSecret: true }, microsoftSetUp]) } })
    expect(within(card(t, 'google')).getByText(t('app.oauth.app.clientId', { clientId: GOOGLE_ID }))).toBeTruthy()
    expect(within(card(t, 'google')).getByText(t('app.oauth.app.secretSaved'))).toBeTruthy()
    expect(within(card(t, 'microsoft')).getByText(t('app.oauth.app.clientId', { clientId: MICROSOFT_ID }))).toBeTruthy()
    expect(within(card(t, 'microsoft')).queryByText(t('app.oauth.app.secretSaved'))).toBeNull()
    expect(within(card(t, 'microsoft')).queryByText(t('app.oauth.app.noSecret'))).toBeNull()
  })

  it('says no Client secret for a Google app saved without one', async () => {
    const { t } = await open({ init: { settings: settingsWith([googleSetUp]) } })
    expect(within(card(t, 'google')).getByText(t('app.oauth.app.noSecret'))).toBeTruthy()
  })

  it('waits for the browser with a Cancel button that has the focus, and goes back when cancelled', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) }, hostOptions: { oauthFlows: { google: 'waiting' } } })
    await user.click(connectButton(t, 'google'))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.connecting'))).toBeTruthy()
    const status = within(card(t, 'google')).getByText(t('app.oauth.waiting'))
    expect(status.getAttribute('role')).toBe('status')
    const cancel = button(card(t, 'google'), t('app.oauth.cancelLabel', { provider: 'Google' }))
    expect(document.activeElement).toBe(cancel)
    expect(within(card(t, 'google')).queryByRole('button', { name: t('app.oauth.connectLabel', { provider: 'Google' }) })).toBeNull()
    await user.click(cancel)
    expect(await within(card(t, 'google')).findByText(t('app.error.host.OAUTH_CANCELLED'))).toBeTruthy()
    expect(within(card(t, 'google')).queryByRole('alert')).toBeNull()
    expect(within(card(t, 'google')).getByText(t(`app.oauth.status.not_connected`))).toBeTruthy()
    expect(host.state().settings.oauth.accounts[0]!.status).toBe('not_connected')
  })

  it('shows the waiting state as soon as Connect is pressed, before the host has reported the status', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) } })
    vi.spyOn(host.oauth, 'connect').mockImplementation(() => new Promise(() => undefined))
    await user.click(connectButton(t, 'google'))
    expect(within(card(t, 'google')).getByText(t('app.oauth.status.connecting'))).toBeTruthy()
    expect(within(card(t, 'google')).getByText(t('app.oauth.waiting'))).toBeTruthy()
    expect(button(card(t, 'google'), t('app.oauth.cancelLabel', { provider: 'Google' }))).toBeTruthy()
    expect(within(card(t, 'google')).queryByRole('button', { name: t('app.oauth.connectLabel', { provider: 'Google' }) })).toBeNull()
  })

  it('shows Connected as the account after a sign-in and announces it as a status that has the focus', async () => {
    const { t, user } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) } })
    await user.click(connectButton(t, 'google'))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.connectedAs', { account: 'someone@example.com' }))).toBeTruthy()
    const notice = await within(card(t, 'google')).findByText(t('app.oauth.didConnectAs', { account: 'someone@example.com' }))
    expect(notice.getAttribute('role')).toBe('status')
    expect(document.activeElement).toBe(notice)
    expect(button(card(t, 'google'), t('app.oauth.disconnectLabel', { provider: 'Google' }))).toBeTruthy()
  })

  it('shows plain Connected when the account has no name', async () => {
    const { t } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected' }, microsoftSetUp]) } })
    expect(chip(t, 'google', 'connected')).toBeTruthy()
  })

  it('asks to reconnect: the chip, an explanation for the provider, a primary Reconnect and a Disconnect', async () => {
    const { t, user } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'needs_reconnect', account: 'someone@example.com' }, { ...microsoftSetUp, status: 'needs_reconnect' }]) } })
    for (const provider of ['google', 'microsoft'] as const) {
      expect(chip(t, provider, 'needs_reconnect')).toBeTruthy()
      expect(within(card(t, provider)).getByText(t(`app.oauth.reconnectNote.${provider}`))).toBeTruthy()
      expect(button(card(t, provider), t('app.oauth.disconnectLabel', { provider: label(t, provider) }))).toBeTruthy()
    }
    expect(t('app.oauth.reconnectNote.google')).toContain('7')
    expect(t('app.oauth.reconnectNote.microsoft')).toContain('90')
    await user.click(button(card(t, 'google'), t('app.oauth.reconnectLabel', { provider: 'Google' })))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.connectedAs', { account: 'someone@example.com' }))).toBeTruthy()
  })

  it('shows a background change of the status without any click, from the event of the host', async () => {
    const { t, host } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) } })
    await act(async () => {
      await host.oauth.connect('google')
    })
    expect(within(card(t, 'google')).getByText(t('app.oauth.status.connectedAs', { account: 'someone@example.com' }))).toBeTruthy()
    act(() => host.expireOAuth('google'))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.needs_reconnect'))).toBeTruthy()
    expect(within(card(t, 'google')).getByText(t('app.oauth.reconnectNote.google'))).toBeTruthy()
  })

  it('stops listening to the host when it goes away', async () => {
    const { host, view } = await open()
    expect(host.state().oauthListeners).toBe(1)
    view.unmount()
    expect(host.state().oauthListeners).toBe(0)
  })
})

describe('the account cards: every error has its own sentence', () => {
  const CASES: Array<[OAuthProvider, NonNullable<FakeHostOptions['oauthFlows']>, MessageKey]> = [
    ['google', { google: 'denied' }, 'app.error.host.OAUTH_DENIED'],
    ['google', { google: 'timeout' }, 'app.error.host.OAUTH_TIMEOUT'],
    ['microsoft', { microsoft: 'scope_missing' }, 'app.error.host.OAUTH_SCOPE_MISSING'],
    ['microsoft', { microsoft: 'exchange_failed' }, 'app.error.host.OAUTH_EXCHANGE_FAILED'],
  ]

  it.each(CASES)('shows the sentence of a failed %s sign-in as an alert and leaves the card not connected', async (provider, flows, key) => {
    const { t, user } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) }, hostOptions: { oauthFlows: flows } })
    await user.click(connectButton(t, provider))
    const alert = await within(card(t, provider)).findByRole('alert')
    expect(alert.textContent).toBe(t(key))
    expect(chip(t, provider, 'not_connected')).toBeTruthy()
    expect(within(card(t, provider)).queryByText(t('app.oauth.didConnect', { provider: label(t, provider) }))).toBeNull()
  })

  const SPIED: Array<[ConstructorParameters<typeof HostError>[0], MessageKey]> = [
    ['OAUTH_NOT_CONFIGURED', 'app.error.host.OAUTH_NOT_CONFIGURED'],
    ['OAUTH_BUSY', 'app.error.host.OAUTH_BUSY'],
    ['OAUTH_STATE', 'app.error.host.OAUTH_STATE'],
    ['OAUTH_UNAVAILABLE', 'app.error.host.OAUTH_UNAVAILABLE'],
    ['NO_KEYCHAIN', 'app.error.host.NO_KEYCHAIN'],
    ['INTERNAL', 'app.error.host.INTERNAL'],
    ['NAME_COLLISION', 'app.oauth.nameTaken'],
  ]

  it.each(SPIED)('shows the sentence for %s', async (code, key) => {
    const { t, user, host } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) } })
    vi.spyOn(host.oauth, 'connect').mockRejectedValue(new HostError(code))
    await user.click(connectButton(t, 'google'))
    expect((await within(card(t, 'google')).findByRole('alert')).textContent).toBe(t(key))
  })

  it('refuses a second sign-in while one is open, on the other card', async () => {
    const { t, user } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) }, hostOptions: { oauthFlows: { google: 'waiting' } } })
    await user.click(connectButton(t, 'google'))
    await within(card(t, 'google')).findByText(t('app.oauth.waiting'))
    await user.click(connectButton(t, 'microsoft'))
    expect((await within(card(t, 'microsoft')).findByRole('alert')).textContent).toBe(t('app.error.host.OAUTH_BUSY'))
    await user.click(button(card(t, 'google'), t('app.oauth.cancelLabel', { provider: 'Google' })))
  })

  it('shows the error of a failed app save and of a failed disconnect', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected' }, microsoftSetUp]) } })
    vi.spyOn(host.oauth, 'setApp').mockRejectedValue(new HostError('NO_KEYCHAIN'))
    await expand(user, t, 'google')
    await user.type(clientIdField(t, 'google'), GOOGLE_ID)
    await user.type(secretField(t), SECRET)
    await user.click(saveButton(t, 'google'))
    expect((await within(card(t, 'google')).findByRole('alert')).textContent).toBe(t('app.error.host.NO_KEYCHAIN'))
    vi.spyOn(host.oauth, 'disconnect').mockRejectedValue(new HostError('INTERNAL'))
    await user.click(button(card(t, 'google'), t('app.oauth.disconnectLabel', { provider: 'Google' })))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: t('app.oauth.disconnectAction') }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(t('app.error.host.INTERNAL'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})

describe('the account cards: the Set up part', () => {
  it('lists the numbered console steps of Google, the 7-day limit, and says that no address is to be registered', async () => {
    const { t, user } = await open()
    await expand(user, t, 'google')
    const panel = card(t, 'google')
    const items = within(panel).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual(['app.oauth.google.step1', 'app.oauth.google.step2', 'app.oauth.google.step3', 'app.oauth.google.step4', 'app.oauth.google.step5'].map((key) => t(key as MessageKey)))
    expect(panel.querySelector('ol')).not.toBeNull()
    expect(within(panel).getByText(t('app.oauth.google.limit'))).toBeTruthy()
    expect(t('app.oauth.google.limit')).toContain('7 days')
    expect(within(panel).getByText(t('app.oauth.google.redirect'))).toBeTruthy()
    expect(within(panel).queryByText(t('app.oauth.redirect.label'))).toBeNull()
    expect(within(panel).queryByRole('button', { name: t('app.oauth.redirect.copyLabel') })).toBeNull()
    expect(panel.textContent).not.toContain('http://')
  })

  it('lists the numbered console steps of Microsoft and the 90-day limit', async () => {
    const { t, user } = await open()
    await expand(user, t, 'microsoft')
    const panel = card(t, 'microsoft')
    const items = within(panel).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual(['app.oauth.microsoft.step1', 'app.oauth.microsoft.step2', 'app.oauth.microsoft.step3', 'app.oauth.microsoft.step4', 'app.oauth.microsoft.step5'].map((key) => t(key as MessageKey)))
    expect(within(panel).getByText(t('app.oauth.microsoft.limit'))).toBeTruthy()
    expect(t('app.oauth.microsoft.limit')).toContain('90 days')
    expect(t('app.oauth.microsoft.step4')).toContain('Files.ReadWrite')
    expect(t('app.oauth.microsoft.step4')).toContain('offline_access')
  })

  it('shows Microsoft the redirect address to register as a read-only block with a Copy button, and Google none', async () => {
    const { t, user } = await open()
    await expand(user, t, 'microsoft')
    await expand(user, t, 'google')
    const block = within(card(t, 'microsoft')).getByLabelText(t('app.oauth.redirect.label')) as HTMLInputElement
    expect(block.value).toBe('http://localhost/oauth/callback')
    expect(block.readOnly).toBe(true)
    expect(within(card(t, 'microsoft')).getByRole('button', { name: t('app.oauth.redirect.copyLabel') })).toBeTruthy()
    expect(within(card(t, 'microsoft')).getByText(t('app.oauth.redirect.note'))).toBeTruthy()
    expect(within(card(t, 'google')).queryByDisplayValue('http://localhost/oauth/callback')).toBeNull()
  })

  it('copies the address with the clipboard and says so in a status', async () => {
    const { t, user } = await open()
    await expand(user, t, 'microsoft')
    const writeText = stubClipboard(async () => undefined)
    await user.click(within(card(t, 'microsoft')).getByRole('button', { name: t('app.oauth.redirect.copyLabel') }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('http://localhost/oauth/callback')
    const status = await within(card(t, 'microsoft')).findByText(t('app.oauth.redirect.copied'))
    expect(status.getAttribute('role')).toBe('status')
  })

  it('falls back to selecting the address and copying it when the clipboard refuses, and then says it failed when that fails too', async () => {
    const { t, user } = await open()
    await expand(user, t, 'microsoft')
    stubClipboard(() => Promise.reject(new Error('denied')))
    const exec = vi.fn(() => true)
    document.execCommand = exec
    const copy = () => within(card(t, 'microsoft')).getByRole('button', { name: t('app.oauth.redirect.copyLabel') })
    await user.click(copy())
    expect(await within(card(t, 'microsoft')).findByText(t('app.oauth.redirect.copied'))).toBeTruthy()
    expect(exec).toHaveBeenCalledWith('copy')
    exec.mockReturnValue(false)
    await user.click(copy())
    expect((await within(card(t, 'microsoft')).findByRole('alert')).textContent).toBe(t('app.oauth.redirect.copyFailed'))
    expect(within(card(t, 'microsoft')).queryByText(t('app.oauth.redirect.copied'))).toBeNull()
  })

  it('says copying failed when there is no clipboard at all', async () => {
    const { t, user } = await open()
    await expand(user, t, 'microsoft')
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = undefined as never
    await user.click(within(card(t, 'microsoft')).getByRole('button', { name: t('app.oauth.redirect.copyLabel') }))
    expect((await within(card(t, 'microsoft')).findByRole('alert')).textContent).toBe(t('app.oauth.redirect.copyFailed'))
  })

  it('has the Client ID field with its hint for each provider, and the secret field for Google only', async () => {
    const { t, user } = await open()
    await expand(user, t, 'google')
    await expand(user, t, 'microsoft')
    for (const provider of ['google', 'microsoft'] as const) {
      const field = clientIdField(t, provider)
      expect(field.type).toBe('text')
      expect(field.getAttribute('autocomplete')).toBe('off')
      expect(field.getAttribute('spellcheck')).toBe('false')
      expect(document.getElementById(field.getAttribute('aria-describedby')!)!.textContent).toBe(t(`app.oauth.clientId.hint.${provider}`))
    }
    expect(within(card(t, 'microsoft')).queryByLabelText(t('app.oauth.secret.label'))).toBeNull()
    expect(secretField(t).type).toBe('password')
    expect(secretField(t).getAttribute('aria-required')).toBe('true')
    expect(t('app.oauth.secret.label')).not.toMatch(/optional|선택/i)
    expect(secretField(t).getAttribute('autocomplete')).toBe('off')
    expect(document.getElementById(secretField(t).getAttribute('aria-describedby')!)!.textContent).toBe(t('app.oauth.secret.hint'))
    expect(t('app.oauth.secret.hint')).toMatch(/never shown again/)
  })

  it('opens and closes with the toggle, which says what it controls', async () => {
    const { t, user } = await open({ init: { settings: settingsWith([googleSetUp, microsoftSetUp]) } })
    const control = toggle(t, 'google')
    expect(control.getAttribute('aria-expanded')).toBe('false')
    expect(control.getAttribute('aria-controls')).toBeNull()
    await user.click(control)
    expect(control.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(control.getAttribute('aria-controls')!)).toBeTruthy()
    expect(control.textContent).toBe(t('app.oauth.setup'))
    await user.click(control)
    expect(screen.queryByLabelText(t('app.oauth.clientId.google'))).toBeNull()
  })
})

describe('the account cards: saving the app', () => {
  it('keeps Save disabled until there is a Client ID', async () => {
    const { t, user } = await open()
    await expand(user, t, 'google')
    expect(saveButton(t, 'google').disabled).toBe(true)
    await user.type(clientIdField(t, 'google'), '   ')
    expect(saveButton(t, 'google').disabled).toBe(true)
    await user.type(clientIdField(t, 'google'), 'x')
    expect(saveButton(t, 'google').disabled).toBe(false)
  })

  it('sends a valid Google app once with the trimmed values, clears both fields and shows the saved app', async () => {
    const { t, user, host } = await open()
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await save(user, t, 'google', `  ${GOOGLE_ID}  `, `${SECRET}  `)
    expect(setApp).toHaveBeenCalledExactlyOnceWith({ provider: 'google', clientId: GOOGLE_ID, clientSecret: SECRET })
    expect(await within(card(t, 'google')).findByText(t('app.oauth.app.clientId', { clientId: GOOGLE_ID }))).toBeTruthy()
    expect(within(card(t, 'google')).getByText(t('app.oauth.app.secretSaved'))).toBeTruthy()
    expect(chip(t, 'google', 'not_connected')).toBeTruthy()
    const notice = within(card(t, 'google')).getByText(t('app.oauth.saved'))
    expect(notice.getAttribute('role')).toBe('status')
    expect(document.activeElement).toBe(notice)
    expect(connectButton(t, 'google').disabled).toBe(false)
    expect(toggle(t, 'google').getAttribute('aria-expanded')).toBe('false')
  })

  it('sends a Microsoft app with only its ID', async () => {
    const { t, user, host } = await open()
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await save(user, t, 'microsoft', MICROSOFT_ID)
    expect(setApp.mock.calls).toEqual([[{ provider: 'microsoft', clientId: MICROSOFT_ID }]])
  })

  it('refuses a Google app without a Client secret, says why, focuses the field and sends nothing until it is filled', async () => {
    const { t, user, host } = await open()
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await save(user, t, 'google', GOOGLE_ID)
    const alert = await within(card(t, 'google')).findByRole('alert')
    expect(alert.textContent).toBe(t('app.oauth.secret.required'))
    expect(document.activeElement).toBe(secretField(t))
    expect(secretField(t).getAttribute('aria-invalid')).toBe('true')
    expect(setApp).not.toHaveBeenCalled()
    expect(within(card(t, 'google')).queryByText(t('app.oauth.saved'))).toBeNull()
    await user.type(secretField(t), SECRET)
    expect(within(card(t, 'google')).queryByRole('alert')).toBeNull()
    expect(secretField(t).getAttribute('aria-invalid')).toBeNull()
    await user.click(saveButton(t, 'google'))
    expect(setApp).toHaveBeenCalledExactlyOnceWith({ provider: 'google', clientId: GOOGLE_ID, clientSecret: SECRET })
  })

  it('treats a Client secret of only blanks as missing', async () => {
    const { t, user, host } = await open()
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await save(user, t, 'google', GOOGLE_ID, '   ')
    expect((await within(card(t, 'google')).findByRole('alert')).textContent).toBe(t('app.oauth.secret.required'))
    expect(setApp).not.toHaveBeenCalled()
  })

  it('never lets the Client secret into the page: not in the text, not in an attribute, not in a field, not before and not after saving', async () => {
    const { t, user, host } = await open()
    const gate = deferred()
    vi.spyOn(host.oauth, 'setApp').mockImplementation(async () => {
      await gate.promise
      return {}
    })
    await expand(user, t, 'google')
    await user.type(clientIdField(t, 'google'), GOOGLE_ID)
    await user.type(secretField(t), SECRET)
    expect(secretField(t).type).toBe('password')
    expect(document.body.innerHTML).not.toContain('CLIENTSECRETMARKER')
    await user.click(saveButton(t, 'google'))
    expect(secretField(t).value).toBe('')
    expect(document.body.innerHTML).not.toContain('CLIENTSECRETMARKER')
    expect(document.body.textContent).not.toContain('CLIENTSECRETMARKER')
    gate.resolve()
    await within(card(t, 'google')).findByText(t('app.oauth.saved'))
    expect(document.body.innerHTML).not.toContain('CLIENTSECRETMARKER')
    expect(JSON.stringify(host.state())).not.toContain('CLIENTSECRETMARKER')
    expect([...document.querySelectorAll('input')].every((input) => !input.value.includes('CLIENTSECRETMARKER'))).toBe(true)
  })

  it('sends only once for a double submit', async () => {
    const { t, user, host } = await open()
    const gate = deferred()
    const setApp = vi.spyOn(host.oauth, 'setApp').mockImplementation(async () => {
      await gate.promise
      return {}
    })
    await expand(user, t, 'google')
    await user.type(clientIdField(t, 'google'), GOOGLE_ID)
    await user.type(secretField(t), SECRET)
    await user.click(saveButton(t, 'google'))
    await user.type(clientIdField(t, 'google'), '{Enter}').catch(() => undefined)
    await user.keyboard('{Enter}')
    expect(setApp).toHaveBeenCalledTimes(1)
    gate.resolve()
    await waitFor(() => expect(within(card(t, 'google')).getByText(t('app.oauth.saved'))).toBeTruthy())
    expect(setApp).toHaveBeenCalledTimes(1)
  })

  it('ignores a second submit that comes before the busy state is drawn, with no complaint about the emptied secret field', async () => {
    const { t, user, host } = await open()
    const gate = deferred()
    const setApp = vi.spyOn(host.oauth, 'setApp').mockImplementation(async () => {
      await gate.promise
      return {}
    })
    await expand(user, t, 'google')
    await user.type(clientIdField(t, 'google'), GOOGLE_ID)
    await user.type(secretField(t), SECRET)
    const form = clientIdField(t, 'google').closest('form')!
    act(() => {
      form.requestSubmit()
      form.requestSubmit()
    })
    expect(setApp).toHaveBeenCalledTimes(1)
    expect(within(card(t, 'google')).queryByRole('alert')).toBeNull()
    gate.resolve()
    await waitFor(() => expect(within(card(t, 'google')).getByText(t('app.oauth.saved'))).toBeTruthy())
  })

  it('refuses a Client ID of the wrong shape with a plain sentence, focuses the field and sends nothing', async () => {
    const { t, user, host } = await open()
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await expand(user, t, 'google')
    await expand(user, t, 'microsoft')
    await user.type(clientIdField(t, 'google'), MICROSOFT_ID)
    await user.click(saveButton(t, 'google'))
    expect((await within(card(t, 'google')).findByRole('alert')).textContent).toBe(t('app.oauth.clientId.invalid.google'))
    expect(clientIdField(t, 'google').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(clientIdField(t, 'google'))
    await user.type(clientIdField(t, 'microsoft'), GOOGLE_ID)
    await user.click(saveButton(t, 'microsoft'))
    expect((await within(card(t, 'microsoft')).findByRole('alert')).textContent).toBe(t('app.oauth.clientId.invalid.microsoft'))
    expect(setApp).not.toHaveBeenCalled()
    await user.type(clientIdField(t, 'google'), 'x')
    expect(within(card(t, 'google')).queryByRole('alert')).toBeNull()
  })

  it('refuses a Client secret with a space, focuses it and keeps the page clean of it', async () => {
    const { t, user, host } = await open()
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await expand(user, t, 'google')
    await user.type(clientIdField(t, 'google'), GOOGLE_ID)
    await user.type(secretField(t), 'CLIENTSECRETMARKER with space')
    await user.click(saveButton(t, 'google'))
    expect((await within(card(t, 'google')).findByRole('alert')).textContent).toBe(t('app.oauth.secret.invalid'))
    expect(document.activeElement).toBe(secretField(t))
    expect(document.body.textContent).not.toContain('CLIENTSECRETMARKER')
    expect(setApp).not.toHaveBeenCalled()
  })

  it('warns that a new app disconnects a connected account, and then does', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected', account: 'someone@example.com' }, microsoftSetUp]) } })
    await expand(user, t, 'google')
    expect(within(card(t, 'google')).getByText(t('app.oauth.replaceNote'))).toBeTruthy()
    await user.type(clientIdField(t, 'google'), '987654321098-zyxwvutsrqponm.apps.googleusercontent.com')
    await user.type(secretField(t), SECRET)
    await user.click(saveButton(t, 'google'))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.not_connected'))).toBeTruthy()
    expect(host.state().settings.oauth.accounts[0]).toEqual({ provider: 'google', status: 'not_connected' })
    expect(within(card(t, 'google')).queryByText(t('app.oauth.replaceNote'))).toBeNull()
  })

  it('does not mix the two cards: saving Google leaves Microsoft untouched', async () => {
    const { t, user } = await open()
    await save(user, t, 'google', GOOGLE_ID, SECRET)
    expect(chip(t, 'microsoft', 'not_configured')).toBeTruthy()
    expect(within(card(t, 'microsoft')).queryByText(t('app.oauth.saved'))).toBeNull()
  })
})

describe('the account cards: removing the app, disconnecting', () => {
  it('shows Remove only for an app that is set up, asks first, and leaves everything when cancelled', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([googleSetUp]) } })
    await expand(user, t, 'microsoft')
    expect(within(card(t, 'microsoft')).queryByRole('button', { name: t('app.oauth.removeLabel', { provider: 'Microsoft' }) })).toBeNull()
    await expand(user, t, 'google')
    const clear = vi.spyOn(host.oauth, 'clearApp')
    await user.click(button(card(t, 'google'), t('app.oauth.removeLabel', { provider: 'Google' })))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(t('app.oauth.removeConfirm', { provider: 'Google' }))).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: t('app.common.cancel') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(clear).not.toHaveBeenCalled()
    expect(chip(t, 'google', 'not_connected')).toBeTruthy()
  })

  it('removes the app after the confirmation and shows Not set up, with the Set up part open again', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected', account: 'someone@example.com' }]) } })
    await expand(user, t, 'google')
    await user.click(button(card(t, 'google'), t('app.oauth.removeLabel', { provider: 'Google' })))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.oauth.removeAction') }))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.not_configured'))).toBeTruthy()
    expect(within(card(t, 'google')).getByText(t('app.oauth.didRemove', { provider: 'Google' }))).toBeTruthy()
    expect(host.state().settings.oauth.apps[0]).toEqual({ provider: 'google', hasSecret: false })
    expect(toggle(t, 'google').getAttribute('aria-expanded')).toBe('true')
    expect(connectButton(t, 'google').disabled).toBe(true)
  })

  it('asks before it disconnects, tells each provider what that means, and disconnects on confirmation', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected', account: 'someone@example.com' }, { ...microsoftSetUp, status: 'connected', account: 'Alex' }]) } })
    const disconnect = vi.spyOn(host.oauth, 'disconnect')
    await user.click(button(card(t, 'microsoft'), t('app.oauth.disconnectLabel', { provider: 'Microsoft' })))
    let dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(t('app.oauth.disconnectTitle', { provider: 'Microsoft' }))).toBeTruthy()
    expect(within(dialog).getByText(t('app.oauth.disconnectConfirm.microsoft'))).toBeTruthy()
    expect(t('app.oauth.disconnectConfirm.microsoft')).toMatch(/Microsoft account page/)
    await user.click(within(dialog).getByRole('button', { name: t('app.common.cancel') }))
    expect(disconnect).not.toHaveBeenCalled()
    await user.click(button(card(t, 'google'), t('app.oauth.disconnectLabel', { provider: 'Google' })))
    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(t('app.oauth.disconnectConfirm.google'))).toBeTruthy()
    expect(t('app.oauth.disconnectConfirm.google')).toMatch(/revoke/)
    await user.click(within(dialog).getByRole('button', { name: t('app.oauth.disconnectAction') }))
    expect(await within(card(t, 'google')).findByText(t('app.oauth.status.not_connected'))).toBeTruthy()
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('google')
    expect(within(card(t, 'google')).getByText(t('app.oauth.didDisconnect', { provider: 'Google' }))).toBeTruthy()
    expect(within(card(t, 'microsoft')).getByText(t('app.oauth.status.connectedAs', { account: 'Alex' }))).toBeTruthy()
  })
})

describe('the account cards: no keychain', () => {
  it('disables every input and button, says why, and sends nothing', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([googleSetUp, { ...microsoftSetUp, status: 'connected' }], { encryptionAvailable: false }) } })
    const noKeychain = screen.getAllByText(t('app.oauth.noKeychain'))
    expect(noKeychain).toHaveLength(2)
    await expand(user, t, 'google')
    for (const control of [connectButton(t, 'google'), saveButton(t, 'google'), clientIdField(t, 'google'), secretField(t), button(card(t, 'google'), t('app.oauth.removeLabel', { provider: 'Google' })), button(card(t, 'microsoft'), t('app.oauth.disconnectLabel', { provider: 'Microsoft' }))]) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(true)
    }
    const setApp = vi.spyOn(host.oauth, 'setApp')
    await user.click(connectButton(t, 'google')).catch(() => undefined)
    expect(setApp).not.toHaveBeenCalled()
  })
})

describe('the account cards: text from the provider', () => {
  it('shows an account name as plain text, makes the invisible characters visible and cuts it short', async () => {
    const hostile = `<img src=x onerror="alert(1)"><b>bold</b> ‮evil${'x'.repeat(300)}`
    const { t, view } = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected', account: hostile }]) } })
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('b')).toBeNull()
    const chipNode = within(card(t, 'google')).getByText(/^Connected as /)
    expect(chipNode.textContent).toContain('<img src=x')
    expect(chipNode.textContent).toContain('‹U+202E›')
    expect(chipNode.textContent!.endsWith('…')).toBe(true)
    expect(chipNode.textContent!.length).toBeLessThan(120)
  })

  it('shows a Client ID from the host as plain text and cut short too', async () => {
    const { t, view } = await open({ init: { settings: settingsWith([{ provider: 'google', status: 'not_connected', clientId: `<script>x</script>${'1'.repeat(300)}` }]) } })
    expect(view.container.querySelector('script')).toBeNull()
    expect(within(card(t, 'google')).getByText(/^Client ID: <script>/).textContent!.endsWith('…')).toBe(true)
  })

  it('shows the account text of the notice as text too', async () => {
    const { t, user, host } = await open({ init: { settings: settingsWith([googleSetUp]) } })
    vi.spyOn(host.oauth, 'connect').mockResolvedValue({ account: '<i>name</i>' })
    await user.click(connectButton(t, 'google'))
    const notice = await within(card(t, 'google')).findByText(t('app.oauth.didConnectAs', { account: '<i>name</i>' }))
    expect(notice.querySelector('i')).toBeNull()
  })
})

describe('the account cards: names that belong to them', () => {
  it('refuses the names google and microsoft for a custom connection, with a sentence that explains it', async () => {
    const { t, user } = await open()
    const region = screen.getByRole('region', { name: t('app.connections.custom.heading') })
    const name = within(region).getByLabelText(t('app.connections.name'))
    await user.type(name, 'Google')
    await user.click(within(region).getByRole('button', { name: t('app.connections.custom.save') }))
    expect((await within(region).findByRole('alert')).textContent).toBe(t('app.connections.nameReserved'))
  })

  it('refuses them for a Slack connection too', async () => {
    const { t, user } = await open()
    const region = screen.getByRole('region', { name: t('app.connections.provider.slack') })
    await user.type(within(region).getByLabelText(t('app.slackBot.name')), 'microsoft')
    await user.type(within(region).getByLabelText(t('app.slackBot.token')), 'xoxb-0123456789-abcdef')
    await user.click(within(region).getByRole('button', { name: t('app.slackBot.save') }))
    expect((await within(region).findByRole('alert')).textContent).toBe(t('app.connections.nameReserved'))
  })
})

describe('the settings hook and the change events', () => {
  const base = fakeSettings()

  it('replaces the row of the provider and adds one that is missing, and leaves the rest', () => {
    const settings = { ...base, oauth: { available: true, accounts: [{ provider: 'google' as const, status: 'connected' as const, account: 'a' }], apps: [] } }
    expect(withOAuthChange(settings, { provider: 'google', status: 'needs_reconnect', account: 'a' }).oauth.accounts).toEqual([{ provider: 'google', status: 'needs_reconnect', account: 'a' }])
    expect(withOAuthChange(settings, { provider: 'microsoft', status: 'connecting' }).oauth.accounts).toEqual([{ provider: 'google', status: 'connected', account: 'a' }, { provider: 'microsoft', status: 'connecting' }])
    expect(withOAuthChange(settings, { provider: 'microsoft', status: 'connecting' }).allowedFolders).toBe(settings.allowedFolders)
  })
})

describe('the account cards: languages and accessibility', () => {
  const STATES: Array<[string, Row[], FakeHostOptions['oauthFlows']?]> = [
    ['not set up', []],
    ['set up', [googleSetUp, microsoftSetUp]],
    ['connected', [{ ...googleSetUp, status: 'connected', account: 'someone@example.com' }, { ...microsoftSetUp, status: 'connected', account: 'Alex' }]],
    ['reconnect needed', [{ ...googleSetUp, status: 'needs_reconnect' }, { ...microsoftSetUp, status: 'needs_reconnect' }]],
  ]

  it.each(['ko', 'en'] as const)('renders every state in %s without a missing key', async (locale) => {
    for (const [, rows] of STATES) {
      const { view, user, t } = await open({ locale, init: { settings: settingsWith(rows) } })
      await expand(user, t, 'google')
      await expand(user, t, 'microsoft')
      expect(document.body.textContent).not.toMatch(/\bapp\.(oauth|error|connections)\./)
      view.unmount()
    }
  })

  it('has the Korean and English texts of the sign-in in step with each other', async () => {
    const ko = createTranslator('ko')
    const en = createTranslator('en')
    for (const key of ['app.oauth.status.connectedAs', 'app.oauth.didConnectAs', 'app.oauth.app.clientId', 'app.oauth.disconnectTitle'] as const) {
      expect(ko(key, { account: 'A', clientId: 'A', provider: 'A' })).toContain('A')
      expect(en(key, { account: 'A', clientId: 'A', provider: 'A' })).toContain('A')
    }
  })

  it.each([
    ['not set up', []],
    ['set up', [googleSetUp, microsoftSetUp]],
    ['connected', [{ ...googleSetUp, status: 'connected' as const, account: 'someone@example.com' }, microsoftSetUp]],
    ['reconnect needed', [{ ...googleSetUp, status: 'needs_reconnect' as const }, microsoftSetUp]],
  ] satisfies Array<[string, Row[]]>)('has no accessibility violations when %s, light English and Korean', async (_name, rows) => {
    for (const locale of ['en', 'ko'] as const) {
      const { view, user, t } = await open({ locale, init: { settings: settingsWith(rows) } })
      await expand(user, t, 'google')
      await expand(user, t, 'microsoft')
      expect(await violations(view.container)).toEqual([])
      view.unmount()
    }
  })

  it('has no accessibility violations while waiting, with an error, and with a confirmation open', async () => {
    const waiting = await open({ init: { settings: settingsWith([googleSetUp]) }, hostOptions: { oauthFlows: { google: 'waiting' } } })
    await waiting.user.click(connectButton(waiting.t, 'google'))
    await within(card(waiting.t, 'google')).findByText(waiting.t('app.oauth.waiting'))
    expect(await violations(waiting.view.container)).toEqual([])
    await waiting.user.click(button(card(waiting.t, 'google'), waiting.t('app.oauth.cancelLabel', { provider: 'Google' })))
    waiting.view.unmount()
    const failing = await open({ init: { settings: settingsWith([googleSetUp]) }, hostOptions: { oauthFlows: { google: 'denied' } } })
    await failing.user.click(connectButton(failing.t, 'google'))
    await within(card(failing.t, 'google')).findByRole('alert')
    expect(await violations(failing.view.container)).toEqual([])
    failing.view.unmount()
    const confirming = await open({ init: { settings: settingsWith([{ ...googleSetUp, status: 'connected' }]) } })
    await confirming.user.click(button(card(confirming.t, 'google'), confirming.t('app.oauth.disconnectLabel', { provider: 'Google' })))
    expect(await violations(confirming.view.container)).toEqual([])
  })
})
