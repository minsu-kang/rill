import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, type AppProps } from '../src/app/App'
import { createFakeWorld, type FakeWorld, type FakeWorldOptions } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { fakeSettings, type FakeHostState } from '../src/engine/fake-host'
import { fakeData, ids } from '../src/fixtures'
import { explainCases } from '../src/fixtures/explain'
import { recipeInfos } from '../src/fixtures/recipes'
import { createTranslator } from '../src/i18n'
import { renderThemed } from './render'
import { violations } from './axe'

const MARKER = 'shell-secret-MARKER-0123456789'
const t = createTranslator('ko')
const KEYED = fakeSettings({ configuredProviders: ['anthropic', 'openai'], allowedFolders: ['/Users/demo/Receipts'] })

interface Options {
  world?: FakeWorldOptions
  hostInit?: Partial<FakeHostState>
  initial?: AppProps['initial']
  locale?: 'ko' | 'en'
  restartDelayMs?: number
}

function mount(options: Options = {}) {
  const world = createFakeWorld({
    hostOptions: { restartDelayMs: options.restartDelayMs ?? 0 },
    ...(options.hostInit === undefined ? {} : { hostInit: options.hostInit }),
    control: { stepIntervalMs: 0 },
    ...options.world,
  })
  const view = renderThemed(
    <HostProvider host={world.host} connect={world.connect}>
      <App initial={options.initial} />
    </HostProvider>,
    { locale: options.locale ?? 'ko' },
  )
  return { world, view, user: userEvent.setup() }
}

async function connected(): Promise<void> {
  await screen.findByText(t('app.top.engine.connected'))
}

const tab = (name: string) => within(screen.getByRole('navigation', { name: t('app.top.screens') })).getByRole('button', { name })

async function workflowsLoaded(): Promise<void> {
  await waitFor(() => expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0))
}

afterEach(() => vi.restoreAllMocks())

describe('App shell', () => {
  it('renders the three regions with landmarks, the top bar, the tabs and the engine status', async () => {
    const { view } = mount({ hostInit: { settings: KEYED } })
    expect(screen.getByRole('banner', { name: t('app.region.top') })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: t('app.region.chat') })).toBeTruthy()
    expect(screen.getByRole('main', { name: t('app.region.main') })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: t('app.top.screens') })
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['워크플로우', '레시피', '설정'])
    expect(within(nav).getByRole('button', { name: '워크플로우' }).getAttribute('aria-current')).toBe('page')
    await connected()
    for (const region of ['topbar', 'chat', 'workspace']) expect(view.container.querySelector(`[data-rill-region="${region}"]`)).toBeTruthy()
    expect(view.container.querySelector('[data-rill-app]')).toBeTruthy()
  })

  it('has no axe violations once it is connected and a workflow is drawn', async () => {
    const { view } = mount({ hostInit: { settings: KEYED } })
    await connected()
    await workflowsLoaded()
    expect(await violations(view.container)).toEqual([])
  })

  it('marks the status chip with the ping result the smoke check reads', async () => {
    const { view } = mount({ hostInit: { settings: KEYED } })
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).toBeTruthy())
    expect(view.container.querySelector('[data-rill-ping-ms]')).toBeTruthy()
  })

  it('selects the first workflow by itself and draws its graph, and the switcher changes it', async () => {
    const { user } = mount({ hostInit: { settings: KEYED } })
    await workflowsLoaded()
    const select = screen.getByLabelText(t('app.wf.switcher.label')) as HTMLSelectElement
    expect(select.value).toBe((select.options[0] as HTMLOptionElement).value)
    expect(select.value).not.toBe('')
    await user.selectOptions(select, ids.workflows.webhook)
    await waitFor(() => expect(screen.getByTestId('rf__node-hook')).toBeTruthy())
    expect(screen.getByRole('region', { name: t('app.wf.actions.label') })).toBeTruthy()
  })
})

