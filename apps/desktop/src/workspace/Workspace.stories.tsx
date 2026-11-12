import type { EngineEvent } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useState } from 'react'
import { createFakeClient } from '../engine/fake-client'
import { catalog, fakeData, FIXTURE_NOW, ids } from '../fixtures'
import { branchingEvents, failingReceiptEvents, liveFakeData, liveIds } from '../fixtures/live'
import { useT } from '../i18n'
import { Workspace } from './Workspace'

const client = createFakeClient(fakeData)
const empty = createFakeClient({ workflows: [], runs: [], steps: {}, catalog })
const COMMON = { now: FIXTURE_NOW, timeZone: 'Asia/Seoul' } as const

function describe(event: EngineEvent): string {
  const node = 'nodeId' in event ? ` · ${event.nodeId}` : ''
  const attempt = 'attempt' in event ? ` #${event.attempt}` : ''
  const retry = 'willRetry' in event && event.willRetry ? ' (retry)' : ''
  return `${event.type}${node}${attempt}${retry}`
}

interface LiveProps {
  workflowId: string
  runId: string
  script: (runId: string) => EngineEvent[]
  intervalMs: number
}

function LiveRound({ workflowId, runId, script, intervalMs, onReplay }: LiveProps & { onReplay(): void }) {
  const t = useT()
  const fake = useMemo(() => createFakeClient(liveFakeData()), [])
  const [log, setLog] = useState<EngineEvent[]>([])

  useEffect(() => {
    const off = fake.onEvent((event) => setLog((previous) => [...previous, event]))
    const stop = fake.play(runId, script(runId), undefined, intervalMs)
    return () => {
      stop()
      off()
    }
  }, [fake, runId, script, intervalMs])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Workspace client={fake} workflowId={workflowId} initialRunId={runId} {...COMMON} />
      </div>
      <section aria-label={t('workspace.timeline')} style={{ padding: 'var(--space-2) var(--space-4)', borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-raised)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          <strong style={{ fontSize: 'var(--font-size-sm)' }}>{t('workspace.timeline')}</strong>
          <button type="button" onClick={onReplay} style={{ font: 'inherit' }}>
            {t('workspace.replay')}
          </button>
        </div>
        {log.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>{t('workspace.timelineEmpty')}</p>
        ) : (
          <ol style={{ display: 'flex', gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none', overflowX: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
            {log.map((event, index) => (
              <li key={index} style={{ flex: 'none', padding: '2px var(--space-2)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)' }}>
                {describe(event)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function Live(props: LiveProps) {
  const [round, setRound] = useState(0)
  return <LiveRound key={round} {...props} onReplay={() => setRound((current) => current + 1)} />
}

const meta = {
  title: 'Workspace/Workspace',
  component: Workspace,
  args: { client, workflowId: ids.workflows.receipt, ...COMMON },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Workspace>

export default meta

type Story = StoryObj<typeof meta>

export const NoRunOpen: Story = {}

export const StaticRun: Story = { args: { initialRunId: ids.runs.receiptOk, initialNodeId: 'extract' } }

export const FailedRun: Story = { args: { initialRunId: ids.runs.receiptFailed, initialNodeId: 'extract' } }

export const SkippedBranch: Story = { args: { workflowId: ids.workflows.branching, initialRunId: ids.runs.branchingSkipped, initialNodeId: 'alert' } }

export const ContinuedAfterError: Story = { args: { workflowId: ids.workflows.branching, initialRunId: ids.runs.branchingContinued, initialNodeId: 'check' } }

export const InterruptedRun: Story = { args: { workflowId: ids.workflows.webhook, initialRunId: ids.runs.webhookAbandoned, initialNodeId: 'forward' } }

export const HostileRunData: Story = { args: { initialRunId: ids.runs.receiptHostile, initialNodeId: 'extract' } }

export const LiveBranching: Story = {
  name: 'Live (retry, continue, skip)',
  render: () => <Live workflowId={ids.workflows.branching} runId={liveIds.branching} script={branchingEvents} intervalMs={1000} />,
}

export const LiveFailing: Story = {
  name: 'Live (fails after three attempts)',
  render: () => <Live workflowId={ids.workflows.receipt} runId={liveIds.receiptFails} script={failingReceiptEvents} intervalMs={1000} />,
}

export const NoWorkflow: Story = { args: { client: empty, workflowId: undefined } }

export const WorkflowNotFound: Story = { args: { workflowId: 'wf-deleted' } }

export const RunNotFound: Story = { args: { initialRunId: 'run-deleted' } }
