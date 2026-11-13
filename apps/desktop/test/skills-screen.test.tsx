import { RillError, SKILL_MAX_ITEMS, type Agent, type MethodName, type MethodParams, type MethodResult, type Skill } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SkillsScreen } from '../src/app/agents/SkillsScreen'
import { parseSkillFile, serialiseSkillFile } from '../src/app/agents/skill-file'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { createFakeHost, type FakeHostState } from '../src/engine/fake-host'
import { withPlanMethods } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { agentFixtures } from '../src/fixtures/agents'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { filler, skillFixtures } from '../src/fixtures/skills'
import { createTranslator, type Locale } from '../src/i18n'
import { HostError } from '../src/shared/host-api'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations } from './axe'
import { frames, gate } from './keep-focus'
import { renderThemed } from './render'

const [receipts, slack] = skillFixtures.few as [Skill, Skill, Skill]

const FILE = ['---', 'name: Imported skill', 'description: From a file', '---', '', '# Body', '', 'Check the vendor.', 'Check the total.', ''].join('\n')

interface Options {
  skills?: readonly Skill[]
  agents?: readonly Agent[]
  host?: Partial<FakeHostState>
  intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined
  locale?: Locale
  files?: boolean
}

function mount(options: Options = {}) {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
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
  const locale = options.locale ?? 'en'
  const view = renderThemed(<SkillsScreen client={client} {...(options.files === false ? {} : { files: host.dialogs })} />, { locale })
  return { view, host, inner, user: userEvent.setup(), t: createTranslator(locale), callsOf: (method: MethodName) => calls.filter((call) => call.method === method).map((call) => call.params) }
}

const listItem = (name: string | RegExp): HTMLElement => within(screen.getByRole('list', { name: 'Skill list' })).getByRole('button', { name })
const field = (name: string): HTMLInputElement | HTMLTextAreaElement => screen.getByRole('textbox', { name }) as HTMLInputElement | HTMLTextAreaElement
const button = (name: string | RegExp): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement

async function ready(): Promise<void> {
  await screen.findByRole('list', { name: 'Skill list' })
}

function change(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } })
}

describe('the list', () => {
  it('shows the saved skills by name with their size and the agents that use each one', async () => {
    mount({ skills: skillFixtures.few, agents: agentFixtures.skilled })
    await ready()
    const items = within(screen.getByRole('list', { name: 'Skill list' })).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Receipts checklist'),
      expect.stringContaining('Slack message style'),
      expect.stringContaining('한국어 요약 규칙'),
    ])
    expect(items[0]!.textContent).toContain(`${[...receipts.body].length} characters`)
    expect(items[0]!.textContent).toContain('Used by: Receipts helper')
    expect(items[1]!.textContent).toContain('Used by: Receipts helper')
    expect(items[2]!.textContent).toContain('No agent uses it')
    expect(items[0]!.textContent).toContain(receipts.description)
  })

  it('counts the saved skills out of 24', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    expect(screen.getByText('3 of 24 saved')).toBeTruthy()
  })

  it('names at most three agents and counts the others', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...agentFixtures.few[0]!, id: `agent-${id}`, name: `Agent ${id}`, skillIds: ['skill-slack'] }))
    mount({ skills: skillFixtures.few, agents: many })
    await ready()
    expect(listItem(/Slack message style/).textContent).toContain('Used by: Agent a, Agent b, Agent c, 2 more')
  })

  it('selects the first skill, and shows its text in the editor', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    expect(listItem(/Receipts checklist/).getAttribute('aria-current')).toBe('true')
    expect(field('Name').value).toBe('Receipts checklist')
    expect(field('Description').value).toBe(receipts.description)
    expect(field('Text').value).toBe(receipts.body)
  })

  it('opens the form for a new skill when there is none yet', async () => {
    mount()
    await ready()
    expect(screen.getByRole('heading', { level: 3, name: 'New skill' })).toBeTruthy()
    expect(button('Create skill').disabled).toBe(true)
  })

  it('shows the translated texts in Korean', async () => {
    mount({ locale: 'ko', skills: skillFixtures.few })
    await screen.findByRole('list', { name: ko['skills.list.label'] })
    expect(screen.getByText('저장한 스킬 3/24')).toBeTruthy()
    expect(screen.getByRole('button', { name: ko['skills.list.new'] })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: ko['skills.field.body'] })).toBeTruthy()
  })
})

