import { RillError, type RunSummary } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { createFakeClient } from '../engine/fake-client'
import { withExplainMethod, type ExplainScript } from '../engine/fake-explain'
import { fakeData, fixtureRuns, ids } from '../fixtures'
import { explainCases } from '../fixtures/explain'
import { ExplainPanel, type ExplainPanelProps } from './ExplainPanel'

const run = (id: string): RunSummary => fixtureRuns.find((item) => item.id === id)!
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-5' }

function Wired({ script, ...rest }: Omit<ExplainPanelProps, 'client' | 'onAction' | 'onProposeFix'> & { script: ExplainScript }) {
  const client = useMemo(() => withExplainMethod(createFakeClient(fakeData), script), [script])
  const [log, setLog] = useState<string[]>([])
  const note = (line: string): void => setLog((previous) => [line, ...previous].slice(0, 5))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <ExplainPanel
        {...rest}
        client={client}
        onAction={(action, context) => note(`onAction ${action} ${context.nodeId ?? '-'}`)}
        onProposeFix={(proposal) => note(`onProposeFix ${proposal.nodeId}: ${proposal.requestText}`)}
      />
      {log.length > 0 && (
        <ol style={{ margin: 0, padding: 'var(--space-2) var(--space-4)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
          {log.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      )}
    </div>
  )
}

const FAILED = run(ids.runs.receiptFailed)
const credentialsScript: ExplainScript = () => explainCases.credentials
const meta = {
  title: 'Explain/ExplainPanel',
  component: Wired,
  args: { run: FAILED, model: MODEL, script: credentialsScript },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Wired>

export default meta

type Story = StoryObj<typeof meta>

const clickFirstButtonTwice: Story['play'] = async ({ canvas, userEvent }) => {
  await userEvent.click((await canvas.findAllByRole('button'))[0]!)
  await userEvent.click((await canvas.findAllByRole('button'))[0]!)
}

const clickFirstButtonOnce: Story['play'] = async ({ canvas, userEvent }) => {
  await userEvent.click((await canvas.findAllByRole('button'))[0]!)
}

const failing = (code: string): ExplainScript => () => new RillError(code, 'the server text is never shown')

export const FailedRunReady: Story = {}
export const NoRunPicked: Story = { args: { run: undefined } }
export const RunStillQueued: Story = { args: { run: run(ids.runs.receiptQueued) } }
export const RunStillRunning: Story = { args: { run: run(ids.runs.branchingRunning) } }
export const RunSucceeded: Story = { args: { run: run(ids.runs.receiptOk) } }
export const RunCancelled: Story = { args: { run: run(ids.runs.webhookCancelled) } }
export const NoticeBeforeFirstRequest: Story = { play: clickFirstButtonOnce }
export const NoticeProviderUnknown: Story = { args: { model: undefined }, play: clickFirstButtonOnce }
export const Loading: Story = { args: { script: () => 'hang' }, play: clickFirstButtonTwice }
export const AnswerWithThreeActions: Story = { args: { script: () => explainCases.threeActions }, play: clickFirstButtonTwice }
export const AnswerWithFixProposal: Story = { args: { script: () => explainCases.hiddenText }, play: clickFirstButtonTwice }
export const AnswerHostileText: Story = { args: { script: () => explainCases.hostile }, play: clickFirstButtonTwice }
export const ErrorNotFound: Story = { args: { script: failing('NOT_FOUND') }, play: clickFirstButtonTwice }
export const ErrorNotExplainable: Story = { args: { script: failing('RUN_NOT_EXPLAINABLE') }, play: clickFirstButtonTwice }
export const ErrorProviderMissing: Story = { args: { script: failing('LLM_UNAVAILABLE') }, play: clickFirstButtonTwice }
export const ErrorBusy: Story = { args: { script: failing('EXPLAIN_BUSY') }, play: clickFirstButtonTwice }
export const ErrorProvider: Story = { args: { script: failing('EXPLAIN_PROVIDER') }, play: clickFirstButtonTwice }
export const ErrorInvalidAnswer: Story = { args: { script: failing('EXPLAIN_INVALID') }, play: clickFirstButtonTwice }
export const ErrorInvalidParams: Story = { args: { script: failing('INVALID_PARAMS') }, play: clickFirstButtonTwice }
export const ErrorOther: Story = { args: { script: failing('INTERNAL') }, play: clickFirstButtonTwice }
