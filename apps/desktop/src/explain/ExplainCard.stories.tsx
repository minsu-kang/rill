import type { Meta, StoryObj } from '@storybook/react-vite'
import { explainCases } from '../fixtures/explain'
import { useLocale } from '../i18n'
import { ThemeProvider } from '../theme/ThemeProvider'
import { ExplainCard } from './ExplainCard'

function LightAndDark() {
  const locale = useLocale()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {(['light', 'dark'] as const).map((theme) => (
        <ThemeProvider key={theme} theme={theme} locale={locale}>
          <div style={{ padding: 'var(--space-3)', background: 'var(--surface-base)', borderRadius: 'var(--radius-md)' }}>
            <ExplainCard result={explainCases.credentials} onAction={() => undefined} onProposeFix={() => undefined} />
          </div>
        </ThemeProvider>
      ))}
    </div>
  )
}

function BothLanguages() {
  const theme = document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {(['ko', 'en'] as const).map((locale) => (
        <ThemeProvider key={locale} theme={theme} locale={locale}>
          <div style={{ padding: 'var(--space-3)', background: 'var(--surface-base)', borderRadius: 'var(--radius-md)' }}>
            <ExplainCard result={explainCases.design} onAction={() => undefined} onProposeFix={() => undefined} />
          </div>
        </ThemeProvider>
      ))}
    </div>
  )
}

const meta = {
  title: 'Explain/ExplainCard',
  component: ExplainCard,
  args: { result: explainCases.configuration, onAction: () => undefined, onProposeFix: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExplainCard>

export default meta

type Story = StoryObj<typeof meta>

export const CauseConfiguration: Story = {}
export const CauseInputData: Story = { args: { result: explainCases.inputData } }
export const CauseExternalService: Story = { args: { result: explainCases.externalService } }
export const CauseCredentialsOrConnection: Story = { args: { result: explainCases.credentials } }
export const CausePermissionOrPath: Story = { args: { result: explainCases.permission } }
export const CauseRateLimitOrTimeout: Story = { args: { result: explainCases.rateLimit } }
export const CauseWorkflowDesign: Story = { args: { result: explainCases.design } }
export const CauseUnknown: Story = { args: { result: explainCases.unknown } }
export const NoActions: Story = { args: { result: explainCases.noActions } }
export const ThreeActions: Story = { args: { result: explainCases.threeActions } }
export const FixProposalWithHiddenMarker: Story = { args: { result: explainCases.hiddenText } }
export const TruncatedRecord: Story = { args: { result: explainCases.truncated } }
export const RepairedAnswer: Story = { args: { result: explainCases.repaired } }
export const CostUnknown: Story = { args: { result: explainCases.costUnknown } }
export const EffortLowered: Story = { args: { result: explainCases.effortLowered } }
export const ManySignals: Story = { args: { result: explainCases.manySignals } }
export const LongExplanation: Story = { args: { result: explainCases.longExplanation } }
export const HostileText: Story = { args: { result: explainCases.hostile } }
export const ConfirmStepOpen: Story = {
  args: { result: explainCases.threeActions },
  play: async ({ canvas, userEvent }) => {
    const buttons = await canvas.findAllByRole('button')
    await userEvent.click(buttons[1]!)
  },
}
export const LightAndDarkSideBySide: Story = { name: 'Light and dark side by side', render: () => <LightAndDark /> }
export const KoreanAndEnglishSideBySide: Story = { name: 'Korean and English side by side', render: () => <BothLanguages /> }
