import { AGENT_MAX_SKILLS, AGENT_SKILLS_MAX_CHARS, RillError, type Agent, type MethodName, type MethodParams, type MethodResult, type Skill } from '@rill/protocol'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AgentsScreen } from '../src/app/agents/AgentsScreen'
import { parseAgentFile } from '../src/app/agents/agent-file'
import { AgentPicker } from '../src/chat/AgentPicker'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { createFakeHost, type FakeHostState } from '../src/engine/fake-host'
import { withPlanMethods } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { agentFixtures, agentOf } from '../src/fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { skillFixtures, skillOf } from '../src/fixtures/skills'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations } from './axe'
import { renderThemed } from './render'

const [terse] = agentFixtures.few as [Agent, Agent, Agent]
const [skilled] = agentFixtures.skilled as [Agent]
const [reviewer, reviewerKo] = agentFixtures.reviewers as [Agent, Agent]
const [receipts, slack] = skillFixtures.few as [Skill, Skill, Skill]
const [bigA, bigB, small] = skillFixtures.big as [Skill, Skill, Skill]

interface Options {
  agents?: readonly Agent[]
  skills?: readonly Skill[]
  activeAgentId?: string
  host?: Partial<FakeHostState>
  intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined
  locale?: 'en' | 'ko'
}

function mount(options: Options = {}) {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
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
  const host = createFakeHost(options.host)
  const view = renderThemed(<AgentsScreen client={client} files={host.dialogs} />, { locale: options.locale ?? 'en' })
  return { view, host, inner, client, user: userEvent.setup(), callsOf: (method: MethodName) => calls.filter((call) => call.method === method).map((call) => call.params) }
}

const listItem = (name: string | RegExp): HTMLElement => within(screen.getByRole('list', { name: 'Agent list' })).getByRole('button', { name })
const field = (name: string): HTMLInputElement | HTMLTextAreaElement => screen.getByRole('textbox', { name }) as HTMLInputElement | HTMLTextAreaElement
const kindSelect = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Kind' }) as HTMLSelectElement
const skillsGroup = (): HTMLElement => screen.getByRole('group', { name: 'Skills' })
const box = (name: string | RegExp): HTMLInputElement => within(skillsGroup()).getByRole('checkbox', { name }) as HTMLInputElement
const button = (name: string | RegExp): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement

async function ready(): Promise<void> {
  await screen.findByRole('list', { name: 'Agent list' })
}

async function open(name: string | RegExp): Promise<void> {
  await userEvent.setup().click(listItem(name))
  await screen.findByRole('heading', { level: 3 })
}

describe('the list shows the kind and the skills', () => {
  it('puts a kind chip on every agent and the number of skills on the ones that have some', async () => {
    mount({ agents: [terse, ...agentFixtures.skilled, ...agentFixtures.reviewers], skills: skillFixtures.few, activeAgentId: terse.id })
    await ready()
    const text = (name: string | RegExp): string => listItem(name).textContent ?? ''
    expect(text(/^Default/)).toContain('Assistant')
    expect(text(/Terse reviewer/)).toContain('Assistant')
    expect(text(/Terse reviewer/)).not.toMatch(/skill/)
    expect(text(/Receipts helper/)).toContain('2 skills')
    expect(text(/Safety reviewer/)).toContain('Reviewer')
    expect(text(/Safety reviewer/)).toContain('1 skill')
    expect(text(/Safety reviewer/)).not.toContain('1 skills')
    expect(text(/꼼꼼한 검토자/)).toContain('Reviewer')
    expect(text(/꼼꼼한 검토자/)).not.toMatch(/skill/)
  })

  it('shows no In use mark on a reviewer, and says it is asked from a plan card', async () => {
    mount({ agents: [terse, ...agentFixtures.reviewers], activeAgentId: terse.id })
    await ready()
    expect(listItem(/Safety reviewer/).textContent).not.toContain('In use')
    expect(listItem(/Safety reviewer/).textContent).toContain(en['agents.list.reviewerUse'])
    expect(listItem(/Terse reviewer/).textContent).toContain('In use')
    expect(listItem(/Terse reviewer/).textContent).not.toContain(en['agents.list.reviewerUse'])
  })

  it('never marks a reviewer as in use, even if the engine said so', async () => {
    mount({ agents: [terse, ...agentFixtures.reviewers], activeAgentId: reviewer.id })
    await ready()
    expect(within(screen.getByRole('list', { name: 'Agent list' })).queryByText('In use')).toBeNull()
  })

  it('says it in Korean too', async () => {
    mount({ agents: [terse, ...agentFixtures.skilled, ...agentFixtures.reviewers], skills: skillFixtures.few, locale: 'ko' })
    await screen.findByRole('list', { name: ko['agents.list.label'] })
    const items = within(screen.getByRole('list', { name: ko['agents.list.label'] })).getAllByRole('button')
    expect(items.some((item) => item.textContent?.includes(ko['agents.kind.reviewer']))).toBe(true)
    expect(items.some((item) => item.textContent?.includes('스킬 2개'))).toBe(true)
  })
})

