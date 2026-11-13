import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { createFakeHost, fakeSettings, type FakeHostOptions } from '../../engine/fake-host'
import { useLocale } from '../../i18n'
import { OAUTH_PROVIDERS, type OAuthAccount, type OAuthProvider, type OAuthStatus, type Settings } from '../../shared/host-api'
import { ThemeProvider, type Theme } from '../../theme/ThemeProvider'
import { HostProvider } from '../host'
import { OAuthCard } from './OAuthCard'
import { SettingsStage } from './SettingsStage'
import { useSettings } from './useSettings'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/OAuthCard', component: SettingsStage, args: { section: 'connections' } }
export default meta
type Story = StoryObj<typeof SettingsStage>

type Play = NonNullable<Story['play']>
type Context = Parameters<Play>[0]

const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const MICROSOFT_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const DEMO_SECRET = 'GOCSPX-demo-secret-not-real-0123'
const HOSTILE_ACCOUNT = '<img src=x onerror=alert(1)> ‮Alex Doe with a very long display name that a provider could send back and that keeps going and going for a while'

interface Row {
  provider: OAuthProvider
  status?: OAuthStatus
  account?: string
  clientId?: string
  hasSecret?: boolean
}

function settingsOf(rows: Row[], extra: Partial<Settings> = {}): Settings {
  const accounts: OAuthAccount[] = rows.filter((row) => row.status !== undefined).map((row) => ({ provider: row.provider, status: row.status!, ...(row.account === undefined ? {} : { account: row.account }) }))
  const apps = rows.filter((row) => row.clientId !== undefined).map((row) => ({ provider: row.provider, clientId: row.clientId!, hasSecret: row.hasSecret ?? false }))
  return fakeSettings({ oauth: { available: extra.encryptionAvailable !== false, accounts, apps }, ...extra })
}

function staged(rows: Row[] = [], options: FakeHostOptions = {}, extra: Partial<Settings> = {}): Story['args'] {
  return { section: 'connections', init: { settings: settingsOf(rows, extra) }, options: { restartDelayMs: 0, ...options } }
}

const google = (overrides: Partial<Row> = {}): Row => ({ provider: 'google', clientId: GOOGLE_ID, hasSecret: true, status: 'not_connected', ...overrides })
const microsoft = (overrides: Partial<Row> = {}): Row => ({ provider: 'microsoft', clientId: MICROSOFT_ID, status: 'not_connected', ...overrides })

function cardOf(context: Context, provider: OAuthProvider): HTMLElement {
  const sections = [...context.canvasElement.querySelectorAll<HTMLElement>('section')].filter((section) => section.querySelector(':scope > h3') !== null)
  const found = sections[OAUTH_PROVIDERS.indexOf(provider)]
  if (found === undefined) throw new Error(`no ${provider} card`)
  return found
}

function buttonsOf(context: Context, provider: OAuthProvider): HTMLButtonElement[] {
  return [...cardOf(context, provider).querySelectorAll<HTMLButtonElement>('button')]
}

async function ready(context: Context): Promise<void> {
  await context.canvas.findByRole('navigation')
}

async function expand(context: Context, provider: OAuthProvider): Promise<void> {
  await ready(context)
  const toggle = buttonsOf(context, provider).find((button) => button.hasAttribute('aria-expanded'))
  if (toggle === undefined) throw new Error('no Set up toggle')
  await context.userEvent.click(toggle)
}

async function press(context: Context, provider: OAuthProvider, index = 0): Promise<void> {
  await ready(context)
  await context.userEvent.click(buttonsOf(context, provider)[index]!)
}

async function type(context: Context, provider: OAuthProvider, id: string, secret?: string): Promise<void> {
  await expand(context, provider)
  const card = cardOf(context, provider)
  await context.userEvent.type(card.querySelector<HTMLInputElement>('input[type="text"]:not([readonly])')!, id)
  if (secret !== undefined) await context.userEvent.type(card.querySelector<HTMLInputElement>('input[type="password"]')!, secret)
}