describe('the screen', () => {
  it('keeps its title for screen readers, does not draw it, and says what a skill is', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    const heading = screen.getByRole('heading', { level: 2, name: 'Skills' })
    expect(heading.className).toMatch(/hidden/)
    expect(screen.getByText(en['skills.screen.intro'])).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Skills' })).toBeTruthy()
  })

  it('says on screen that the text of a skill is sent to the model provider, with a transfer mark', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    const note = screen.getByText(en['skills.screen.transfer'])
    expect(note.parentElement?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('shows loading, and an error with a retry', async () => {
    const first = mount({ intercept: (method) => (method === 'listSkills' ? new Promise(() => undefined) : undefined) })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByText(en['skills.screen.loading'])).toBeTruthy()
    first.view.unmount()
    let failing = true
    const { user } = mount({ skills: skillFixtures.few, intercept: (method) => (method === 'listSkills' && failing ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.screen.loadError'])
    failing = false
    await user.click(button('Try again'))
    await ready()
  })

  it('has no accessibility violations', async () => {
    const { view } = mount({ skills: skillFixtures.few, agents: agentFixtures.skilled })
    await ready()
    expect(await violations(view.container)).toEqual([])
  })
})

describe('the editor', () => {
  it('shows the three fields with their hints and counters, and the rules of the engine as hints', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    expect(screen.getByText(en['skills.field.name.hint'])).toBeTruthy()
    expect(screen.getByText(en['skills.field.description.hint'])).toBeTruthy()
    expect(screen.getByText(en['skills.field.body.hint'])).toBeTruthy()
    expect(screen.getByText('18/60')).toBeTruthy()
    expect(screen.getAllByText(/^\d+\/(60|200|4,000)$/)).toHaveLength(3)
    expect(screen.getByText(`${[...receipts.body].length}/4,000`)).toBeTruthy()
    expect(screen.getByText(/at most 6,000 characters together/)).toBeTruthy()
  })

  it('counts characters, not UTF-16 units, and turns the counter red past the limit', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    change('Text', '😀'.repeat(4000))
    expect(screen.getByText('4,000/4,000').className).not.toMatch(/Over/)
    change('Text', '😀'.repeat(4001))
    expect(screen.getByText('4,001/4,000').className).toMatch(/Over/)
  })

  it.each([
    ['Name', '', 'A name is required.'],
    ['Name', 'one\ttwo', 'This is one line: no line breaks, tabs or other control characters.'],
    ['Name', 'x'.repeat(61), 'At most 60 characters.'],
    ['Description', 'a\tb', 'This is one line: no line breaks, tabs or other control characters.'],
    ['Description', 'x'.repeat(201), 'At most 200 characters.'],
    ['Text', '', 'The text is required.'],
    ['Text', 'a\tb', 'Line breaks are fine; tabs and other control characters are not.'],
    ['Text', 'a\u2028b', 'Line and paragraph separator characters are not allowed.'],
    ['Text', 'a\u202eb', 'Characters that change the text direction are not allowed.'],
    ['Text', 'a\u200bb', 'Invisible formatting characters are not allowed.'],
    ['Text', 'x'.repeat(4001), 'At most 4,000 characters.'],
  ])('says what is wrong with %s %#, as the engine would, and blocks Save', async (label, value, message) => {
    mount({ skills: skillFixtures.few })
    await ready()
    change(label, value)
    expect(screen.getByText(message)).toBeTruthy()
    expect(field(label).getAttribute('aria-invalid')).toBe('true')
    expect(button('Save').disabled).toBe(true)
  })

  it('accepts line breaks in the text', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    change('Text', 'one\ntwo\n\nthree')
    expect(screen.queryByText(/Line breaks are fine/)).toBeNull()
    expect(button('Save').disabled).toBe(false)
  })

  it('keeps Save off until something changed and valid', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    expect(button('Save').disabled).toBe(true)
    change('Name', 'Receipts checklist 2')
    expect(button('Save').disabled).toBe(false)
    change('Name', 'Receipts checklist')
    expect(button('Save').disabled).toBe(true)
  })

  it('lists the agents that have the skill, or says that none has it', async () => {
    mount({ skills: skillFixtures.few, agents: agentFixtures.skilled })
    await ready()
    const used = screen.getByRole('list', { name: en['skills.editor.usedBy'] })
    expect(within(used).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Receipts helper'])
    await userEvent.setup().click(listItem(/한국어/))
    expect(screen.queryByRole('list', { name: en['skills.editor.usedBy'] })).toBeNull()
    expect(screen.getByText(en['skills.editor.unused'])).toBeTruthy()
  })
})