describe('first run', () => {
  it('shows the checklist from the host settings and leads to the right settings sections', async () => {
    const { user } = mount({ world: { workflows: [] } })
    const card = await screen.findByRole('region', { name: t('app.firstRun.title') })
    const items = within(card).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.getAttribute('data-done'))).toEqual(['false', 'false', 'false'])
    await user.click(within(card).getByRole('button', { name: t('app.firstRun.key.action') }))
    expect(tab('설정').getAttribute('aria-current')).toBe('page')
    expect(await screen.findByRole('heading', { name: 'API 키', level: 2 })).toBeTruthy()
    await user.click(tab('워크플로우'))
    await user.click(within(await screen.findByRole('region', { name: t('app.firstRun.title') })).getByRole('button', { name: t('app.firstRun.folder.action') }))
    expect(await screen.findByRole('heading', { name: '폴더', level: 2 })).toBeTruthy()
    await user.click(tab('워크플로우'))
    await user.click(within(await screen.findByRole('region', { name: t('app.firstRun.title') })).getByRole('button', { name: t('app.firstRun.slack.action') }))
    expect(await screen.findByRole('heading', { name: '연결', level: 2 })).toBeTruthy()
  })

  it('marks what is done, keeps showing while one required item is open, and disappears when the folder and the key are done', async () => {
    const { user } = mount({ world: { workflows: [] }, hostInit: { settings: fakeSettings({ allowedFolders: ['/Users/demo/Receipts'] }) } })
    const card = await screen.findByRole('region', { name: t('app.firstRun.title') })
    expect(within(card).getAllByRole('listitem').map((item) => item.getAttribute('data-done'))).toEqual(['true', 'false', 'false'])
    await user.click(tab('설정'))
    await user.click(screen.getByRole('button', { name: 'API 키' }))
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })), `${MARKER}{Enter}`)
    await screen.findByText(t('app.keys.saved'))
    await user.click(tab('워크플로우'))
    await waitFor(() => expect(screen.queryByRole('region', { name: t('app.firstRun.title') })).toBeNull())
  })

  it('does not show for a host that is already set up', async () => {
    mount({ hostInit: { settings: KEYED } })
    await connected()
    expect(screen.queryByRole('region', { name: t('app.firstRun.title') })).toBeNull()
  })

  it('shows the no-model state in the chat until a key exists, and then the chat can plan', async () => {
    const { user } = mount({ world: { workflows: [] } })
    expect(await screen.findByText(t('chat.panel.noModelTitle'))).toBeTruthy()
    await user.click(tab('설정'))
    await user.click(screen.getByRole('button', { name: 'API 키' }))
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })), `${MARKER}{Enter}`)
    await screen.findByText(t('app.keys.saved'))
    await waitFor(() => expect(screen.queryByText(t('chat.panel.noModelTitle'))).toBeNull())
  })
})

