import { RillError, type Agent } from '@rill/protocol'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AgentPicker } from '../src/chat/AgentPicker'
import { ChatPanel, type ChatPanelProps } from '../src/chat/ChatPanel'
import type { AttachmentPort } from '../src/chat/Composer'
import { MetaLine } from '../src/chat/MetaLine'
import { agentsStoreFor } from '../src/engine/agents'
import { catalog } from '../src/fixtures'
import { agentFixtures, agentOf } from '../src/fixtures/agents'
import { metas, outcomeOf, results } from '../src/fixtures/plan'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { makeWorld, type WorldOptions } from './chat-world'
import { renderThemed } from './render'

const port: AttachmentPort = {
  async add(file) {
    return { id: `att-agents-${file.name.length}-xxxxxxxx`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}

const [terse, kind, plain] = agentFixtures.few as [Agent, Agent, Agent]
const noText = agentOf('agent-empty', { name: 'No text at all' })

function show(options: WorldOptions = {}, props: Partial<ChatPanelProps> = {}, locale: 'en' | 'ko' = 'en') {
  const world = makeWorld(options)
  let serial = 0
  const view = renderThemed(<ChatPanel client={world.client} port={port} catalog={catalog} newId={() => `plan-${++serial}`} {...props} />, { locale })
  return { world, ...view }
}

const picker = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement
const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Your request' }) as HTMLTextAreaElement

async function ready(): Promise<void> {
  await screen.findByText('Anthropic · Claude Opus 5.5')
  await screen.findByRole('combobox', { name: 'Agent' })
}

function ask(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

const optionNames = (): string[] => within(picker()).getAllByRole('option').map((option) => option.textContent ?? '')

describe('the agent picker in the chat header', () => {
  it('lists the Default agent first, then the saved agents by name, and shows the active one', async () => {
    show({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    expect(optionNames()).toEqual(['Default', 'Plain tone only', 'Terse reviewer', '친절한 도우미'])
    expect(picker().value).toBe(terse.id)
    expect(picker().title).toBe('Terse reviewer')
  })

  it('shows only Default when no agent is saved, with the translated name in both languages', async () => {
    const view = show()
    await ready()
    expect(optionNames()).toEqual(['Default'])
    view.unmount()
    show({}, {}, 'ko')
    await screen.findByRole('combobox', { name: ko['agents.picker.label'] })
    expect(within(screen.getByRole('combobox', { name: ko['agents.picker.label'] })).getAllByRole('option').map((option) => option.textContent)).toEqual([ko['agents.default.name']])
  })

  it('never shows the text the engine sends for the Default agent', async () => {
    const world = makeWorld()
    await world.agents.list()
    renderThemed(<AgentPicker client={world.client} />, { locale: 'ko' })
    await screen.findByRole('combobox')
    expect(document.body.textContent).not.toContain('No persona')
    expect(optionNamesOf()).toEqual([ko['agents.default.name']])
    expect((screen.getByRole('combobox') as HTMLSelectElement).title).toBe('')

    function optionNamesOf(): string[] {
      return within(screen.getByRole('combobox')).getAllByRole('option').map((option) => option.textContent ?? '')
    }
  })

  it('changing it calls setActiveAgent with the id and shows the new agent', async () => {
    const { world } = show({ agents: agentFixtures.few })
    await ready()
    await userEvent.setup().selectOptions(picker(), kind.id)
    await waitFor(() => expect(picker().value).toBe(kind.id))
    expect(world.callsOf('setActiveAgent').map((call) => call.params)).toEqual([{ id: kind.id }])
    await userEvent.setup().selectOptions(picker(), 'default')
    await waitFor(() => expect(picker().value).toBe('default'))
    expect(world.callsOf('setActiveAgent').map((call) => call.params)).toEqual([{ id: kind.id }, { id: 'default' }])
  })

  it('loads the list once for the whole panel, however many chat tabs there are', async () => {
    const { world } = show({ agents: agentFixtures.few })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Open a new chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open a new chat' }))
    expect(world.callsOf('listAgents')).toHaveLength(1)
  })

  it('truncates a long name and shows a hostile name as plain text with the hidden characters made visible', async () => {
    show({ agents: [...agentFixtures.long, ...agentFixtures.hostile, agentOf('agent-wide', { name: 'W'.repeat(60) }), agentOf('agent-zero', { name: 'x\u200by' })], activeAgentId: 'agent-hostile' })
    await ready()
    const names = optionNames()
    expect(names.every((name) => [...name].length <= 41 + 6 * 8)).toBe(true)
    expect(names.find((name) => name.startsWith('W'))).toBe(`${'W'.repeat(39)}…`)
    const hostile = names.find((name) => name.includes('img'))!
    expect(hostile).toContain('<img src=x onerror=alert(1)>')
    expect(hostile).toContain('‹U+202E›')
    expect(names).toContain('x‹U+200B›y')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  it('stays enabled while a plan runs, and the running request keeps the agent it started with', async () => {
    let call = 0
    const { world } = show({
      agents: agentFixtures.few,
      activeAgentId: terse.id,
      script: () => {
        call += 1
        return call === 1 ? 'hang' : outcomeOf(results.workflow)
      },
    })
    await ready()
    ask('first request')
    await waitFor(() => expect(world.planCalls()).toHaveLength(1))
    expect(picker().disabled).toBe(false)
    await userEvent.setup().selectOptions(picker(), plain.id)
    await waitFor(() => expect(picker().value).toBe(plain.id))
    fireEvent.click(screen.getByRole('button', { name: 'Open a new chat' }))
    ask('second request')
    await waitFor(() => expect(world.planCalls()).toHaveLength(2))
    expect(world.planAgentIds()).toEqual([terse.id, plain.id])
    expect(world.planCalls()[0]!.agentId).toBe(terse.id)
    expect(world.planCalls()[1]!.agentId).toBe(plain.id)
  })
})

describe('plan requests carry the active agent', () => {
  it('sends the id of a saved agent and nothing for the Default agent', async () => {
    const { world } = show({ agents: agentFixtures.few })
    await ready()
    ask('with the default agent')
    await screen.findByText(results.workflow.kind === 'workflow' ? results.workflow.summary : '')
    expect(world.planCalls()[0]).not.toHaveProperty('agentId')
    await userEvent.setup().selectOptions(picker(), terse.id)
    await waitFor(() => expect(picker().value).toBe(terse.id))
    fireEvent.click(screen.getByRole('button', { name: 'Open a new chat' }))
    ask('with a saved agent')
    await waitFor(() => expect(world.planCalls()).toHaveLength(2))
    expect(world.planCalls()[1]).toMatchObject({ agentId: terse.id })
    expect(world.planAgentIds()).toEqual([undefined, terse.id])
  })

  it('uses the new agent for the next request of every chat tab', async () => {
    const { world } = show({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Open a new chat' }))
    await userEvent.setup().selectOptions(picker(), kind.id)
    await waitFor(() => expect(picker().value).toBe(kind.id))
    ask('in the second tab')
    await waitFor(() => expect(world.planCalls()).toHaveLength(1))
    const tabs = screen.getAllByRole('tab')
    fireEvent.click(tabs[0]!)
    await waitFor(() => expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'))
    ask('in the first tab')
    await waitFor(() => expect(world.planCalls()).toHaveLength(2))
    expect(world.planAgentIds()).toEqual([kind.id, kind.id])
  })

  it('sends no agentId while the agents are not loaded, and says so', async () => {
    const { world } = show({
      agents: agentFixtures.few,
      activeAgentId: terse.id,
      intercept: (method) => (method === 'listAgents' ? new Promise(() => undefined) : undefined),
    })
    await screen.findByText('Anthropic · Claude Opus 5.5')
    expect(screen.getByText(en['agents.picker.loading'])).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull()
    ask('before the agents load')
    await waitFor(() => expect(world.planCalls()).toHaveLength(1))
    expect(world.planCalls()[0]).not.toHaveProperty('agentId')
  })

  it('shows a retry when the list cannot be loaded, and loads again', async () => {
    let failing = true
    const { world } = show({ agents: agentFixtures.few, intercept: (method) => (method === 'listAgents' && failing ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    expect(await screen.findByText(en['agents.picker.loadError'])).toBeTruthy()
    failing = false
    fireEvent.click(screen.getByRole('button', { name: en['chat.panel.retry'] }))
    await screen.findByRole('combobox', { name: 'Agent' })
    expect(world.callsOf('listAgents')).toHaveLength(2)
  })

  it('answers an agent that was deleted elsewhere with the fixed text and a fresh list', async () => {
    const { world } = show({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    world.agents.remove({ id: terse.id })
    ask('with an agent that is gone')
    expect(await screen.findByText(en['chat.error.AGENT_NOT_FOUND'])).toBeTruthy()
    await waitFor(() => expect(picker().value).toBe('default'))
    expect(world.callsOf('listAgents')).toHaveLength(2)
    expect(box().value).toBe('with an agent that is gone')
  })
})

describe('errors from setActiveAgent', () => {
  it('show the fixed text of the code and can be dismissed', async () => {
    const { world } = show({
      agents: agentFixtures.few,
      intercept: (method) => (method === 'setActiveAgent' ? Promise.reject(new RillError('INTERNAL', 'SECRET-DETAIL-9')) : undefined),
    })
    await ready()
    await userEvent.setup().selectOptions(picker(), terse.id)
    const alert = await screen.findByText(en['chat.error.INTERNAL'])
    expect(document.body.textContent).not.toContain('SECRET-DETAIL-9')
    expect(picker().value).toBe('default')
    fireEvent.click(within(alert.parentElement!).getByRole('button', { name: en['chat.error.dismiss'] }))
    expect(screen.queryByText(en['chat.error.INTERNAL'])).toBeNull()
    expect(world.callsOf('setActiveAgent')).toHaveLength(1)
  })

  it('say that the agent is gone and reload the list when it was deleted elsewhere', async () => {
    const { world } = show({ agents: agentFixtures.few })
    await ready()
    world.agents.remove({ id: kind.id })
    await userEvent.setup().selectOptions(picker(), kind.id)
    expect(await screen.findByText(en['chat.error.AGENT_NOT_FOUND'])).toBeTruthy()
    await waitFor(() => expect(optionNames()).not.toContain(kind.name))
  })
})

describe('the transfer notice names the agent settings', () => {
  const notice = (): string => screen.getByRole('note').textContent ?? ''

  it('lists them for an agent with a persona or instructions, and not for Default or an agent without text', async () => {
    show({ agents: [terse, plain, noText] })
    await ready()
    expect(notice()).toBe(`${en['chat.transfer.lead']} your request, notes`)
    await userEvent.setup().selectOptions(picker(), terse.id)
    await waitFor(() => expect(notice()).toContain(en['chat.transfer.item.agent']))
    expect(notice()).toBe(`${en['chat.transfer.lead']} your request, notes, agent settings`)
    await userEvent.setup().selectOptions(picker(), noText.id)
    await waitFor(() => expect(notice()).not.toContain(en['chat.transfer.item.agent']))
    await userEvent.setup().selectOptions(picker(), plain.id)
    await waitFor(() => expect(notice()).toContain(en['chat.transfer.item.agent']))
    await userEvent.setup().selectOptions(picker(), 'default')
    await waitFor(() => expect(notice()).not.toContain(en['chat.transfer.item.agent']))
  })

  it('lists them for an agent that has only skills, because the text of its skills is sent', async () => {
    const onlySkills = agentOf('agent-only-skills', { name: 'Only skills', skillIds: ['skill-slack'] })
    show({ agents: [onlySkills, noText] })
    await ready()
    expect(notice()).toBe(`${en['chat.transfer.lead']} your request, notes`)
    await userEvent.setup().selectOptions(picker(), onlySkills.id)
    await waitFor(() => expect(notice()).toContain(en['chat.transfer.item.agent']))
  })

  it('follows an edit of the active agent that empties its text', async () => {
    const { world } = show({ agents: [terse], activeAgentId: terse.id })
    await ready()
    expect(notice()).toContain(en['chat.transfer.item.agent'])
    await agentsStoreFor(world.client).save({ name: terse.name, description: '', persona: '', instructions: '', id: terse.id })
    await waitFor(() => expect(notice()).not.toContain(en['chat.transfer.item.agent']))
  })

  it('is in Korean too', async () => {
    show({ agents: [terse], activeAgentId: terse.id }, {}, 'ko')
    await screen.findByRole('combobox', { name: ko['agents.picker.label'] })
    expect(screen.getByRole('note').textContent).toContain(ko['chat.transfer.item.agent'])
  })
})

describe('what an answer says about the agent', () => {
  it('names the agent that was used', () => {
    renderThemed(<MetaLine meta={metas.agent} />, { locale: 'en' })
    expect(screen.getByText('Agent Terse reviewer')).toBeTruthy()
  })

  it('says when the agent settings were left out', () => {
    renderThemed(<MetaLine meta={metas.agentDropped} />, { locale: 'en' })
    expect(screen.getByText(en['chat.meta.agentDropped'])).toBeTruthy()
  })

  it('shows a hostile agent name as text', () => {
    const hostile = { ...metas.agent, agentUsed: { id: 'x', name: '<img src=x onerror=alert(1)>\u202e' } }
    renderThemed(<MetaLine meta={hostile} />, { locale: 'en' })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(/Agent <img src=x onerror=alert\(1\)>‹U\+202E›/)).toBeTruthy()
  })

  it('says how many skills were in the agent settings that were sent, and nothing when there were none', () => {
    const { unmount } = renderThemed(<MetaLine meta={{ ...metas.agent, skillsUsed: 2 }} />, { locale: 'en' })
    expect(screen.getByText('Used 2 skills')).toBeTruthy()
    unmount()
    const one = renderThemed(<MetaLine meta={{ ...metas.agent, skillsUsed: 1 }} />, { locale: 'en' })
    expect(screen.getByText('Used 1 skill')).toBeTruthy()
    one.unmount()
    renderThemed(<MetaLine meta={{ ...metas.agent, skillsUsed: 0 }} />, { locale: 'en' })
    expect(screen.queryByText(/skill/)).toBeNull()
  })

  it('says it in Korean', () => {
    renderThemed(<MetaLine meta={{ ...metas.agent, skillsUsed: 2 }} />, { locale: 'ko' })
    expect(screen.getByText(ko['chat.meta.skillsUsed.other'].replace('{count}', '2'))).toBeTruthy()
  })

  it('shows nothing about agents when none was used', () => {
    renderThemed(<MetaLine meta={metas.plain} />, { locale: 'en' })
    expect(screen.queryByText(/Agent/)).toBeNull()
  })
})
