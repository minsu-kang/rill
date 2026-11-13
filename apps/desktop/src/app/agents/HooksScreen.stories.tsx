import type { Meta, StoryObj } from '@storybook/react-vite'
import type { Rule } from '@rill/protocol'
import { ids } from '../../fixtures'
import { hookConnections, hookFixtures, hookLogFixtures, hookOf } from '../../fixtures/hooks'
import { chooseOption, pause, typeInto } from '../../story-utils/dom'
import { HooksStage, type HooksStageProps } from './HooksStage'

const meta: Meta<typeof HooksStage> = { title: 'App/Agents/HooksScreen', component: HooksStage }
export default meta
type Story = StoryObj<typeof HooksStage>

const some: HooksStageProps = { hooks: hookFixtures.some, hookLog: hookLogFixtures.mixed }
const forbidNotify: Rule[] = [{ id: 'rule-notify', kind: 'forbidNode', value: 'notify.slack', createdAt: 1 }]

const field = (root: HTMLElement, name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-hook-field="${name}"]`)
const select = (root: HTMLElement, name: string): HTMLSelectElement | null => field(root, name) as HTMLSelectElement | null
const input = (root: HTMLElement, name: string): HTMLInputElement | null => field(root, name) as HTMLInputElement | null
const press = (root: HTMLElement, selector: string): void => root.querySelector<HTMLElement>(selector)?.click()

async function openNew(root: HTMLElement): Promise<void> {
  await pause(120)
  press(root, '[data-hook-new]')
  await pause(60)
}

async function openEdit(root: HTMLElement, id: string): Promise<void> {
  await pause(120)
  press(root, `[data-hook-edit="${id}"]`)
  await pause(60)
}

export const Empty: Story = { name: 'No hooks yet', args: {} }

export const SomeHooks: Story = { name: 'Hooks of every kind, with activity', args: some }

export const Loading: Story = { args: { list: 'hang' } }

export const LoadError: Story = { name: 'Load error', args: { list: 'fail' } }

export const StaleList: Story = {
  name: 'The list could not be refreshed',
  args: { ...some, list: 'failLater', failSave: { code: 'HOOK_NOT_FOUND' } },
  play: async ({ canvasElement }) => {
    await pause(150)
    canvasElement.querySelector<HTMLInputElement>('li input[type="checkbox"]')?.click()
  },
}

export const ProblemHooks: Story = { name: 'Hooks that cannot post', args: { hooks: hookFixtures.problems } }

export const RuleForbidsNotice: Story = { name: 'A rule forbids the Slack message node', args: { ...some, rules: forbidNotify } }

export const AtTheLimit: Story = { name: 'At the limit of 20 hooks', args: { hooks: hookFixtures.full } }

export const HostileNames: Story = {
  name: 'Hostile names',
  args: { hooks: hookFixtures.hostile, hookLog: hookLogFixtures.hostile, workflows: 'hostile', connections: [...hookConnections, { name: hookFixtures.hostileConnection, kind: 'slack' }] },
}

export const NoticeForm: Story = {
  name: 'New hook, a Slack notice',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
  },
}

export const NoticeFormFilled: Story = {
  name: 'New hook, filled, with the message preview',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'event'), 'plan.deployed')
    chooseOption(select(canvasElement, 'scope'), ids.workflows.webhook)
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
    await pause(40)
    typeInto(input(canvasElement, 'channel'), '#releases')
  },
}

export const NoticeFormHostileName: Story = {
  name: 'New hook, preview of a hostile workflow name',
  args: { ...some, workflows: 'hostile' },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'scope'), 'wf-hostile')
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
  },
}

export const SwitchOffForm: Story = {
  name: 'New hook, switch a workflow off',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'action'), 'deactivateAfterFailures')
    await pause(40)
    chooseOption(select(canvasElement, 'scope'), ids.workflows.branching)
  },
}

export const CountOutOfRange: Story = {
  name: 'Count out of range',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'action'), 'deactivateAfterFailures')
    await pause(40)
    typeInto(input(canvasElement, 'count'), '1')
  },
}

export const RecordForm: Story = {
  name: 'New hook, only the activity log',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'action'), 'record')
    await pause(40)
    chooseOption(select(canvasElement, 'event'), 'run.succeeded')
  },
}

export const ChannelProblem: Story = {
  name: 'A channel with a space',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
    await pause(40)
    typeInto(input(canvasElement, 'channel'), '#two words')
  },
}

export const WebhookWithChannel: Story = {
  name: 'A webhook with a channel',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'connection'), 'ops-webhook')
    await pause(40)
    typeInto(input(canvasElement, 'channel'), '#alerts')
  },
}

export const BotWithoutAChannel: Story = {
  name: 'A bot with no channel at all',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'connection'), 'no-default-channel')
  },
}

export const DuplicateHook: Story = {
  name: 'A hook that is already saved',
  args: some,
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
    await pause(40)
    typeInto(input(canvasElement, 'channel'), '#alerts')
  },
}

export const FormWithRuleForbidding: Story = {
  name: 'A rule forbids the notice: it can be saved switched off',
  args: { ...some, rules: forbidNotify },
  play: async ({ canvasElement }) => {
    await pause(200)
    press(canvasElement, '[data-hook-new]')
    await pause(60)
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
  },
}

export const NoSlackConnection: Story = {
  name: 'No Slack connection, with the way to Settings',
  args: { ...some, connections: [{ name: 'api-main', kind: 'http' }], openSettings: true },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
  },
}

export const NoSlackConnectionPlain: Story = {
  name: 'No Slack connection, without the way to Settings',
  args: { ...some, connections: [] },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
  },
}

export const ConnectionsNotKnownYet: Story = {
  name: 'The connections are not known yet',
  args: { ...some, connections: 'unknown' },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
  },
}

export const WorkflowsNotLoaded: Story = {
  name: 'The workflows could not be loaded',
  args: { ...some, workflowList: 'fail' },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
  },
}

export const EditHook: Story = {
  name: 'Edit a hook',
  args: some,
  play: async ({ canvasElement }) => {
    await openEdit(canvasElement, 'hook-failed-all')
    typeInto(input(canvasElement, 'channel'), '#ops')
  },
}

export const EditHookWithGoneConnection: Story = {
  name: 'Edit a hook whose connection is not saved any more',
  args: { hooks: hookFixtures.problems },
  play: async ({ canvasElement }) => {
    await openEdit(canvasElement, 'hook-missing-connection')
  },
}

export const EditWithUnsavedPrompt: Story = {
  name: 'Another hook is opened while the form has changes',
  args: some,
  play: async ({ canvasElement }) => {
    await openEdit(canvasElement, 'hook-failed-all')
    typeInto(input(canvasElement, 'channel'), '#ops')
    await pause(40)
    press(canvasElement, '[data-hook-edit="hook-ok-webhook"]')
  },
}

export const ConfirmDelete: Story = {
  name: 'Confirm deleting a hook',
  args: some,
  play: async ({ canvasElement }) => {
    await pause(150)
    press(canvasElement, '[data-hook-delete="hook-failed-all"]')
  },
}

export const DeleteFails: Story = {
  name: 'Deleting fails',
  args: { ...some, failDelete: 'INTERNAL' },
  play: async ({ canvasElement }) => {
    await pause(150)
    press(canvasElement, '[data-hook-delete="hook-deployed"]')
    await pause(60)
    document.querySelector<HTMLElement>('[role="dialog"] button:last-child')?.click()
  },
}

export const SaveRefusedAsFull: Story = {
  name: 'Save refused: the engine says the list is full',
  args: { ...some, failSave: { code: 'HOOK_FULL' } },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
    await pause(40)
    press(canvasElement, '[data-hook-save]')
  },
}

export const SaveRefusedAsInvalid: Story = {
  name: 'Save refused: a workflow that is gone',
  args: { ...some, failSave: { code: 'HOOK_INVALID', problems: ['scope.unknown_workflow: the workflow does not exist'] } },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'connection'), 'team-slack')
    await pause(40)
    press(canvasElement, '[data-hook-save]')
  },
}

export const SaveFails: Story = {
  name: 'Save fails for no known reason',
  args: { ...some, failSave: { code: 'INTERNAL' } },
  play: async ({ canvasElement }) => {
    await openNew(canvasElement)
    chooseOption(select(canvasElement, 'action'), 'record')
    await pause(40)
    press(canvasElement, '[data-hook-save]')
  },
}

export const SwitchedOff: Story = {
  name: 'A hook is switched off',
  args: some,
  play: async ({ canvasElement }) => {
    await pause(150)
    canvasElement.querySelector<HTMLInputElement>('li input[type="checkbox"]')?.click()
  },
}

export const ActivityEmpty: Story = { name: 'Activity: nothing yet', args: { hooks: hookFixtures.some } }

export const ActivityLoading: Story = { name: 'Activity: loading', args: { hooks: hookFixtures.some, log: 'hang' } }

export const ActivityError: Story = { name: 'Activity: could not be loaded', args: { hooks: hookFixtures.some, log: 'fail' } }

export const ActivityFull: Story = { name: 'Activity: the last 50 rows', args: { hooks: hookFixtures.some, hookLog: hookLogFixtures.many } }

export const ActivityMeaning: Story = {
  name: 'Activity: what the results mean',
  args: some,
  play: async ({ canvasElement }) => {
    await pause(200)
    press(canvasElement, 'details summary')
  },
}

export const ActivityOfDeletedHook: Story = {
  name: 'Activity: a hook that is deleted',
  args: { hooks: [hookOf('hook-deployed', 'plan.deployed', { type: 'all' }, { type: 'record' })], hookLog: hookLogFixtures.mixed },
}

export const NarrowWindow: Story = { name: 'A narrow window', args: { ...some, width: 420 } }
