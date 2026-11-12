import type { Meta, StoryObj } from '@storybook/react-vite'
import { catalog } from '../fixtures'
import { recipeDrafts } from '../fixtures/recipes'
import { useLocale } from '../i18n'
import { ThemeProvider } from '../theme/ThemeProvider'
import { DraftPreview } from './DraftPreview'

const RECEIPT = recipeDrafts['receipt-folder-to-csv']!
const HEALTH = recipeDrafts['daily-health-check']!

function SideBySide() {
  const locale = useLocale()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
      {(['light', 'dark'] as const).map((theme) => (
        <ThemeProvider key={theme} theme={theme} locale={locale}>
          <div style={{ padding: 'var(--space-3)', background: 'var(--surface-base)', borderRadius: 'var(--radius-md)' }}>
            <DraftPreview draft={RECEIPT} catalog={catalog} deploy={{ phase: 'idle' }} onDeploy={() => undefined} onEdit={() => undefined} />
          </div>
        </ThemeProvider>
      ))}
    </div>
  )
}

const meta = {
  title: 'Recipes/DraftPreview',
  component: DraftPreview,
  args: { draft: HEALTH, catalog, deploy: { phase: 'idle' }, onDeploy: () => undefined, onEdit: () => undefined, onAction: () => undefined, onDone: () => undefined },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DraftPreview>

export default meta

type Story = StoryObj<typeof meta>

export const WithoutModelTransfer: Story = {}
export const WithModelTransfer: Story = { args: { draft: RECEIPT } }
export const WithBothSideEffects: Story = { args: { draft: recipeDrafts['receipt-big-amount-alert']! } }
export const NoSideEffects: Story = { args: { draft: { ...HEALTH, summary: { ...HEALTH.summary, sideEffects: [] } } } }
export const Deploying: Story = { args: { deploy: { phase: 'deploying' } } }
export const Deployed: Story = { args: { deploy: { phase: 'deployed', workflowId: 'wf-recipe-deployed' } } }
export const DeployFailed: Story = { args: { deploy: { phase: 'failed', key: 'recipes.deployError.invalid' } } }
export const LightAndDarkSideBySide: Story = { name: 'Light and dark side by side', render: () => <SideBySide /> }
