import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { createFakeClient } from '../../engine/fake-client'
import { withPlanMethods } from '../../engine/fake-plan'
import { catalog, fakeData } from '../../fixtures'
import { agentFixtures } from '../../fixtures/agents'
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
        agents: agentFixtures.few,
        activeAgentId: 'agent-terse',
        rules: ruleFixtures.some,
        violations: () => violationFixtures.one,
      }),
    [],
  )
  const [section, setSection] = useState<AgentsSectionId>(initial)
  return (
    <div style={{ height: 820, overflow: 'auto' }}>
      <Page>
        <AgentsTab client={client} catalog={catalog} section={section} onSectionChange={setSection} />
      </Page>
    </div>
  )
}

const base = { client: createFakeClient(fakeData), catalog, section: 'agents', onSectionChange: () => undefined } as const

export const AgentsScreenOpen: Story = { name: 'The Agents screen', args: base, render: () => <Demo initial="agents" /> }

export const RulesScreenOpen: Story = { name: 'The Rules screen', args: base, render: () => <Demo initial="rules" /> }