describe('deploying', () => {
  it('selects the workflow that the chat deployed and shows its actions', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED } })
    await connected()
    const composer = await screen.findByLabelText(t('chat.composer.label'))
    await user.type(composer, t('chat.panel.example1'))
    await user.keyboard('{Control>}{Enter}{/Control}')
    await user.click(await screen.findByRole('button', { name: t('chat.deploy.button') }))
    await waitFor(() => expect(world.callsOf('deployPlan')).toHaveLength(1))
    const added = world.workflowIds().find((id) => id.startsWith('wf-deployed-'))!
    await waitFor(() => expect((screen.getByLabelText(t('app.wf.switcher.label')) as HTMLSelectElement).value).toBe(added))
    expect(screen.getByRole('button', { name: t('app.wf.actions.dryRun') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('app.wf.actions.activate') })).toBeTruthy()
    expect(tab('워크플로우').getAttribute('aria-current')).toBe('page')
  })

  it('selects the workflow that a recipe deployed, from the recipes tab, and shows its actions', async () => {
    const { user, world } = mount({ hostInit: { settings: fakeSettings({ ...KEYED, connections: [{ name: 'slack-ops', kind: 'slack' }] }) } })
    await connected()
    await user.click(tab('레시피'))
    const health = recipeInfos.find((recipe) => recipe.id === 'daily-health-check')!
    await user.click(await screen.findByRole('button', { name: t('recipes.card.chooseLabel', { title: health.title.ko }) }))
    await user.type(screen.getByLabelText(health.params[1]!.label.ko), 'https://example.test/health')
    await user.selectOptions(screen.getByLabelText(health.params[2]!.label.ko), 'slack-ops')
    await user.click(screen.getByRole('button', { name: t('recipes.form.submit') }))
    await user.click(await screen.findByRole('button', { name: t('recipes.preview.deploy') }))
    await waitFor(() => expect(tab('워크플로우').getAttribute('aria-current')).toBe('page'))
    await waitFor(() => expect((screen.getByLabelText(t('app.wf.switcher.label')) as HTMLSelectElement).value).toBe('wf-recipe-deployed'))
    expect(world.workflowIds()).toContain('wf-recipe-deployed')
    expect(screen.getByRole('button', { name: t('app.wf.actions.dryRun') })).toBeTruthy()
  })
})

describe('edit context', () => {
  it('sets the chat edit context from a node picked in the graph, and clears it again', async () => {
    const { user } = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.receipt } })
    await workflowsLoaded()
    expect(screen.queryByText(/수정 중/)).toBeNull()
    fireEvent.click(screen.getByTestId('rf__node-extract'))
    expect(await screen.findByText(t('chat.composer.editingNode', { workflow: ids.workflows.receipt, node: 'extract' }))).toBeTruthy()
    const chat = screen.getByRole('complementary', { name: t('app.region.chat') })
    const clear = within(chat).getAllByRole('button').find((button) => /수정 해제|해제|지우기|취소/.test(button.textContent ?? '') && button.closest('[class*="composer"], form, div') !== null && chat.textContent?.includes('수정 중'))
    expect(clear).toBeTruthy()
    await user.click(clear!)
    await waitFor(() => expect(screen.queryByText(/수정 중/)).toBeNull())
    expect(screen.getByRole('heading', { name: 'Extract fields with AI', level: 3 })).toBeTruthy()
  })

  it('sends the workflow and the node with the next plan request', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.receipt } })
    await workflowsLoaded()
    fireEvent.click(screen.getByTestId('rf__node-extract'))
    await screen.findByText(/수정 중/)
    await user.type(screen.getByLabelText(t('chat.composer.label')), '금액만 뽑아 줘')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(world.callsOf('plan')).toHaveLength(1))
    expect(world.callsOf('plan')[0]!.params).toMatchObject({ workflowId: ids.workflows.receipt, selection: { nodeId: 'extract' } })
  })

  it('forgets the edit context when another workflow is chosen', async () => {
    const { user } = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.receipt } })
    await workflowsLoaded()
    fireEvent.click(screen.getByTestId('rf__node-extract'))
    await screen.findByText(/수정 중/)
    await user.selectOptions(screen.getByLabelText(t('app.wf.switcher.label')), ids.workflows.webhook)
    await waitFor(() => expect(screen.queryByText(/수정 중/)).toBeNull())
  })
})

