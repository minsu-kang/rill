import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings, type FakeSlackCheck } from '../../engine/fake-host'
import { useLocale } from '../../i18n'
import type { ConnectionSummary, SlackVerdict } from '../../shared/host-api'
import { ThemeProvider, type Theme } from '../../theme/ThemeProvider'
import { SettingsStage } from './SettingsStage'
import { SlackResult, type SlackView } from './SlackCard'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/SlackCard', component: SettingsStage }
export default meta
type Story = StoryObj<typeof SettingsStage>

type Play = NonNullable<Story['play']>
type Context = Parameters<Play>[0]

const DEMO_TOKEN = 'xoxb-0000000000-demo-token-not-real'
const never: FakeSlackCheck = () => new Promise(() => undefined)
const invalid: FakeSlackCheck = () => ({ status: 'invalid', reason: 'unauthorized' })

const SAVED: ConnectionSummary[] = [
  { name: 'team-alerts', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Rill Team', channel: '#alerts' } },
  { name: 'billing', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'rill-bot in Rill Team' } },
  { name: 'unchecked', kind: 'slack', slack: { mode: 'bot', confirmed: false } },
  { name: 'old-hook', kind: 'slack' },
]

function staged(slackChecks?: FakeSlackCheck, settings: Parameters<typeof fakeSettings>[0] = {}): Story['args'] {
  return { section: 'connections', init: { settings: fakeSettings(settings) }, options: { restartDelayMs: 0, ...(slackChecks === undefined ? {} : { slackChecks }) } }
}

function slackForm({ canvasElement }: Context): HTMLFormElement {
  const form = canvasElement.querySelector<HTMLFormElement>('form')
  if (form === null) throw new Error('no Slack form')
  return form
}

async function openSteps({ canvas, userEvent }: Context): Promise<void> {
  const toggles = await canvas.findAllByRole('button', { expanded: false })
  await userEvent.click(toggles.at(-1)!)
}

async function fillForm(context: Context, withToken = true): Promise<void> {
  await context.canvas.findByRole('navigation')
  const [name, channel] = [...slackForm(context).querySelectorAll<HTMLInputElement>('input[type="text"]')]
  await context.userEvent.type(name!, 'alerts')
  await context.userEvent.type(channel!, '#alerts')
  if (withToken) await context.userEvent.type(slackForm(context).querySelector<HTMLInputElement>('input[type="password"]')!, DEMO_TOKEN)
}

async function submit(context: Context): Promise<void> {
  await fillForm(context)
  await context.userEvent.type(slackForm(context).querySelector<HTMLInputElement>('input[type="password"]')!, '{Enter}')
}

async function refuseThenSaveAnyway(context: Context): Promise<void> {
  await submit(context)
  const notice = await context.canvas.findByRole('alert')
  const button = notice.querySelector('button')
  if (button === null) throw new Error('no save anyway button')
  await context.userEvent.click(button)
}

export const Empty: Story = { args: staged() }
export const StepsOpen: Story = { args: staged(), play: openSteps }
export const FilledForm: Story = { args: staged(), play: fillForm }
export const Checking: Story = { args: staged(never), play: submit }
export const Confirmed: Story = { args: staged(() => ({ status: 'valid', workspace: 'Rill Team', bot: 'rill-bot' })), play: submit }
export const SavedButNotConfirmed: Story = { args: staged(() => ({ status: 'unverified', reason: 'network' })), play: submit }
export const RefusedWithSaveAnyway: Story = { args: staged(invalid), play: submit }
export const SavedAnywayAfterRefusal: Story = { args: staged(invalid), play: refuseThenSaveAnyway }
export const SavedBotsAndAnOldWebhook: Story = { args: staged(undefined, { connections: SAVED }) }
export const NoKeychain: Story = { args: staged(undefined, { encryptionAvailable: false, connections: SAVED }) }

const VERDICTS: ReadonlyArray<{ name: string; verdict: SlackVerdict }> = [
  { name: 'valid with workspace and bot', verdict: { status: 'valid', workspace: 'Rill Team', bot: 'rill-bot' } },
  { name: 'valid with a workspace only', verdict: { status: 'valid', workspace: 'Rill Team' } },
  { name: 'valid with a bot only', verdict: { status: 'valid', bot: 'rill-bot' } },
  { name: 'valid without details', verdict: { status: 'valid' } },
  { name: 'unverified forbidden', verdict: { status: 'unverified', reason: 'forbidden' } },
  { name: 'unverified rate limited', verdict: { status: 'unverified', reason: 'rate_limited' } },
  { name: 'unverified server error', verdict: { status: 'unverified', reason: 'server_error' } },
  { name: 'unverified network', verdict: { status: 'unverified', reason: 'network' } },
  { name: 'unverified timeout', verdict: { status: 'unverified', reason: 'timeout' } },
  { name: 'unverified unexpected answer', verdict: { status: 'unverified', reason: 'unexpected_status' } },
  { name: 'saved anyway', verdict: { status: 'invalid', reason: 'unauthorized' } },
]

const RESULTS: ReadonlyArray<{ name: string; view: SlackView }> = [
  { name: 'checking', view: { kind: 'checking' } },
  ...VERDICTS.map(({ name, verdict }) => ({ name, view: { kind: 'checked', verdict } }) as const),
  { name: 'refused', view: { kind: 'refused' } },
]

function Results() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 720, padding: 'var(--space-4)' }}>
      {RESULTS.map(({ name, view }) => (
        <section key={name} aria-label={name} style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <small style={{ color: 'var(--text-muted)' }}>{name}</small>
          <SlackResult view={view} />
        </section>
      ))}
    </div>
  )
}

function Pair({ themes, locales }: { themes: readonly Theme[]; locales: readonly ('ko' | 'en')[] }) {
  const locale = useLocale()
  const current = document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  const views: SlackView[] = [
    { kind: 'refused' },
    { kind: 'checked', verdict: { status: 'unverified', reason: 'forbidden' } },
    { kind: 'checked', verdict: { status: 'valid', workspace: 'Rill Team', bot: 'rill-bot' } },
  ]
  const cells = themes.length > 1 ? themes.map((theme) => ({ theme, locale })) : locales.map((value) => ({ theme: current as Theme, locale: value }))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {cells.map((cell) => (
        <ThemeProvider key={`${cell.theme}-${cell.locale}`} theme={cell.theme} locale={cell.locale}>
          <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--surface-base)', borderRadius: 'var(--radius-md)' }}>
            {views.map((view) => (
              <SlackResult key={view.kind === 'checked' ? view.verdict.status : view.kind} view={view} />
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
