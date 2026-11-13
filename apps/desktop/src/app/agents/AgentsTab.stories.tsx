import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { createFakeClient } from '../../engine/fake-client'
import { withPlanMethods } from '../../engine/fake-plan'
import { catalog, fakeData } from '../../fixtures'
import { agentFixtures } from '../../fixtures/agents'
import { hookConnections, hookFixtures, hookLogFixtures } from '../../fixtures/hooks'
import { skillFixtures } from '../../fixtures/skills'
import { memoryFixtures, models, outcomeOf, results } from '../../fixtures/plan'
import { ruleFixtures, violationFixtures } from '../../fixtures/rules'
import { Page } from '../Page'
import { AgentsTab, type AgentsSectionId } from './AgentsTab'

const meta = { title: 'App/Agents/AgentsTab', component: AgentsTab } satisfies Meta<typeof AgentsTab>
export default meta
type Story = StoryObj<typeof meta>

function Demo({ initial }: { initial: AgentsSectionId }) {
  const client = useMemo(
    () =>
      withPlanMethods(createFakeClient(fakeData), {
        models,
        script: () => outcomeOf(results.workflow),
        memory: [...memoryFixtures.three],
        agents: [...agentFixtures.few, ...agentFixtures.skilled, ...agentFixtures.reviewers],
        skills: skillFixtures.few,
        activeAgentId: 'agent-terse',
        rules: ruleFixtures.some,
        violations: () => violationFixtures.one,
        hooks: hookFixtures.some,
        hookLog: hookLogFixtures.mixed,
        connections: hookConnections.map((entry) => ({ name: entry.name, kind: entry.kind })),
      }),
    [],
  )
  const [section, setSection] = useState<AgentsSectionId>(initial)
  return (
    <div style={{ height: 820, overflow: 'auto' }}>
      <Page>
        <AgentsTab client={client} catalog={catalog} connections={hookConnections} onOpenConnections={() => undefined} section={section} onSectionChange={setSection} />
      </Page>
    </div>
  )
}

const base = { client: createFakeClient(fakeData), catalog, section: 'agents', onSectionChange: () => undefined } as const

export const AgentsScreenOpen: Story = { name: 'The Agents screen', args: base, render: () => <Demo initial="agents" /> }

export const SkillsScreenOpen: Story = { name: 'The Skills screen', args: base, render: () => <Demo initial="skills" /> }

export const RulesScreenOpen: Story = { name: 'The Rules screen', args: base, render: () => <Demo initial="rules" /> }

export const HooksScreenOpen: Story = { name: 'The Hooks screen', args: base, render: () => <Demo initial="hooks" /> }
