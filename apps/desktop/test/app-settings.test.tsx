import type { MethodName, MethodResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withHostModels } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { SettingsScreen } from '../src/app/settings/SettingsScreen'
import type { SettingsSectionId } from '../src/app/settings/types'
import { useSettings } from '../src/app/settings/useSettings'
import type { ConnectionState } from '../src/app/connection'
import type { EngineClient } from '../src/engine/client'
import { createFakeHost, fakeSettings, type FakeHost, type FakeHostState } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import { HostError, MAX_FOLDERS } from '../src/shared/host-api'
import { renderThemed } from './render'
import { violations } from './axe'

const MARKER = 'settings-secret-MARKER-0123456789'

function baseClient(): EngineClient {
  return {
    request: async <M extends MethodName>(method: M): Promise<MethodResult<M>> => {
      throw new Error(`unexpected ${method}`)
    },
    onEvent: () => () => undefined,
  }
}

interface Options {
  host?: FakeHost
  init?: Partial<FakeHostState>
  section?: SettingsSectionId
  locale?: Locale
  client?: EngineClient | undefined
  connection?: Pick<ConnectionState, 'state' | 'status'>
  onSection?: (section: SettingsSectionId) => void
}

function Harness({ host, client, connection, section, onSection }: Required<Pick<Options, 'host'>> & Omit<Options, 'host'>) {
  const state = useSettings(host)
  const [current, setCurrent] = useState(section)
  return (
    <SettingsScreen
      state={state}
      client={client}
      connection={connection ?? { state: 'connected', status: { state: 'running', restarts: 0 } }}
      section={current}
      onSectionChange={(next) => {
        setCurrent(next)
        onSection?.(next)
      }}
    />
  )
}

function show(options: Options = {}) {
  const host = options.host ?? createFakeHost(options.init ?? {}, { restartDelayMs: 0 })
  const client = 'client' in options ? options.client : withHostModels(baseClient(), host)
  const view = renderThemed(
    <HostProvider host={host}>
      <Harness host={host} client={client} connection={options.connection} section={options.section} onSection={options.onSection} />
    </HostProvider>,
    { locale: options.locale ?? 'ko' },
  )
  const t = createTranslator(options.locale ?? 'ko')
  return { host, view, t, user: userEvent.setup() }
}

async function ready(t: ReturnType<typeof createTranslator>): Promise<void> {
  await screen.findByRole('navigation', { name: t('app.settings.nav') })
}

afterEach(() => vi.restoreAllMocks())

