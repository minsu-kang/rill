import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AGENTS_SECTIONS, AgentsTab, type AgentsSectionId } from '../src/app/agents/AgentsTab'
import { SubNav } from '../src/app/agents/SubNav'
import { App } from '../src/app/App'
import { createFakeWorld } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { fakeSettings } from '../src/engine/fake-host'
import { catalog, fakeData } from '../src/fixtures'
import { agentFixtures } from '../src/fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { createTranslator } from '../src/i18n'
import { violations } from './axe'
import { renderThemed } from './render'

const t = createTranslator('en')

describe('SubNav', () => {
  const items = [
    { id: 'one', label: 'agents.nav.agents' },
    { id: 'two', label: 'agents.nav.rules' },
  ] as const

  it('is a navigation with a name, one button per item, and the current one marked', () => {
    renderThemed(<SubNav label="agents.nav.label" items={items} current="two" onChange={() => undefined} />, { locale: 'en' })
    const nav = screen.getByRole('navigation', { name: 'Agent settings' })
    expect(within(nav).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-current')])).toEqual([
      ['Agents', null],
      ['Rules', 'page'],
    ])
  })

  it('calls onChange with the id of the item, also for the current one', () => {
    const onChange = vi.fn()
    renderThemed(<SubNav label="agents.nav.label" items={items} current="one" onChange={onChange} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }))
    expect(onChange).toHaveBeenLastCalledWith('two')
  })

  it('speaks Korean', () => {
    renderThemed(<SubNav label="agents.nav.label" items={items} current="one" onChange={() => undefined} />, { locale: 'ko' })
    expect(screen.getByRole('navigation', { name: '에이전트 설정' })).toBeTruthy()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['에이전트', '규칙'])
  })

  it('has no axe violation', async () => {
    renderThemed(<SubNav label="agents.nav.label" items={items} current="one" onChange={() => undefined} />, { locale: 'en' })
    expect(await violations(document.body)).toEqual([])
  })
})

function clientOf() {
  return withPlanMethods(createFakeClient(fakeData), { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three], agents: agentFixtures.few })
}

function Host({ initial = 'agents' }: { initial?: AgentsSectionId }) {
  const [client] = useState(clientOf)
  const [section, setSection] = useState<AgentsSectionId>(initial)
  return <AgentsTab client={client} catalog={catalog} section={section} onSectionChange={setSection} />
}