describe('failed run and the explanation', () => {
  const failed = { workflowId: ids.workflows.receipt, runId: ids.runs.receiptFailed }

  it('shows the explain button for a failed run and nowhere else', async () => {
    const { view } = mount({ hostInit: { settings: KEYED }, initial: failed })
    await workflowsLoaded()
    expect(await screen.findAllByRole('button', { name: t('explain.ask') })).toHaveLength(1)
    expect(within(view.container.querySelector('[data-rill-region="chat"]') as HTMLElement).queryByText(t('explain.ask'))).toBeNull()
  })

  it('shows no explain button for a run that did not fail, or when no run is open', async () => {
    const ok = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.receipt, runId: ids.runs.receiptOk } })
    await workflowsLoaded()
    await waitFor(() => expect(within(screen.getByRole('region', { name: t('history.heading') })).getAllByRole('button').length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: t('explain.ask') })).toBeNull()
    ok.view.unmount()
    mount({ hostInit: { settings: KEYED } })
    await workflowsLoaded()
    expect(screen.queryByRole('button', { name: t('explain.ask') })).toBeNull()
  })

  async function explain(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: t('explain.ask') }))
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: t('explain.notice.send') }))
  }

  it('does what the suggested buttons say: open the connections section', async () => {
    const { user } = mount({ hostInit: { settings: KEYED }, initial: failed })
    await explain(user)
    await user.click(await screen.findByRole('button', { name: t('explain.action.open_connections') }))
    expect(tab('설정').getAttribute('aria-current')).toBe('page')
    expect(await screen.findByRole('heading', { name: '연결', level: 2 })).toBeTruthy()
  })

  it('retries the run after the confirmation of the card, selecting the new run', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED }, initial: failed })
    await explain(user)
    await user.click(await screen.findByRole('button', { name: t('explain.action.retry_run') }))
    await user.click(await screen.findByRole('button', { name: t('explain.confirm.yes') }))
    await waitFor(() => expect(world.callsOf('startRun')).toHaveLength(1))
    expect(world.callsOf('startRun')[0]!.params).toEqual({ workflowId: ids.workflows.receipt })
    expect(await screen.findByText(t('app.notice.retryStarted'))).toBeTruthy()
  })

  it('deactivates the workflow after the confirmation of the card', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED }, initial: failed })
    await explain(user)
    await user.click(await screen.findByRole('button', { name: t('explain.action.deactivate_workflow') }))
    await user.click(await screen.findByRole('button', { name: t('explain.confirm.yes') }))
    await waitFor(() => expect(world.callsOf('deactivate')).toHaveLength(1))
    expect(await screen.findByText(t('app.notice.deactivated'))).toBeTruthy()
  })

  it('puts a fix proposal into the chat draft and focuses it, without sending, and sets the edit context of that node', async () => {
    const { user, world } = mount({
      hostInit: { settings: KEYED },
      initial: failed,
      world: { explain: (params) => ({ ...structuredClone(explainCases.configuration), runId: params.runId }) },
    })
    await explain(user)
    await user.click(await screen.findByRole('button', { name: t('explain.fix.use') }))
    const composer = screen.getByLabelText(t('chat.composer.label')) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(explainCases.configuration.fixProposal!.requestText))
    expect(document.activeElement).toBe(composer)
    expect(world.callsOf('plan')).toHaveLength(0)
    expect(await screen.findByText(t('chat.composer.editingNode', { workflow: ids.workflows.receipt, node: 'extract' }))).toBeTruthy()
  })

  it('edits the node of a suggested action: selects it and sets the edit context', async () => {
    const { user } = mount({
      hostInit: { settings: KEYED },
      initial: failed,
      world: { explain: (params) => ({ ...structuredClone(explainCases.permission), runId: params.runId }) },
    })
    await explain(user)
    await user.click(await screen.findByRole('button', { name: t('explain.action.edit_node') }))
    expect(await screen.findByText(t('chat.composer.editingNode', { workflow: ids.workflows.receipt, node: 'append' }))).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Append CSV row', level: 3 })).toBeTruthy()
  })

  it('shows the file path of the failing step as text for check_input_file', async () => {
    const { user } = mount({
      hostInit: { settings: KEYED },
      initial: failed,
      world: { explain: (params) => ({ ...structuredClone(explainCases.inputData), runId: params.runId }) },
    })
    await explain(user)
    await user.click(await screen.findByRole('button', { name: t('explain.action.check_input_file') }))
    expect((await screen.findByText(/이 단계가 읽으려던 파일/)).textContent).toMatch(/\//)
  })
})

