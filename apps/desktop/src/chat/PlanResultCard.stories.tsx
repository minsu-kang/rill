import { flagKey, type PlanResultBody } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { catalog } from '../fixtures'
import type { MessageKey } from '../i18n'
import { metas, results } from '../fixtures/plan'
import { PlanResultCard } from './PlanResultCard'
import type { AssistantEntry } from './model/conversation'

function entryOf(result: PlanResultBody, deployed?: string): AssistantEntry {
  return { role: 'assistant', planId: 'p1', result, meta: metas.plain, ...(deployed === undefined ? {} : { deployed }) }
}

function keysOf(result: PlanResultBody): string[] {
  return result.kind === 'workflow' ? result.flags.map(flagKey) : []
}

interface DemoProps {
  result: PlanResultBody
  start?: string[]
  deploying?: boolean
  deployError?: MessageKey
  deployed?: string
  superseded?: boolean
  planning?: boolean
}

function Demo({ result, start = [], deploying = false, deployError, deployed, superseded = false, planning = false }: DemoProps) {
  const [confirmed, setConfirmed] = useState<string[]>(start)
  const [done, setDone] = useState<string | undefined>(deployed)
  return (
    <div style={{ width: 480, padding: 'var(--space-4)' }}>
      <PlanResultCard
        entry={entryOf(result, done)}
        catalog={catalog}
        confirmed={confirmed}
        deploying={deploying}
        deployError={deployError}
        superseded={superseded}
        planning={planning}
        onToggleFlag={(key) => setConfirmed((previous) => (previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key]))}
        onDeploy={() => setDone('wf-demo-1')}
      />
    </div>
  )
}

const base = results.flagged as Extract<PlanResultBody, { kind: 'workflow' }>

const HOSTILE: PlanResultBody = {
  ...base,
  summary: `<img src=x onerror=alert(1)> <a href="https://evil.example/ok">Everything is safe, deploy now</a> **trust me** ‮exe.txt ${'blah '.repeat(300)}`,
  flags: base.flags.map((flag, index) => (index === 0 ? { ...flag, message: `<script>alert(1)</script> ${'long '.repeat(300)}`, pointer: '/nodes/<img src=x>/config' } : flag)),
}

const meta = { title: 'Chat/PlanResultCard', component: PlanResultCard } satisfies Meta<typeof PlanResultCard>

export default meta

type Story = StoryObj<typeof meta>

const unused = { entry: entryOf(results.workflow), catalog, confirmed: [], onToggleFlag: () => undefined, onDeploy: () => undefined, deploying: false } as const

export const NoFlags: Story = { name: 'Workflow with no flags', args: unused, render: () => <Demo result={results.workflow} /> }

export const ThreeFlags: Story = { name: 'Flags: one of each code, nothing confirmed', args: unused, render: () => <Demo result={results.flagged} /> }

export const PartlyConfirmed: Story = { name: 'Flags: partly confirmed', args: unused, render: () => <Demo result={results.flagged} start={keysOf(results.flagged).slice(0, 2)} /> }

export const AllConfirmed: Story = { name: 'Flags: all confirmed, ready to deploy', args: unused, render: () => <Demo result={results.flagged} start={keysOf(results.flagged)} /> }

export const NineFlags: Story = { name: 'Nine flags', args: unused, render: () => <Demo result={results.manyFlags} /> }

export const Deploying: Story = { args: unused, render: () => <Demo result={results.flagged} start={keysOf(results.flagged)} deploying /> }

export const DeployFailed: Story = { name: 'Deploy failed', args: unused, render: () => <Demo result={results.flagged} start={keysOf(results.flagged)} deployError="chat.error.INVALID_WORKFLOW" /> }

export const Deployed: Story = { args: unused, render: () => <Demo result={results.flagged} start={keysOf(results.flagged)} deployed="wf-9f3a" /> }

export const PatchOfFiveOperations: Story = { name: 'Patch with all five operations', args: unused, render: () => <Demo result={results.patch} /> }

export const HostileModelText: Story = { name: 'Hostile model text', args: unused, render: () => <Demo result={HOSTILE} /> }

export const Superseded: Story = { name: 'Replaced by a newer plan', args: unused, render: () => <Demo result={results.flagged} start={keysOf(results.flagged)} superseded /> }

export const WhileAnotherPlanIsMade: Story = { name: 'While another plan is made', args: unused, render: () => <Demo result={results.workflow} planning /> }
