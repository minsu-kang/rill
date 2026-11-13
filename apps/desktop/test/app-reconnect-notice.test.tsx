import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/app/App'
import { createFakeWorld, type FakeWorld } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { createFakeHost, fakeSettings, type FakeHost, type FakeHostOptions } from '../src/engine/fake-host'
import { createTranslator, type Locale } from '../src/i18n'
import type { EngineStatus, OAuthAccount, OAuthProvider, OAuthStatus } from '../src/shared/host-api'
import { violations } from './axe'
import { renderThemed } from './render'

const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const MICROSOFT_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const HOSTILE = '‮<img src=x onerror=alert(1)>HOSTILEACCOUNT'

type Row = Partial<Record<OAuthProvider, OAuthStatus>>

function settingsFor(rows: Row, account: string | undefined = 'someone@example.com') {
  const accounts: OAuthAccount[] = (Object.entries(rows) as Array<[OAuthProvider, OAuthStatus]>).map(([provider, status]) => ({ provider, status, ...(account === undefined || status === 'not_configured' || status === 'not_connected' ? {} : { account }) }))
  const apps = (Object.keys(rows) as OAuthProvider[]).filter((provider) => rows[provider] !== 'not_configured').map((provider) => ({ provider, clientId: provider === 'google' ? GOOGLE_ID : MICROSOFT_ID, hasSecret: provider === 'google' }))
  return fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'slack-ops', kind: 'slack' }], oauth: { available: true, accounts, apps } })
}

interface Options {
  locale?: Locale
  account?: string | undefined
  hostOptions?: FakeHostOptions
  engine?: EngineStatus
}

function mount(rows: Row, options: Options = {}) {
  const locale = options.locale ?? 'en'
  const host: FakeHost = createFakeHost({ settings: settingsFor(rows, 'account' in options ? options.account : undefined), ...(options.engine === undefined ? {} : { engine: options.engine }) }, { restartDelayMs: 0, ...options.hostOptions })
  const listeners = new Set<(change: OAuthAccount) => void>()
  const subscribe = host.oauth.onChanged.bind(host.oauth)
  host.oauth.onChanged = (listener) => {
    listeners.add(listener)
    const off = subscribe(listener)
    return () => {
      listeners.delete(listener)
      off()
    }
  }
  const world: FakeWorld = createFakeWorld({ host, control: { stepIntervalMs: 0 } })
  const view = renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App />
    </HostProvider>,
    { locale },
  )
  const emit = (change: OAuthAccount): void => {
    act(() => {
      for (const listener of [...listeners]) listener(change)
    })
  }
  return { host, world, view, emit, t: createTranslator(locale), user: userEvent.setup() }
}

const en = createTranslator('en')
const ko = createTranslator('ko')

async function ready(t: ReturnType<typeof createTranslator>): Promise<void> {
  await screen.findByText(t('app.top.engine.connected'))
}

const sentence = (t: ReturnType<typeof createTranslator>, provider: OAuthProvider) => t('app.notice.reconnect', { provider: t(`app.connections.provider.${provider}`) })
const RECONNECT_ANY = /needs? to be connected again|다시 연결해야 해요/

afterEach(() => vi.restoreAllMocks())