async function typeAndSave(context: Context, provider: OAuthProvider, id: string, secret?: string): Promise<void> {
  await type(context, provider, id, secret)
  await context.userEvent.click(cardOf(context, provider).querySelector<HTMLButtonElement>('button[type="submit"]')!)
}

export const NotSetUp: Story = { args: staged() }

export const NotSetUpWithTheStepsOpen: Story = {
  args: staged(),
  play: async (context) => {
    await expand(context, 'google')
    await expand(context, 'microsoft')
  },
}

export const GoogleFormFilled: Story = { args: staged(), play: (context) => type(context, 'google', GOOGLE_ID, DEMO_SECRET) }

export const MicrosoftRedirectToRegister: Story = { args: staged(), play: (context) => expand(context, 'microsoft') }

export const MicrosoftFormFilled: Story = { args: staged(), play: (context) => type(context, 'microsoft', MICROSOFT_ID) }

export const RedirectCopied: Story = {
  args: staged(),
  play: async (context) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })
    await expand(context, 'microsoft')
    await context.userEvent.click(cardOf(context, 'microsoft').querySelector('input[readonly]')!.nextElementSibling!)
  },
}

export const RedirectCopyFailed: Story = {
  args: staged(),
  play: async (context) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })
    document.execCommand = () => false
    await expand(context, 'microsoft')
    await context.userEvent.click(cardOf(context, 'microsoft').querySelector('input[readonly]')!.nextElementSibling!)
  },
}

export const InvalidClientId: Story = { args: staged(), play: (context) => typeAndSave(context, 'google', 'not a client id') }

export const InvalidMicrosoftClientId: Story = { args: staged(), play: (context) => typeAndSave(context, 'microsoft', GOOGLE_ID) }

export const InvalidClientSecret: Story = { args: staged(), play: (context) => typeAndSave(context, 'google', GOOGLE_ID, 'a secret with spaces') }

export const AppSaved: Story = { args: staged(), play: (context) => typeAndSave(context, 'google', GOOGLE_ID, DEMO_SECRET) }

export const SetUpAndReadyToConnect: Story = { args: staged([google(), microsoft()]) }

export const SetUpGoogleWithoutSecret: Story = { args: staged([google({ hasSecret: false }), microsoft()]) }

export const SetUpWithSettingsOpen: Story = {
  args: staged([google(), microsoft()]),
  play: async (context) => {
    await expand(context, 'google')
    await expand(context, 'microsoft')
  },
}

export const WaitingForTheBrowser: Story = { args: staged([google(), microsoft()], { oauthFlows: { google: 'waiting' } }), play: (context) => press(context, 'google') }

export const SignInCancelled: Story = {
  args: staged([google(), microsoft()], { oauthFlows: { google: 'waiting' } }),
  play: async (context) => {
    await press(context, 'google')
    await context.canvas.findByRole('status')
    await context.userEvent.click(buttonsOf(context, 'google')[0]!)
  },
}

export const Connected: Story = {
  args: staged([google({ status: 'connected', account: 'someone@example.com' }), microsoft({ status: 'connected', account: 'Alex Doe' })]),
}

export const ConnectedJustNow: Story = { args: staged([google(), microsoft()]), play: (context) => press(context, 'google') }

export const ConnectedWithoutAName: Story = { args: staged([google({ status: 'connected' }), microsoft()]) }

export const ConnectedWithHostileAccountText: Story = { args: staged([google({ status: 'connected', account: HOSTILE_ACCOUNT }), microsoft()]) }

export const ReconnectNeeded: Story = {
  args: staged([google({ status: 'needs_reconnect', account: 'someone@example.com' }), microsoft({ status: 'needs_reconnect', account: 'Alex Doe' })]),
}

export const ReconnectNeededLater: Story = {
  args: staged([google(), microsoft()], { oauthFlows: { google: 'needs_reconnect_later' } }),
  play: async (context) => {
    await press(context, 'google')
    await new Promise((resolve) => setTimeout(resolve, 120))
  },
}

