import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostProvider } from '../src/app/host'
import { SettingsScreen } from '../src/app/settings/SettingsScreen'
import { useSettings } from '../src/app/settings/useSettings'
import { createFakeHost, fakeSettings, type FakeHost, type FakeHostState } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import { HostError, type AuthType } from '../src/shared/host-api'
import { violations } from './axe'
import { renderThemed } from './render'

const MARKER = 'CONN-SECRET-MARKER'
const CONNECTED = { state: 'connected', status: { state: 'running', restarts: 0 } } as const
const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const ONLINE = { available: true, accounts: [], apps: [{ provider: 'google' as const, clientId: GOOGLE_ID, hasSecret: false }] }

interface Options {
  init?: Partial<FakeHostState>
  host?: FakeHost
  locale?: Locale
}

function Harness({ host }: { host: FakeHost }) {
  const state = useSettings(host)
  return <SettingsScreen state={state} client={undefined} connection={CONNECTED} section="connections" />
}

async function open(options: Options = {}) {
  const host = options.host ?? createFakeHost(options.init ?? {}, { restartDelayMs: 0 })
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

const region = (t: T, key: 'accounts' | 'custom' | 'other') => screen.getByRole('region', { name: t(`app.connections.${key}.heading`) })
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement
const typeSelect = (t: T) => screen.getByLabelText(t('app.connections.custom.authType')) as HTMLSelectElement
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const providerCard = (t: T, provider: 'google' | 'microsoft') => screen.getByText(t(`app.connections.provider.${provider}`), { selector: 'strong' }).closest('li') as HTMLElement

function labelsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('label')].map((label) => (label.firstChild?.textContent ?? '').trim())
}

function passwordInputs(t: T): HTMLInputElement[] {
  return [...region(t, 'custom').querySelectorAll<HTMLInputElement>('input[type="password"]')]
}

async function pick(user: User, t: T, type: AuthType) {
  await user.selectOptions(typeSelect(t), type)
}

function nothingSecretShown(extra: unknown = ''): void {
  expect(document.body.innerHTML).not.toContain(MARKER)
  expect(document.body.textContent).not.toContain(MARKER)
  expect([...document.querySelectorAll('input, textarea, select')].every((item) => !(item as HTMLInputElement).value.includes(MARKER))).toBe(true)
  expect(JSON.stringify(extra)).not.toContain(MARKER)
}

afterEach(() => vi.restoreAllMocks())

describe('layout', () => {
  it('has one title, an intro, an Accounts part and a Custom connection part, and no Other part', async () => {
    const { t } = await open()
    expect(screen.getAllByRole('heading', { name: t('app.settings.section.connections') })).toHaveLength(1)
    expect(screen.getByRole('region', { name: t('app.settings.section.connections') })).toBeTruthy()
    expect(screen.getByText(t('app.connections.intro'))).toBeTruthy()
    expect(screen.getByRole('heading', { name: t('app.connections.accounts.heading'), level: 3 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: t('app.connections.custom.heading'), level: 3 })).toBeTruthy()
    expect(screen.queryByText(t('app.connections.other.heading'))).toBeNull()
  })

  it('shows two account cards, Google and Microsoft, each with a status chip', async () => {
    const { t } = await open()
    const cards = within(region(t, 'accounts')).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    for (const provider of ['google', 'microsoft'] as const) {
      expect(within(providerCard(t, provider)).getByText(t('app.connections.account.notConnected'))).toBeTruthy()
    }
    expect(screen.queryByText(t('app.connections.kind.slack' as never))).toBeNull()
  })

  it('no longer offers the three engine kinds as a choice', async () => {
    const { t } = await open()
    for (const word of ['webhookSecret', 'Webhook signing secret']) expect(screen.queryByText(word)).toBeNull()
    const options = within(typeSelect(t)).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(options).toEqual(['none', 'apiKey', 'bearer', 'basic'])
  })
})