describe('saving', () => {
  it('creates a skill: New skill, fill, Create, and the new skill is selected and in the list', async () => {
    const { callsOf, user } = mount({ skills: skillFixtures.few })
    await ready()
    await user.click(button('New skill'))
    expect(screen.getByRole('heading', { level: 3, name: 'New skill' })).toBeTruthy()
    expect(button('Create skill').disabled).toBe(true)
    change('Name', '  Zed   note ')
    change('Text', 'Line one\nLine two')
    await user.click(button('Create skill'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The skill was created.'))
    expect(callsOf('saveSkill')).toEqual([{ name: '  Zed   note ', description: '', body: 'Line one\nLine two' }])
    expect(listItem(/Zed note/).getAttribute('aria-current')).toBe('true')
    expect(field('Name').value).toBe('Zed note')
    expect(screen.getByText('4 of 24 saved')).toBeTruthy()
  })

  it('updates a skill with its id and says so', async () => {
    const { callsOf, user } = mount({ skills: skillFixtures.few })
    await ready()
    change('Text', 'New text')
    expect(screen.getByText(en['skills.editor.unsaved'])).toBeTruthy()
    await user.click(button('Save'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveSkill')).toEqual([{ id: receipts.id, name: receipts.name, description: receipts.description, body: 'New text' }])
    expect(screen.queryByText(en['skills.editor.unsaved'])).toBeNull()
  })

  it('undoes the changes', async () => {
    const { user } = mount({ skills: skillFixtures.few })
    await ready()
    change('Text', 'Typed')
    await user.click(button('Undo changes'))
    expect(field('Text').value).toBe(receipts.body)
  })

  it('shows a duplicate name as an alert and keeps what was typed', async () => {
    const { user } = mount({ skills: skillFixtures.few })
    await ready()
    change('Name', 'slack MESSAGE style')
    await user.click(button('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.error.SKILL_DUPLICATE'])
    expect(field('Name').value).toBe('slack MESSAGE style')
  })

  it('shows the limit: New skill and Import are off at 24 skills, with the reason', async () => {
    mount({ skills: skillFixtures.full })
    await ready()
    expect(button('New skill').disabled).toBe(true)
    expect(button('Import…').disabled).toBe(true)
    expect(screen.getAllByRole('note').map((note) => note.textContent)).toContain(`All ${SKILL_MAX_ITEMS} places are used. Delete a skill to add another.`)
    expect(screen.getByText('24 of 24 saved')).toBeTruthy()
  })

  it('shows the engine answer for a full list when the list on screen was out of date', async () => {
    const { user, inner } = mount({ skills: skillFixtures.few })
    await ready()
    for (let index = 0; index < SKILL_MAX_ITEMS - 3; index++) inner.skills.save({ name: `Other ${index}`, description: '', body: 'x' }, [])
    await user.click(button('New skill'))
    change('Name', 'one too many')
    change('Text', 'x')
    await user.click(button('Create skill'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.error.SKILL_FULL'])
  })

  it('says that a longer text would push an agent past 6,000 characters, without any name or text', async () => {
    const { user } = mount({ skills: skillFixtures.big, agents: [{ ...agentFixtures.few[0]!, skillIds: ['skill-big-a', 'skill-big-b'] }] })
    await ready()
    await user.click(listItem(/Glossary/))
    change('Text', filler(2600, 'Term and its meaning. '))
    await user.click(button('Save'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(en['skills.error.tooLargeForAgent'])
    expect(alert.textContent).not.toContain('Terse')
  })

  it('sends one request for a double submit', async () => {
    const { callsOf } = mount({ skills: skillFixtures.few })
    await ready()
    change('Text', 'Twice?')
    const save = button('Save')
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.submit(save.closest('form')!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveSkill')).toHaveLength(1)
  })

  it('shows the fixed text of an unexpected error, never its message', async () => {
    const { user } = mount({ skills: skillFixtures.few, intercept: (method) => (method === 'saveSkill' ? Promise.reject(new RillError('INTERNAL', 'SECRET-DETAIL-3')) : undefined) })
    await ready()
    change('Name', 'Changed')
    await user.click(button('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['chat.error.INTERNAL'])
    expect(document.body.textContent).not.toContain('SECRET-DETAIL-3')
  })

  it('asks before changes are thrown away by choosing another skill, and keeps them when the person keeps editing', async () => {
    const { user } = mount({ skills: skillFixtures.few })
    await ready()
    change('Text', 'Edited')
    await user.click(listItem(/Slack message style/))
    const dialog = screen.getByRole('dialog', { name: 'Discard your changes?' })
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(field('Text').value).toBe('Edited')
    await user.click(listItem(/Slack message style/))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    expect(field('Name').value).toBe(slack.name)
  })
})

describe('a skill that another client deleted', () => {
  async function deletedElsewhere() {
    const world = mount({ skills: skillFixtures.few })
    await ready()
    await world.user.click(listItem(/Slack message style/))
    change('Text', 'MY NEW SLACK TEXT')
    await act(async () => {
      await world.inner.request('deleteSkill', { id: slack.id })
    })
    await world.user.click(button('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.error.SKILL_NOT_FOUND'])
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Skill list' })).queryByRole('button', { name: /Slack message style/ })).toBeNull())
    return world
  }

  it('does not carry the unsaved text of the deleted skill over to the skill that is shown instead', async () => {
    await deletedElsewhere()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(receipts.name)
    expect(field('Name').value).toBe(receipts.name)
    expect(field('Text').value).toBe(receipts.body)
    expect(button('Save').disabled).toBe(true)
    expect(screen.queryByText(en['skills.editor.unsaved'])).toBeNull()
  })

  it('starts the next edit from the stored skill, and saves nothing of the deleted draft', async () => {
    const { callsOf, inner, user } = await deletedElsewhere()
    change('Name', 'Receipts checklist 2')
    expect(field('Text').value).toBe(receipts.body)
    await user.click(button('Save'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(callsOf('saveSkill')).toEqual([
      { name: slack.name, description: slack.description, body: 'MY NEW SLACK TEXT', id: slack.id },
      { name: 'Receipts checklist 2', description: receipts.description, body: receipts.body, id: receipts.id },
    ])
    expect((await inner.request('listSkills', {})).skills.map((skill) => skill.body)).toContain(receipts.body)
  })

  it('shows an empty form for a new skill when the deleted one was the last, without its text', async () => {
    const { inner, user } = mount({ skills: [slack] })
    await ready()
    change('Text', 'MY NEW SLACK TEXT')
    await act(async () => {
      await inner.request('deleteSkill', { id: slack.id })
    })
    await user.click(button('Save'))
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('New skill'))
    expect(field('Text').value).toBe('')
    expect(field('Name').value).toBe('')
  })
})

describe('deleting', () => {
  it('asks first, names the skill and the agents that will lose it, and keeps it when the person keeps it', async () => {
    const { callsOf, user } = mount({ skills: skillFixtures.few, agents: [...agentFixtures.skilled, ...agentFixtures.reviewers] })
    await ready()
    await user.click(button('Delete'))
    const dialog = screen.getByRole('dialog', { name: 'Delete this skill?' })
    expect(within(dialog).getByText(/The skill “Receipts checklist” is deleted/)).toBeTruthy()
    expect(within(dialog).getByText(en['skills.delete.agents'])).toBeTruthy()
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Receipts helper', 'Safety reviewer'])
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsOf('deleteSkill')).toEqual([])
  })

  it('says that no agent has the skill when none has', async () => {
    const { user } = mount({ skills: skillFixtures.few })
    await ready()
    await user.click(button('Delete'))
    const dialog = screen.getByRole('dialog', { name: 'Delete this skill?' })
    expect(within(dialog).getByText(en['skills.delete.none'])).toBeTruthy()
    expect(within(dialog).queryByRole('list')).toBeNull()
  })

  it('deletes the skill, selects another one and loads the agents again', async () => {
    const { callsOf, user } = mount({ skills: skillFixtures.few, agents: agentFixtures.skilled })
    await ready()
    await user.click(button('Delete'))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The skill was deleted.'))
    expect(callsOf('deleteSkill')).toEqual([{ id: receipts.id }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Skill list' })).queryByRole('button', { name: /Receipts checklist/ })).toBeNull()
    expect(field('Name').value).toBe(slack.name)
    await waitFor(() => expect(callsOf('listAgents').length).toBeGreaterThan(1))
  })

  it('shows the fixed error text in the dialog when the delete fails', async () => {
    const { user } = mount({ skills: skillFixtures.few, intercept: (method) => (method === 'deleteSkill' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    await user.click(button('Delete'))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(en['chat.error.INTERNAL'])
  })
})

describe('the Import and Export buttons', () => {
  it('are there when the screen is given the file dialogs, and not otherwise', async () => {
    mount({ files: false, skills: skillFixtures.few })
    await ready()
    expect(screen.queryByRole('button', { name: 'Import…' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export…' })).toBeNull()
  })

  it('leave the screen as it was when the person cancels the file dialog', async () => {
    const { user, host } = mount({ skills: skillFixtures.few, host: { textPicks: [undefined] } })
    await ready()
    await user.click(button('Import…'))
    await waitFor(() => expect(host.state().textPicks).toEqual([]))
    expect(screen.queryByRole('heading', { name: 'Review the imported skill' })).toBeNull()
  })

  it('send one request for a double click on Import', async () => {
    const { host } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'a.md', text: FILE }, { name: 'b.md', text: FILE }] } })
    await ready()
    fireEvent.click(button('Import…'))
    fireEvent.click(button('Import…'))
    await screen.findByRole('heading', { name: 'Review the imported skill' })
    expect(host.state().textPicks).toHaveLength(1)
  })

  it('writes the saved skill as a file with a name made from its name', async () => {
    const { user, host } = mount({ skills: skillFixtures.few })
    await ready()
    await user.click(button('Export…'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The file was saved.'))
    const saved = host.state().savedTexts
    expect(saved).toHaveLength(1)
    expect(saved[0]!.suggestedName).toBe('Receipts checklist')
    const written = serialiseSkillFile({ name: receipts.name, description: receipts.description, body: receipts.body })
    expect(written.ok).toBe(true)
    expect(saved[0]!.text).toBe(written.ok ? written.text : '')
    expect(parseSkillFile(saved[0]!.text)).toEqual({ fields: { name: receipts.name, description: receipts.description, body: receipts.body }, problems: [] })
  })

  it('is off while there are unsaved changes, and says why', async () => {
    mount({ skills: skillFixtures.few })
    await ready()
    change('Text', 'Edited')
    expect(button('Export…').disabled).toBe(true)
    expect(screen.getByText(en['skills.editor.saveFirst'])).toBeTruthy()
  })

  it('refuses to export a text with a line that the format keeps for its heading, and says so', async () => {
    const { user, host } = mount({ skills: [{ ...receipts, body: 'one\n# Steps\ntwo' }] })
    await ready()
    await user.click(button('Export…'))
    expect((await screen.findByRole('alert')).textContent).toBe(en['skills.export.headingInText'])
    expect(host.state().savedTexts).toEqual([])
  })

  it('round-trips: what is exported is what an import reads', async () => {
    const first = mount({ skills: skillFixtures.few })
    await ready()
    await first.user.click(button('Export…'))
    await waitFor(() => expect(first.host.state().savedTexts).toHaveLength(1))
    const text = first.host.state().savedTexts[0]!.text
    first.view.unmount()
    const second = mount({ host: { textPicks: [{ name: 'Receipts checklist.md', text }] } })
    await ready()
    await second.user.click(button('Import…'))
    await screen.findByRole('heading', { name: 'Review the imported skill' })
    expect(field('Name').value).toBe(receipts.name)
    expect(field('Description').value).toBe(receipts.description)
    expect(screen.getByText(/Before you file a receipt:/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the review of an imported file', () => {
  async function startImport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await ready()
    await user.click(button('Import…'))
    await screen.findByRole('heading', { level: 3, name: 'Review the imported skill' })
  }

  it('shows the parsed fields, says that nothing is saved or attached, and names the file and what is sent', async () => {
    const { user, callsOf } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'Imported skill.md', text: FILE }] } })
    await startImport(user)
    expect(screen.getByText('File: Imported skill.md')).toBeTruthy()
    expect(screen.getByText(en['skills.import.nothing'])).toBeTruthy()
    expect(screen.getByText(en['skills.import.sent'])).toBeTruthy()
    expect(field('Name').value).toBe('Imported skill')
    expect(field('Description').value).toBe('From a file')
    expect(screen.getByText(/Check the vendor\./)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(callsOf('saveSkill')).toEqual([])
  })

  it('saves a new skill only when Save is pressed, and attaches it to no agent', async () => {
    const { user, callsOf } = mount({ skills: skillFixtures.few, agents: agentFixtures.skilled, host: { textPicks: [{ name: 'a.md', text: FILE }] } })
    await startImport(user)
    await user.click(button('Save as a new skill'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en['skills.status.imported']))
    expect(callsOf('saveSkill')).toEqual([{ name: 'Imported skill', description: 'From a file', body: 'Check the vendor.\nCheck the total.' }])
    expect(callsOf('saveAgent')).toEqual([])
    expect(listItem(/Imported skill/).getAttribute('aria-current')).toBe('true')
  })

  it('saves nothing when the person cancels the import', async () => {
    const { user, callsOf } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'a.md', text: FILE }] } })
    await startImport(user)
    await user.click(button('Cancel import'))
    expect(screen.queryByRole('heading', { name: 'Review the imported skill' })).toBeNull()
    expect(callsOf('saveSkill')).toEqual([])
  })

  it('asks before an unsaved import is thrown away by choosing another skill', async () => {
    const { user } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'a.md', text: FILE }] } })
    await startImport(user)
    await user.click(listItem(/Slack message style/))
    expect(within(screen.getByRole('dialog')).getByText(en['skills.unsaved.messageImport'])).toBeTruthy()
  })

  it('lists every problem with a plain message and a line number, and blocks Save', async () => {
    const text = FILE.replace('description: From a file', 'description: From a file\nkind: reviewer\nmodel: x').replace('Check the vendor.', 'Che\tck')
    const { user, callsOf } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'bad.md', text }] } })
    await startImport(user)
    const alert = within(screen.getByRole('alert'))
    expect(alert.getByText(en['skills.import.problems'])).toBeTruthy()
    expect(alert.getByText('Line 4: This front matter key is not allowed. Only name and description are.')).toBeTruthy()
    expect(alert.getByText('Line 5: This front matter key is not allowed. Only name and description are.')).toBeTruthy()
    expect(alert.getByText('Text: Line breaks are fine; tabs and other control characters are not.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).not.toContain('reviewer')
    expect(button('Save as a new skill').disabled).toBe(true)
    fireEvent.submit(button('Save as a new skill').closest('form')!)
    expect(callsOf('saveSkill')).toEqual([])
  })

  it('lets the person fix a name problem in the review, and Save turns on', async () => {
    const { user, callsOf } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'long.md', text: FILE.replace('Imported skill', 'x'.repeat(61)) }] } })
    await startImport(user)
    expect(screen.getByText('At most 60 characters.')).toBeTruthy()
    expect(button('Save as a new skill').disabled).toBe(true)
    fireEvent.change(field('Name'), { target: { value: 'Short name' } })
    await user.click(button('Save as a new skill'))
    await waitFor(() => expect(callsOf('saveSkill')).toHaveLength(1))
    expect(callsOf('saveSkill')[0]).toMatchObject({ name: 'Short name' })
  })

  it('makes a name that already exists be changed first, ignoring case', async () => {
    const { user, callsOf } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'dup.md', text: FILE.replace('Imported skill', 'receipts CHECKLIST') }] } })
    await startImport(user)
    expect(screen.getByRole('alert').textContent).toContain(en['skills.import.duplicate'])
    expect(button('Save as a new skill').disabled).toBe(true)
    fireEvent.change(field('Name'), { target: { value: 'Receipts checklist, new' } })
    expect(screen.queryByText(en['skills.import.duplicate'])).toBeNull()
    await user.click(button('Save as a new skill'))
    await waitFor(() => expect(callsOf('saveSkill')).toHaveLength(1))
  })

  it('shows a file that is not a skill as unreadable, with nothing to save', async () => {
    const { user } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'notes.md', text: '# Body\n\nhello\n' }] } })
    await startImport(user)
    expect(within(screen.getByRole('alert')).getByText(en['skills.file.problem.front_matter_missing'])).toBeTruthy()
    expect(screen.getByText(en['skills.import.noFields'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save as a new skill' })).toBeNull()
    await user.click(button('Cancel import'))
    expect(screen.queryByRole('heading', { name: 'Review the imported skill' })).toBeNull()
  })

  it.each([
    ['too large', 'FILE_TOO_LARGE', en['app.error.host.FILE_TOO_LARGE']],
    ['refused', 'FILE_REJECTED', en['app.error.host.FILE_REJECTED']],
    ['unreadable', 'INTERNAL', en['app.error.host.INTERNAL']],
  ] as const)('says that a file that is %s was not opened, with the fixed text', async (_name, code, message) => {
    const { user } = mount({ skills: skillFixtures.few, host: { textPicks: [new HostError(code)] } })
    await ready()
    await user.click(button('Import…'))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByRole('heading', { name: 'Review the imported skill' })).toBeNull()
  })

  it('shows the text of a hostile file as text, with hidden characters marked', async () => {
    const hostile = FILE.replace('Check the vendor.', '<img src=x onerror=alert(2)> [x](https://evil.example) \u202e').replace('Imported skill', '<b>Imported</b>')
    const { user, view } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: '<img src=x onerror=alert(1)>.md', text: hostile }] } })
    await startImport(user)
    expect(view.container.querySelector('img, b, a')).toBeNull()
    expect(screen.getByText(/File: <img src=x onerror=alert\(1\)>\.md/)).toBeTruthy()
    expect(document.body.textContent).toContain('‹U+202E›')
  })

  it('has no accessibility violations', async () => {
    const { user, view } = mount({ skills: skillFixtures.few, host: { textPicks: [{ name: 'a.md', text: FILE }] } })
    await startImport(user)
    expect(await violations(view.container)).toEqual([])
  })
})

