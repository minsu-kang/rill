import type { Meta, StoryObj } from '@storybook/react-vite'
import { ruleFixtures, violationFixtures } from '../../fixtures/rules'
import { chooseOption, pause, typeInto } from '../../story-utils/dom'
import { RulesStage, type RulesStageProps } from './RulesStage'

const meta: Meta<typeof RulesStage> = { title: 'App/Agents/RulesScreen', component: RulesStage }
export default meta
type Story = StoryObj<typeof RulesStage>

const some: RulesStageProps = { rules: ruleFixtures.some, violations: violationFixtures.several }

const hostInput = (root: HTMLElement): HTMLInputElement | null => root.querySelector<HTMLInputElement>('input[type="text"]')

function removeButton(root: HTMLElement, value: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('ul li button')].find((button) => (button.getAttribute('aria-label') ?? '').includes(value))
}

function confirmButton(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[role="dialog"] button:last-child')
}

async function typeHost(root: HTMLElement, text: string): Promise<void> {
  await pause(80)
  typeInto(hostInput(root), text)
}

export const Empty: Story = { name: 'No rules yet', args: {} }

export const SomeRules: Story = { name: 'Rules of every kind', args: some }

export const OnlyACap: Story = { name: 'Only a planning effort cap', args: { rules: ruleFixtures.capOnly } }

export const AtTheLimit: Story = { name: 'At the limit of 30 rules', args: { rules: ruleFixtures.full } }

export const Loading: Story = { args: { list: 'hang' } }

export const LoadError: Story = { name: 'Load error', args: { list: 'fail' } }

export const NodeChosen: Story = {
  name: 'A node type is chosen',
  args: {},
  play: async ({ canvasElement }) => {
    await pause(80)
    chooseOption(canvasElement.querySelector('select'), 'http.request')
  },
}

export const HostWithAProblem: Story = {
  name: 'Host with a problem',
  args: some,
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'https://api.example.com/v1/items')
  },
}

export const HostWildcardOnAddress: Story = {
  name: 'Wildcard in front of an address',
  args: some,
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, '*.127.0.0.1')
  },
}

export const HostWillBeNormalised: Story = {
  name: 'Host is saved in another form',
  args: some,
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'Bücher.Example.COM')
  },
}

export const HostAlreadyInTheList: Story = {
  name: 'Host is already in the list',
  args: some,
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'API.example.com')
  },
}

export const ConfirmRemoveNode: Story = {
  name: 'Confirm removing a forbidden node',
  args: some,
  play: async ({ canvasElement }) => {
    await pause(80)
    removeButton(canvasElement, 'http.request')?.click()
  },
}

export const ConfirmRemoveHost: Story = {
  name: 'Confirm removing an allowed host',
  args: some,
  play: async ({ canvasElement }) => {
    await pause(80)
    removeButton(canvasElement, 'api.example.com')?.click()
  },
}

export const ConfirmRemoveLastHost: Story = {
  name: 'Confirm removing the last allowed host',
  args: { rules: ruleFixtures.oneHost },
  play: async ({ canvasElement }) => {
    await pause(80)
    removeButton(canvasElement, 'api.example.com')?.click()
  },
}

export const ConfirmRemoveCap: Story = {
  name: 'Confirm removing the cap',
  args: some,
  play: async ({ canvasElement }) => {
    await pause(80)
    chooseOption(canvasElement.querySelectorAll('select')[1] ?? null, 'none')
  },
}

export const RemoveFails: Story = {
  name: 'Removing fails',
  args: { ...some, failDelete: 'INTERNAL' },
  play: async ({ canvasElement }) => {
    await pause(80)
    removeButton(canvasElement, 'http.request')?.click()
    await pause(40)
    confirmButton(canvasElement)?.click()
  },
}

function submitHost(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('button[type="submit"]')[1]?.click()
}

export const SaveFailsFull: Story = {
  name: 'Saving fails: all places used',
  args: { rules: ruleFixtures.some, failSave: { code: 'RULE_FULL' } },
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'new.example.com')
    await pause(40)
    submitHost(canvasElement)
  },
}

export const SaveFailsDuplicate: Story = {
  name: 'Saving fails: same rule',
  args: { rules: ruleFixtures.some, failSave: { code: 'RULE_DUPLICATE' } },
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'new.example.com')
    await pause(40)
    submitHost(canvasElement)
  },
}

export const SaveFailsInvalid: Story = {
  name: 'Saving fails: the engine refuses the value',
  args: { rules: ruleFixtures.some, failSave: { code: 'RULE_INVALID', problems: ['host_idn: the host name cannot be converted to its ASCII form'] } },
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'new.example.com')
    await pause(40)
    submitHost(canvasElement)
  },
}

export const SaveFailsOther: Story = {
  name: 'Saving fails: the engine is not answering',
  args: { rules: ruleFixtures.some, failSave: { code: 'INTERNAL' } },
  play: async ({ canvasElement }) => {
    await typeHost(canvasElement, 'new.example.com')
    await pause(40)
    submitHost(canvasElement)
  },
}

export const OneWorkflowBreaksARule: Story = { name: 'Existing workflows: one breaks a rule', args: { rules: ruleFixtures.some, violations: violationFixtures.one } }

export const SeveralWorkflowsBreakRules: Story = { name: 'Existing workflows: several break rules', args: some }

export const ManyProblemsInOneWorkflow: Story = { name: 'Existing workflows: twenty problems in one', args: { rules: ruleFixtures.some, violations: violationFixtures.manyIssues } }

export const HostileWorkflowText: Story = { name: 'Existing workflows: hostile and long text', args: { rules: ruleFixtures.some, violations: violationFixtures.hostile } }

export const CheckLoading: Story = { name: 'Existing workflows: checking', args: { rules: ruleFixtures.some, check: 'hang' } }

export const CheckError: Story = { name: 'Existing workflows: the check fails', args: { rules: ruleFixtures.some, check: 'fail' } }
