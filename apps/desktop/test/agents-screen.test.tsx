import { AGENT_MAX_ITEMS, RillError, type Agent, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AgentsScreen } from '../src/app/agents/AgentsScreen'
import { agentsStoreFor } from '../src/engine/agents'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { agentFixtures, agentOf } from '../src/fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { createTranslator, type Locale } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations } from './axe'
import { renderThemed } from './render'

const [terse, kind, plain] = agentFixtures.few as [Agent, Agent, Agent]

interface Options {
  agents?: readonly Agent[]
  activeAgentId?: string
  intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined
  locale?: Locale
}

function world(options: Options = {}) {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.activeAgentId === undefined ? {} : { activeAgentId: options.activeAgentId }),
  })
  const calls: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      const replaced = options.intercept?.(method, params)
      return (replaced ?? inner.request(method, params)) as Promise<MethodResult<M>>
    },
    onEvent: inner.onEvent,
  }
  const callsOf = (method: MethodName) => calls.filter((call) => call.method === method).map((call) => call.params)
  return { client, inner, calls, callsOf }
}

function mount(options: Options = {}, existing?: ReturnType<typeof world>) {
  const made = existing ?? world(options)
  const locale = options.locale ?? 'en'
  const view = renderThemed(<AgentsScreen client={made.client} />, { locale })
  return { ...made, view, user: userEvent.setup(), t: createTranslator(locale) }
}

const listItem = (name: string | RegExp): HTMLElement => within(screen.getByRole('list', { name: 'Agent list' })).getByRole('button', { name })
const field = (name: string): HTMLInputElement | HTMLTextAreaElement => screen.getByRole('textbox', { name }) as HTMLInputElement | HTMLTextAreaElement

async function ready(): Promise<void> {
  await screen.findByRole('list', { name: 'Agent list' })
}

async function open(name: string | RegExp): Promise<void> {
  await userEvent.setup().click(listItem(name))
  await screen.findByRole('heading', { level: 3 })
}

function change(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } })
}

describe('the list', () => {
  it('shows Default first, then the saved agents by name, and marks the one in use', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    const buttons = within(screen.getByRole('list', { name: 'Agent list' })).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Default'),
      expect.stringContaining('Plain tone only'),
      expect.stringContaining('Terse reviewer'),
      expect.stringContaining('친절한 도우미'),
    ])
    expect(buttons[0]!.textContent).toContain('Built in')
    expect(buttons.filter((button) => button.textContent?.includes('In use')).map((button) => button.textContent)).toEqual([expect.stringContaining('Terse reviewer')])
  })

  it('selects the agent in use first, and Default when none is', async () => {
    const first = mount({ agents: agentFixtures.few, activeAgentId: kind.id })
    await ready()
    expect(listItem(/친절한/).getAttribute('aria-current')).toBe('true')
    expect((field('Name') as HTMLInputElement).value).toBe(kind.name)
    first.view.unmount()
    mount({ agents: agentFixtures.few })
    await ready()
    expect(listItem(/^Default/).getAttribute('aria-current')).toBe('true')
  })

  it('shows the translated name and description of Default, never the text of the engine', async () => {
    mount({ locale: 'ko' })
    await screen.findByRole('list', { name: ko['agents.list.label'] })
    const list = screen.getByRole('list', { name: ko['agents.list.label'] })
    expect(list.textContent).toContain(ko['agents.default.name'])
    expect(list.textContent).toContain(ko['agents.default.description'])
    expect(document.body.textContent).not.toContain('No persona and no instructions')
  })

  it('counts the saved agents out of 12', async () => {
    mount({ agents: agentFixtures.few })
    await ready()
    expect(screen.getByText('3 of 12 saved')).toBeTruthy()
  })
})

