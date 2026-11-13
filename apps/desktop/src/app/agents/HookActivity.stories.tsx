import type { Meta, StoryObj } from '@storybook/react-vite'
import { ids } from '../../fixtures'
import { hookFixtures, hookLogFixtures } from '../../fixtures/hooks'
import { createTranslator, useT } from '../../i18n'
import { truncate } from '../../model/text'
import { HookActivity, type HookActivityProps } from './HookActivity'
import { hookLabels } from './model/hooks'

const meta = { title: 'App/Agents/HookActivity', component: HookActivity } satisfies Meta<typeof HookActivity>
export default meta
type Story = StoryObj<typeof meta>

const NAMES = new Map([
  [ids.workflows.receipt, '영수증 정리'],
  [ids.workflows.branching, '매일 서버 상태 확인'],
  [ids.workflows.webhook, 'Order webhook to Slack'],
])

const clip = (text: string): string => truncate(text, 80)

function Demo(props: Pick<HookActivityProps, 'log' | 'hooks'>) {
  const t = useT()
  return (
    <div style={{ maxWidth: 760, padding: 'var(--space-4)' }}>
      <HookActivity {...props} visible={hookLabels(t, NAMES, clip)} names={NAMES} clip={clip} timeZone="UTC" onRefresh={() => undefined} />
    </div>
  )
}

const probe = createTranslator('en')
const base: HookActivityProps = { log: { status: 'ready', entries: [] }, hooks: [], visible: hookLabels(probe, NAMES, clip), names: NAMES, clip, timeZone: 'UTC', onRefresh: () => undefined }

export const Rows: Story = { name: 'Every result and code', args: base, render: () => <Demo log={{ status: 'ready', entries: [...hookLogFixtures.mixed].reverse() }} hooks={hookFixtures.some} /> }

export const NothingYet: Story = { name: 'Nothing yet', args: base, render: () => <Demo log={{ status: 'ready', entries: [] }} hooks={hookFixtures.some} /> }

export const Loading: Story = { args: base, render: () => <Demo log={{ status: 'loading', entries: [] }} hooks={hookFixtures.some} /> }

export const Refreshing: Story = { name: 'Refreshing, with the rows that it has', args: base, render: () => <Demo log={{ status: 'loading', entries: [...hookLogFixtures.mixed].reverse().slice(0, 4) }} hooks={hookFixtures.some} /> }

export const LoadFailed: Story = { name: 'Could not be loaded', args: base, render: () => <Demo log={{ status: 'error', entries: [] }} hooks={hookFixtures.some} /> }

export const FailedKeepingRows: Story = { name: 'Could not be refreshed, with the rows that it has', args: base, render: () => <Demo log={{ status: 'error', entries: [...hookLogFixtures.mixed].reverse().slice(0, 4) }} hooks={hookFixtures.some} /> }

export const FiftyRows: Story = { name: 'The last 50 rows', args: base, render: () => <Demo log={{ status: 'ready', entries: [...hookLogFixtures.many].reverse() }} hooks={hookFixtures.some} /> }

export const MeaningOpen: Story = {
  name: 'What the results mean, open',
  args: base,
  render: () => <Demo log={{ status: 'ready', entries: [...hookLogFixtures.mixed].reverse().slice(0, 2) }} hooks={hookFixtures.some} />,
  play: async ({ canvasElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    canvasElement.querySelector<HTMLElement>('details summary')?.click()
  },
}
