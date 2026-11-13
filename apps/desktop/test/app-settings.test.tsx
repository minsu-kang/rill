import type { MethodName, MethodResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withHostModels } from '../src/app/fake-world'
import { withHostConfigured } from '../src/app/glue/host-models'
import { HostProvider } from '../src/app/host'
import { KEY_MASK } from '../src/app/settings/KeysSection'
import { SettingsScreen } from '../src/app/settings/SettingsScreen'
import type { SettingsSectionId } from '../src/app/settings/types'
import { useSettings } from '../src/app/settings/useSettings'
import type { ConnectionState } from '../src/app/connection'
import type { EngineClient } from '../src/engine/client'
import { createFakeHost, fakeSettings, type FakeHost, type FakeHostState } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import { HostError, KEY_INVALID_REASONS, KEY_UNVERIFIED_REASONS, MAX_FOLDERS, type KeyVerdict } from '../src/shared/host-api'
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
  const client = 'client' in options ? options.client : withHostConfigured(withHostModels(baseClient(), host), host.state().settings.configuredProviders)
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

  it('shows the same fixed mask in the field of every provider that has a key and none in the others, never the key', async () => {
    await openKeys({ init: { settings: fakeSettings({ configuredProviders: ['anthropic', 'gemini'] }) } })
    const fields = [...document.querySelectorAll('input')]
    expect(fields.map((field) => field.placeholder)).toEqual([KEY_MASK, '', KEY_MASK, '', ''])
    for (const field of fields) expect(field.value).toBe('')
    expect(KEY_MASK).toBe('\u2022'.repeat(16))
  })

  it('shows the mask after a key was saved and takes it away after the key was removed', async () => {
    const { host, t, user } = await openKeys()
    const field = () => document.querySelectorAll('input')[0] as HTMLInputElement
    expect(field().placeholder).toBe('')
    await user.type(field(), 'KEY-MASK-MARKER-12345')
    await user.click(screen.getAllByRole('button', { name: t('app.keys.save') })[0]!)
    await waitFor(() => expect(field().placeholder).toBe(KEY_MASK))
    expect(host.state().settings.configuredProviders).toContain('anthropic')
    expect(document.body.innerHTML).not.toContain('KEY-MASK-MARKER-12345')
    await user.click(screen.getAllByRole('button', { name: t('app.keys.remove') })[0]!)
    await waitFor(() => expect(field().placeholder).toBe(''))
  })

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

  it('still says saved when the settings cannot be read again right after the key was stored', async () => {
    const { host, t, user } = await openKeys()
    vi.spyOn(host.settings, 'get').mockRejectedValue(new HostError('ENGINE_UNAVAILABLE'))
    const field = screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })) as HTMLInputElement
    await user.type(field, MARKER)
    await user.click(within(field.closest('form')!).getByRole('button', { name: t('app.keys.save') }))
    expect(await screen.findByText(t('app.keys.saved'))).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(host.state().settings.configuredProviders).toEqual(['anthropic'])
  })

  it('sends the key without the white space around it', async () => {
    const { host, t, user } = await openKeys()
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })), `  ${MARKER}  {Enter}`)
    await screen.findByText(t('app.keys.saved'))
    expect(save).toHaveBeenCalledWith('anthropic', MARKER)
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

describe('KeysSection with a host that answers the old way', () => {
  it('treats an answer without a verdict as saved but not confirmed instead of showing an unknown error', async () => {
    const host = createFakeHost({}, { restartDelayMs: 0 })
    const old = { ...host, secrets: { ...host.secrets, setProviderKey: async (provider: never, value: string) => { await host.secrets.setProviderKey(provider, value); return undefined as never } } }
    const { t, user } = show({ host: old as never, section: 'keys' })
    await ready(t)
    await user.type(document.querySelectorAll('input')[0] as HTMLInputElement, 'OLD-HOST-KEY-0123456789')
    await user.click(screen.getAllByRole('button', { name: t('app.keys.save') })[0]!)
    await waitFor(() => expect(document.querySelectorAll('input')[0]!.getAttribute('placeholder')).toBe(KEY_MASK))
    expect(screen.queryByText(t('app.error.host.INTERNAL'))).toBeNull()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })
})

