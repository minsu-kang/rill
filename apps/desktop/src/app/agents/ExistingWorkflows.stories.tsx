import { RillError, type MethodName, type MethodResult } from '@rill/protocol'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { EngineClient } from '../../engine/client'
import { violationFixtures } from '../../fixtures/rules'
import type { RuleViolation } from '../../model/rules'
import { ExistingWorkflows } from './ExistingWorkflows'

const meta = { title: 'App/Agents/ExistingWorkflows', component: ExistingWorkflows } satisfies Meta<typeof ExistingWorkflows>
export default meta
type Story = StoryObj<typeof meta>

function clientOf(answer: readonly RuleViolation[] | 'hang' | 'fail'): EngineClient {
  return {
    onEvent: () => () => undefined,
    request: async <M extends MethodName>(): Promise<MethodResult<M>> => {
      if (answer === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (answer === 'fail') throw new RillError('INTERNAL', 'x')
      return { violations: [...answer] } as MethodResult<M>
    },
  }
}

const frame = (answer: readonly RuleViolation[] | 'hang' | 'fail') => ({ client: clientOf(answer) })

export const NoWorkflowBreaksARule: Story = { name: 'No workflow breaks a rule', args: frame([]) }

export const Checking: Story = { args: frame('hang') }

export const CheckFails: Story = { name: 'The check fails', args: frame('fail') }

export const OneWorkflow: Story = { name: 'One workflow', args: frame(violationFixtures.one) }

export const SeveralWorkflows: Story = { name: 'Several workflows', args: frame(violationFixtures.several) }

export const TwentyProblemsInOne: Story = { name: 'Twenty problems in one workflow', args: frame(violationFixtures.manyIssues) }

export const HostileAndLongText: Story = { name: 'Hostile and long text', args: frame(violationFixtures.hostile) }
