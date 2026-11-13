import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { skillFixtures } from '../../fixtures/skills'
import type { SkillsState } from '../../engine/skills'
import { SkillsPicker } from './SkillsPicker'

const meta = { title: 'App/Agents/SkillsPicker', component: SkillsPicker } satisfies Meta<typeof SkillsPicker>
export default meta
type Story = StoryObj<typeof meta>

function Demo({ skills, start = [], disabled = false }: { skills: SkillsState; start?: string[]; disabled?: boolean }) {
  const [picked, setPicked] = useState<string[]>(start)
  return (
    <div style={{ width: 520, padding: 'var(--space-4)' }}>
      <SkillsPicker skills={skills} value={picked} disabled={disabled} onChange={setPicked} onRetry={() => undefined} />
    </div>
  )
}

const ready = (skills = skillFixtures.few): SkillsState => ({ status: 'ready', skills })
const unused = { skills: ready(), value: [], disabled: false, onChange: () => undefined, onRetry: () => undefined } as const

export const NothingChecked: Story = { name: 'Nothing checked', args: unused, render: () => <Demo skills={ready()} /> }

export const TwoChecked: Story = { name: 'Two checked', args: unused, render: () => <Demo skills={ready()} start={['skill-receipts', 'skill-slack']} /> }

export const NoSkillsYet: Story = { name: 'No skills yet', args: unused, render: () => <Demo skills={ready([])} /> }

export const Loading: Story = { args: unused, render: () => <Demo skills={{ status: 'loading', skills: [] }} /> }

export const LoadError: Story = { name: 'Load error', args: unused, render: () => <Demo skills={{ status: 'error', skills: [] }} /> }

export const NearTheCharacterLimit: Story = { name: 'Near the limit of 6,000 characters', args: unused, render: () => <Demo skills={ready(skillFixtures.big)} start={['skill-big-a', 'skill-big-b']} /> }

export const AtTheLimitOfEight: Story = {
  name: 'At the limit of 8 skills',
  args: unused,
  render: () => <Demo skills={ready(skillFixtures.full)} start={skillFixtures.full.slice(0, 8).map((skill) => skill.id)} />,
}

export const OverTheLimit: Story = { name: 'Over the limit (the list changed meanwhile)', args: unused, render: () => <Demo skills={ready(skillFixtures.big)} start={['skill-big-a', 'skill-big-b', 'skill-small']} /> }

export const Saving: Story = { args: unused, render: () => <Demo skills={ready()} start={['skill-slack']} disabled /> }

export const HostileNames: Story = { name: 'Hostile names', args: unused, render: () => <Demo skills={ready([...skillFixtures.hostile, ...skillFixtures.long])} start={['skill-hostile']} /> }