describe('KeysSection key check', () => {
  const INVALID: KeyVerdict = { status: 'invalid', reason: 'unauthorized' }

  function hostWith(keyChecks: (provider: string, key: string) => KeyVerdict | Promise<KeyVerdict>, init: Partial<FakeHostState> = {}) {
    return createFakeHost(init, { restartDelayMs: 0, keyChecks: keyChecks as never })
  }

  async function open(host: FakeHost, locale: Locale = 'ko') {
    const shown = show({ host, section: 'keys', locale })
    await ready(shown.t)
    return shown
  }

  function rowOf(t: ReturnType<typeof createTranslator>, provider = 'Anthropic') {
    const field = screen.getByLabelText(t('app.keys.input', { provider })) as HTMLInputElement
    return { field, row: field.closest('li')!, form: field.closest('form')! }
  }

  async function submit(user: ReturnType<typeof userEvent.setup>, t: ReturnType<typeof createTranslator>, value = MARKER, provider = 'Anthropic') {
    const { field } = rowOf(t, provider)
    await user.type(field, `${value}{Enter}`)
  }

  it('says once, next to the fields, that saving asks the provider with a model-list request', async () => {
    const { host, t } = await open(createFakeHost())
    expect(screen.getAllByText(t('app.keys.checkNote'))).toHaveLength(1)
    const noteId = screen.getByText(t('app.keys.checkNote')).id
    expect(noteId).not.toBe('')
    for (const field of document.querySelectorAll('input')) expect(field.getAttribute('aria-describedby')).toBe(noteId)
    expect(host.state().settings.configuredProviders).toEqual([])
  })

  it('shows that it is checking, keeps the row off while it runs, and sends a double submit once', async () => {
    let release: (verdict: KeyVerdict) => void = () => undefined
    const host = hostWith(() => new Promise<KeyVerdict>((resolve) => (release = resolve)))
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user } = await open(host)
    const { field, row, form } = rowOf(t)
    await user.type(field, MARKER)
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(within(row).getByRole('status').textContent).toBe(t('app.keys.checking'))
    expect(field.disabled).toBe(true)
    expect((within(form).getByRole('button', { name: t('app.keys.save') }) as HTMLButtonElement).disabled).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('')
    await act(async () => release({ status: 'valid' }))
    expect(await within(row).findByText(t('app.keys.saved'))).toBeTruthy()
    expect(within(row).queryByText(t('app.keys.checking'))).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('says the provider accepts a valid key, clears the field and moves focus to the result in a live region', async () => {
    const { host, t, user } = await open(hostWith(() => ({ status: 'valid' })))
    await submit(user, t)
    const { row, field } = rowOf(t)
    const result = await within(row).findByText(t('app.keys.saved'))
    expect(result.getAttribute('role')).toBe('status')
    await waitFor(() => expect(document.activeElement).toBe(result))
    expect(field.value).toBe('')
    expect(host.state().settings.configuredProviders).toEqual(['anthropic'])
    expect(within(row).getByText(t('app.keys.configured'))).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it.each(KEY_UNVERIFIED_REASONS)('saves the key and says in plain words that it could not be confirmed: %s', async (reason) => {
    const { host, t, user } = await open(hostWith(() => ({ status: 'unverified', reason })))
    await submit(user, t)
    const { row, field } = rowOf(t)
    const text = t('app.keys.unverified', { reason: t(`app.keys.reason.${reason}`) })
    const result = await within(row).findByText(text)
    expect(result.getAttribute('role')).toBe('status')
    expect(text).not.toContain('app.keys')
    await waitFor(() => expect(document.activeElement).toBe(result))
    expect(field.value).toBe('')
    expect(host.state().settings.configuredProviders).toEqual(['anthropic'])
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('refuses a key the provider rejects: nothing is saved, the notice offers save anyway and close, and the key is not on the page', async () => {
    const host = hostWith(() => INVALID)
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user } = await open(host)
    await submit(user, t)
    const { row, field } = rowOf(t)
    const notice = await within(row).findByRole('alert')
    expect(notice.textContent).toContain(t('app.error.host.KEY_INVALID'))
    expect(within(notice).getAllByRole('button').map((button) => button.textContent)).toEqual([t('app.keys.saveAnyway'), t('app.common.close')])
    await waitFor(() => expect(document.activeElement).toBe(notice))
    expect(host.state().settings.configuredProviders).toEqual([])
    expect(host.state().restartCalls).toBe(0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('')
    expect(document.body.innerHTML).not.toContain('MARKER')
    expect(document.body.textContent).not.toContain('MARKER')
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) expect(element.getAttribute(attribute), attribute).not.toContain('MARKER')
    }
    expect([...document.querySelectorAll('input')].every((input) => input.value === '')).toBe(true)
  })

  it('sends saveAnyway once with the same key, and says it was saved as it is', async () => {
    const host = hostWith(() => INVALID)
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user } = await open(host)
    await submit(user, t)
    const { row } = rowOf(t)
    const button = within(await within(row).findByRole('alert')).getByRole('button', { name: t('app.keys.saveAnyway') })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(await within(row).findByText(t('app.keys.savedAnyway', { reason: t('app.keys.reason.unauthorized') }))).toBeTruthy()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(1, 'anthropic', MARKER)
    expect(save).toHaveBeenNthCalledWith(2, 'anthropic', MARKER, { saveAnyway: true })
    expect(host.state().settings.configuredProviders).toEqual(['anthropic'])
    expect(within(row).queryByRole('alert')).toBeNull()
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('forgets the key when the notice is closed, so nothing can send it later', async () => {
    const host = hostWith(() => INVALID)
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user } = await open(host)
    await submit(user, t)
    const { row, field } = rowOf(t)
    await user.click(within(await within(row).findByRole('alert')).getByRole('button', { name: t('app.common.close') }))
    expect(within(row).queryByRole('alert')).toBeNull()
    expect(within(row).queryByRole('button', { name: t('app.keys.saveAnyway') })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(save).toHaveBeenCalledTimes(1)
    expect(host.state().settings.configuredProviders).toEqual([])
  })

  it('forgets the key when the field is edited, and a later refusal holds only the new key', async () => {
    const host = hostWith(() => INVALID)
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user } = await open(host)
    await submit(user, t, `${MARKER}-first`)
    const { row, field } = rowOf(t)
    await within(row).findByRole('alert')
    await user.type(field, 'x')
    expect(within(row).queryByRole('alert')).toBeNull()
    await user.clear(field)
    await submit(user, t, `${MARKER}-second`)
    await user.click(within(await within(row).findByRole('alert')).getByRole('button', { name: t('app.keys.saveAnyway') }))
    await within(row).findByText(t('app.keys.savedAnyway', { reason: t('app.keys.reason.unauthorized') }))
    expect(save).toHaveBeenLastCalledWith('anthropic', `${MARKER}-second`, { saveAnyway: true })
    expect(save.mock.calls.filter((call) => call[1] === `${MARKER}-first`)).toHaveLength(1)
  })

  it('forgets the key when remove is pressed, and leaves nothing on the page after unmount', async () => {
    const host = hostWith(() => INVALID, { settings: fakeSettings({ configuredProviders: ['anthropic'] }) })
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user, view } = await open(host)
    await submit(user, t)
    const { row } = rowOf(t)
    await within(row).findByRole('alert')
    await user.click(within(row).getByRole('button', { name: t('app.keys.remove') }))
    expect(await within(row).findByText(t('app.keys.removed'))).toBeTruthy()
    expect(within(row).queryByRole('button', { name: t('app.keys.saveAnyway') })).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('shows the existing fixed text for any other failure, and goes back to the idle state', async () => {
    const host = hostWith(() => ({ status: 'valid' }))
    vi.spyOn(host.secrets, 'setProviderKey').mockRejectedValue(new HostError('ENGINE_UNAVAILABLE'))
    const { t, user } = await open(host)
    await submit(user, t)
    const { row, field } = rowOf(t)
    expect((await within(row).findByRole('alert')).textContent).toBe(t('app.error.host.ENGINE_UNAVAILABLE'))
    expect(within(row).queryByText(t('app.keys.checking'))).toBeNull()
    expect(within(row).queryByRole('button', { name: t('app.keys.saveAnyway') })).toBeNull()
    expect(field.disabled).toBe(false)
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('shows the fixed text, and no second chance, when save anyway then fails', async () => {
    const host = hostWith(() => INVALID)
    const { t, user } = await open(host)
    await submit(user, t)
    const { row } = rowOf(t)
    const alert = await within(row).findByRole('alert')
    vi.spyOn(host.secrets, 'setProviderKey').mockRejectedValue(new HostError('NO_KEYCHAIN'))
    await user.click(within(alert).getByRole('button', { name: t('app.keys.saveAnyway') }))
    await waitFor(() => expect(within(row).getByRole('alert').textContent).toBe(t('app.error.host.NO_KEYCHAIN')))
    expect(within(row).queryByRole('button', { name: t('app.keys.saveAnyway') })).toBeNull()
  })

  it('keeps the other rows alone while one row is checked', async () => {
    let release: (verdict: KeyVerdict) => void = () => undefined
    const host = hostWith(() => new Promise<KeyVerdict>((resolve) => (release = resolve)))
    const { t, user } = await open(host)
    await submit(user, t)
    const other = rowOf(t, 'OpenAI')
    expect(other.field.disabled).toBe(false)
    expect(within(other.row).queryByRole('status')).toBeNull()
    await act(async () => release({ status: 'valid' }))
    await screen.findByText(t('app.keys.saved'))
  })

  it('refuses a key that cannot be an API key with its own text before anything is saved, and offers no save anyway', async () => {
    const host = hostWith(() => ({ status: 'invalid', reason: 'malformed' }))
    const save = vi.spyOn(host.secrets, 'setProviderKey')
    const { t, user } = await open(host)
    await submit(user, t, `${MARKER}\u200bX`)
    const { row, field } = rowOf(t)
    const notice = await within(row).findByRole('alert')
    expect(notice.textContent).toBe(t('app.error.host.KEY_MALFORMED'))
    expect(notice.textContent).not.toBe(t('app.error.host.KEY_INVALID'))
    expect(within(row).queryByRole('button', { name: t('app.keys.saveAnyway') })).toBeNull()
    expect(host.state().settings.configuredProviders).toEqual([])
    expect(save).toHaveBeenCalledTimes(1)
    expect(field.disabled).toBe(false)
    expect(field.value).toBe('')
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('says in plain words when a newer change to the same key replaced this one', async () => {
    const host = hostWith(() => ({ status: 'valid' }))
    vi.spyOn(host.secrets, 'setProviderKey').mockRejectedValue(new HostError('SUPERSEDED'))
    const { t, user } = await open(host)
    await submit(user, t)
    const { row } = rowOf(t)
    expect((await within(row).findByRole('alert')).textContent).toBe(t('app.error.host.SUPERSEDED'))
    expect(within(row).queryByRole('button', { name: t('app.keys.saveAnyway') })).toBeNull()
    expect(document.body.innerHTML).not.toContain('MARKER')
  })

  it('tells the user in both languages that the key is sent once to the provider, and nowhere else', () => {
    const en = createTranslator('en')('app.keys.checkNote')
    const ko = createTranslator('ko')('app.keys.checkNote')
    expect(en).toContain('the key is sent once')
    expect(en).toContain("provider's own API")
    expect(en).toContain('nowhere else')
    expect(ko).toContain('키를 한 번')
    expect(ko).toContain('제공사')
    expect(ko).toContain('다른 곳에는 보내지 않아요')
  })

  it('has fixed texts for the new refusal codes in both languages', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = createTranslator(locale)
      for (const key of ['app.error.host.KEY_MALFORMED', 'app.error.host.SUPERSEDED'] as const) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
        expect(t(key).length, `${locale} ${key}`).toBeGreaterThan(20)
      }
    }
  })

  it('has texts for every verdict reason in both languages, and none that is a missing key', async () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = createTranslator(locale)
      for (const reason of [...KEY_INVALID_REASONS, ...KEY_UNVERIFIED_REASONS]) {
        const key = `app.keys.reason.${reason}` as const
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
      for (const key of ['app.keys.checkNote', 'app.keys.checking', 'app.keys.unverified', 'app.keys.savedAnyway', 'app.keys.saveAnyway', 'app.error.host.KEY_INVALID'] as const) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
    }
  })

  it('works in English, with the reason in the sentence', async () => {
    const { t, user } = await open(hostWith(() => ({ status: 'unverified', reason: 'rate_limited' })), 'en')
    await submit(user, t)
    const { row } = rowOf(t)
    const text = await within(row).findByRole('status')
    expect(text.textContent).toBe('Saved, but the key could not be confirmed. The provider is limiting requests for the moment. You can still use it. The key is never shown again.')
  })

  it('has no axe violations while checking, and in each result', async () => {
    for (const verdict of [{ status: 'valid' }, { status: 'unverified', reason: 'timeout' }, INVALID] as KeyVerdict[]) {
      const { t, user, view } = await open(hostWith(() => verdict))
      await submit(user, t)
      await waitFor(() => expect(within(rowOf(t).row).queryByText(t('app.keys.checking'))).toBeNull())
      expect(await violations(view.container)).toEqual([])
      view.unmount()
    }
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

  describe('language', () => {
    const FIXED_LABELS = ['System default / 시스템 기본값', 'English', '한국어']
    const picker = (t: ReturnType<typeof createTranslator>) => screen.getByRole('combobox', { name: t('app.general.language') }) as HTMLSelectElement

    it.each(['ko', 'en'] as const)('offers three options whose labels are the same in every language (%s)', async (locale) => {
      const { t } = await openGeneral({ locale })
      const select = picker(t)
      expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(FIXED_LABELS)
      expect(within(select).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['system', 'en', 'ko'])
    })

    it('shows the saved language and the hint', async () => {
      const { t } = await openGeneral({ init: { settings: fakeSettings({ language: 'ko' }) } })
      expect(picker(t).value).toBe('ko')
      expect(screen.getByText(t('app.general.languageHint'))).toBeTruthy()
    })

    it('starts on system for the default settings', async () => {
      const { t } = await openGeneral()
      expect(picker(t).value).toBe('system')
    })

    it('saves the choice through settings.update and shows it', async () => {
      const { host, t, user } = await openGeneral()
      const update = vi.spyOn(host.settings, 'update')
      await user.selectOptions(picker(t), 'en')
      await waitFor(() => expect(host.state().settings.language).toBe('en'))
      expect(update).toHaveBeenCalledExactlyOnceWith({ language: 'en' })
      expect(picker(t).value).toBe('en')
      expect(host.state().restartCalls).toBe(0)
    })

    it('shows the error and keeps the saved value when saving fails', async () => {
      const host = createFakeHost({}, { restartDelayMs: 0 })
      vi.spyOn(host.settings, 'update').mockRejectedValue(new HostError('INTERNAL'))
      const { t, user } = await openGeneral({ host })
      await user.selectOptions(picker(t), 'ko')
      expect((await screen.findByRole('alert')).textContent).toBe(t('app.error.host.INTERNAL'))
      expect(picker(t).value).toBe('system')
    })

    it('is disabled while the choice is being saved', async () => {
      const host = createFakeHost({}, { restartDelayMs: 0 })
      let release!: () => void
      const original = host.settings.update.bind(host.settings)
      vi.spyOn(host.settings, 'update').mockImplementation(async (patch) => {
        await new Promise<void>((resolve) => (release = resolve))
        return original(patch)
      })
      const { t, user } = await openGeneral({ host })
      await user.selectOptions(picker(t), 'ko')
      await waitFor(() => expect(picker(t).disabled).toBe(true))
      release()
      await waitFor(() => expect(picker(t).disabled).toBe(false))
      expect(picker(t).value).toBe('ko')
    })

    it('has no axe violations', async () => {
      const { view } = await openGeneral({ locale: 'en' })
      expect(await violations(view.container)).toEqual([])
    })
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