describe('engine changes', () => {
  it('restarts the engine when the model is changed in the settings, shows the status and recovers', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED }, restartDelayMs: 120 })
    await connected()
    await user.click(tab('설정'))
    await user.click(within(screen.getByRole('navigation', { name: t('app.settings.nav') })).getByRole('button', { name: '모델' }))
    await user.click(await screen.findByRole('button', { name: /GPT-6.1 Sol/ }))
    expect(await screen.findByText(t('app.top.engine.restarting'))).toBeTruthy()
    const textarea = screen.getByLabelText(t('chat.composer.label'))
    expect(textarea.matches(':disabled')).toBe(true)
    expect(screen.getByText(t('app.chat.paused'))).toBeTruthy()
    await screen.findByText(t('app.top.engine.connected'))
    expect(world.host.state().settings).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol' })
    expect(world.host.state().restartCalls).toBe(1)
    await waitFor(() => expect(screen.getByLabelText(t('chat.composer.label')).matches(':disabled')).toBe(false))
    expect(await screen.findByText(/OpenAI · gpt-6\.1-sol/)).toBeTruthy()
  })

  it('restarts the engine when the model is changed in the chat, and reloads the model list', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED }, restartDelayMs: 60 })
    await connected()
    await user.click(await screen.findByRole('button', { name: t('chat.model.label') }))
    await user.click(await screen.findByRole('button', { name: /GPT-6.1 Sol/ }))
    await waitFor(() => expect(world.host.state().settings.provider).toBe('openai'))
    await screen.findByText(t('app.top.engine.restarting'))
    await screen.findByText(t('app.top.engine.connected'))
    expect(world.callsOf('llmModels').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the stopped engine with a restart button that brings it back', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED, engine: { state: 'stopped', error: 'crashed', restarts: 6 } } })
    expect(await screen.findByText(t('app.top.engine.stopped'))).toBeTruthy()
    expect(screen.getByText(t('app.engine.error.crashed'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('app.top.engine.restart') }))
    await screen.findByText(t('app.top.engine.connected'))
    expect(world.host.state().restartCalls).toBe(1)
    expect(screen.queryByRole('button', { name: t('app.top.engine.restart') })).toBeNull()
  })

  it('tells the chat to wait for the engine while it has never been connected', async () => {
    mount({ hostInit: { settings: KEYED, engine: { state: 'starting', restarts: 0 } } })
    expect(await screen.findByText(t('app.chat.connecting'))).toBeTruthy()
    expect(screen.getByText(t('app.main.connecting'))).toBeTruthy()
  })

  it('shows the no-keychain state in the settings and the stopped engine together', async () => {
    const { user } = mount({ hostInit: { settings: fakeSettings({ encryptionAvailable: false }), engine: { state: 'stopped', error: 'no_keychain', restarts: 0 } } })
    expect(await screen.findByText(t('app.engine.error.no_keychain'))).toBeTruthy()
    await user.click(tab('설정'))
    expect((await screen.findByRole('alert')).textContent).toContain(t('app.settings.noKeychain.title'))
  })
})