describe('accounts', () => {
  it('disables every Connect button and says why, while sign-in is not available', async () => {
    const { t, host } = await open({ init: { settings: fakeSettings({ encryptionAvailable: false }) } })
    const note = screen.getByText(t('app.connections.accounts.unavailable'))
    for (const provider of ['google', 'microsoft'] as const) {
      const connect = within(providerCard(t, provider)).getByRole('button', { name: t('app.connections.account.connectLabel', { provider: t(`app.connections.provider.${provider}`) }) }) as HTMLButtonElement
      expect(connect.disabled).toBe(true)
      expect(connect.getAttribute('aria-describedby')).toBe(note.id)
    }
    expect(host.state().settings.oauth.accounts.map((entry) => entry.status)).toEqual(['not_configured', 'not_configured'])
  })

  it('connects and disconnects when sign-in is available, showing who is connected', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ oauth: ONLINE }) } })
    expect(screen.queryByText(t('app.connections.accounts.unavailable'))).toBeNull()
    await user.click(button(t('app.connections.account.connectLabel', { provider: 'Google' })))
    expect(await within(providerCard(t, 'google')).findByText(t('app.connections.account.connectedAs', { account: 'someone@example.com' }))).toBeTruthy()
    expect((await screen.findByRole('status')).textContent).toBe(t('app.connections.account.didConnect', { provider: 'Google' }))
    expect(host.state().settings.oauth.accounts.filter((entry) => entry.status === 'connected').map((entry) => entry.provider)).toEqual(['google'])
    expect(within(providerCard(t, 'microsoft')).getByText(t('app.connections.account.notConnected'))).toBeTruthy()
    await user.click(button(t('app.connections.account.disconnectLabel', { provider: 'Google' })))
    expect(await within(providerCard(t, 'google')).findByText(t('app.connections.account.notConnected'))).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(t('app.connections.account.didDisconnect', { provider: 'Google' }))
    expect(host.state().settings.oauth.accounts.map((entry) => entry.status)).toEqual(['not_connected', 'not_configured'])
  })

  it('shows a connected provider without an account name as just Connected', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ oauth: { available: true, accounts: [{ provider: 'microsoft', status: 'connected' }], apps: [] } }) } })
    expect(within(providerCard(t, 'microsoft')).getByText(t('app.connections.account.connected'))).toBeTruthy()
  })

  it('shows a failed connect as an alert with the fixed text', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ oauth: ONLINE }) } })
    vi.spyOn(host.oauth, 'connect').mockRejectedValue(new HostError('OAUTH_UNAVAILABLE'))
    await user.click(button(t('app.connections.account.connectLabel', { provider: 'Microsoft' })))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.OAUTH_UNAVAILABLE'))
  })

  it('disables Connect without a keychain, even when sign-in is available', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ oauth: ONLINE, encryptionAvailable: false }) } })
    expect(button(t('app.connections.account.connectLabel', { provider: 'Google' })).disabled).toBe(true)
  })
})