describe('SettingsScreen shell', () => {
  it('shows a loading state, then the sections, and moves between them', async () => {
    const { t, user } = show()
    expect(screen.getByText(t('app.settings.loading'))).toBeTruthy()
    await ready(t)
    const nav = screen.getByRole('navigation', { name: t('app.settings.nav') })
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['폴더', '모델', 'API 키', '연결', '일반'])
    expect(within(nav).getByRole('button', { name: '폴더' }).getAttribute('aria-current')).toBe('page')
    await user.click(within(nav).getByRole('button', { name: 'API 키' }))
    expect(within(nav).getByRole('button', { name: 'API 키' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { name: 'API 키', level: 2 })).toBeTruthy()
  })

  it('opens the section it is given and moves focus to its heading', async () => {
    const { t } = show({ section: 'connections' })
    await ready(t)
    const heading = screen.getByRole('heading', { name: t('app.settings.section.connections'), level: 2 })
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('reports the section that was chosen', async () => {
    const onSection = vi.fn()
    const { t, user } = show({ onSection })
    await ready(t)
    await user.click(screen.getByRole('button', { name: '일반' }))
    expect(onSection).toHaveBeenCalledWith('general')
  })

  it('says so when the settings cannot be loaded and offers a retry', async () => {
    const host = createFakeHost()
    const get = vi.spyOn(host.settings, 'get').mockRejectedValueOnce(new HostError('INTERNAL'))
    const { t, user } = show({ host })
    expect(await screen.findByText(t('app.settings.loadError'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('app.settings.retry') }))
    await ready(t)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('has no axe violations in the folders section', async () => {
    const { view, t } = show({ init: { settings: fakeSettings({ allowedFolders: ['/Users/demo/Receipts'] }) } })
    await ready(t)
    expect(await violations(view.container)).toEqual([])
  })
})

describe('FoldersSection', () => {
  it('explains the empty state: without a folder only attachments can be read', async () => {
    const { t } = show()
    await ready(t)
    expect(screen.getByText(t('app.folders.empty'))).toBeTruthy()
  })

  it('adds a folder through the dialog only, and sends the whole list once', async () => {
    const { host, t, user } = show({ init: { folderPicks: ['/Users/demo/Receipts'] } })
    await ready(t)
    const update = vi.spyOn(host.settings, 'update')
    await user.click(screen.getByRole('button', { name: t('app.folders.add') }))
    expect(await screen.findByText('/Users/demo/Receipts')).toBeTruthy()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ allowedFolders: ['/Users/demo/Receipts'] })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(t('app.folders.restartNote'))).toBeTruthy()
  })

  it('does nothing when the dialog is cancelled', async () => {
    const { host, t, user } = show({ init: { folderPicks: [undefined] } })
    await ready(t)
    const update = vi.spyOn(host.settings, 'update')
    await user.click(screen.getByRole('button', { name: t('app.folders.add') }))
    await waitFor(() => expect((screen.getByRole('button', { name: t('app.folders.add') }) as HTMLButtonElement).disabled).toBe(false))
    expect(update).not.toHaveBeenCalled()
    expect(screen.getByText(t('app.folders.empty'))).toBeTruthy()
  })

  it('says a folder is already added and does not send it again', async () => {
    const { host, t, user } = show({ init: { settings: fakeSettings({ allowedFolders: ['/Users/demo/Receipts'] }), folderPicks: ['/Users/demo/Receipts'] } })
    await ready(t)
    const update = vi.spyOn(host.settings, 'update')
    await user.click(screen.getByRole('button', { name: t('app.folders.add') }))
    expect(await screen.findByText(t('app.folders.exists'))).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it('removes a folder with a button that names it', async () => {
    const { host, t, user } = show({ init: { settings: fakeSettings({ allowedFolders: ['/a', '/b'] }) } })
    await ready(t)
    await user.click(screen.getByRole('button', { name: t('app.folders.removeLabel', { path: '/a' }) }))
    await waitFor(() => expect(screen.queryByText('/a')).toBeNull())
    expect(host.state().settings.allowedFolders).toEqual(['/b'])
  })

  it('stops at the folder limit and says so', async () => {
    const folders = Array.from({ length: MAX_FOLDERS }, (_, index) => `/f${index}`)
    const { t } = show({ init: { settings: fakeSettings({ allowedFolders: folders }) } })
    await ready(t)
    expect((screen.getByRole('button', { name: t('app.folders.add') }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(t('app.folders.limit', { max: MAX_FOLDERS }))).toBeTruthy()
  })

  it('shows a fixed text when the host refuses the folder, never the text of the error', async () => {
    const host = createFakeHost({ folderPicks: ['/x'] })
    vi.spyOn(host.settings, 'update').mockRejectedValue(new HostError('INVALID_SETTINGS'))
    const { t, user } = show({ host })
    await ready(t)
    await user.click(screen.getByRole('button', { name: t('app.folders.add') }))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.INVALID_SETTINGS'))
  })

  it('shows folder names with invisible characters made visible', async () => {
    const { t } = show({ init: { settings: fakeSettings({ allowedFolders: ['/Users/demo/‮evil'] }) } })
    await ready(t)
    expect(screen.getByText(/‹U\+202E›/)).toBeTruthy()
  })
})

describe('ModelSection', () => {
  async function openModel(options: Options = {}) {
    const shown = show({ ...options, section: 'model', init: { settings: fakeSettings({ configuredProviders: ['anthropic', 'openai'] }), ...options.init } })
    await ready(shown.t)
    return shown
  }

  it('lists the models of the engine, with the providers that have no key disabled and marked', async () => {
    const { t } = await openModel()
    expect(await screen.findByText('Claude Opus 5.5')).toBeTruthy()
    expect(screen.getAllByText(t('chat.model.keyNeeded')).length).toBeGreaterThan(0)
    const gemini = screen.getByRole('group', { name: /Gemini/ })
    expect(within(gemini).getAllByRole('button')[0]!.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(t('app.model.active', { model: 'Claude Opus 5.5' }))).toBeTruthy()
  })

  it('shows the data note of the provider and names what is sent', async () => {
    const { t } = await openModel()
    await screen.findByText('Claude Opus 5.5')
    expect(screen.getAllByText(/Your content is sent to the Anthropic API/).length).toBeGreaterThan(0)
    const notice = screen.getByRole('note', { name: t('app.model.transfer.heading') })
    expect(within(notice).getByText(t('badge.externalTransfer'))).toBeTruthy()
    expect(notice.textContent).toContain(t('app.model.transfer.body'))
    for (const word of ['요청한 글', '첨부한 파일', '메모', '실패한 실행']) expect(notice.textContent).toContain(word)
  })

  it('names the same four things in English', async () => {
    const { t } = await openModel({ locale: 'en' })
    const notice = await screen.findByRole('note', { name: t('app.model.transfer.heading') })
    for (const word of ['request text', 'files you attach', 'saved notes', 'failed run']) expect(notice.textContent).toContain(word)
  })

  it('calls settings.update once with provider and model when a model is chosen, and shows restarting', async () => {
    const { host, t, user } = await openModel()
    await screen.findByText('Claude Opus 5.5')
    const update = vi.spyOn(host.settings, 'update')
    await user.click(screen.getByRole('button', { name: /GPT-6.1 Sol/ }))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-6.1-sol' })
    expect(host.state().settings.model).toBe('gpt-6.1-sol')
    expect(host.state().restartCalls).toBe(1)
    void t
  })

  it('shows the restarting text while the engine restarts', async () => {
    const { t } = await openModel({ connection: { state: 'reconnecting', status: { state: 'restarting', restarts: 1 } } })
    expect(await screen.findByText(t('app.model.restarting'))).toBeTruthy()
  })

  it('does not select a provider without a key', async () => {
    const { host, t, user } = await openModel()
    await screen.findByText('Claude Opus 5.5')
    const update = vi.spyOn(host.settings, 'update')
    await user.click(screen.getByRole('button', { name: /Gemini 3 Pro/ }))
    expect(update).not.toHaveBeenCalled()
    void t
  })

  it('says no model is available when nothing is configured, and leads to the keys section', async () => {
    const { t, user } = show({ section: 'model' })
    await ready(t)
    expect(await screen.findByText(t('app.model.noneActive'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('app.model.goKeys') }))
    expect(screen.getByRole('heading', { name: 'API 키', level: 2 })).toBeTruthy()
  })

  it('waits for the engine when there is no client, and says so when the list fails', async () => {
    const waiting = show({ section: 'model', client: undefined })
    await ready(waiting.t)
    expect(screen.getByText(waiting.t('app.model.notConnected'))).toBeTruthy()
    waiting.view.unmount()
    const failing: EngineClient = { request: async () => { throw new Error('no') }, onEvent: () => () => undefined }
    const failed = show({ section: 'model', client: failing })
    await ready(failed.t)
    expect(await screen.findByText(failed.t('app.model.loadError'))).toBeTruthy()
  })
})

describe('KeysSection', () => {
  async function openKeys(options: Options = {}) {
    const shown = show({ ...options, section: 'keys' })
    await ready(shown.t)
    return shown
  }

  it('has one row per provider, a password field and save and remove buttons', async () => {
    const { t } = await openKeys()
    const fields = [...document.querySelectorAll('input')]
    expect(fields).toHaveLength(5)
    for (const field of fields) expect(field.type).toBe('password')
    expect(screen.getAllByRole('button', { name: t('app.keys.save') })).toHaveLength(5)
    expect(screen.getAllByRole('button', { name: t('app.keys.remove') })).toHaveLength(5)
  })

  it('saves a key once, clears the field, and shows only that it is configured', async () => {
    const { host, t, user } = await openKeys()
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const field = screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })) as HTMLInputElement
    await user.type(field, MARKER)
    await user.click(within(field.closest('form')!).getByRole('button', { name: t('app.keys.save') }))
    expect(await screen.findByText(t('app.keys.saved'))).toBeTruthy()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('anthropic', MARKER)
    expect(field.value).toBe('')
    expect(within(field.closest('li')!).getByText(t('app.keys.configured'))).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('MARKER')
    expect(host.state().settings.configuredProviders).toEqual(['anthropic'])
  })

  it('saves with Enter, and the save button stays off while the field is empty', async () => {
    const { host, t, user } = await openKeys()
    const row = screen.getByLabelText(t('app.keys.input', { provider: 'OpenAI' })).closest('form')!
    expect((within(row).getByRole('button', { name: t('app.keys.save') }) as HTMLButtonElement).disabled).toBe(true)
    await user.type(within(row).getByLabelText(t('app.keys.input', { provider: 'OpenAI' })), `${MARKER}{Enter}`)
    await screen.findByText(t('app.keys.saved'))
    expect(host.state().settings.configuredProviders).toEqual(['openai'])
  })

  it('removes a key', async () => {
    const { host, t, user } = await openKeys({ init: { settings: fakeSettings({ configuredProviders: ['openai'] }) } })
    const row = screen.getByLabelText(t('app.keys.input', { provider: 'OpenAI' })).closest('form')!
    await user.click(within(row).getByRole('button', { name: t('app.keys.remove') }))
    expect(await screen.findByText(t('app.keys.removed'))).toBeTruthy()
    expect(host.state().settings.configuredProviders).toEqual([])
  })

  it('maps errors to fixed texts, no_keychain with its own explanation, and never shows the key', async () => {
    const host = createFakeHost()
    vi.spyOn(host.secrets, 'setProviderKey').mockRejectedValue(new HostError('NO_KEYCHAIN'))
    const { t, user } = await openKeys({ host })
    const field = screen.getByLabelText(t('app.keys.input', { provider: 'Gemini' })) as HTMLInputElement
    await user.type(field, `${MARKER}{Enter}`)
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.NO_KEYCHAIN'))
    expect(document.body.innerHTML).not.toContain('MARKER')
    expect(field.value).toBe('')
  })

  it('maps another error to another fixed text', async () => {
    const host = createFakeHost()
    vi.spyOn(host.secrets, 'setProviderKey').mockRejectedValue(new Error(`boom ${MARKER}`))
    const { t, user } = await openKeys({ host })
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Meta' })), `${MARKER}{Enter}`)
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.INTERNAL'))
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('disables the forms and shows the banner when encryption is unavailable', async () => {
    const { t } = await openKeys({ init: { settings: fakeSettings({ encryptionAvailable: false }) } })
    expect(screen.getByRole('alert').textContent).toContain(t('app.settings.noKeychain.title'))
    for (const field of document.querySelectorAll('input')) expect(field.disabled).toBe(true)
    for (const button of screen.getAllByRole('button', { name: t('app.keys.save') })) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps a secret out of the page text after a whole session with errors', async () => {
    const host = createFakeHost()
    const { t, user } = await openKeys({ host })
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })), `${MARKER}{Enter}`)
    await screen.findByText(t('app.keys.saved'))
    expect(document.body.textContent).not.toContain('MARKER')
    expect(document.body.innerHTML).not.toContain('MARKER')
    expect([...document.querySelectorAll('input')].every((input) => !input.value.includes('MARKER'))).toBe(true)
  })
})

