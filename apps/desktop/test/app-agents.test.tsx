import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App, type AppProps } from '../src/app/App'
import { createFakeWorld } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { fakeSettings } from '../src/engine/fake-host'
import { agentFixtures } from '../src/fixtures/agents'
import { createTranslator } from '../src/i18n'
import { renderThemed } from './render'

const t = createTranslator('en')
const READY = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'slack-ops', kind: 'slack' }] })

function mount(initial: AppProps['initial'] = {}, agents = agentFixtures.few, activeAgentId?: string) {
  const world = createFakeWorld({
    hostOptions: { restartDelayMs: 0 },
    hostInit: { settings: READY },
    control: { stepIntervalMs: 0 },
    agents,
    ...(activeAgentId === undefined ? {} : { activeAgentId }),
  })
  const view = renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App initial={initial} />
    </HostProvider>,
    { locale: 'en' },
  )
  return { world, view, user: userEvent.setup() }
}

const nav = (): HTMLElement => screen.getByRole('navigation', { name: t('app.top.screens') })
const chatPicker = (): HTMLSelectElement => within(screen.getByRole('complementary', { name: t('app.region.chat') })).getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement
const list = (): HTMLElement => screen.getByRole('list', { name: 'Agent list' })

describe('the Agents tab', () => {
  it('sits between Recipes and Settings and opens the Agents screen', async () => {
    const { user } = mount()
    await screen.findByRole('combobox', { name: 'Agent' })
    expect(within(nav()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Workflows', 'Recipes', 'Agents', 'Settings'])
    await user.click(within(nav()).getByRole('button', { name: 'Agents' }))
    expect(within(nav()).getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe('page')
    expect(await screen.findByRole('heading', { level: 2, name: 'Agents' })).toBeTruthy()
    expect(within(list()).getAllByRole('button')).toHaveLength(4)
  })

  it('can be the first screen', async () => {
    mount({ tab: 'agents' })
    expect(await screen.findByRole('list', { name: 'Agent list' })).toBeTruthy()
  })

  it('shares the agent in use with the picker in the chat header, both ways', async () => {
    const { user } = mount({ tab: 'agents' })
    await screen.findByRole('list', { name: 'Agent list' })
    await waitFor(() => expect(chatPicker().value).toBe('default'))
    await user.click(within(list()).getByRole('button', { name: /Terse reviewer/ }))
    await user.click(screen.getByRole('button', { name: 'Use this agent' }))
    await waitFor(() => expect(chatPicker().value).toBe('agent-terse'))
    await user.selectOptions(chatPicker(), 'default')
    await waitFor(() => expect(within(list()).getByRole('button', { name: /^Default/ }).textContent).toContain('In use'))
    expect(within(list()).getByRole('button', { name: /Terse reviewer/ }).textContent).not.toContain('In use')
  })

  it('creates an agent, uses it, and the next chat request carries its id', async () => {
    const { user, world } = mount({ tab: 'agents' })
    await screen.findByRole('list', { name: 'Agent list' })
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Receipt helper' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Persona' }), { target: { value: 'Short sentences.' } })
    await user.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe('The agent was created.'))
    await user.click(screen.getByRole('button', { name: 'Use this agent' }))
    await waitFor(() => expect(chatPicker().selectedOptions[0]!.textContent).toBe('Receipt helper'))
    const box = screen.getByRole('textbox', { name: 'Your request' })
    fireEvent.change(box, { target: { value: 'watch a folder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(world.callsOf('plan')).toHaveLength(1))
    expect(world.callsOf('plan')[0]!.params).toMatchObject({ agentId: chatPicker().value })
    expect(chatPicker().value).not.toBe('default')
  })

  it('keeps an unsaved edit while another screen is open', async () => {
    const { user } = mount({ tab: 'agents' }, agentFixtures.few, 'agent-terse')
    await screen.findByRole('list', { name: 'Agent list' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Persona' }), { target: { value: 'Typed, not saved' } })
    await user.click(within(nav()).getByRole('button', { name: 'Recipes' }))
    expect(screen.queryByRole('list', { name: 'Agent list' })).toBeNull()
    await user.click(within(nav()).getByRole('button', { name: 'Agents' }))
    expect((await screen.findByRole('textbox', { name: 'Persona' }) as HTMLTextAreaElement).value).toBe('Typed, not saved')
    expect(screen.getByText(t('agents.editor.unsaved'))).toBeTruthy()
  })

  it('loads the agents once for the whole window, whichever screen is open', async () => {
    const { user, world } = mount({ tab: 'workflows', runId: undefined }, agentFixtures.few, 'agent-terse')
    await waitFor(() => expect(chatPicker().value).toBe('agent-terse'))
    expect(world.callsOf('listAgents')).toHaveLength(1)
    await user.click(within(nav()).getByRole('button', { name: 'Agents' }))
    await screen.findByRole('list', { name: 'Agent list' })
    expect(world.callsOf('listAgents')).toHaveLength(1)
  })
})