describe('the custom connection form', () => {
  it('starts as No Auth with a note and no credential field', async () => {
    const { t } = await open()
    expect(typeSelect(t).value).toBe('none')
    expect(screen.getByText(t('app.connections.custom.noneNote'))).toBeTruthy()
    expect(passwordInputs(t)).toEqual([])
    expect(labelsOf(region(t, 'custom'))).toEqual([t('app.connections.name'), t('app.connections.custom.authType')])
  })

  it('offers the fields of each auth type and only those', async () => {
    const { t, user } = await open()
    const base = [t('app.connections.name'), t('app.connections.custom.authType')]
    await pick(user, t, 'apiKey')
    expect(labelsOf(region(t, 'custom'))).toEqual([...base, t('app.connections.custom.keyName'), t('app.connections.custom.keyValue'), t('app.connections.custom.keyIn')])
    expect(field(t('app.connections.custom.keyName')).type).toBe('text')
    expect(field(t('app.connections.custom.keyValue')).type).toBe('password')
    const where = screen.getByLabelText(t('app.connections.custom.keyIn')) as HTMLSelectElement
    expect(within(where).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['header', 'query'])
    expect(where.value).toBe('header')
    await pick(user, t, 'bearer')
    expect(labelsOf(region(t, 'custom'))).toEqual([...base, t('app.connections.custom.token')])
    expect(field(t('app.connections.custom.token')).type).toBe('password')
    await pick(user, t, 'basic')
    expect(labelsOf(region(t, 'custom'))).toEqual([...base, t('app.connections.custom.username'), t('app.connections.custom.password')])
    expect(field(t('app.connections.custom.username')).type).toBe('text')
    expect(field(t('app.connections.custom.password')).type).toBe('password')
    await pick(user, t, 'none')
    expect(labelsOf(region(t, 'custom'))).toEqual(base)
  })

  it('names the types as the users know them', async () => {
    const { t } = await open()
    const text = within(typeSelect(t)).getAllByRole('option').map((option) => option.textContent)
    expect(text).toEqual(['No Auth', 'API Key', 'Bearer Token', 'Basic Auth'])
  })

  it('clears every secret field when the type changes, also when it comes back to the same type', async () => {
    const { t, user } = await open()
    await pick(user, t, 'basic')
    await user.type(field(t('app.connections.custom.username')), 'someone')
    await user.type(field(t('app.connections.custom.password')), MARKER)
    await pick(user, t, 'bearer')
    expect(passwordInputs(t).map((item) => item.value)).toEqual([''])
    await user.type(field(t('app.connections.custom.token')), MARKER)
    await pick(user, t, 'apiKey')
    await user.type(field(t('app.connections.custom.keyValue')), MARKER)
    await pick(user, t, 'basic')
    expect(passwordInputs(t).map((item) => item.value)).toEqual([''])
    expect(field(t('app.connections.custom.username')).value).toBe('')
    await pick(user, t, 'bearer')
    expect(field(t('app.connections.custom.token')).value).toBe('')
    nothingSecretShown()
  })

  it('keeps the name when the type changes', async () => {
    const { t, user } = await open()
    await user.type(field(t('app.connections.name')), 'my-api')
    await pick(user, t, 'bearer')
    expect(field(t('app.connections.name')).value).toBe('my-api')
  })

  it('blocks Save with a hint, focus on the first empty field, and calls nothing', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setCustomConnection')
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.custom.missing'))
    expect(document.activeElement).toBe(field(t('app.connections.name')))
    await user.type(field(t('app.connections.name')), 'my-api')
    await pick(user, t, 'apiKey')
    await user.type(field(t('app.connections.custom.keyValue')), MARKER)
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.custom.missing'))
    expect(document.activeElement).toBe(field(t('app.connections.custom.keyName')))
    expect(field(t('app.connections.custom.keyValue')).value).toBe(MARKER)
    await pick(user, t, 'bearer')
    await user.click(button(t('app.connections.custom.save')))
    expect(document.activeElement).toBe(field(t('app.connections.custom.token')))
    await pick(user, t, 'basic')
    await user.click(button(t('app.connections.custom.save')))
    expect(document.activeElement).toBe(field(t('app.connections.custom.username')))
    expect(set).not.toHaveBeenCalled()
  })

  it('blocks a key name or a username the engine would refuse, with a hint and focus on the field', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setCustomConnection')
    await user.type(field(t('app.connections.name')), 'my-api')
    await pick(user, t, 'apiKey')
    await user.type(field(t('app.connections.custom.keyName')), 'bad name')
    await user.type(field(t('app.connections.custom.keyValue')), 'v')
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.custom.invalid'))
    expect(document.activeElement).toBe(field(t('app.connections.custom.keyName')))
    await user.clear(field(t('app.connections.custom.keyName')))
    await user.type(field(t('app.connections.custom.keyName')), 'Host')
    await user.click(button(t('app.connections.custom.save')))
    expect(screen.getByRole('alert').textContent).toBe(t('app.connections.custom.invalid'))
    await pick(user, t, 'basic')
    await user.type(field(t('app.connections.custom.username')), 'a:b')
    await user.click(button(t('app.connections.custom.save')))
    expect(screen.getByRole('alert').textContent).toBe(t('app.connections.custom.invalid'))
    expect(document.activeElement).toBe(field(t('app.connections.custom.username')))
    expect(set).not.toHaveBeenCalled()
  })

  const CASES: Array<{ label: string; type: AuthType; fill(user: User, t: T): Promise<void>; auth: unknown }> = [
    { label: 'No Auth', type: 'none', fill: async () => undefined, auth: { type: 'none' } },
    {
      label: 'an API key in a header',
      type: 'apiKey',
      fill: async (user, t) => {
        await user.type(field(t('app.connections.custom.keyName')), 'X-Api-Key')
        await user.type(field(t('app.connections.custom.keyValue')), MARKER)
      },
      auth: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: MARKER },
    },
    {
      label: 'an API key in the query',
      type: 'apiKey',
      fill: async (user, t) => {
        await user.type(field(t('app.connections.custom.keyName')), 'api_key')
        await user.type(field(t('app.connections.custom.keyValue')), MARKER)
        await user.selectOptions(screen.getByLabelText(t('app.connections.custom.keyIn')), 'query')
      },
      auth: { type: 'apiKey', in: 'query', name: 'api_key', value: MARKER },
    },
    {
      label: 'a bearer token',
      type: 'bearer',
      fill: async (user, t) => {
        await user.type(field(t('app.connections.custom.token')), MARKER)
      },
      auth: { type: 'bearer', token: MARKER },
    },
    {
      label: 'a basic login',
      type: 'basic',
      fill: async (user, t) => {
        await user.type(field(t('app.connections.custom.username')), 'someone')
        await user.type(field(t('app.connections.custom.password')), MARKER)
      },
      auth: { type: 'basic', username: 'someone', password: MARKER },
    },
    {
      label: 'a basic login with an empty password',
      type: 'basic',
      fill: async (user, t) => {
        await user.type(field(t('app.connections.custom.username')), 'someone')
      },
      auth: { type: 'basic', username: 'someone', password: '' },
    },
  ]

  it.each(CASES)('saves $label once with the right object, then clears and shows no secret', async ({ type, fill, auth }) => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setCustomConnection')
    await user.type(field(t('app.connections.name')), 'My API')
    await pick(user, t, type)
    await fill(user, t)
    await user.click(button(t('app.connections.custom.save')))
    expect(set).toHaveBeenCalledExactlyOnceWith({ name: 'My API', auth })
    expect((await screen.findByRole('status')).textContent).toBe(t('app.connections.custom.didSave'))
    expect(field(t('app.connections.name')).value).toBe('')
    expect(passwordInputs(t).every((item) => item.value === '')).toBe(true)
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="text"]')].every((item) => item.value === '')).toBe(true)
    nothingSecretShown(host.state())
    expect(host.state().settings.connections).toEqual([{ name: 'My API', kind: 'http', authType: type }])
    const list = screen.getByRole('list', { name: t('app.connections.custom.listTitle') })
    expect(within(list).getByText('My API')).toBeTruthy()
    expect(within(list).getByText(t(`app.connections.custom.type.${type}`))).toBeTruthy()
    expect(list.textContent).toBe(`My API${t(`app.connections.custom.type.${type}`)}${t('app.connections.remove')}`)
  })

  it('sends once when the form is submitted twice in a row', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setCustomConnection').mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 30)))
    await user.type(field(t('app.connections.name')), 'My API')
    await pick(user, t, 'bearer')
    await user.type(field(t('app.connections.custom.token')), MARKER)
    const form = button(t('app.connections.custom.save')).closest('form')!
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitFor(() => expect(button(t('app.connections.custom.save')).disabled).toBe(false))
    expect(set).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses a name that any connection already uses, in any case, and keeps what was typed', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'Team', kind: 'slack' }] }) } })
    const set = vi.spyOn(host.secrets, 'setCustomConnection')
    await user.type(field(t('app.connections.name')), 'team')
    await pick(user, t, 'bearer')
    await user.type(field(t('app.connections.custom.token')), 'abc')
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.duplicate'))
    expect(set).not.toHaveBeenCalled()
    expect(field(t('app.connections.custom.token')).value).toBe('abc')
    expect(document.activeElement).toBe(field(t('app.connections.name')))
  })

  it('refuses a name with a control character, and an over-long one cannot be typed', async () => {
    const { t, user, host } = await open()
    const set = vi.spyOn(host.secrets, 'setCustomConnection')
    fireEvent.change(field(t('app.connections.name')), { target: { value: 'bad\u0007name' } })
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.nameInvalid'))
    expect(set).not.toHaveBeenCalled()
    expect(field(t('app.connections.name')).maxLength).toBe(64)
  })

  it('maps a collision reported by the host to its fixed text and still forgets the secret', async () => {
    const { t, user, host } = await open()
    vi.spyOn(host.secrets, 'setCustomConnection').mockRejectedValue(new HostError('NAME_COLLISION'))
    await user.type(field(t('app.connections.name')), 'x')
    await pick(user, t, 'bearer')
    await user.type(field(t('app.connections.custom.token')), MARKER)
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.NAME_COLLISION'))
    expect(field(t('app.connections.custom.token')).value).toBe('')
    nothingSecretShown()
  })

  it('still says saved when the settings cannot be read again right after saving', async () => {
    const { t, user, host } = await open()
    vi.spyOn(host.settings, 'get').mockRejectedValue(new HostError('ENGINE_UNAVAILABLE'))
    await user.type(field(t('app.connections.name')), 'My API')
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('status')).textContent).toBe(t('app.connections.custom.didSave'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lists custom connections by name and type chip only, plain HTTP secrets included', async () => {
    const { t, user, host } = await open({
      init: { settings: fakeSettings({ connections: [{ name: 'billing-api', kind: 'http', authType: 'apiKey' }, { name: 'older', kind: 'http' }, { name: 'team', kind: 'slack' }] }) },
    })
    const list = screen.getByRole('list', { name: t('app.connections.custom.listTitle') })
    const rows = within(list).getAllByRole('listitem').map((row) => row.textContent)
    expect(rows).toEqual([`billing-api${t('app.connections.custom.type.apiKey')}${t('app.connections.remove')}`, `older${t('app.connections.custom.legacy')}${t('app.connections.remove')}`])
    await user.click(within(list).getByRole('button', { name: t('app.connections.removeLabel', { name: 'older' }) }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.connections.removeAction') }))
    await waitFor(() => expect(host.state().settings.connections.map((entry) => entry.name)).toEqual(['billing-api', 'team']))
  })

  it('says so when there is no custom connection yet', async () => {
    const { t } = await open()
    expect(screen.getByText(t('app.connections.custom.none'))).toBeTruthy()
  })

  it('disables the whole form without a keychain', async () => {
    const { t } = await open({ init: { settings: fakeSettings({ encryptionAvailable: false }) } })
    expect(field(t('app.connections.name')).disabled).toBe(true)
    expect(typeSelect(t).disabled).toBe(true)
    expect(button(t('app.connections.custom.save')).disabled).toBe(true)
  })

  it('shows the 200 connections limit and disables the forms', async () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ name: `c${index}`, kind: 'http' as const, authType: 'none' as const }))
    const { t } = await open({ init: { settings: fakeSettings({ connections: many }) } })
    expect(screen.getByText(t('app.connections.limit'))).toBeTruthy()
    expect(button(t('app.connections.custom.save')).disabled).toBe(true)
  })
})