describe('hostile names', () => {
  it('are shown as text everywhere: the list, the title, the used-by line and the delete dialog', async () => {
    const hostileAgent = { ...agentFixtures.hostile[0]!, skillIds: ['skill-hostile'] }
    const { user, view } = mount({ skills: [...skillFixtures.hostile, ...skillFixtures.long], agents: [hostileAgent] })
    await ready()
    expect(view.container.querySelector('img, script, b, a')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Skill list' })).getByRole('button', { name: /<img src=x onerror=alert\(1\)>/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('<img src=x onerror=alert(1)>')
    await user.click(button('Delete'))
    expect(document.querySelector('[role="dialog"] img')).toBeNull()
    expect(within(screen.getByRole('dialog')).getAllByRole('listitem')).toHaveLength(1)
  })
})

describe('focus and the live region', () => {
  it('moves the focus to the title of the skill that was chosen', async () => {
    const { user } = mount({ skills: skillFixtures.few })
    await ready()
    await user.click(listItem(/Slack message style/))
    const title = screen.getByRole('heading', { level: 3, name: 'Slack message style' })
    await waitFor(() => expect(document.activeElement).toBe(title))
  })

  it('gives the focus back to the Save button when a slow save is refused', async () => {
    const wait = gate()
    const { user, inner } = mount({
      skills: skillFixtures.few,
      intercept: (method, params) => (method === 'saveSkill' ? wait.promise.then(() => inner.request(method, params as MethodParams<'saveSkill'>)) : undefined),
    })
    await ready()
    change('Name', 'slack MESSAGE style')
    const save = button('Save')
    save.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(save.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await screen.findByRole('alert')
    expect(save.disabled).toBe(false)
    expect(document.activeElement).toBe(save)
  })

  it('gives the focus back to the Name field where Enter was pressed after a slow save went through', async () => {
    const wait = gate()
    const { user, inner } = mount({
      skills: skillFixtures.few,
      intercept: (method, params) => (method === 'saveSkill' ? wait.promise.then(() => inner.request(method, params as MethodParams<'saveSkill'>)) : undefined),
    })
    await ready()
    change('Name', 'Receipts checklist 2')
    const name = field('Name')
    name.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(name.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(document.activeElement).toBe(field('Name'))
  })

  it('announces a result in a status region that is always there', async () => {
    const { user } = mount({ skills: skillFixtures.few })
    await ready()
    const status = screen.getByRole('status', { hidden: true })
    expect(status.hasAttribute('hidden')).toBe(true)
    change('Text', 'Edited')
    await user.click(button('Save'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
  })
})