export const ErrorDenied: Story = { args: staged([google(), microsoft()], { oauthFlows: { google: 'denied' } }), play: (context) => press(context, 'google') }

export const ErrorTimeout: Story = { args: staged([google(), microsoft()], { oauthFlows: { google: 'timeout' } }), play: (context) => press(context, 'google') }

export const ErrorScopeMissing: Story = { args: staged([google(), microsoft()], { oauthFlows: { microsoft: 'scope_missing' } }), play: (context) => press(context, 'microsoft') }

export const ErrorExchangeFailed: Story = { args: staged([google(), microsoft()], { oauthFlows: { microsoft: 'exchange_failed' } }), play: (context) => press(context, 'microsoft') }

export const ErrorAnotherSignInIsOpen: Story = {
  args: staged([google(), microsoft()], { oauthFlows: { google: 'waiting' } }),
  play: async (context) => {
    await press(context, 'google')
    await context.canvas.findByRole('status')
    await context.userEvent.click(buttonsOf(context, 'microsoft')[0]!)
  },
}

export const ErrorNameTaken: Story = {
  args: staged([google(), microsoft()], {}, { connections: [{ name: 'Google', kind: 'http' }] }),
  play: (context) => press(context, 'google'),
}

export const DisconnectConfirmation: Story = {
  args: staged([google({ status: 'connected', account: 'someone@example.com' }), microsoft({ status: 'connected', account: 'Alex Doe' })]),
  play: (context) => press(context, 'microsoft'),
}

export const RemoveConfirmation: Story = {
  args: staged([google(), microsoft()]),
  play: async (context) => {
    await expand(context, 'google')
    await context.userEvent.click(buttonsOf(context, 'google').at(-1)!)
  },
}

export const ReplacingTheAppOfAConnectedAccount: Story = {
  args: staged([google({ status: 'connected', account: 'someone@example.com' }), microsoft()]),
  play: (context) => expand(context, 'google'),
}

export const NoKeychain: Story = { args: staged([google(), microsoft({ status: 'connected', account: 'Alex Doe' })], {}, { encryptionAvailable: false }) }

function Cell({ rows, provider }: { rows: Row[]; provider: OAuthProvider }) {
  const [host] = useState(() => createFakeHost({ settings: settingsOf(rows) }, { restartDelayMs: 0 }))
  const state = useSettings(host)
  if (state.settings === undefined) return null
  return (
    <HostProvider host={host}>
      <OAuthCard provider={provider} api={{ settings: state.settings, apply: state.apply, reload: state.reload }} locked={!state.settings.encryptionAvailable} />
    </HostProvider>
  )
}

function Pair({ themes, locales }: { themes: readonly Theme[]; locales: readonly ('ko' | 'en')[] }) {
  const locale = useLocale()
  const current = document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  const cells = themes.length > 1 ? themes.map((theme) => ({ theme, locale })) : locales.map((value) => ({ theme: current as Theme, locale: value }))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {cells.map((cell) => (
        <ThemeProvider key={`${cell.theme}-${cell.locale}`} theme={cell.theme} locale={cell.locale}>
          <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--surface-base)', borderRadius: 'var(--radius-md)' }}>
            <Cell provider="google" rows={[google({ status: 'connected', account: 'someone@example.com' })]} />
            <Cell provider="microsoft" rows={[microsoft({ status: 'needs_reconnect', account: 'Alex Doe' })]} />
          </div>
        </ThemeProvider>
      ))}
    </div>
  )
}

export const LightAndDarkSideBySide: Story = { name: 'Light and dark side by side', render: () => <Pair themes={['light', 'dark']} locales={['ko']} /> }
export const KoreanAndEnglishSideBySide: Story = { name: 'Korean and English side by side', render: () => <Pair themes={['light']} locales={['ko', 'en']} /> }