describe('Other saved secrets', () => {
  it('appears only when a webhook signing secret exists, with a Remove button and no way to add one', async () => {
    const { t, user, host } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'shop-hook', kind: 'webhookSecret' }, { name: 'api', kind: 'http', authType: 'bearer' }] }) } })
    const other = region(t, 'other')
    expect(within(other).getByText(t('app.connections.other.note'))).toBeTruthy()
    expect(within(other).getByText('shop-hook')).toBeTruthy()
    expect(within(other).getByText(t('app.connections.other.webhookSecret'))).toBeTruthy()
    expect(within(other).queryByText('api')).toBeNull()
    expect(within(other).queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getAllByRole('list', { name: t('app.connections.custom.listTitle') })[0]!.textContent).not.toContain('shop-hook')
    await user.click(within(other).getByRole('button', { name: t('app.connections.removeLabel', { name: 'shop-hook' }) }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.connections.removeAction') }))
    await waitFor(() => expect(host.state().settings.connections.map((entry) => entry.name)).toEqual(['api']))
    await waitFor(() => expect(screen.queryByText(t('app.connections.other.heading'))).toBeNull())
  })
})

describe('accessibility and languages', () => {
  it('has no axe violations in the default view and with each auth type chosen', async () => {
    const { t, user, view } = await open({ init: { settings: fakeSettings({ connections: [{ name: 'billing-api', kind: 'http', authType: 'basic' }, { name: 'team', kind: 'slack' }, { name: 'shop-hook', kind: 'webhookSecret' }], oauth: { available: true, accounts: [{ provider: 'google', status: 'connected', account: 'a@b.example' }], apps: [] } }) } })
    expect(await violations(view.container)).toEqual([])
    for (const type of ['apiKey', 'bearer', 'basic'] as const) {
      await pick(user, t, type)
      expect(await violations(view.container)).toEqual([])
    }
  })

  it.each(['ko', 'en'] as const)('renders every part in %s without a missing key', async (locale) => {
    const { t, user } = await open({ locale, init: { settings: fakeSettings({ connections: [{ name: 'shop-hook', kind: 'webhookSecret' }] }) } })
    for (const type of ['apiKey', 'bearer', 'basic', 'none'] as const) await pick(user, t, type)
    await user.click(button(t('app.connections.custom.save')))
    expect(document.body.textContent).not.toMatch(/\bapp\.[a-z]+\./)
    expect(screen.getByRole('heading', { name: t('app.connections.accounts.heading') })).toBeTruthy()
    expect(screen.getByRole('heading', { name: t('app.connections.custom.heading') })).toBeTruthy()
  })
})

describe('switching the auth type', () => {
  it('drops the message about the previous type', async () => {
    const { t, user } = await open()
    await user.type(field(t('app.connections.name')), 'my-api')
    await pick(user, t, 'apiKey')
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.custom.missing'))
    await pick(user, t, 'bearer')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops the saved note', async () => {
    const { t, user } = await open()
    await user.type(field(t('app.connections.name')), 'my-api')
    await user.click(button(t('app.connections.custom.save')))
    expect((await screen.findByRole('status')).textContent).toBe(t('app.connections.custom.didSave'))
    await pick(user, t, 'bearer')
    expect(screen.queryByRole('status')).toBeNull()
  })
})