describe('Default is read only', () => {
  it('has no field, no Save and no Delete, says why, and can be used', async () => {
    const { callsOf } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await open(/^Default/)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByText(en['agents.editor.defaultNote'])).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use this agent' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'In use' })).toBeTruthy())
    expect(callsOf('setActiveAgent')).toEqual([{ id: 'default' }])
    expect((screen.getByRole('button', { name: 'In use' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the editor', () => {
  it('shows the four fields with their hints and counters', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    expect((field('Name') as HTMLInputElement).value).toBe('Terse reviewer')
    expect((field('Description') as HTMLInputElement).value).toBe(terse.description)
    expect((field('Persona') as HTMLTextAreaElement).value).toBe(terse.persona)
    expect((field('Instructions') as HTMLTextAreaElement).value).toBe(terse.instructions)
    expect(screen.getByText(en['agents.field.name.hint'])).toBeTruthy()
    expect(screen.getByText(en['agents.field.instructions.hint'])).toBeTruthy()
    expect(screen.getByText('14/60')).toBeTruthy()
    expect(screen.getAllByText(/^\d+\/(60|200|600|3,000)$/)).toHaveLength(4)
  })

  it('counts characters, not UTF-16 units, and shows the counter in the error colour past the limit', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Name', '😀'.repeat(60))
    expect(screen.getByText('60/60').className).not.toMatch(/Over/)
    change('Name', '😀'.repeat(61))
    expect(screen.getByText('61/60').className).toMatch(/Over/)
  })

  it.each([
    ['Name', '', 'A name is required.'],
    ['Name', 'one\ttwo', 'This is one line: no line breaks, tabs or other control characters.'],
    ['Name', 'x'.repeat(61), 'At most 60 characters.'],
    ['Description', 'a\tb', 'This is one line: no line breaks, tabs or other control characters.'],
    ['Description', 'x'.repeat(201), 'At most 200 characters.'],
    ['Persona', 'a\tb', 'Line breaks are fine; tabs and other control characters are not.'],
    ['Persona', 'a\u2028b', 'Line and paragraph separator characters are not allowed.'],
    ['Persona', 'x'.repeat(601), 'At most 600 characters.'],
    ['Instructions', 'a\u202eb', 'Characters that change the text direction are not allowed.'],
    ['Instructions', 'a\u200bb', 'Invisible formatting characters are not allowed.'],
    ['Instructions', 'x'.repeat(3001), 'At most 3,000 characters.'],
  ])('says what is wrong with %s %#, as the engine would, and blocks Save', async (label, value, message) => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change(label, value)
    expect(screen.getByText(message)).toBeTruthy()
    expect(field(label).getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('accepts line breaks in the persona and the instructions', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Persona', 'one\ntwo')
    change('Instructions', 'a\n\nb')
    expect(screen.queryByText(/Line breaks are fine/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('describes each field with its hint, its counter and its error', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Name', '')
    const ids = field('Name').getAttribute('aria-describedby')!.split(' ')
    expect(ids).toHaveLength(3)
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([en['agents.field.name.hint'], '0/60', 'A name is required.'])
  })

  it('keeps Save off until something changed and valid', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    const save = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save().disabled).toBe(true)
    change('Name', 'Terse reviewer 2')
    expect(save().disabled).toBe(false)
    change('Name', 'Terse reviewer')
    expect(save().disabled).toBe(true)
  })
})

describe('saving', () => {
  it('creates an agent: New agent, fill, Create, and the new agent is selected and in the list', async () => {
    const { callsOf, user } = mount({ agents: agentFixtures.few })
    await ready()
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    expect(screen.getByRole('heading', { level: 3, name: 'New agent' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true)
    change('Name', '  Zed   helper ')
    change('Persona', 'Short.')
    await user.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The agent was created.'))
    expect(callsOf('saveAgent')).toEqual([{ name: '  Zed   helper ', description: '', persona: 'Short.', instructions: '' }])
    expect(listItem(/Zed helper/).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('heading', { level: 3, name: 'Zed helper' })).toBeTruthy()
    expect((field('Name') as HTMLInputElement).value).toBe('Zed helper')
  })

  it('updates an agent with its id and says so', async () => {
    const { callsOf, user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Persona', 'Even calmer.')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveAgent')).toEqual([{ id: terse.id, name: terse.name, description: terse.description, persona: 'Even calmer.', instructions: terse.instructions }])
    expect(screen.queryByText(en['agents.editor.unsaved'])).toBeNull()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a duplicate name as an alert and keeps what was typed', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Name', 'plain TONE only')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['chat.error.AGENT_DUPLICATE'])
    expect((field('Name') as HTMLInputElement).value).toBe('plain TONE only')
    expect(screen.getByText(en['agents.editor.unsaved'])).toBeTruthy()
  })

  it('shows the limit: New agent is off at 12 agents, with the reason', async () => {
    mount({ agents: agentFixtures.twelve })
    await ready()
    expect((screen.getByRole('button', { name: 'New agent' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByRole('note').map((note) => note.textContent)).toContain(`All ${AGENT_MAX_ITEMS} places are used. Delete an agent to add another.`)
    expect(screen.getByText('12 of 12 saved')).toBeTruthy()
  })

  it('shows the engine answer for a full list when the list on screen was out of date', async () => {
    const stale = world({ agents: agentFixtures.few })
    const { user } = mount({}, stale)
    await ready()
    for (let index = 0; index < AGENT_MAX_ITEMS - 3; index++) stale.inner.agents.save({ name: `Other ${index}`, description: '', persona: '', instructions: '' })
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    change('Name', 'one too many')
    await user.click(screen.getByRole('button', { name: 'Create agent' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['chat.error.AGENT_FULL'])
  })

  it('sends one request for a double submit', async () => {
    const { callsOf } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Persona', 'Twice?')
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.submit(save.closest('form')!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveAgent')).toHaveLength(1)
  })

  it('submits with Enter in the name field', async () => {
    const { callsOf, user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Name', 'Terse reviewer, v2')
    await user.type(field('Name'), '{Enter}')
    await waitFor(() => expect(callsOf('saveAgent')).toHaveLength(1))
  })

  it('shows the fixed text of an unexpected error, never its message', async () => {
    const { user } = mount({
      agents: agentFixtures.few,
      activeAgentId: terse.id,
      intercept: (method) => (method === 'saveAgent' ? Promise.reject(new RillError('INTERNAL', 'SECRET-DETAIL-3')) : undefined),
    })
    await ready()
    change('Name', 'Changed')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['chat.error.INTERNAL'])
    expect(document.body.textContent).not.toContain('SECRET-DETAIL-3')
  })
})

describe('Use this agent', () => {
  it('makes the saved agent the one in use, and the chip moves', async () => {
    const { callsOf, user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await open(/Plain tone only/)
    await user.click(screen.getByRole('button', { name: 'Use this agent' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('This agent is now in use.'))
    expect(callsOf('setActiveAgent')).toEqual([{ id: plain.id }])
    expect(listItem(/Plain tone only/).textContent).toContain('In use')
    expect(listItem(/Terse reviewer/).textContent).not.toContain('In use')
  })

  it('is off while the agent has unsaved changes, and says why', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await open(/Plain tone only/)
    change('Persona', 'Edited')
    const use = screen.getByRole('button', { name: 'Use this agent' }) as HTMLButtonElement
    expect(use.disabled).toBe(true)
    expect(screen.getByText(en['agents.editor.saveFirst'])).toBeTruthy()
  })

  it('shows In use and is off for the agent that is already in use', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    expect((screen.getByRole('button', { name: 'In use' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('deleting', () => {
  it('asks first, names the agent, and keeps it when the person keeps it', async () => {
    const { callsOf, user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await open(/Plain tone only/)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete this agent?' })
    expect(within(dialog).getByText(/“Plain tone only” is deleted and cannot be brought back/)).toBeTruthy()
    expect(within(dialog).queryByText(en['agents.delete.active'])).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsOf('deleteAgent')).toEqual([])
    expect(listItem(/Plain tone only/)).toBeTruthy()
  })

  it('deletes after the confirmation and selects Default', async () => {
    const { callsOf, user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await open(/Plain tone only/)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsOf('deleteAgent')).toEqual([{ id: plain.id }])
    expect(within(screen.getByRole('list', { name: 'Agent list' })).queryByRole('button', { name: /Plain tone only/ })).toBeNull()
    expect(listItem(/^Default/).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('The agent was deleted.')
  })

  it('says that Default takes over when the agent in use is deleted', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(en['agents.delete.active'])).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(listItem(/^Default/).textContent).toContain('In use')
  })

  it('shows the failure inside the dialog and keeps the dialog open', async () => {
    const { user } = mount({
      agents: agentFixtures.few,
      activeAgentId: terse.id,
      intercept: (method) => (method === 'deleteAgent' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined),
    })
    await ready()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(en['chat.error.INTERNAL'])
  })

  it('shows a hostile name in the dialog as text with the hidden characters made visible', async () => {
    const { user } = mount({ agents: agentFixtures.hostile, activeAgentId: 'agent-hostile' })
    await ready()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(dialog.textContent).toContain('‹U+202E›')
  })
})

describe('unsaved changes', () => {
  it('asks before another agent is selected, and keeps the edit when the person keeps editing', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Persona', 'Edited persona')
    await user.click(listItem(/Plain tone only/))
    const dialog = screen.getByRole('dialog', { name: 'Discard your changes?' })
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((field('Persona') as HTMLTextAreaElement).value).toBe('Edited persona')
    expect(listItem(/Terse reviewer/).getAttribute('aria-current')).toBe('true')
  })

  it('discards the edit and moves on when the person confirms', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Persona', 'Edited persona')
    await user.click(listItem(/Plain tone only/))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    expect((field('Name') as HTMLInputElement).value).toBe('Plain tone only')
    await user.click(listItem(/Terse reviewer/))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((field('Persona') as HTMLTextAreaElement).value).toBe(terse.persona)
  })

  it('asks before New agent, and before Default, and not for the agent that is already open', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Persona', 'Edited persona')
    await user.click(listItem(/Terse reviewer/))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    expect(screen.getByRole('dialog', { name: 'Discard your changes?' })).toBeTruthy()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('heading', { level: 3, name: 'New agent' })).toBeTruthy()
    change('Name', 'Half typed')
    await user.click(listItem(/^Default/))
    expect(screen.getByRole('dialog', { name: 'Discard your changes?' })).toBeTruthy()
  })

  it('undoes the changes with a button', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    change('Name', 'Other name')
    await user.click(screen.getByRole('button', { name: 'Undo changes' }))
    expect((field('Name') as HTMLInputElement).value).toBe(terse.name)
    expect(screen.queryByText(en['agents.editor.unsaved'])).toBeNull()
  })

  it('keeps an unsaved edit when the screen is left and opened again', async () => {
    const made = world({ agents: agentFixtures.few, activeAgentId: terse.id })
    const first = mount({}, made)
    await ready()
    change('Persona', 'Kept while away')
    first.view.unmount()
    mount({}, made)
    await ready()
    expect((field('Persona') as HTMLTextAreaElement).value).toBe('Kept while away')
    expect(screen.getByText(en['agents.editor.unsaved'])).toBeTruthy()
  })

  it('falls back to Default when the open agent is deleted somewhere else', async () => {
    const made = world({ agents: agentFixtures.few, activeAgentId: terse.id })
    mount({}, made)
    await ready()
    expect((field('Name') as HTMLInputElement).value).toBe(terse.name)
    await act(async () => {
      made.inner.agents.remove({ id: terse.id })
      await agentsStoreFor(made.client).refresh()
    })
    expect(listItem(/^Default/).getAttribute('aria-current')).toBe('true')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Agent list' })).queryByRole('button', { name: /Terse reviewer/ })).toBeNull()
  })
})

describe('the note about what is sent', () => {
  it('names the agent settings, says when they are sent and advises against secrets', async () => {
    mount({ agents: agentFixtures.few })
    await ready()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByText(en['agents.screen.transfer'])).toBeTruthy()
    expect(screen.getByText(en['agents.screen.transfer']).textContent).toMatch(/secrets, passwords or personal data/)
  })

  it('is in Korean too', async () => {
    mount({ locale: 'ko' })
    await screen.findByRole('list', { name: ko['agents.list.label'] })
    expect(screen.getByText(ko['agents.screen.transfer'])).toBeTruthy()
  })
})

describe('loading and failing', () => {
  it('says that it is loading, and shows a retry when the engine cannot list', async () => {
    let failing = true
    const { user } = mount({ intercept: (method) => (method === 'listAgents' && failing ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    expect(screen.getByRole('status').textContent).toBe(en['agents.screen.loading'])
    expect((await screen.findByRole('alert')).textContent).toBe(en['agents.screen.loadError'])
    failing = false
    await user.click(screen.getByRole('button', { name: en['agents.screen.retry'] }))
    await ready()
  })
})

describe('focus and live regions', () => {
  it('moves the focus to the editor heading when another agent is selected', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    await user.click(listItem(/Plain tone only/))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3 }))
  })

  it('does not take the focus when it opens', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps one polite status for what was done and one alert for what failed', async () => {
    const { user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    change('Persona', 'Changed once')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    change('Name', 'Plain tone only')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['chat.error.AGENT_DUPLICATE'])
  })

  it('has no axe violations in the list, the editor, the new agent form and Default', async () => {
    const { view, user } = mount({ agents: agentFixtures.few, activeAgentId: terse.id })
    await ready()
    expect(await violations(view.container)).toEqual([])
    change('Name', '')
    expect(await violations(view.container)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Undo changes' }))
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    expect(await violations(view.container)).toEqual([])
    await user.click(listItem(/^Default/))
    expect(await violations(view.container)).toEqual([])
  })
})

describe('untrusted text', () => {
  it('shows names and descriptions from the engine as text, truncated by the layout, with hidden characters made visible', async () => {
    mount({ agents: [...agentFixtures.hostile, ...agentFixtures.long, agentOf('agent-zero', { name: 'x\u200by', description: 'a\u202eb' })], activeAgentId: 'agent-long' })
    await ready()
    const list = screen.getByRole('list', { name: 'Agent list' })
    expect(list.querySelector('img')).toBeNull()
    expect(list.querySelector('script')).toBeNull()
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(list.textContent).toContain('‹U+202E›')
    expect(list.textContent).toContain('x‹U+200B›y')
    expect(document.body.querySelector('a')).toBeNull()
  })

  it('keeps the text of a field in the field, as typed, and never as markup', async () => {
    mount({ agents: agentFixtures.hostile, activeAgentId: 'agent-hostile' })
    await ready()
    expect((field('Instructions') as HTMLTextAreaElement).value).toContain('<a href="https://evil.example">x</a>')
    expect(document.querySelector('a')).toBeNull()
  })
})

describe('both languages', () => {
  it('renders the screen in Korean without a missing key', async () => {
    mount({ agents: agentFixtures.few, activeAgentId: terse.id, locale: 'ko' })
    await screen.findByRole('list', { name: ko['agents.list.label'] })
    change(ko['agents.field.name'], '')
    expect(screen.getByText(ko['agents.rule.empty'])).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\bagents\.[a-z]+\./)
    expect(screen.getByRole('button', { name: ko['agents.list.new'] })).toBeTruthy()
  })
})
