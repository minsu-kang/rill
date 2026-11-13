import type { Hook, WorkflowSummary } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { ids } from '../../fixtures'
import { hookConnections, hookFixtures } from '../../fixtures/hooks'
import type { MessageKey } from '../../i18n'
import type { ConnectionSummary } from '../../shared/host-api'
import { HookEditor, type HookEditorProps } from './HookEditor'
import { NEW_HOOK_DRAFT, checkDraft, draftOf, sameDraft, type HookDraft } from './model/hooks'

const meta = { title: 'App/Agents/HookEditor', component: HookEditor } satisfies Meta<typeof HookEditor>
export default meta
type Story = StoryObj<typeof meta>

const WORKFLOWS: WorkflowSummary[] = [
  { id: ids.workflows.receipt, name: '영수증 정리', active: true, triggerType: 'trigger.folderWatch@1', createdAt: 3 },
  { id: ids.workflows.branching, name: '매일 서버 상태 확인', active: true, triggerType: 'trigger.cron@1', createdAt: 2 },
  { id: ids.workflows.webhook, name: 'Order webhook to Slack', active: false, triggerType: 'trigger.webhook@1', createdAt: 1 },
]

interface DemoProps {
  start?: HookDraft
  base?: HookDraft
  hook?: Hook
  saved?: readonly Hook[]
  connections?: readonly ConnectionSummary[] | undefined
  workflows?: 'ready' | 'loading' | 'error'
  notifyForbidden?: boolean
  busy?: boolean
  error?: MessageKey
  openSettings?: boolean
}

function Demo({ start = { ...NEW_HOOK_DRAFT, connection: 'team-slack' }, base, hook, saved = hookFixtures.some, connections = hookConnections, workflows = 'ready', notifyForbidden = false, busy = false, error, openSettings = false }: DemoProps) {
  const [draft, setDraft] = useState(start)
  const baseline = base ?? (hook === undefined ? NEW_HOOK_DRAFT : draftOf(hook))
  const check = checkDraft(draft, { workflowIds: workflows === 'ready' ? new Set(WORKFLOWS.map((item) => item.id)) : undefined, connections, notifyForbidden }, saved, hook?.id)
  return (
    <div style={{ maxWidth: 760, padding: 'var(--space-4)' }}>
      <HookEditor
        creating={hook === undefined}
        draft={draft}
        dirty={!sameDraft(draft, baseline)}
        check={check}
        workflows={{ status: workflows, items: workflows === 'ready' ? WORKFLOWS : [] }}
        connections={connections}
        busy={busy}
        error={error}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onSave={() => undefined}
        onCancel={() => undefined}
        {...(openSettings ? { onOpenConnections: () => undefined } : {})}
      />
    </div>
  )
}

const base: HookEditorProps = { creating: true, draft: NEW_HOOK_DRAFT, dirty: false, check: { problems: [], input: undefined, canSave: false }, workflows: { status: 'ready', items: [] }, connections: [], busy: false, error: undefined, onChange: () => undefined, onSave: () => undefined, onCancel: () => undefined }

export const NewNotice: Story = { name: 'New hook, a Slack notice', args: base, render: () => <Demo start={NEW_HOOK_DRAFT} /> }

export const NoticeFilled: Story = { name: 'A notice with a channel', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, event: 'plan.deployed', scopeId: ids.workflows.webhook, connection: 'team-slack', channel: '#releases' }} /> }

export const SwitchOff: Story = { name: 'Switch a workflow off', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, action: 'deactivateAfterFailures', count: '5' }} /> }

export const SwitchOffCountProblem: Story = { name: 'Switch off with a count out of range', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, action: 'deactivateAfterFailures', count: '21' }} /> }

export const RecordOnly: Story = { name: 'Only the activity log', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, action: 'record', event: 'run.succeeded' }} /> }

export const ChannelProblem: Story = { name: 'A channel with a space', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, connection: 'team-slack', channel: '#two words' }} /> }

export const WebhookWithChannel: Story = { name: 'A webhook with a channel', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, connection: 'ops-webhook', channel: '#alerts' }} /> }

export const BotWithoutChannel: Story = { name: 'A bot with no channel at all', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, connection: 'no-default-channel' }} /> }

export const Duplicate: Story = { name: 'A hook that is already saved', args: base, render: () => <Demo start={{ ...NEW_HOOK_DRAFT, connection: 'team-slack', channel: '#alerts' }} /> }

export const RuleForbidsNotice: Story = { name: 'A rule forbids the notice', args: base, render: () => <Demo notifyForbidden /> }

export const RuleForbidsNoticeSwitchedOff: Story = { name: 'A rule forbids the notice, saved switched off', args: base, render: () => <Demo notifyForbidden start={{ ...NEW_HOOK_DRAFT, connection: 'team-slack', enabled: false }} /> }

export const NoSlackConnection: Story = { name: 'No Slack connection, with the way to Settings', args: base, render: () => <Demo start={NEW_HOOK_DRAFT} connections={[{ name: 'api-main', kind: 'http' }]} openSettings /> }

export const NoSlackConnectionPlain: Story = { name: 'No Slack connection, without the way to Settings', args: base, render: () => <Demo start={NEW_HOOK_DRAFT} connections={[]} /> }

export const ConnectionsNotKnown: Story = { name: 'The connections are not known yet', args: base, render: () => <Demo start={NEW_HOOK_DRAFT} connections={undefined} /> }

export const WorkflowsLoading: Story = { name: 'The workflows are loading', args: base, render: () => <Demo workflows="loading" /> }

export const WorkflowsFailed: Story = { name: 'The workflows could not be loaded', args: base, render: () => <Demo workflows="error" /> }

export const EditWithGoneConnection: Story = {
  name: 'Edit a hook whose connection is gone',
  args: base,
  render: () => <Demo hook={hookFixtures.problems[0]!} start={draftOf(hookFixtures.problems[0]!)} saved={hookFixtures.problems} />,
}

export const EditChanged: Story = {
  name: 'Edit a hook, with unsaved changes',
  args: base,
  render: () => <Demo hook={hookFixtures.some[0]!} start={{ ...draftOf(hookFixtures.some[0]!), channel: '#ops' }} />,
}

export const Busy: Story = { name: 'Saving', args: base, render: () => <Demo busy /> }

export const SaveError: Story = { name: 'The engine refused the save', args: base, render: () => <Demo error="agents.hooks.error.HOOK_FULL" /> }