describe('the reconnect notice: when the app starts', () => {
  it('tells the person in English that a Google account needs to be connected again, with the action', async () => {
    mount({ google: 'needs_reconnect' })
    expect(await screen.findByText('Your Google account needs to be connected again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Connections' })).toBeTruthy()
  })

  it('tells the person in Korean', async () => {
    const { t } = mount({ google: 'needs_reconnect' }, { locale: 'ko' })
    expect(await screen.findByText(sentence(ko, 'google'))).toBeTruthy()
    expect(sentence(ko, 'google')).toBe('Google 계정을 다시 연결해야 해요.')
    expect(screen.getByRole('button', { name: t('app.notice.reconnect.action') })).toBeTruthy()
  })

  it('names Microsoft for a Microsoft account', async () => {
    mount({ google: 'connected', microsoft: 'needs_reconnect' })
    expect(await screen.findByText('Your Microsoft account needs to be connected again.')).toBeTruthy()
    expect(screen.queryByText(sentence(en, 'google'))).toBeNull()
  })

  it('shows one notice that names both when both accounts need it', async () => {
    mount({ google: 'needs_reconnect', microsoft: 'needs_reconnect' })
    expect(await screen.findByText('Your Google and Microsoft accounts need to be connected again.')).toBeTruthy()
    expect(screen.getAllByText(RECONNECT_ANY)).toHaveLength(1)
  })

  it('shows the both-accounts text in Korean', async () => {
    mount({ google: 'needs_reconnect', microsoft: 'needs_reconnect' }, { locale: 'ko' })
    expect(await screen.findByText('Google, Microsoft 계정을 다시 연결해야 해요.')).toBeTruthy()
  })

  it('shows nothing for accounts that are connected, not connected or not set up', async () => {
    mount({ google: 'connected', microsoft: 'not_connected' })
    await ready(en)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    expect(screen.queryByRole('button', { name: en('app.notice.dismiss') })).toBeNull()
  })

  it('shows exactly one notice once the settings have loaded', async () => {
    mount({ google: 'needs_reconnect' })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    expect(await screen.findByText(sentence(en, 'google'))).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getAllByText(RECONNECT_ANY)).toHaveLength(1)
  })

  it('does not show it again after it was dismissed and the settings change', async () => {
    const { user, host } = mount({ google: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    expect(screen.queryByText(sentence(en, 'google'))).toBeNull()
    await host.settings.update({ openAtLogin: true })
    await user.click(within(screen.getByRole('navigation', { name: en('app.top.screens') })).getByRole('button', { name: en('app.tab.settings') }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })
})

describe('the reconnect notice: while the window is open', () => {
  it('shows it when a connected account moves to needs reconnect', async () => {
    const { host } = mount({ google: 'connected' })
    await ready(en)
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    act(() => host.expireOAuth('google'))
    expect(await screen.findByText(sentence(en, 'google'))).toBeTruthy()
  })

  it('shows it for Microsoft too, in Korean', async () => {
    const { host } = mount({ microsoft: 'connected' }, { locale: 'ko' })
    await ready(ko)
    act(() => host.expireOAuth('microsoft'))
    expect(await screen.findByText(sentence(ko, 'microsoft'))).toBeTruthy()
  })

  it('does not repeat when a second event carries the same status', async () => {
    const { host, user, emit } = mount({ google: 'connected' })
    await ready(en)
    act(() => host.expireOAuth('google'))
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    emit({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
    emit({ provider: 'google', status: 'needs_reconnect' })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })

  it('does not repeat while the person retries and the retry fails', async () => {
    const { user, emit } = mount({ google: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    emit({ provider: 'google', status: 'connecting' })
    emit({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })

  it('shows it again for a later transition, after the account was connected again', async () => {
    const { user, emit } = mount({ google: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    emit({ provider: 'google', status: 'connecting' })
    emit({ provider: 'google', status: 'connected', account: 'someone@example.com' })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    emit({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
    expect(await screen.findByText(sentence(en, 'google'))).toBeTruthy()
  })

  it('shows it when the withdrawn sign-in is found while a new sign-in is open', async () => {
    const { emit } = mount({ google: 'connected' })
    await ready(en)
    emit({ provider: 'google', status: 'connecting' })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    emit({ provider: 'google', status: 'needs_reconnect', account: 'someone@example.com' })
    expect(await screen.findByText(sentence(en, 'google'))).toBeTruthy()
  })

  it('says nothing when the person disconnects an account', async () => {
    const { host } = mount({ google: 'connected', microsoft: 'connected' })
    await ready(en)
    await act(async () => {
      await host.oauth.disconnect('google')
    })
    await act(async () => {
      await host.oauth.disconnect('microsoft')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })

  it('says nothing when the person disconnects an account that needs to be connected again, after the notice was dismissed', async () => {
    const { host, user } = mount({ google: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    await act(async () => {
      await host.oauth.disconnect('google')
    })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })

  it('says nothing for a first connect that fails, is cancelled or is denied', async () => {
    for (const flow of ['denied', 'timeout', 'scope_missing', 'exchange_failed'] as const) {
      const { host, view } = mount({ google: 'not_connected' }, { hostOptions: { oauthFlows: { google: flow } } })
      await ready(en)
      await act(async () => {
        await host.oauth.connect('google').catch(() => undefined)
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(screen.queryByText(RECONNECT_ANY), flow).toBeNull()
      view.unmount()
    }
  })

  it('says nothing for a sign-in that is cancelled while it waits', async () => {
    const { host } = mount({ google: 'not_connected' }, { hostOptions: { oauthFlows: { google: 'waiting' } } })
    await ready(en)
    let pending!: Promise<unknown>
    act(() => {
      pending = host.oauth.connect('google').catch(() => undefined)
    })
    await act(async () => {
      await host.oauth.cancel('google')
      await pending
    })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })

  it('says nothing when a connected account is reconnected and the new sign-in is cancelled', async () => {
    const { host } = mount({ google: 'connected' }, { hostOptions: { oauthFlows: { google: 'waiting' } } })
    await ready(en)
    let pending!: Promise<unknown>
    act(() => {
      pending = host.oauth.connect('google').catch(() => undefined)
    })
    await act(async () => {
      await host.oauth.cancel('google')
      await pending
    })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })

  it('names both accounts when the second one follows in its own event while the first is still waiting', async () => {
    const { host } = mount({ google: 'connected', microsoft: 'connected' })
    await ready(en)
    act(() => host.expireOAuth('google'))
    expect(await screen.findByText(sentence(en, 'google'))).toBeTruthy()
    act(() => host.expireOAuth('microsoft'))
    expect(await screen.findByText(en('app.notice.reconnectBoth'))).toBeTruthy()
    expect(screen.queryByText(sentence(en, 'google'))).toBeNull()
    expect(screen.queryByText(sentence(en, 'microsoft'))).toBeNull()
    expect(screen.getAllByText(RECONNECT_ANY)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en('app.notice.reconnect.action') })).toHaveLength(1)
  })

  it('names both accounts in Korean when the second one follows the first', async () => {
    const { host } = mount({ google: 'connected', microsoft: 'connected' }, { locale: 'ko' })
    await ready(ko)
    act(() => host.expireOAuth('microsoft'))
    expect(await screen.findByText(sentence(ko, 'microsoft'))).toBeTruthy()
    act(() => host.expireOAuth('google'))
    expect(await screen.findByText(ko('app.notice.reconnectBoth'))).toBeTruthy()
    expect(screen.getAllByText(RECONNECT_ANY)).toHaveLength(1)
  })

  it('names both accounts when the second one follows after the notice of the first was dismissed', async () => {
    const { host, user } = mount({ google: 'connected', microsoft: 'connected' })
    await ready(en)
    act(() => host.expireOAuth('google'))
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    act(() => host.expireOAuth('microsoft'))
    expect(await screen.findByText(en('app.notice.reconnectBoth'))).toBeTruthy()
  })

  it('names only the account that needs it when the other one was connected again in the meantime', async () => {
    const { user, emit } = mount({ google: 'needs_reconnect', microsoft: 'connected' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    emit({ provider: 'google', status: 'connecting' })
    emit({ provider: 'google', status: 'connected', account: 'someone@example.com' })
    emit({ provider: 'microsoft', status: 'needs_reconnect', account: 'someone@example.com' })
    expect(await screen.findByText(sentence(en, 'microsoft'))).toBeTruthy()
    expect(screen.queryByText(en('app.notice.reconnectBoth'))).toBeNull()
  })

  it('names only the new account while the first one is being connected again', async () => {
    const { user, emit } = mount({ google: 'needs_reconnect', microsoft: 'connected' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    emit({ provider: 'google', status: 'connecting' })
    emit({ provider: 'microsoft', status: 'needs_reconnect', account: 'someone@example.com' })
    expect(await screen.findByText(sentence(en, 'microsoft'))).toBeTruthy()
    expect(screen.queryByText(en('app.notice.reconnectBoth'))).toBeNull()
  })

  it('shows nothing new for a second event of the account that is already waiting, while the other one is waiting too', async () => {
    const { user, emit } = mount({ google: 'needs_reconnect', microsoft: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.dismiss') }))
    emit({ provider: 'microsoft', status: 'needs_reconnect' })
    emit({ provider: 'google', status: 'needs_reconnect' })
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
  })
})

describe('the reconnect notice: its buttons', () => {
  it('opens Settings, Connections with the action and closes the notice', async () => {
    const { user } = mount({ google: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.reconnect.action') }))
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    const nav = await screen.findByRole('navigation', { name: en('app.settings.nav') })
    expect(within(nav).getByRole('button', { name: en('app.settings.section.connections') }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('button', { name: en('app.settings.section.folders') }).getAttribute('aria-current')).toBeNull()
    const card = await screen.findByRole('region', { name: en('app.connections.provider.google') })
    expect(within(card).getByText(en('app.oauth.status.needs_reconnect'))).toBeTruthy()
  })

  it('opens Connections from another screen of the app too', async () => {
    const { user, host } = mount({ microsoft: 'connected' })
    await ready(en)
    await user.click(within(screen.getByRole('navigation', { name: en('app.top.screens') })).getByRole('button', { name: en('app.tab.recipes') }))
    act(() => host.expireOAuth('microsoft'))
    await user.click(await screen.findByRole('button', { name: en('app.notice.reconnect.action') }))
    const nav = await screen.findByRole('navigation', { name: en('app.settings.nav') })
    expect(within(nav).getByRole('button', { name: en('app.settings.section.connections') }).getAttribute('aria-current')).toBe('page')
    const tabs = screen.getByRole('navigation', { name: en('app.top.screens') })
    expect(within(tabs).getByRole('button', { name: en('app.tab.settings') }).getAttribute('aria-current')).toBe('page')
  })

  it('puts the focus on the heading of Connections when the action opens it from another screen', async () => {
    const { user } = mount({ google: 'needs_reconnect' })
    await user.click(await screen.findByRole('button', { name: en('app.notice.reconnect.action') }))
    const heading = await screen.findByRole('heading', { name: en('app.settings.section.connections') })
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('puts the focus on the heading of Connections when Settings shows another section', async () => {
    const { user, host } = mount({ google: 'connected' })
    await ready(en)
    await user.click(within(screen.getByRole('navigation', { name: en('app.top.screens') })).getByRole('button', { name: en('app.tab.settings') }))
    await screen.findByRole('heading', { name: en('app.settings.section.folders') })
    act(() => host.expireOAuth('google'))
    await user.click(await screen.findByRole('button', { name: en('app.notice.reconnect.action') }))
    const heading = await screen.findByRole('heading', { name: en('app.settings.section.connections') })
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('keeps the focus in the page when Connections is already open and the action is used', async () => {
    const { user, host } = mount({ google: 'connected' })
    await ready(en)
    await user.click(within(screen.getByRole('navigation', { name: en('app.top.screens') })).getByRole('button', { name: en('app.tab.settings') }))
    await user.click(within(await screen.findByRole('navigation', { name: en('app.settings.nav') })).getByRole('button', { name: en('app.settings.section.connections') }))
    const heading = await screen.findByRole('heading', { name: en('app.settings.section.connections') })
    act(() => host.expireOAuth('google'))
    await user.click(await screen.findByRole('button', { name: en('app.notice.reconnect.action') }))
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('dismisses with the dismiss button and keeps the screen as it is', async () => {
    const { user } = mount({ google: 'needs_reconnect' })
    await screen.findByText(sentence(en, 'google'))
    await user.click(screen.getByRole('button', { name: en('app.notice.dismiss') }))
    expect(screen.queryByText(sentence(en, 'google'))).toBeNull()
    expect(screen.queryByRole('navigation', { name: en('app.settings.nav') })).toBeNull()
  })

  it('is replaced by an unrelated notice, which shows no action', async () => {
    const { world, user } = mount({ google: 'needs_reconnect' }, { engine: { state: 'stopped', error: 'crashed', restarts: 6 } })
    await screen.findByText(sentence(en, 'google'))
    vi.spyOn(world.host.engine, 'restart').mockRejectedValue(new Error('no'))
    await user.click(await screen.findByRole('button', { name: en('app.top.engine.restart') }))
    expect(await screen.findByText(en('app.notice.actionFailed'))).toBeTruthy()
    expect(screen.queryByText(RECONNECT_ANY)).toBeNull()
    expect(screen.queryByRole('button', { name: en('app.notice.reconnect.action') })).toBeNull()
    expect(screen.getByRole('button', { name: en('app.notice.dismiss') })).toBeTruthy()
  })

  it('shows no action on a notice that is not about an account', async () => {
    const { world, user } = mount({ google: 'connected' }, { engine: { state: 'stopped', error: 'crashed', restarts: 6 } })
    vi.spyOn(world.host.engine, 'restart').mockRejectedValue(new Error('no'))
    await user.click(await screen.findByRole('button', { name: en('app.top.engine.restart') }))
    await screen.findByText(en('app.notice.actionFailed'))
    expect(screen.queryByRole('button', { name: en('app.notice.reconnect.action') })).toBeNull()
  })
})

describe('the reconnect notice: what it holds', () => {
  it('is the fixed sentence and never the account text, even when the account text is hostile', async () => {
    mount({ google: 'needs_reconnect', microsoft: 'connected' }, { account: HOSTILE })
    const text = await screen.findByText(sentence(en, 'google'))
    const container = text.parentElement!
    expect(container.textContent).toBe(`${sentence(en, 'google')}${en('app.notice.reconnect.action')}${en('app.notice.dismiss')}`)
    expect(container.innerHTML).not.toMatch(/HOSTILEACCOUNT|onerror|someone@/)
    expect(document.body.innerHTML.includes('<img src=x')).toBe(false)
  })

  it('passes axe', async () => {
    const { view } = mount({ google: 'needs_reconnect' })
    await screen.findByText(sentence(en, 'google'))
    expect(await violations(view.container)).toEqual([])
  })

  it('passes axe in Korean with both accounts', async () => {
    const { view } = mount({ google: 'needs_reconnect', microsoft: 'needs_reconnect' }, { locale: 'ko' })
    await screen.findByText('Google, Microsoft 계정을 다시 연결해야 해요.')
    expect(await violations(view.container)).toEqual([])
  })

  it('keeps the notice in the live region of the bar', async () => {
    mount({ google: 'needs_reconnect' })
    const text = await screen.findByText(sentence(en, 'google'))
    const region = text.closest('[data-rill-region="notice"]')!
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.contains(screen.getByRole('button', { name: en('app.notice.reconnect.action') }))).toBe(true)
  })
})
