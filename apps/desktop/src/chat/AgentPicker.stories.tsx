import { RillError, type Agent, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import type { EngineClient } from '../engine/client'
import { createFakeClient } from '../engine/fake-client'
import { withPlanMethods } from '../engine/fake-plan'
import { fakeData } from '../fixtures'
import { agentFixtures } from '../fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../fixtures/plan'
import { AgentPicker } from './AgentPicker'

interface World {
  agents?: readonly Agent[]
  activeAgentId?: string
  list?: 'hang' | 'fail'
  select?: 'fail'
}

function clientOf(world: World): EngineClient {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(world.agents === undefined ? {} : { agents: world.agents }),
    ...(world.activeAgentId === undefined ? {} : { activeAgentId: world.activeAgentId }),
  })
  return {
    onEvent: inner.onEvent,
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method === 'listAgents' && world.list === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listAgents' && world.list === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'setActiveAgent' && world.select === 'fail') throw new RillError('AGENT_NOT_FOUND', 'x')
      return inner.request(method, params)
    },
  }
}

function Demo({ world }: { world: World }) {
  const client = useMemo(() => clientOf(world), [world])
  return (
    <div style={{ width: 420, padding: 'var(--space-3)', border: '1px solid var(--border-default)' }}>
      <AgentPicker client={client} />
    </div>
  )
}

const meta = { title: 'Chat/AgentPicker', component: AgentPicker } satisfies Meta<typeof AgentPicker>

export default meta

type Story = StoryObj<typeof meta>

const unused = { client: {} as EngineClient } as const

const defaultOnly: World = {}
const few: World = { agents: agentFixtures.few, activeAgentId: 'agent-terse' }
const long: World = { agents: agentFixtures.long, activeAgentId: 'agent-long' }
const hostile: World = { agents: agentFixtures.hostile, activeAgentId: 'agent-hostile' }
const loading: World = { list: 'hang' }
const loadError: World = { list: 'fail' }
const changeFails: World = { agents: agentFixtures.few, select: 'fail' }

export const DefaultAgent: Story = { name: 'Default agent', args: unused, render: () => <Demo world={defaultOnly} /> }

export const CustomAgent: Story = { name: 'A custom agent is active', args: unused, render: () => <Demo world={few} /> }

export const LongName: Story = { name: 'Long name', args: unused, render: () => <Demo world={long} /> }

export const HostileName: Story = { name: 'Hostile name', args: unused, render: () => <Demo world={hostile} /> }

export const Loading: Story = { args: unused, render: () => <Demo world={loading} /> }

export const LoadError: Story = { name: 'Load error', args: unused, render: () => <Demo world={loadError} /> }

export const ChangeFails: Story = {
  name: 'Changing the agent fails',
  args: unused,
  render: () => <Demo world={changeFails} />,
  play: async ({ canvasElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 60))
    const select = canvasElement.querySelector('select')
    if (select === null) return
    select.value = 'agent-terse'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  },
}
