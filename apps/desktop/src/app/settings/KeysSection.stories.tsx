import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings, type FakeKeyCheck } from '../../engine/fake-host'
import { useLocale } from '../../i18n'
import { KEY_INVALID_REASONS, KEY_UNVERIFIED_REASONS } from '../../shared/host-api'
import { ThemeProvider, type Theme } from '../../theme/ThemeProvider'
import { KeyResult, type KeyView } from './KeysSection'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/KeysSection', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

const DEMO_KEY = 'demo-key-not-a-real-secret'

const never: FakeKeyCheck = () => new Promise(() => undefined)
const invalid: FakeKeyCheck = () => ({ status: 'invalid', reason: 'unauthorized' })

function staged(keyChecks: FakeKeyCheck): Story['args'] {
  return { section: 'keys', options: { restartDelayMs: 0, keyChecks } }
}

const typeAndSubmit: NonNullable<Story['play']> = async ({ canvas, canvasElement, userEvent }) => {
  await canvas.findByRole('navigation')
  const field = canvasElement.querySelector<HTMLInputElement>('input[type="password"]')
  if (field === null) throw new Error('no key field')
  await userEvent.type(field, `${DEMO_KEY}{Enter}`)
}

const refuseThenSaveAnyway: NonNullable<Story['play']> = async (context) => {
  await typeAndSubmit(context)
  const notice = await context.canvas.findByRole('alert')
  const button = notice.querySelector('button')
  if (button === null) throw new Error('no save anyway button')
  await context.userEvent.click(button)
}

export const Empty: Story = { args: { section: 'keys' } }
export const SomeConfigured: Story = { args: { section: 'keys', init: { settings: fakeSettings({ configuredProviders: ['anthropic', 'gemini'] }) } } }
export const NoKeychain: Story = { args: { section: 'keys', init: { settings: fakeSettings({ encryptionAvailable: false }) } } }

export const Checking: Story = { args: staged(never), play: typeAndSubmit }
export const ProviderAcceptsTheKey: Story = { args: staged(() => ({ status: 'valid' })), play: typeAndSubmit }
export const SavedButNotConfirmed: Story = { args: staged(() => ({ status: 'unverified', reason: 'network' })), play: typeAndSubmit }
export const RefusedWithSaveAnyway: Story = { args: staged(invalid), play: typeAndSubmit }
export const SavedAnywayAfterRefusal: Story = { args: staged(invalid), play: refuseThenSaveAnyway }

const RESULTS: ReadonlyArray<{ name: string; view: KeyView }> = [
  { name: 'checking', view: { kind: 'checking' } },
  { name: 'valid', view: { kind: 'checked', verdict: { status: 'valid' } } },
  ...KEY_UNVERIFIED_REASONS.map((reason) => ({ name: `unverified ${reason}`, view: { kind: 'checked', verdict: { status: 'unverified', reason } } }) as const),
  ...KEY_INVALID_REASONS.map((reason) => ({ name: `saved anyway ${reason}`, view: { kind: 'checked', verdict: { status: 'invalid', reason } } }) as const),
  { name: 'refused', view: { kind: 'refused' } },
  { name: 'removed', view: { kind: 'removed' } },
]

function Results() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 720, padding: 'var(--space-4)' }}>
      {RESULTS.map(({ name, view }) => (
        <section key={name} aria-label={name} style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <small style={{ color: 'var(--text-muted)' }}>{name}</small>
          <KeyResult view={view} />
        </section>
      ))}
    </div>
  )
}

function Pair({ themes, locales }: { themes: readonly Theme[]; locales: readonly ('ko' | 'en')[] }) {
  const locale = useLocale()
  const current = document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  const views: KeyView[] = [
    { kind: 'refused' },
    { kind: 'checked', verdict: { status: 'unverified', reason: 'forbidden' } },
    { kind: 'checked', verdict: { status: 'valid' } },
  ]
  const cells = themes.length > 1 ? themes.map((theme) => ({ theme, locale })) : locales.map((value) => ({ theme: current as Theme, locale: value }))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {cells.map((cell) => (
        <ThemeProvider key={`${cell.theme}-${cell.locale}`} theme={cell.theme} locale={cell.locale}>
          <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--surface-base)', borderRadius: 'var(--radius-md)' }}>
            {views.map((view) => (
              <KeyResult key={view.kind === 'checked' ? view.verdict.status : view.kind} view={view} />
            ))}
          </div>
        </ThemeProvider>
      ))}
    </div>
  )
}

export const EveryResult: Story = { render: () => <Results /> }
export const LightAndDarkSideBySide: Story = { name: 'Light and dark side by side', render: () => <Pair themes={['light', 'dark']} locales={['ko']} /> }
export const KoreanAndEnglishSideBySide: Story = { name: 'Korean and English side by side', render: () => <Pair themes={['light']} locales={['ko', 'en']} /> }
