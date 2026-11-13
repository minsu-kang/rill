import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../engine/fake-host'
import { explainCases } from '../fixtures/explain'
import { fakeData, ids, receiptWorkflow } from '../fixtures'
import { createTranslator, type Locale } from '../i18n'
import { AppStage } from './AppStage'

const meta: Meta<typeof AppStage> = { title: 'App/Screen', component: AppStage }
export default meta
type Story = StoryObj<typeof AppStage>

const ready = fakeSettings({
  allowedFolders: ['/Users/demo/Receipts'],
  configuredProviders: ['anthropic', 'openai'],
  connections: [{ name: 'slack-ops', kind: 'slack' }],
})

async function press(canvasElement: HTMLElement, text: string, inside: string): Promise<HTMLButtonElement> {
  for (let tries = 0; tries < 100; tries += 1) {
    const root = canvasElement.querySelector(inside)
    const found = [...(root?.querySelectorAll('button') ?? [])].find((button) => button.textContent === text)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`no button ${text}`)
}

const LONG_NAME = '매일 아침 받은 편지함의 영수증을 모아서 월별 장부에 정리하고 팀 채널에 요약을 보내는 아주 긴 이름의 워크플로우 '.repeat(3).trim()

export const FirstRun: Story = { name: 'First run', args: { world: { workflows: [] } } }

export const Ready: Story = {
  name: 'Ready (workflow selected, succeeded run)',
  args: { world: { hostInit: { settings: ready } }, initial: { workflowId: ids.workflows.receipt, runId: ids.runs.receiptOk } },
}

export const FailedRunWithExplanation: Story = {
  name: 'Failed run with explanation',
  args: {
    world: { hostInit: { settings: ready }, explain: (params) => ({ ...structuredClone(explainCases.configuration), runId: params.runId }) },
    initial: { workflowId: ids.workflows.receipt, runId: ids.runs.receiptFailed },
  },
  play: async ({ canvasElement, userEvent, globals }) => {
    const t = createTranslator((globals['locale'] as Locale | undefined) === 'en' ? 'en' : 'ko')
    await userEvent.click(await press(canvasElement, t('explain.ask'), 'main'))
    await userEvent.click(await press(canvasElement, t('explain.notice.send'), 'main'))
  },
}

export const EngineRestarting: Story = {
  name: 'Engine restarting',
  args: { world: { hostInit: { settings: ready, engine: { state: 'restarting', restarts: 1 } } }, initial: { workflowId: ids.workflows.receipt } },
}

export const EngineStopped: Story = {
  name: 'Engine stopped',
  args: { world: { hostInit: { settings: ready, engine: { state: 'stopped', error: 'crashed', restarts: 6 } } } },
}

export const NoKeychain: Story = {
  name: 'No keychain',
  args: {
    world: { hostInit: { settings: fakeSettings({ encryptionAvailable: false }), engine: { state: 'stopped', error: 'no_keychain', restarts: 0 } } },
    initial: { tab: 'settings', settingsSection: 'keys' },
  },
}

export const NarrowWindow: Story = {
  name: 'Narrow window',
  args: { width: 900, world: { hostInit: { settings: ready } }, initial: { workflowId: ids.workflows.receipt, chatOpen: true } },
}

export const RecipesScreen: Story = {
  name: 'Recipes screen',
  args: { world: { hostInit: { settings: ready } }, initial: { tab: 'recipes' } },
}

export const SettingsFolders: Story = {
  name: 'Settings, folders',
  args: { world: { hostInit: { settings: ready } }, initial: { tab: 'settings', settingsSection: 'folders' } },
}

export const SettingsModel: Story = {
  name: 'Settings, model',
  args: { world: { hostInit: { settings: ready } }, initial: { tab: 'settings', settingsSection: 'model' } },
}

export const SettingsKeys: Story = {
  name: 'Settings, API keys',
  args: { world: { hostInit: { settings: ready } }, initial: { tab: 'settings', settingsSection: 'keys' } },
}

export const SettingsConnections: Story = {
  name: 'Settings, connections',
  args: { world: { hostInit: { settings: ready } }, initial: { tab: 'settings', settingsSection: 'connections' } },
}

export const GeneralSettings: Story = {
  name: 'General settings',
  args: { world: { hostInit: { settings: ready } }, initial: { tab: 'settings', settingsSection: 'general' } },
}

export const NarrowRecipes: Story = {
  name: 'Narrow window, recipes',
  args: { width: 700, world: { hostInit: { settings: ready } }, initial: { tab: 'recipes' } },
}

export const OneWorkflow: Story = {
  name: 'One workflow',
  args: { world: { hostInit: { settings: ready }, workflows: [fakeData.workflows[0]!] }, initial: { workflowId: ids.workflows.receipt } },
}

export const TwoWorkflows: Story = {
  name: 'Two workflows',
  args: { world: { hostInit: { settings: ready }, workflows: [fakeData.workflows[0]!, fakeData.workflows[2]!] }, initial: { workflowId: ids.workflows.webhook } },
}

export const LongWorkflowName: Story = {
  name: 'Long workflow name',
  args: {
    world: {
      hostInit: { settings: ready },
      workflows: [{ ...fakeData.workflows[0]!, workflow: { ...receiptWorkflow, name: LONG_NAME } }, fakeData.workflows[1]!],
    },
    initial: { workflowId: ids.workflows.receipt },
  },
}