describe('ConnectionsSection', () => {
  async function openConnections(options: Options = {}) {
    const shown = show({ ...options, section: 'connections' })
    await ready(shown.t)
    return shown
  }

  async function add(user: ReturnType<typeof userEvent.setup>, t: ReturnType<typeof createTranslator>, name: string, secret: string, kind?: string) {
    await user.type(screen.getByLabelText(t('app.connections.name')), name)
    if (kind !== undefined) await user.selectOptions(screen.getByLabelText(t('app.connections.kind')), kind)
    await user.type(screen.getByLabelText(t('app.connections.secret')), secret)
    await user.click(screen.getByRole('button', { name: t('app.connections.add') }))
  }

  it('adds a connection with a name, a kind and a password field, and lists name and kind only', async () => {
    const { host, t, user } = await openConnections()
    expect(screen.getByText(t('app.connections.empty'))).toBeTruthy()
    expect((screen.getByLabelText(t('app.connections.secret')) as HTMLInputElement).type).toBe('password')
    await add(user, t, 'team-alerts', `https://hooks.slack.com/${MARKER}`)
    expect(await screen.findByText(t('app.connections.added'))).toBeTruthy()
    const list = screen.getByRole('list')
    expect(within(list).getByText('team-alerts')).toBeTruthy()
    expect(within(list).getByText(t('app.connections.kind.slack'))).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('MARKER')
    expect((screen.getByLabelText(t('app.connections.secret')) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(t('app.connections.name')) as HTMLInputElement).value).toBe('')
    expect(host.state().settings.connections).toEqual([{ name: 'team-alerts', kind: 'slack' }])
  })

  it('offers slack, http and webhookSecret', async () => {
    const { t } = await openConnections()
    const kinds = within(screen.getByLabelText(t('app.connections.kind'))).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(kinds).toEqual(['slack', 'http', 'webhookSecret'])
  })

  it('refuses a duplicate name, also when it differs only in case, without calling the host', async () => {
    const { host, t, user } = await openConnections({ init: { settings: fakeSettings({ connections: [{ name: 'Team-Alerts', kind: 'slack' }] }) } })
    const set = vi.spyOn(host.secrets, 'setConnection')
    await add(user, t, 'team-alerts', 'https://hooks.slack.com/x')
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.duplicate'))
    expect(set).not.toHaveBeenCalled()
    expect((screen.getByLabelText(t('app.connections.secret')) as HTMLInputElement).value).toBe('https://hooks.slack.com/x')
  })

  it('gives a hint for a slack secret that is not a URL, and still allows saving it', async () => {
    const { host, t, user } = await openConnections()
    await user.type(screen.getByLabelText(t('app.connections.name')), 'ops')
    await user.type(screen.getByLabelText(t('app.connections.secret')), 'not a url')
    expect(screen.getByText(t('app.connections.slackHint'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('app.connections.add') }))
    await screen.findByText(t('app.connections.added'))
    expect(host.state().settings.connections).toEqual([{ name: 'ops', kind: 'slack' }])
    expect(screen.queryByText(t('app.connections.slackHint'))).toBeNull()
  })

  it('shows no hint for a URL or for another kind', async () => {
    const { t, user } = await openConnections()
    await user.type(screen.getByLabelText(t('app.connections.secret')), 'https://hooks.slack.com/services/x')
    expect(screen.queryByText(t('app.connections.slackHint'))).toBeNull()
    await user.clear(screen.getByLabelText(t('app.connections.secret')))
    await user.selectOptions(screen.getByLabelText(t('app.connections.kind')), 'http')
    await user.type(screen.getByLabelText(t('app.connections.secret')), 'plain')
    expect(screen.queryByText(t('app.connections.slackHint'))).toBeNull()
  })

  it('refuses a name with a control character or no name', async () => {
    const { host, t, user } = await openConnections()
    const set = vi.spyOn(host.secrets, 'setConnection')
    await user.type(screen.getByLabelText(t('app.connections.name')), 'a')
    fireEvent.change(screen.getByLabelText(t('app.connections.name')), { target: { value: 'bad\u0007name' } })
    await user.type(screen.getByLabelText(t('app.connections.secret')), 'https://x.example')
    await user.click(screen.getByRole('button', { name: t('app.connections.add') }))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.connections.nameInvalid'))
    expect(set).not.toHaveBeenCalled()
  })

  it('removes a connection only after a confirmation that names it, and returns focus to the button', async () => {
    const { host, t, user } = await openConnections({ init: { settings: fakeSettings({ connections: [{ name: 'ops', kind: 'http' }] }) } })
    const trigger = screen.getByRole('button', { name: t('app.connections.removeLabel', { name: 'ops' }) })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: t('app.connections.removeTitle') })
    expect(dialog.textContent).toContain(t('app.connections.removeConfirm', { name: 'ops' }))
    expect(host.state().settings.connections).toHaveLength(1)
    await user.click(within(dialog).getByRole('button', { name: t('app.common.cancel') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.state().settings.connections).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    await user.click(trigger)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.connections.removeAction') }))
    await waitFor(() => expect(host.state().settings.connections).toEqual([]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('maps a name collision from the host to its fixed text', async () => {
    const host = createFakeHost()
    vi.spyOn(host.secrets, 'setConnection').mockRejectedValue(new HostError('NAME_COLLISION'))
    const { t, user } = await openConnections({ host })
    await add(user, t, 'x', 'https://x.example')
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.NAME_COLLISION'))
    expect(document.body.innerHTML).not.toContain('x.example/MARKER')
  })

  it('disables the form when encryption is unavailable', async () => {
    const { t } = await openConnections({ init: { settings: fakeSettings({ encryptionAvailable: false }) } })
    expect((screen.getByLabelText(t('app.connections.name')) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(t('app.connections.secret')) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: t('app.connections.add') }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('GeneralSection', () => {
  async function openGeneral(options: Options = {}) {
    const shown = show({ ...options, section: 'general' })
    await ready(shown.t)
    return shown
  }

  it('toggles open at login through settings.update', async () => {
    const { host, t, user } = await openGeneral()
    const box = screen.getByRole('checkbox', { name: t('app.general.openAtLogin') }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await user.click(box)
    await waitFor(() => expect((screen.getByRole('checkbox', { name: t('app.general.openAtLogin') }) as HTMLInputElement).checked).toBe(true))
    expect(host.state().settings.openAtLogin).toBe(true)
  })

  it('shows the engine status and restarts the engine on request', async () => {
    const { host, t, user } = await openGeneral({ connection: { state: 'connected', status: { state: 'running', restarts: 2 } } })
    expect(screen.getByText(t('app.engine.state.running'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('app.general.restart') }))
    expect(host.state().restartCalls).toBe(1)
  })

  it('shows the reason when the engine is stopped, and the note about the data folder', async () => {
    const { t } = await openGeneral({ connection: { state: 'engine_stopped', status: { state: 'stopped', error: 'crashed', restarts: 6 } } })
    expect(screen.getByText(t('app.engine.state.stopped'))).toBeTruthy()
    expect(screen.getByText(t('app.engine.error.crashed'))).toBeTruthy()
    expect(screen.getByText(t('app.general.dataNote'))).toBeTruthy()
  })
})

describe('settings in English', () => {
  it('renders every section in English without a missing key', async () => {
    const { t, user } = show({ locale: 'en' })
    await ready(t)
    for (const id of ['folders', 'model', 'keys', 'connections', 'general'] as const) {
      await user.click(screen.getByRole('button', { name: t(`app.settings.section.${id}`) }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(document.body.textContent).not.toMatch(/\bapp\.[a-z]+\./)
    }
  })
})
