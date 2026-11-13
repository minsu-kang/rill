import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App, type AppProps } from '../src/app/App'
import { createFakeWorld, type FakeWorldOptions } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { fakeSettings } from '../src/engine/fake-host'
import { ids } from '../src/fixtures'
import { hookFixtures, hookLogFixtures } from '../src/fixtures/hooks'
import { createTranslator } from '../src/i18n'
import { renderThemed } from './render'

const t = createTranslator('en')
const READY = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'slack-ops', kind: 'slack' }, { name: 'api-main', kind: 'http' }] })
const NO_SLACK = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'api-main', kind: 'http' }] })

function mount(initial: AppProps['initial'], extra: FakeWorldOptions = {}, settings = READY) {
  const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings }, control: { stepIntervalMs: 0 }, ...extra })
  renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App initial={initial} />
    </HostProvider>,
    { locale: 'en' },
  )
  return { world, user: userEvent.setup() }
}

const main = (): HTMLElement => screen.getByRole('main')
const subNav = (): HTMLElement => within(main()).getByRole('navigation', { name: 'Agent settings' })
const saved = (): HTMLElement => screen.getByRole('region', { name: 'Saved hooks' })

describe('the Hooks entry of the Agents tab in the app', () => {
  it('is the last entry of the sub-navigation, and opens the Hooks screen', async () => {
    const { user } = mount({ tab: 'agents' })
    await screen.findByRole('list', { name: 'Agent list' })
    expect(within(subNav()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Agents', 'Skills', 'Rules', 'Hooks'])
    await user.click(within(subNav()).getByRole('button', { name: 'Hooks' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Hooks' })).toBeTruthy()
    expect(within(subNav()).getByRole('button', { name: 'Hooks' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('list', { name: 'Agent list' })).toBeNull()
  })

  it('can start on the Hooks screen, and remembers it when the person visits another tab', async () => {
    const { user } = mount({ tab: 'agents', agentsSection: 'hooks' })
    await screen.findByRole('region', { name: 'Saved hooks' })
    const top = within(screen.getByRole('navigation', { name: t('app.top.screens') }))
    await user.click(top.getByRole('button', { name: 'Recipes' }))
    await user.click(top.getByRole('button', { name: 'Agents' }))
    expect(await screen.findByRole('region', { name: 'Saved hooks' })).toBeTruthy()
  })

  it('offers the Slack connections of the settings, and no other kind', async () => {
    const { user } = mount({ tab: 'agents', agentsSection: 'hooks' })
    await screen.findByRole('region', { name: 'Saved hooks' })
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    const form = await screen.findByRole('region', { name: 'New hook' })
    const options = [...(within(form).getByRole('combobox', { name: 'Slack connection' }) as HTMLSelectElement).options].map((option) => option.textContent)
    expect(options).toEqual(['Choose a connection', 'slack-ops'])
  })

  it('creates a hook for one workflow through the fake engine, which knows the workflows of the world and the connections of the settings', async () => {
    const { user, world } = mount({ tab: 'agents', agentsSection: 'hooks' })
    await screen.findByRole('region', { name: 'Saved hooks' })
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    const form = await screen.findByRole('region', { name: 'New hook' })
    await user.selectOptions(within(form).getByRole('combobox', { name: 'For' }), ids.workflows.webhook)
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Slack connection' }), 'slack-ops')
    await user.click(within(form).getByRole('button', { name: 'Create hook' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New hook' })).toBeNull())
    expect(world.callsOf('saveHook').map((call) => call.params)).toEqual([{ event: 'run.failed', scope: { type: 'workflow', workflowId: ids.workflows.webhook }, action: { type: 'notify', connection: 'slack-ops' }, enabled: true }])
    expect(within(saved()).getAllByRole('listitem')[0]!.textContent).toContain('웹훅을 슬랙으로 전달')
    expect(screen.getByText('1 of 20 hooks')).toBeTruthy()
  })

  it('shows the hooks and the activity that the world starts with', async () => {
    mount({ tab: 'agents', agentsSection: 'hooks' }, { hooks: hookFixtures.some, hookLog: hookLogFixtures.mixed })
    await screen.findByRole('region', { name: 'Saved hooks' })
    expect(within(saved()).getAllByRole('listitem')).toHaveLength(5)
    expect((await within(screen.getByRole('region', { name: 'Activity' })).findAllByRole('listitem')).length).toBe(hookLogFixtures.mixed.length)
  })

  it('takes the person to Settings, Connections from the empty hint', async () => {
    const { user } = mount({ tab: 'agents', agentsSection: 'hooks' }, {}, NO_SLACK)
    await screen.findByRole('region', { name: 'Saved hooks' })
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    const form = await screen.findByRole('region', { name: 'New hook' })
    await user.click(within(form).getByRole('button', { name: 'Open Settings, Connections' }))
    expect(await screen.findByRole('heading', { level: 2, name: t('app.settings.section.connections') })).toBeTruthy()
  })

  it('keeps the form and what was typed in it when the person looks at Rules, and comes back', async () => {
    const { user } = mount({ tab: 'agents', agentsSection: 'hooks' })
    await screen.findByRole('region', { name: 'Saved hooks' })
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    const form = await screen.findByRole('region', { name: 'New hook' })
    await user.selectOptions(within(form).getByRole('combobox', { name: 'For' }), ids.workflows.webhook)
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Then' }), 'deactivateAfterFailures')
    await user.clear(within(form).getByRole('spinbutton'))
    await user.type(within(form).getByRole('spinbutton'), '5')
    await user.click(within(subNav()).getByRole('button', { name: 'Rules' }))
    await screen.findByRole('heading', { level: 2, name: 'Rules' })
    await user.click(within(subNav()).getByRole('button', { name: 'Hooks' }))
    const again = await screen.findByRole('region', { name: 'New hook' })
    expect((within(again).getByRole('combobox', { name: 'For' }) as HTMLSelectElement).value).toBe(ids.workflows.webhook)
    expect((within(again).getByRole('combobox', { name: 'Then' }) as HTMLSelectElement).value).toBe('deactivateAfterFailures')
    expect((within(again).getByRole('spinbutton') as HTMLInputElement).value).toBe('5')
    expect(within(again).getByText('Unsaved changes')).toBeTruthy()
  })

  it('keeps the form while the person goes to Settings, Connections to add a connection, and comes back', async () => {
    const { user } = mount({ tab: 'agents', agentsSection: 'hooks' }, {}, NO_SLACK)
    await screen.findByRole('region', { name: 'Saved hooks' })
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    const form = await screen.findByRole('region', { name: 'New hook' })
    await user.selectOptions(within(form).getByRole('combobox', { name: 'When' }), 'run.succeeded')
    await user.click(within(form).getByRole('button', { name: 'Open Settings, Connections' }))
    await screen.findByRole('heading', { level: 2, name: t('app.settings.section.connections') })
    const top = within(screen.getByRole('navigation', { name: t('app.top.screens') }))
    await user.click(top.getByRole('button', { name: 'Agents' }))
    const again = await screen.findByRole('region', { name: 'New hook' })
    expect((within(again).getByRole('combobox', { name: 'When' }) as HTMLSelectElement).value).toBe('run.succeeded')
  })

  it('loses the hooks of a workflow that is deleted, as the engine does', async () => {
    const { world } = mount(
      { tab: 'agents', agentsSection: 'hooks' },
      {
        hooks: [
          { id: 'h-receipt', event: 'run.failed', scope: { type: 'workflow', workflowId: ids.workflows.receipt }, action: { type: 'record' }, enabled: true, createdAt: 1, updatedAt: 1 },
          { id: 'h-all', event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true, createdAt: 1, updatedAt: 1 },
        ],
      },
    )
    await screen.findByRole('region', { name: 'Saved hooks' })
    expect(within(saved()).getAllByRole('listitem')).toHaveLength(2)
    await world.client.request('deleteWorkflow', { workflowId: ids.workflows.receipt })
    await waitFor(() => expect(within(saved()).getAllByRole('listitem')).toHaveLength(1))
  })
})