describe('transfer badge, dialogs and the chat drawer', () => {
  it('carries the external transfer badge in the top bar, the composer, the model settings and the dry run dialog', async () => {
    const { user } = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.webhook } })
    await connected()
    const bar = screen.getByRole('banner', { name: t('app.region.top') })
    expect(within(bar).getByText(t('badge.externalTransfer'))).toBeTruthy()
    expect(await within(bar).findByText(/Anthropic · claude-opus-5-5/)).toBeTruthy()
    await user.type(screen.getByLabelText(t('chat.composer.label')), '요청')
    const chat = screen.getByRole('complementary', { name: t('app.region.chat') })
    expect(within(chat).getAllByText(t('badge.externalTransfer')).length).toBeGreaterThan(0)
    await user.click(await screen.findByRole('button', { name: t('app.wf.actions.dryRun') }))
    expect(within(screen.getByRole('dialog')).getByText(t('badge.externalTransfer'))).toBeTruthy()
    await user.keyboard('{Escape}')
    await user.click(tab('설정'))
    await user.click(within(screen.getByRole('navigation', { name: t('app.settings.nav') })).getByRole('button', { name: '모델' }))
    expect(within(await screen.findByRole('note', { name: t('app.model.transfer.heading') })).getByText(t('badge.externalTransfer'))).toBeTruthy()
  })

  it('shows no model in the top bar when none is set', async () => {
    mount({ world: { workflows: [] } })
    expect(await screen.findByText(t('app.top.transfer.none'))).toBeTruthy()
  })

  it('returns focus to the button after a dialog closes with Escape', async () => {
    const { user } = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.webhook } })
    const trigger = await screen.findByRole('button', { name: t('app.wf.actions.dryRun') })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('opens the chat as a drawer with the toggle, closes it with Escape and returns focus to the toggle', async () => {
    const { user, view } = mount({ hostInit: { settings: KEYED } })
    const toggle = await screen.findByRole('button', { name: t('app.top.chat.open') })
    const chat = view.container.querySelector('[data-rill-region="chat"]') as HTMLElement
    expect(chat.getAttribute('data-open')).toBe('false')
    await user.click(toggle)
    expect(chat.getAttribute('data-open')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await user.click(screen.getByLabelText(t('chat.composer.label')))
    await user.keyboard('{Escape}')
    expect(chat.getAttribute('data-open')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })
})

describe('secrets', () => {
  it('keeps every secret out of the page after a scripted session with the fake host', async () => {
    const { user, world } = mount({ hostInit: { settings: KEYED }, initial: { workflowId: ids.workflows.receipt, runId: ids.runs.receiptFailed } })
    await connected()
    await user.click(tab('설정'))
    await user.click(screen.getByRole('button', { name: 'API 키' }))
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Gemini' })), `${MARKER}-key{Enter}`)
    await screen.findByText(t('app.keys.saved'))
    await user.click(screen.getByRole('button', { name: '연결' }))
    await user.type(screen.getByLabelText(t('app.connections.name')), 'ops')
    await user.type(screen.getByLabelText(t('app.connections.secret')), `https://hooks.slack.com/${MARKER}-hook`)
    await user.click(screen.getByRole('button', { name: t('app.connections.add') }))
    await screen.findByText(t('app.connections.added'))
    await user.click(tab('워크플로우'))
    await workflowsLoaded()
    await user.click(await screen.findByRole('button', { name: t('explain.ask') }))
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: t('explain.notice.send') }))
    await screen.findByText(t('explain.card.actions'))
    expect(document.body.innerHTML).not.toContain('MARKER')
    expect(document.body.textContent).not.toContain('MARKER')
    expect([...document.querySelectorAll('input, textarea')].every((field) => !(field as HTMLInputElement).value.includes('MARKER'))).toBe(true)
    expect(JSON.stringify(world.host.state())).not.toContain('MARKER')
    expect(JSON.stringify(world.calls)).not.toContain('MARKER')
  })
})

describe('the app in English', () => {
  it('renders the shell, the first run card and the settings in English without a missing key', async () => {
    const en = createTranslator('en')
    const { user } = mount({ locale: 'en', world: { workflows: [] } })
    await screen.findByText(en('app.top.engine.connected'))
    await screen.findByRole('region', { name: en('app.firstRun.title') })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(await screen.findByRole('button', { name: 'General' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    expect(document.body.textContent).not.toMatch(/\bapp\.[a-z]+\./)
    expect(fakeData.workflows.length).toBeGreaterThan(0)
  })
})

export type { FakeWorld }
