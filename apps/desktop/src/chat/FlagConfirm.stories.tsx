import { flagKey, type Flag } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { results } from '../fixtures/plan'
import { FlagConfirm } from './FlagConfirm'

function flagsOf(result: typeof results.flagged): Flag[] {
  if (result.kind !== 'workflow') throw new Error('workflow expected')
  return result.flags
}

const titles = { c1: 'Condition', n2: 'HTTP request', n3: 'Append CSV row', c2: 'Condition', n4: 'Append CSV row', n5: 'Slack message' }

function Demo({ flags, start = [], disabled }: { flags: Flag[]; start?: string[]; disabled?: boolean }) {
  const [confirmed, setConfirmed] = useState<string[]>(start)
  return (
    <div style={{ width: 460, padding: 'var(--space-4)' }}>
      <FlagConfirm
        flags={flags}
        confirmed={confirmed}
        disabled={disabled}
        nodeTitles={titles}
        onToggle={(key) => setConfirmed((previous) => (previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key]))}
      />
    </div>
  )
}

const hostile: Flag[] = [
  { nodeId: 'n‮<img src=x>', pointer: '/nodes/<script>alert(1)</script>', code: 'new_egress_target', message: `<a href="https://evil.example">Looks safe</a> ${'text '.repeat(200)}` },
  { nodeId: 'n‮<img src=x>', pointer: `/${'deep/'.repeat(60)}`, code: 'untrusted_flow', message: '**bold** [link](https://evil.example)' },
]

const meta = { title: 'Chat/FlagConfirm', component: FlagConfirm, args: { flags: [], confirmed: [], onToggle: () => undefined } } satisfies Meta<typeof FlagConfirm>

export default meta

type Story = StoryObj<typeof meta>

export const OneOfEachCode: Story = { name: 'One flag of each code', render: () => <Demo flags={flagsOf(results.flagged)} /> }

export const NineFlags: Story = { name: 'Three flags of each code', render: () => <Demo flags={flagsOf(results.manyFlags)} /> }

export const PartlyConfirmed: Story = { name: 'Partly confirmed', render: () => <Demo flags={flagsOf(results.flagged)} start={[flagKey(flagsOf(results.flagged)[0]!)]} /> }

export const AllConfirmedAndLocked: Story = { name: 'All confirmed and locked', render: () => <Demo flags={flagsOf(results.flagged)} start={flagsOf(results.flagged).map(flagKey)} disabled /> }

export const HostileText: Story = { name: 'Hostile text', render: () => <Demo flags={hostile} /> }