describe('AgentsTab', () => {
  it('lists its screens from one table, Agents first and Rules second', () => {
    expect(AGENTS_SECTIONS.map((section) => section.id)).toEqual(['agents', 'rules'])
    expect(AGENTS_SECTIONS.map((section) => section.label)).toEqual(['agents.nav.agents', 'agents.nav.rules'])
  })

  it('shows the Agents screen first, with the sub-navigation above it', async () => {
    renderThemed(<Host />, { locale: 'en' })
    expect(within(screen.getByRole('navigation', { name: 'Agent settings' })).getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe('page')
    expect(await screen.findByRole('list', { name: 'Agent list' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Forbidden nodes' })).toBeNull()
  })

  it('switches to the Rules screen and back, and keeps the focus on the button that was pressed', async () => {
    const user = userEvent.setup()
    renderThemed(<Host />, { locale: 'en' })
    await screen.findByRole('list', { name: 'Agent list' })
    const nav = screen.getByRole('navigation', { name: 'Agent settings' })
    await user.click(within(nav).getByRole('button', { name: 'Rules' }))
    expect(await screen.findByRole('region', { name: 'Forbidden nodes' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Agent list' })).toBeNull()
    expect(within(nav).getByRole('button', { name: 'Rules' }).getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(within(nav).getByRole('button', { name: 'Rules' }))
    await user.click(within(nav).getByRole('button', { name: 'Agents' }))
    expect(await screen.findByRole('list', { name: 'Agent list' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Forbidden nodes' })).toBeNull()
  })

  it('can start on the Rules screen', async () => {
    renderThemed(<Host initial="rules" />, { locale: 'en' })
    expect(await screen.findByRole('region', { name: 'Forbidden nodes' })).toBeTruthy()
  })

  it('keeps an unsaved edit of an agent while the Rules screen is open', async () => {
    const user = userEvent.setup()
    renderThemed(<Host />, { locale: 'en' })
    await screen.findByRole('list', { name: 'Agent list' })
    await user.click(within(screen.getByRole('list', { name: 'Agent list' })).getByRole('button', { name: /Terse reviewer/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed in a hurry' } })
    const nav = screen.getByRole('navigation', { name: 'Agent settings' })
    await user.click(within(nav).getByRole('button', { name: 'Rules' }))
    await screen.findByRole('region', { name: 'Forbidden nodes' })
    await user.click(within(nav).getByRole('button', { name: 'Agents' }))
    expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe('Renamed in a hurry')
  })

  it('has no axe violation on either screen', async () => {
    const user = userEvent.setup()
    renderThemed(<Host />, { locale: 'en' })
    await screen.findByRole('list', { name: 'Agent list' })
    expect(await violations(document.body)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Rules' }))
    await screen.findByRole('region', { name: 'Forbidden nodes' })
    expect(await violations(document.body)).toEqual([])
  })
})

const READY = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'], connections: [{ name: 'slack-ops', kind: 'slack' }] })

function mountApp(initial: Parameters<typeof App>[0]['initial'] = {}) {
  const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings: READY }, control: { stepIntervalMs: 0 }, agents: agentFixtures.few })
  renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App initial={initial} />
    </HostProvider>,
    { locale: 'en' },
  )
  return { world, user: userEvent.setup() }
}

describe('the Agents tab of the app', () => {
  const main = (): HTMLElement => screen.getByRole('main')

  it('shows the sub-navigation and, by default, the agents', async () => {
    const { user } = mountApp()
    await user.click(within(screen.getByRole('navigation', { name: t('app.top.screens') })).getByRole('button', { name: 'Agents' }))
    expect(within(main()).getByRole('navigation', { name: 'Agent settings' })).toBeTruthy()
    expect(await screen.findByRole('list', { name: 'Agent list' })).toBeTruthy()
  })

  it('opens the Rules screen from the sub-navigation, and remembers it when the person visits another tab', async () => {
    const { user } = mountApp({ tab: 'agents' })
    await screen.findByRole('list', { name: 'Agent list' })
    await user.click(within(main()).getByRole('button', { name: 'Rules' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Rules' })).toBeTruthy()
    const top = within(screen.getByRole('navigation', { name: t('app.top.screens') }))
    await user.click(top.getByRole('button', { name: 'Recipes' }))
    await user.click(top.getByRole('button', { name: 'Agents' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Rules' })).toBeTruthy()
  })

  it('can start on the Rules screen', async () => {
    mountApp({ tab: 'agents', agentsSection: 'rules' })
    expect(await screen.findByRole('region', { name: 'Forbidden nodes' })).toBeTruthy()
  })

  it('offers the node types of the engine catalog and sends the rule to the engine', async () => {
    const { user, world } = mountApp({ tab: 'agents', agentsSection: 'rules' })
    const region = await screen.findByRole('region', { name: 'Forbidden nodes' })
    await user.selectOptions(within(region).getByRole('combobox', { name: 'Node type' }), 'http.request')
    await user.click(within(region).getByRole('button', { name: 'Add' }))
    await within(region).findByRole('list', { name: 'Forbidden node types' })
    expect(world.callsOf('saveRule').map((call) => call.params)).toEqual([{ kind: 'forbidNode', value: 'http.request' }])
  })

  it('lists a deployed workflow that a new rule breaks', async () => {
    const { user } = mountApp({ tab: 'agents', agentsSection: 'rules' })
    const region = await screen.findByRole('region', { name: 'Forbidden nodes' })
    const panel = screen.getByRole('region', { name: 'Existing workflows' })
    expect(await within(panel).findByText('No workflow breaks a rule.')).toBeTruthy()
    await user.selectOptions(within(region).getByRole('combobox', { name: 'Node type' }), 'http.request')
    await user.click(within(region).getByRole('button', { name: 'Add' }))
    const list = await within(panel).findByRole('list', { name: 'Workflows that break a rule' })
    expect(list.textContent).toContain('forbidden by the rules')
  })
})