describe('the kind of an agent in the editor', () => {
  it('shows the kind as a select with the hint of the chosen kind', async () => {
    mount({ agents: [terse, reviewer], activeAgentId: terse.id })
    await ready()
    expect(kindSelect().value).toBe('assistant')
    expect(within(kindSelect()).getAllByRole('option').map((option) => option.textContent)).toEqual(['Assistant', 'Reviewer'])
    expect(screen.getByText(en['agents.kind.hint.assistant'])).toBeTruthy()
    await open(/Safety reviewer/)
    expect(kindSelect().value).toBe('reviewer')
    expect(screen.getByText(en['agents.kind.hint.reviewer'])).toBeTruthy()
  })

  it('makes the agent dirty when the kind changes, sends only the kind, and moves the chip', async () => {
    const { callsOf, user } = mount({ agents: [terse, ...agentFixtures.few.slice(1)], activeAgentId: 'default' })
    await ready()
    await open(/Plain tone only/)
    await user.selectOptions(kindSelect(), 'reviewer')
    expect(screen.getByText(en['agents.editor.unsaved'])).toBeTruthy()
    expect(button('Save').disabled).toBe(false)
    await user.click(button('Save'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveAgent')).toEqual([{ id: 'agent-plain', name: 'Plain tone only', description: '', persona: 'Plain words, no jargon.', instructions: '', kind: 'reviewer' }])
    expect(listItem(/Plain tone only/).textContent).toContain('Reviewer')
    expect(screen.queryByRole('button', { name: 'Use this agent' })).toBeNull()
  })

  it('goes back to clean when the kind is put back', async () => {
    const { user } = mount({ agents: [terse] })
    await ready()
    await open(/Terse reviewer/)
    await user.selectOptions(kindSelect(), 'reviewer')
    await user.selectOptions(kindSelect(), 'assistant')
    expect(screen.queryByText(en['agents.editor.unsaved'])).toBeNull()
    expect(button('Save').disabled).toBe(true)
  })

  it('is locked for the agent in use, with the reason', async () => {
    mount({ agents: [terse], activeAgentId: terse.id })
    await ready()
    expect(kindSelect().disabled).toBe(true)
    expect(screen.getByText(en['agents.kind.lockedInUse'])).toBeTruthy()
  })

  it('sends the kind of a new agent only when it is not an assistant', async () => {
    const { callsOf, user } = mount({ agents: [terse] })
    await ready()
    await user.click(button('New agent'))
    expect(kindSelect().value).toBe('assistant')
    fireEvent.change(field('Name'), { target: { value: 'First' } })
    await user.click(button('Create agent'))
    await waitFor(() => expect(callsOf('saveAgent')).toHaveLength(1))
    expect(callsOf('saveAgent')[0]).toEqual({ name: 'First', description: '', persona: '', instructions: '' })
    await user.click(button('New agent'))
    await user.selectOptions(kindSelect(), 'reviewer')
    fireEvent.change(field('Name'), { target: { value: 'Second' } })
    await user.click(button('Create agent'))
    await waitFor(() => expect(callsOf('saveAgent')).toHaveLength(2))
    expect(callsOf('saveAgent')[1]).toEqual({ name: 'Second', description: '', persona: '', instructions: '', kind: 'reviewer' })
    expect(listItem(/Second/).textContent).toContain('Reviewer')
  })

  it('shows a reviewer without the Use button, and says where it is used', async () => {
    mount({ agents: [terse, reviewer], activeAgentId: terse.id })
    await ready()
    await open(/Safety reviewer/)
    expect(screen.queryByRole('button', { name: 'Use this agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'In use' })).toBeNull()
    expect(screen.getByText(en['agents.editor.reviewerNote'])).toBeTruthy()
  })

  it('shows the Default agent without a kind or skills to change', async () => {
    mount({ agents: [terse], skills: skillFixtures.few })
    await ready()
    await open(/^Default/)
    expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Skills' })).toBeNull()
  })

  it('shows the fixed text when the engine refuses to turn the agent in use into a reviewer', async () => {
    const { user } = mount({
      agents: [terse, ...agentFixtures.few.slice(1)],
      activeAgentId: 'agent-plain',
      intercept: (method, params) => (method === 'saveAgent' && (params as { kind?: string }).kind === 'reviewer' ? Promise.reject(new RillError('AGENT_NOT_ASSISTANT', 'x')) : undefined),
    })
    await ready()
    await open(/Terse reviewer/)
    await user.selectOptions(kindSelect(), 'reviewer')
    await user.click(button('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.error.AGENT_NOT_ASSISTANT'])
  })
})

describe('the skills picker', () => {
  it('lists every skill as a checkbox with its size, and checks the ones the agent has', async () => {
    mount({ agents: [skilled], skills: skillFixtures.few, activeAgentId: 'default' })
    await ready()
    await open(/Receipts helper/)
    expect(within(skillsGroup()).getAllByRole('checkbox').map((item) => (item.closest('li') as HTMLElement).textContent)).toEqual([
      expect.stringContaining('Receipts checklist'),
      expect.stringContaining('Slack message style'),
      expect.stringContaining('한국어 요약 규칙'),
    ])
    expect(box('Receipts checklist').checked).toBe(true)
    expect(box('Slack message style').checked).toBe(true)
    expect(box('한국어 요약 규칙').checked).toBe(false)
    expect(within(skillsGroup()).getByText(`${[...receipts.body].length} characters`)).toBeTruthy()
  })

  it('shows a meter with the characters of the checked skills out of 6,000, the count out of 8 and the order note', async () => {
    mount({ agents: [skilled], skills: skillFixtures.few })
    await ready()
    await open(/Receipts helper/)
    const used = [...receipts.body].length + [...slack.body].length
    expect(within(skillsGroup()).getByText(`${used.toLocaleString('en-US')} of 6,000 characters`)).toBeTruthy()
    const meter = within(skillsGroup()).getByRole('meter', { name: en['agents.skills.meterLabel'] })
    expect(meter.getAttribute('aria-valuenow')).toBe(String(used))
    expect(meter.getAttribute('aria-valuemax')).toBe(String(AGENT_SKILLS_MAX_CHARS))
    expect(within(skillsGroup()).getByText('2 of 8 skills')).toBeTruthy()
    expect(within(skillsGroup()).getByText(en['agents.skills.order'])).toBeTruthy()
    expect(within(skillsGroup()).getByText(/sent to the model provider with every request that uses this agent/)).toBeTruthy()
  })

  it('updates the meter and makes the agent dirty when a skill is checked, and sends the skill ids in the order of the names', async () => {
    const { callsOf, user } = mount({ agents: [terse], skills: skillFixtures.few })
    await ready()
    await open(/Terse reviewer/)
    expect(within(skillsGroup()).getByText('0 of 6,000 characters')).toBeTruthy()
    await user.click(box('Slack message style'))
    await user.click(box('Receipts checklist'))
    expect(screen.getByText(en['agents.editor.unsaved'])).toBeTruthy()
    await user.click(button('Save'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveAgent')).toEqual([{ id: terse.id, name: terse.name, description: terse.description, persona: terse.persona, instructions: terse.instructions, skillIds: ['skill-receipts', 'skill-slack'] }])
    expect(listItem(/Terse reviewer/).textContent).toContain('2 skills')
  })

  it('sends an empty list when the last skill is unchecked, and sends nothing about skills when they did not change', async () => {
    const { callsOf, user } = mount({ agents: [{ ...skilled, skillIds: ['skill-slack'] }], skills: skillFixtures.few })
    await ready()
    await open(/Receipts helper/)
    fireEvent.change(field('Persona'), { target: { value: 'Other persona' } })
    await user.click(button('Save'))
    await waitFor(() => expect(callsOf('saveAgent')).toHaveLength(1))
    expect(callsOf('saveAgent')[0]).not.toHaveProperty('skillIds')
    await user.click(box('Slack message style'))
    await user.click(button('Save'))
    await waitFor(() => expect(callsOf('saveAgent')).toHaveLength(2))
    expect(callsOf('saveAgent')[1]).toMatchObject({ skillIds: [] })
  })

  it('goes back to clean when the checks are put back', async () => {
    const { user } = mount({ agents: [skilled], skills: skillFixtures.few })
    await ready()
    await open(/Receipts helper/)
    await user.click(box('Receipts checklist'))
    await user.click(box('Receipts checklist'))
    expect(screen.queryByText(en['agents.editor.unsaved'])).toBeNull()
  })

  it('stops at 8 skills: the others are off with a reason, and turn on again when one is unchecked', async () => {
    const { user } = mount({ agents: [terse], skills: skillFixtures.full })
    await ready()
    await open(/Terse reviewer/)
    for (let index = 1; index <= AGENT_MAX_SKILLS; index++) await user.click(box(`Skill ${String(index).padStart(2, '0')}`))
    expect(within(skillsGroup()).getByText('8 of 8 skills')).toBeTruthy()
    expect(box('Skill 09').disabled).toBe(true)
    expect(box('Skill 01').disabled).toBe(false)
    expect(within(skillsGroup()).getAllByText(en['agents.skills.doesNotFit'])).toHaveLength(16)
    expect(screen.getByText(en['agents.skills.limit'])).toBeTruthy()
    await user.click(box('Skill 01'))
    expect(box('Skill 09').disabled).toBe(false)
    expect(screen.queryByText(en['agents.skills.limit'])).toBeNull()
  })

  it('stops at 6,000 characters: a skill that no longer fits is off, with a reason', async () => {
    const { user } = mount({ agents: [terse], skills: skillFixtures.big })
    await ready()
    await open(/Terse reviewer/)
    await user.click(box(bigA.name))
    await user.click(box(bigB.name))
    expect(within(skillsGroup()).getByText('5,900 of 6,000 characters')).toBeTruthy()
    expect(box(small.name).disabled).toBe(true)
    expect(box(small.name).getAttribute('aria-describedby')).toBeTruthy()
    expect(within(skillsGroup()).getAllByText(en['agents.skills.doesNotFit'])).toHaveLength(1)
    await user.click(box(bigB.name))
    expect(box(small.name).disabled).toBe(false)
  })

  it('says there are no skills yet when there are none', async () => {
    mount({ agents: [terse] })
    await ready()
    await open(/Terse reviewer/)
    expect(within(skillsGroup()).getByText(en['agents.skills.none'])).toBeTruthy()
    expect(within(skillsGroup()).queryByRole('checkbox')).toBeNull()
  })

  it('says it while the skills load, and when they could not be loaded, with a retry', async () => {
    let failing = true
    const { user } = mount({ agents: [terse], intercept: (method) => (method === 'listSkills' && failing ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined), skills: skillFixtures.few })
    await ready()
    await open(/Terse reviewer/)
    expect(within(skillsGroup()).getByText(en['agents.skills.loadError'])).toBeTruthy()
    failing = false
    await user.click(within(skillsGroup()).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(skillsGroup()).getAllByRole('checkbox')).toHaveLength(3))
  })

  it('shows the fixed text when the engine says that a skill was deleted meanwhile', async () => {
    const { user } = mount({
      agents: [terse],
      skills: skillFixtures.few,
      intercept: (method) => (method === 'saveAgent' ? Promise.reject(new RillError('AGENT_INVALID', 'x', ['skills.unknown: a skill of the agent does not exist'])) : undefined),
    })
    await ready()
    await open(/Terse reviewer/)
    await user.click(box('Slack message style'))
    await user.click(button('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.error.agentSkillsUnknown'])
  })

  it.each([
    ['skills.too_many: x', 'agentSkillsTooMany'],
    ['skills.too_large: x', 'agentSkillsTooLarge'],
  ] as const)('shows its own fixed text for %s', async (line, key) => {
    const { user } = mount({ agents: [terse], skills: skillFixtures.few, intercept: (method) => (method === 'saveAgent' ? Promise.reject(new RillError('AGENT_INVALID', 'x', [line])) : undefined) })
    await ready()
    await open(/Terse reviewer/)
    await user.click(box('Slack message style'))
    await user.click(button('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe(en[`skills.error.${key}`])
  })

  it('keeps showing the skills of an agent while its list is edited, in the order of the names, not of the agent', async () => {
    mount({ agents: [{ ...skilled, skillIds: ['skill-slack', 'skill-receipts'] }], skills: skillFixtures.few })
    await ready()
    await open(/Receipts helper/)
    expect(within(skillsGroup()).getAllByRole('checkbox').map((item) => (item as HTMLInputElement).checked)).toEqual([true, true, false])
  })

  it('shows hostile skill names as text', async () => {
    const hostile = skillFixtures.hostile[0]!
    const { view } = mount({ agents: [{ ...terse, skillIds: [hostile.id] }], skills: [hostile, skillOf('s-ok', { name: 'Fine' })] })
    await ready()
    await open(/Terse reviewer/)
    expect(view.container.querySelector('img, script, b, a')).toBeNull()
    expect(within(skillsGroup()).getAllByRole('checkbox')).toHaveLength(2)
  })

  it('has no accessibility violations, in the editor of an agent with skills and of a reviewer', async () => {
    const { view } = mount({ agents: [skilled, ...agentFixtures.reviewers], skills: skillFixtures.few })
    await ready()
    await open(/Receipts helper/)
    expect(await violations(view.container)).toEqual([])
    await open(/Safety reviewer/)
    expect(await violations(view.container)).toEqual([])
  })

  it('shows the Korean texts', async () => {
    mount({ agents: [skilled], skills: skillFixtures.few, locale: 'ko' })
    await screen.findByRole('list', { name: ko['agents.list.label'] })
    await userEvent.setup().click(within(screen.getByRole('list', { name: ko['agents.list.label'] })).getByRole('button', { name: /Receipts helper/ }))
    const group = await screen.findByRole('group', { name: ko['agents.skills.legend'] })
    expect(within(group).getByText(ko['agents.skills.order'])).toBeTruthy()
    expect(within(group).getByText(/\/6,000자$/)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: ko['agents.field.kind'] })).toBeTruthy()
  })
})

describe('the file of an agent with a kind', () => {
  const REVIEWER_FILE = ['---', 'name: File reviewer', 'description: From a file', 'kind: reviewer', '---', '', '# Persona', '', 'Strict.', '', '# Instructions', '', 'Say what could go wrong.', ''].join('\n')

  async function startImport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await ready()
    await user.click(button('Import…'))
    await screen.findByRole('heading', { level: 3, name: 'Review the imported agent' })
  }

  it('is exported with kind: reviewer for a reviewer, and the same as before for an assistant', async () => {
    const first = mount({ agents: [terse, reviewer], activeAgentId: terse.id })
    await ready()
    await first.user.click(button('Export…'))
    await waitFor(() => expect(first.host.state().savedTexts).toHaveLength(1))
    expect(first.host.state().savedTexts[0]!.text).not.toContain('kind:')
    await open(/Safety reviewer/)
    await first.user.click(button('Export…'))
    await waitFor(() => expect(first.host.state().savedTexts).toHaveLength(2))
    const text = first.host.state().savedTexts[1]!.text
    expect(text).toContain('\nkind: reviewer\n')
    expect(parseAgentFile(text)).toMatchObject({ kind: 'reviewer', problems: [] })
  })

  it('shows the kind of the file on the review screen, says that an imported agent has no skills, and saves a reviewer', async () => {
    const { user, callsOf } = mount({ agents: [terse], skills: skillFixtures.few, host: { textPicks: [{ name: 'File reviewer.md', text: REVIEWER_FILE }] } })
    await startImport(user)
    expect(screen.getByText(`${en['agents.import.kind']}: ${en['agents.kind.reviewer']}`)).toBeTruthy()
    expect(screen.getByText(en['agents.import.noSkills'])).toBeTruthy()
    await user.click(button('Save as a new agent'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en['agents.status.imported']))
    expect(callsOf('saveAgent')).toEqual([{ name: 'File reviewer', description: 'From a file', persona: 'Strict.', instructions: 'Say what could go wrong.', kind: 'reviewer' }])
    expect(listItem(/File reviewer/).textContent).toContain('Reviewer')
    expect(listItem(/File reviewer/).textContent).not.toContain('In use')
  })

  it('shows an assistant as the kind of a file that has none', async () => {
    const { user } = mount({ agents: [terse], host: { textPicks: [{ name: 'a.md', text: REVIEWER_FILE.replace('kind: reviewer\n', '') }] } })
    await startImport(user)
    expect(screen.getByText(`${en['agents.import.kind']}: ${en['agents.kind.assistant']}`)).toBeTruthy()
  })

  it('refuses a kind that is neither, by line, and blocks Save', async () => {
    const { user } = mount({ agents: [terse], host: { textPicks: [{ name: 'a.md', text: REVIEWER_FILE.replace('kind: reviewer', 'kind: admin') }] } })
    await startImport(user)
    expect(within(screen.getByRole('alert')).getByText('Line 4: The kind must be assistant or reviewer.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).not.toContain('admin')
    expect(button('Save as a new agent').disabled).toBe(true)
  })

  it('has a key list that includes the kind in its messages', () => {
    expect(en['agents.file.problem.unknown_key']).toContain('name, description and kind')
    expect(ko['agents.file.problem.unknown_key']).toContain('kind')
  })
})

describe('the chat picker', () => {
  it('lists only assistants, and shows no reviewer even if the engine lists one', async () => {
    const { client } = mount({ agents: [terse, ...agentFixtures.reviewers, agentOf('agent-assist', { name: 'Another assistant', kind: 'assistant' })], activeAgentId: terse.id })
    await ready()
    renderThemed(<AgentPicker client={client} />, { locale: 'en' })
    const picker = await screen.findByRole('combobox', { name: 'Agent' })
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Default', 'Another assistant', 'Terse reviewer'])
    expect((picker as HTMLSelectElement).value).toBe(terse.id)
    expect(within(picker).queryByRole('option', { name: reviewerKo.name })).toBeNull()
  })
})
