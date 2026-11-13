import { HOOK_MAX_ITEMS, RillError, hookMessage, type Hook, type HookLogEntry, type MethodName, type MethodParams, type MethodResult, type Rule } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HookActivity } from '../src/app/agents/HookActivity'
import { HooksScreen } from '../src/app/agents/HooksScreen'
import { hookLabels } from '../src/app/agents/model/hooks'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient, type FakeData } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import { fakeData, ids, workflowOf } from '../src/fixtures'
import { HOSTILE_WORKFLOW_NAME, LONG_WORKFLOW_NAME, hookConnections, hookFixtures, hookLogFixtures, hookOf, logRow } from '../src/fixtures/hooks'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { createTranslator, type Locale } from '../src/i18n'
import type { ConnectionSummary } from '../src/shared/host-api'
import { violations as axeViolations } from './axe'
import { frames, gate } from './keep-focus'
import { renderThemed } from './render'

interface Options {
  hooks?: readonly Hook[]
  log?: readonly HookLogEntry[]
  rules?: readonly Rule[]
  connections?: readonly ConnectionSummary[] | undefined
  workflows?: FakeData['workflows']
  onOpenConnections?: (() => void) | undefined
  intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined
  locale?: Locale
}

const ALL_CONNECTIONS = hookConnections

function world(options: Options = {}) {
  const connections = options.connections === undefined && 'connections' in options ? undefined : (options.connections ?? ALL_CONNECTIONS)
  const inner = withPlanMethods(createFakeClient({ ...fakeData, workflows: options.workflows ?? fakeData.workflows }), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    connections: (connections ?? ALL_CONNECTIONS).map((entry) => ({ name: entry.name, kind: entry.kind })),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.log === undefined ? {} : { hookLog: options.log }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  })
  const calls: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      return (options.intercept?.(method, params) ?? inner.request(method, params)) as Promise<MethodResult<M>>
    },
    onEvent: inner.onEvent,
  }
  const callsOf = (method: MethodName) => calls.filter((call) => call.method === method).map((call) => call.params)
  return { client, inner, calls, callsOf, connections }
}

function mount(options: Options = {}) {
  const made = world(options)
  const locale = options.locale ?? 'en'
  const view = renderThemed(
    <HooksScreen client={made.client} connections={made.connections} {...(options.onOpenConnections === undefined ? {} : { onOpenConnections: options.onOpenConnections })} timeZone="UTC" />,
    { locale },
  )
  return { ...made, view, user: userEvent.setup(), t: createTranslator(locale) }
}

const rule = (id: string, value: string): Rule => ({ id, kind: 'forbidNode', value, createdAt: 1 })

const statusText = (): string => screen.getAllByRole('status').map((element) => element.textContent ?? '').join(' ')
const saved = (): HTMLElement => screen.getByRole('region', { name: 'Saved hooks' })
const activity = (): HTMLElement => screen.getByRole('region', { name: 'Activity' })
const editor = (): HTMLElement => screen.getByRole('region', { name: /^(New hook|Edit hook)$/ })
const rows = (): HTMLElement[] => within(saved()).getAllByRole('listitem')
const rowOf = (text: string | RegExp): HTMLElement => {
  const found = rows().find((row) => (typeof text === 'string' ? (row.textContent ?? '').includes(text) : text.test(row.textContent ?? '')))
  if (found === undefined) throw new Error(`no row with ${String(text)}`)
  return found
}
const field = (name: string | RegExp): HTMLElement => within(editor()).getByLabelText(name)
const select = (name: string): HTMLSelectElement => within(editor()).getByRole('combobox', { name }) as HTMLSelectElement
const saveButton = (): HTMLButtonElement => within(editor()).getByRole('button', { name: /^(Save|Create hook)$/ }) as HTMLButtonElement
const optionsOf = (element: HTMLSelectElement): string[] => [...element.options].map((option) => option.textContent ?? '')
const disabledOptions = (element: HTMLSelectElement): string[] => [...element.options].filter((option) => option.disabled).map((option) => option.textContent ?? '')

async function ready(): Promise<void> {
  await screen.findByRole('region', { name: 'Saved hooks' })
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await ready()
  await user.click(screen.getByRole('button', { name: 'New hook' }))
  await screen.findByRole('region', { name: 'New hook' })
}

async function pickConnection(user: ReturnType<typeof userEvent.setup>, name = 'team-slack'): Promise<void> {
  await user.selectOptions(select('Slack connection'), name)
}

describe('loading', () => {
  it('says so while the hooks load, and shows neither the list nor the buttons yet', () => {
    mount({ intercept: (method) => (method === 'listHooks' ? new Promise(() => undefined) : undefined) })
    expect(screen.getByRole('status').textContent).toContain('Loading hooks…')
    expect(screen.queryByRole('region', { name: 'Saved hooks' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New hook' })).toBeNull()
  })

  it('shows an alert and a retry when the hooks cannot be loaded, and loads again on retry', async () => {
    let fail = true
    const { user, callsOf } = mount({ intercept: (method) => (method === 'listHooks' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the hooks.')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await ready()
    expect(callsOf('listHooks')).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the list and says that it may be out of date when a later refresh fails, and loads again on retry', async () => {
    let fail = false
    const { user, inner } = mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'listHooks' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    await user.type(field('Channel (optional)'), '#x')
    fail = true
    inner.hooks.remove({ id: 'hook-ok-webhook' })
    await user.click(saveButton())
    await waitFor(() => expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain('Could not refresh the hooks. The list below may be out of date.'))
    expect(rows()).toHaveLength(5)
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('the page', () => {
  it('has a title for screen readers, and says in muted lines that hooks run in the engine and that a notice goes to Slack', async () => {
    mount()
    await ready()
    expect(screen.getByRole('region', { name: 'Hooks' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Hooks' })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Hooks run in the engine, so they keep working when this window is closed.')
    expect(text).toContain('A Slack notice goes to Slack with the name of the workflow in a fixed sentence.')
    expect(text).toContain('A hook never starts a run, a plan or a model call.')
  })

  it('has the quiet transfer arrow on the line that says what goes to Slack, and on no other line', async () => {
    mount()
    await ready()
    const line = screen.getByText(/^A Slack notice goes to Slack with the name/).closest('p')!
    expect(line.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('region', { name: 'Hooks' }).querySelectorAll('header svg')).toHaveLength(1)
  })

  it('counts the hooks out of 20, and says that there is none yet', async () => {
    mount({ hooks: hookFixtures.some })
    await ready()
    expect(screen.getByText('5 of 20 hooks')).toBeTruthy()
  })

  it('shows what to do when there is no hook', async () => {
    mount()
    await ready()
    expect(screen.getByText('0 of 20 hooks')).toBeTruthy()
    expect(within(saved()).getByText(/^No hook yet\./)).toBeTruthy()
    expect(within(saved()).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('speaks Korean', async () => {
    const { t } = mount({ hooks: hookFixtures.some, locale: 'ko' })
    const list = await screen.findByRole('region', { name: t('agents.hooks.list.title') })
    expect(screen.getByRole('heading', { level: 2, name: t('agents.hooks.screen.title') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('agents.hooks.new') })).toBeTruthy()
    expect(screen.getByRole('region', { name: t('agents.hooks.activity.title') })).toBeTruthy()
    expect(screen.getByText(t('agents.hooks.count', { count: 5, max: HOOK_MAX_ITEMS }))).toBeTruthy()
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain(t('agents.hooks.event.run.failed'))
  })
})

describe('the list of hooks', () => {
  it('shows for each hook the event, the scope, the action and whether it is on', async () => {
    mount({ hooks: hookFixtures.some })
    await ready()
    expect(rows()).toHaveLength(5)
    const [notice, off, webhook, record, disabled] = rows() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(notice.textContent).toContain('A run fails')
    expect(notice.textContent).toContain('All workflows')
    expect(notice.textContent).toContain('Send a Slack notice via team-slack to #alerts')
    expect(off.textContent).toContain('영수증 정리')
    expect(off.textContent).toContain('Switch the workflow off after 3 failures in a row')
    expect(webhook.textContent).toContain('A run succeeds')
    expect(webhook.textContent).toContain('웹훅을 슬랙으로 전달')
    expect(webhook.textContent).toContain('Send a Slack notice via ops-webhook')
    expect(webhook.textContent).not.toContain(' to ')
    expect(record.textContent).toContain('A plan is deployed')
    expect(record.textContent).toContain('Write to the activity log only')
    expect((within(notice).getByRole('switch') as HTMLInputElement).checked).toBe(true)
    expect((within(disabled).getByRole('switch') as HTMLInputElement).checked).toBe(false)
    expect(within(notice).getByText('On')).toBeTruthy()
    expect(within(disabled).getByText('Off')).toBeTruthy()
  })

  it('names the hook in the label of each button and of the switch', async () => {
    mount({ hooks: hookFixtures.one })
    await ready()
    const summary = 'A run fails · All workflows · Send a Slack notice via team-slack to #alerts'
    const row = rows()[0]!
    expect(within(row).getByRole('switch', { name: `Hook on or off: ${summary}` })).toBeTruthy()
    expect(within(row).getByRole('button', { name: `Edit the hook: ${summary}` })).toBeTruthy()
    expect(within(row).getByRole('button', { name: `Delete the hook: ${summary}` })).toBeTruthy()
  })

  it('shows a workflow that is not in the list of the engine as one whose name is not available', async () => {
    mount({ hooks: [hookOf('h', 'run.failed', { type: 'workflow', workflowId: 'wf-unknown' }, { type: 'record' })] })
    await ready()
    expect(rows()[0]!.textContent).toContain('A workflow whose name is not available')
  })

  it('shows a name and a connection that are hostile as text, with the hidden characters made visible', async () => {
    mount({
      hooks: hookFixtures.hostile,
      connections: [...hookConnections, { name: hookFixtures.hostileConnection, kind: 'slack' }],
      workflows: [
        { id: 'wf-hostile', workflow: workflowOf(HOSTILE_WORKFLOW_NAME, [], []), active: false, createdAt: 2 },
        { id: 'wf-long', workflow: workflowOf(LONG_WORKFLOW_NAME, [], []), active: false, createdAt: 1 },
      ],
    })
    await ready()
    const [hostile, long] = rows() as [HTMLElement, HTMLElement]
    expect(hostile.querySelector('img, script')).toBeNull()
    expect(hostile.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(hostile.textContent).toContain('‹U+202E›')
    expect(hostile.textContent).toContain('‹U+200B›')
    expect(hostile.textContent).toContain('<b>slack</b>')
    expect(long.textContent).toContain('…')
    expect(long.textContent).not.toContain(LONG_WORKFLOW_NAME)
    expect(long.textContent).toContain(LONG_WORKFLOW_NAME.slice(0, 40))
  })

  it('warns on a hook whose connection is not saved any more, and not on a hook that does not use one', async () => {
    mount({ hooks: hookFixtures.problems })
    await ready()
    expect(rowOf('old-slack').textContent).toContain('The connection old-slack is not saved any more')
    expect(rowOf('ops-webhook').textContent).not.toContain('not saved any more')
    expect(rowOf('no-default-channel').textContent).not.toContain('not saved any more')
  })

  it('says nothing about the connections of a hook while the connections are not known', async () => {
    mount({ hooks: hookFixtures.problems, connections: undefined })
    await ready()
    expect(saved().textContent).not.toContain('not saved any more')
  })
})

describe('switching a hook on or off', () => {
  it('sends the whole hook with the other value of the flag, and says what happened', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('switch'))
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('saveHook')[0]).toEqual({ id: 'hook-failed-all', event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#alerts' }, enabled: false })
    await waitFor(() => expect((within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement).checked).toBe(false))
    expect(statusText()).toContain('Hook switched off.')
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('switch'))
    await waitFor(() => expect((within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement).checked).toBe(true))
    expect(statusText()).toContain('Hook switched on.')
  })

  it('keeps the focus on the switch', async () => {
    const { user } = mount({ hooks: hookFixtures.some })
    await ready()
    const toggle = within(rowOf('team-slack to #alerts')).getByRole('switch')
    await user.click(toggle)
    await waitFor(() => expect((within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement).checked).toBe(false))
    expect(document.activeElement).toBe(within(rowOf('team-slack to #alerts')).getByRole('switch'))
  })

  it('sends one request for two quick clicks, and turns the controls off while it waits', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, callsOf, inner } = mount({
      hooks: hookFixtures.some,
      intercept: (method, params) => (method === 'saveHook' ? gate.then(() => inner.request(method, params as MethodParams<'saveHook'>)) : undefined),
    })
    await ready()
    const toggle = within(rowOf('team-slack to #alerts')).getByRole('switch')
    await user.click(toggle)
    await user.click(toggle)
    expect(callsOf('saveHook')).toHaveLength(1)
    expect((within(rowOf('ops-webhook')).getByRole('switch') as HTMLInputElement).disabled).toBe(true)
    expect(within(rowOf('ops-webhook')).getByRole('button', { name: /^Delete the hook/ }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      release()
    })
    await waitFor(() => expect((within(rowOf('ops-webhook')).getByRole('switch') as HTMLInputElement).disabled).toBe(false))
    expect(callsOf('saveHook')).toHaveLength(1)
  })

  it('shows the error of a refused switch as an alert and leaves the switch as it was', async () => {
    const { user } = mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'saveHook' ? Promise.reject(new RillError('HOOK_NOT_FOUND', 'x')) : undefined) })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('switch'))
    expect((await screen.findByRole('alert')).textContent).toBe('This hook does not exist any more. The list was refreshed.')
    expect((within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement).checked).toBe(true)
  })

  it('does not tell the person to choose from a list on the page: the connection of a switched off notice is gone, and the connections are not known yet when the switch is pressed', async () => {
    const gone = hookOf('hook-gone', 'run.failed', { type: 'all' }, { type: 'notify', connection: 'old-slack' }, { enabled: false })
    const { user } = mount({ hooks: [gone], connections: undefined })
    await ready()
    await user.click(within(rowOf('old-slack')).getByRole('switch'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This hook cannot be switched on as it is saved. Choose Edit to see what has to change.')
    expect(alert.textContent).not.toContain('Choose one from the list')
    expect((within(rowOf('old-slack')).getByRole('switch') as HTMLInputElement).checked).toBe(false)
  })

  it('does not let a notice be switched on while a rule forbids notify.slack, says why on each notice, and still lets one be switched off', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some, rules: [rule('r', 'notify.slack')] })
    await ready()
    await waitFor(() => expect(rowOf('team-slack to #alerts').textContent).toContain('A rule forbids the Slack message node'))
    const branching = rowOf('매일 서버 상태 확인')
    expect((within(branching).getByRole('switch') as HTMLInputElement).disabled).toBe(true)
    expect(branching.textContent).toContain('A rule forbids the Slack message node, so this notice is not sent and cannot be switched on.')
    expect((within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement).disabled).toBe(false)
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('switch'))
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect((callsOf('saveHook')[0] as { enabled: boolean }).enabled).toBe(false)
    expect(rowOf('영수증 정리').textContent).not.toContain('A rule forbids')
    expect(rowOf('A plan is deployed').textContent).not.toContain('A rule forbids')
  })
})

describe('deleting a hook', () => {
  it('asks first, names the hook, and deletes nothing on Cancel', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Delete the hook/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete this hook?' })
    expect(dialog.textContent).toContain('A run fails · All workflows · Send a Slack notice via team-slack to #alerts')
    expect(dialog.textContent).toContain('Deleted hook')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsOf('deleteHook')).toEqual([])
    expect(rows()).toHaveLength(5)
  })

  it('deletes on confirmation, says so, and moves the focus to the heading of the list', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Delete the hook/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete hook' }))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(callsOf('deleteHook')).toEqual([{ id: 'hook-failed-all' }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(statusText()).toContain('Hook deleted.')
    await waitFor(() => expect(document.activeElement).toBe(within(saved()).getByRole('heading', { level: 3, name: 'Saved hooks' })))
  })

  it('sends one request for two quick clicks on Delete hook', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, callsOf, inner } = mount({
      hooks: hookFixtures.some,
      intercept: (method, params) => (method === 'deleteHook' ? gate.then(() => inner.request(method, params as MethodParams<'deleteHook'>)) : undefined),
    })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Delete the hook/ }))
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete hook' })
    await user.click(confirm)
    await user.click(confirm)
    expect(callsOf('deleteHook')).toHaveLength(1)
    await act(async () => {
      release()
    })
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(callsOf('deleteHook')).toHaveLength(1)
  })

  it('shows the error in the dialog when the delete fails, and keeps the dialog open', async () => {
    const { user } = mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'deleteHook' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Delete the hook/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete hook' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Something went wrong with the hook. Try again.')
    expect(rows()).toHaveLength(5)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Delete the hook/ }))
  })

  it('closes the form of a hook that is deleted', async () => {
    const { user } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Edit the hook/ }))
    await screen.findByRole('region', { name: 'Edit hook' })
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Delete the hook/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete hook' }))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(screen.getByRole('region', { name: 'Edit hook' })).toBeTruthy()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Delete the hook/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete hook' }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByRole('region', { name: 'Edit hook' })).toBeNull()
  })

  it('keeps the rows of a deleted hook in the activity, as a deleted hook', async () => {
    const { user } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed })
    await ready()
    await within(activity()).findByRole('list')
    const before = within(activity()).queryAllByText('Deleted hook').length
    await user.click(within(rowOf('A plan is deployed')).getByRole('button', { name: /^Delete the hook/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete hook' }))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(within(activity()).queryAllByText('Deleted hook').length).toBe(before + 1)
  })
})

describe('the form', () => {
  it('opens with the heading focused and a Slack notice for a failed run of any workflow, switched on, with no connection chosen', async () => {
    const { user } = mount()
    await open(user)
    const heading = within(editor()).getByRole('heading', { level: 3, name: 'New hook' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(select('When').value).toBe('run.failed')
    expect(select('For').value).toBe('')
    expect(select('Then').value).toBe('notify')
    expect(select('Slack connection').value).toBe('')
    expect((field('Channel (optional)') as HTMLInputElement).value).toBe('')
    expect((field('Switch this hook on') as HTMLInputElement).checked).toBe(true)
    expect(saveButton().textContent).toBe('Create hook')
    expect(saveButton().disabled).toBe(true)
    expect(within(editor()).getByText('Choose a connection to save this hook.')).toBeTruthy()
  })

  it('offers the three events, All workflows and every workflow by name, and the three actions', async () => {
    const { user } = mount()
    await open(user)
    expect(optionsOf(select('When'))).toEqual(['A run fails', 'A run succeeds', 'A plan is deployed'])
    expect(optionsOf(select('For'))).toEqual(['All workflows', '영수증 정리', '매일 서버 상태 확인', '웹훅을 슬랙으로 전달'])
    expect(optionsOf(select('Then')).map((text) => text.split(' (')[0])).toEqual(['Send a Slack notice', 'Switch the workflow off after failures in a row', 'Write to the activity log only'])
  })

  it('offers only the Slack connections, by name', async () => {
    const { user } = mount()
    await open(user)
    expect(optionsOf(select('Slack connection'))).toEqual(['Choose a connection', 'team-slack', 'ops-webhook', 'no-default-channel'])
  })

  it('says that a test run never triggers a hook', async () => {
    const { user } = mount()
    await open(user)
    expect(within(editor()).getByText('A test run (dry run) never triggers a hook.')).toBeTruthy()
  })

  it('creates a Slack notice with the exact input, closes the form, says so, and puts the focus on the Edit button of the new hook', async () => {
    const { user, callsOf } = mount()
    await open(user)
    await pickConnection(user)
    await user.type(field('Channel (optional)'), '  #ops  ')
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('saveHook')[0]).toEqual({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#ops' }, enabled: true })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New hook' })).toBeNull())
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('Send a Slack notice via team-slack to #ops')
    expect(statusText()).toContain('Hook created.')
    await waitFor(() => expect(document.activeElement).toBe(within(rows()[0]!).getByRole('button', { name: /^Edit the hook/ })))
  })

  it('leaves the channel out of a notice that has none', async () => {
    const { user, callsOf } = mount()
    await open(user)
    await user.selectOptions(select('For'), ids.workflows.webhook)
    await user.selectOptions(select('When'), 'plan.deployed')
    await pickConnection(user, 'ops-webhook')
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('saveHook')[0]).toEqual({ event: 'plan.deployed', scope: { type: 'workflow', workflowId: ids.workflows.webhook }, action: { type: 'notify', connection: 'ops-webhook' }, enabled: true })
  })

  it('creates a switch off with the count, and a record with nothing else', async () => {
    const { user, callsOf } = mount()
    await open(user)
    await user.selectOptions(select('Then'), 'deactivateAfterFailures')
    expect(saveButton().disabled).toBe(false)
    const count = field('Failures in a row') as HTMLInputElement
    expect(count.value).toBe('3')
    await user.clear(count)
    await user.type(count, '5')
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('saveHook')[0]).toEqual({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'deactivateAfterFailures', count: 5 }, enabled: true })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New hook' })).toBeNull())
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    await user.selectOptions(select('Then'), 'record')
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(2))
    expect(callsOf('saveHook')[1]).toEqual({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
  })

  it('shows the fields of the chosen action only', async () => {
    const { user } = mount()
    await open(user)
    expect(within(editor()).queryByLabelText('Failures in a row')).toBeNull()
    expect(within(editor()).getByLabelText('Slack connection')).toBeTruthy()
    await user.selectOptions(select('Then'), 'deactivateAfterFailures')
    expect(within(editor()).getByLabelText('Failures in a row')).toBeTruthy()
    expect(within(editor()).queryByLabelText('Slack connection')).toBeNull()
    expect(within(editor()).queryByLabelText('Channel (optional)')).toBeNull()
    await user.selectOptions(select('Then'), 'record')
    expect(within(editor()).queryByLabelText('Failures in a row')).toBeNull()
    expect(within(editor()).queryByLabelText('Slack connection')).toBeNull()
  })

  it('keeps the connection that was chosen when the person looks at another action and comes back', async () => {
    const { user } = mount()
    await open(user)
    await pickConnection(user)
    await user.selectOptions(select('Then'), 'record')
    await user.selectOptions(select('Then'), 'notify')
    expect(select('Slack connection').value).toBe('team-slack')
  })

  it('edits a hook in its place: the form starts from the hook, and Save sends its id', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Edit the hook/ }))
    const form = await screen.findByRole('region', { name: 'Edit hook' })
    expect(within(form).getByRole('heading', { level: 3, name: 'Edit hook' })).toBeTruthy()
    expect(select('Slack connection').value).toBe('team-slack')
    expect((field('Channel (optional)') as HTMLInputElement).value).toBe('#alerts')
    expect(saveButton().textContent).toBe('Save')
    expect(saveButton().disabled).toBe(true)
    await user.clear(field('Channel (optional)'))
    await user.type(field('Channel (optional)'), '#ops')
    expect(saveButton().disabled).toBe(false)
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('saveHook')[0]).toEqual({ id: 'hook-failed-all', event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#ops' }, enabled: true })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Edit hook' })).toBeNull())
    expect(rows()).toHaveLength(5)
    expect(rowOf('#ops')).toBeTruthy()
    expect(statusText()).toContain('Hook saved.')
    await waitFor(() => expect(document.activeElement).toBe(within(rowOf('#ops')).getByRole('button', { name: /^Edit the hook/ })))
  })

  it('cancels without a request and puts the focus back on the button that opened the form', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    await user.click(within(editor()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('region', { name: 'New hook' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New hook' }))
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    await user.click(within(editor()).getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    expect(callsOf('saveHook')).toEqual([])
  })

  it('turns the switch of the hook off in the list while its form is open, so that two controls never disagree', async () => {
    const { user } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Edit the hook/ }))
    expect((within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement).disabled).toBe(true)
    expect((within(rowOf('ops-webhook')).getByRole('switch') as HTMLInputElement).disabled).toBe(false)
  })

  it('keeps the form of a hook with its changes when the screen is closed and opened again, and starts clean for another client', async () => {
    const { user, client, view, connections } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    await user.type(field('Channel (optional)'), '#late')
    view.unmount()
    const again = renderThemed(<HooksScreen client={client} connections={connections} timeZone="UTC" />, { locale: 'en' })
    await screen.findByRole('region', { name: 'Edit hook' })
    expect((field('Channel (optional)') as HTMLInputElement).value).toBe('#late')
    expect(within(editor()).getByText('Unsaved changes')).toBeTruthy()
    again.unmount()
    mount({ hooks: hookFixtures.some })
    await ready()
    expect(screen.queryByRole('region', { name: 'Edit hook' })).toBeNull()
  })

  it('drops the kept form when it is cancelled or saved, so that a later visit finds none', async () => {
    const { user, client, view, connections } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    await user.type(field('Channel (optional)'), '#late')
    await user.click(within(editor()).getByRole('button', { name: 'Cancel' }))
    view.unmount()
    renderThemed(<HooksScreen client={client} connections={connections} timeZone="UTC" />, { locale: 'en' })
    await ready()
    expect(screen.queryByRole('region', { name: 'Edit hook' })).toBeNull()
  })

  it('asks before it drops changes when another hook or a new hook is opened, and not when nothing changed', async () => {
    const { user } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Edit the hook/ }))
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(select('Slack connection').value).toBe('ops-webhook')
    await user.type(field('Channel (optional)'), '#x')
    expect(within(editor()).getByText('Unsaved changes')).toBeTruthy()
    await user.click(within(rowOf('team-slack to #alerts')).getByRole('button', { name: /^Edit the hook/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard your changes?' })
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(select('Slack connection').value).toBe('ops-webhook')
    expect((field('Channel (optional)') as HTMLInputElement).value).toBe('#x')
    await user.click(screen.getByRole('button', { name: 'New hook' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('region', { name: 'New hook' })).toBeTruthy()
    expect(select('Slack connection').value).toBe('')
  })
})

describe('what the form prevents', () => {
  it('turns the switch off for every event but a failed run, and turns the other events off while the switch off is chosen, so that no combination is left that the engine refuses', async () => {
    const { user } = mount()
    await open(user)
    expect(disabledOptions(select('Then'))).toEqual([])
    await user.selectOptions(select('When'), 'run.succeeded')
    expect(disabledOptions(select('Then'))).toHaveLength(1)
    expect(disabledOptions(select('Then'))[0]).toContain('Switch the workflow off after failures in a row')
    await user.selectOptions(select('When'), 'plan.deployed')
    expect(disabledOptions(select('Then'))).toHaveLength(1)
    await user.selectOptions(select('When'), 'run.failed')
    expect(disabledOptions(select('Then'))).toEqual([])
    await user.selectOptions(select('Then'), 'deactivateAfterFailures')
    expect(disabledOptions(select('When'))).toEqual(['A run succeeds', 'A plan is deployed'])
    expect(within(editor()).getByText(/^Switching a workflow off works only when a run fails/)).toBeTruthy()
    await user.selectOptions(select('Then'), 'record')
    expect(disabledOptions(select('When'))).toEqual([])
  })

  it('does not let a count out of range be saved, and says what a count is', async () => {
    const { user, callsOf } = mount()
    await open(user)
    await user.selectOptions(select('Then'), 'deactivateAfterFailures')
    const count = field('Failures in a row') as HTMLInputElement
    expect(count.getAttribute('min')).toBe('2')
    expect(count.getAttribute('max')).toBe('20')
    for (const bad of ['1', '21', '0', '2.5', '']) {
      await user.clear(count)
      if (bad !== '') await user.type(count, bad)
      expect(saveButton().disabled, bad).toBe(true)
      expect(within(editor()).getByText('Use a whole number from 2 to 20.'), bad).toBeTruthy()
      expect(count.getAttribute('aria-invalid')).toBe('true')
    }
    for (const good of ['2', '20']) {
      await user.clear(count)
      await user.type(count, good)
      expect(saveButton().disabled, good).toBe(false)
      expect(within(editor()).queryByText('Use a whole number from 2 to 20.')).toBeNull()
    }
    expect(callsOf('saveHook')).toEqual([])
  })

  it('needs a connection for a notice that is switched on, and not for a record', async () => {
    const { user } = mount()
    await open(user)
    expect(saveButton().disabled).toBe(true)
    await pickConnection(user)
    expect(saveButton().disabled).toBe(false)
    await user.selectOptions(select('Slack connection'), '')
    expect(saveButton().disabled).toBe(true)
  })

  it('says that there is no Slack connection yet when the list is empty, and offers the way to Settings, Connections', async () => {
    let opened = 0
    const { user } = mount({ connections: [{ name: 'api-main', kind: 'http' }], onOpenConnections: () => (opened += 1) })
    await open(user)
    expect(select('Slack connection').disabled).toBe(true)
    expect(within(editor()).getByText('There is no Slack connection yet. Add one in Settings, Connections.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    await user.click(within(editor()).getByRole('button', { name: 'Open Settings, Connections' }))
    expect(opened).toBe(1)
  })

  it('names Settings, Connections in plain text when the screen cannot open them', async () => {
    const { user } = mount({ connections: [] })
    await open(user)
    expect(within(editor()).getByText('There is no Slack connection yet. Add one in Settings, Connections.')).toBeTruthy()
    expect(within(editor()).queryByRole('button', { name: 'Open Settings, Connections' })).toBeNull()
  })

  it('waits for the connections instead of saying that there are none, when they are not known yet', async () => {
    const { user } = mount({ connections: undefined })
    await open(user)
    expect(select('Slack connection').disabled).toBe(true)
    expect(within(editor()).getByText('Loading the connections…')).toBeTruthy()
    expect(within(editor()).queryByText(/There is no Slack connection yet/)).toBeNull()
  })

  it('shows a connection that is not saved any more as the chosen one, says so, and does not let the hook be saved while it is switched on', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.problems })
    await ready()
    await user.click(within(rowOf('old-slack')).getByRole('button', { name: /^Edit the hook/ }))
    expect(select('Slack connection').value).toBe('old-slack')
    expect(optionsOf(select('Slack connection'))).toContain('old-slack (not saved)')
    expect(within(editor()).getByText('No saved connection has this name. Choose one from the list.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    await user.click(within(editor()).getByRole('checkbox', { name: 'Switch this hook on' }))
    expect(saveButton().disabled).toBe(false)
    await user.click(within(editor()).getByRole('checkbox', { name: 'Switch this hook on' }))
    expect(saveButton().disabled).toBe(true)
    await pickConnection(user)
    expect(saveButton().disabled).toBe(false)
    expect(callsOf('saveHook')).toEqual([])
  })

  it('lets a hook that is switched off keep a connection that is not saved any more, and be saved', async () => {
    const { user, callsOf } = mount({ hooks: [{ ...hookFixtures.problems[0]!, enabled: false }] })
    await ready()
    await user.click(within(rows()[0]!).getByRole('button', { name: /^Edit the hook/ }))
    expect(within(editor()).queryByText(/No saved connection has this name/)).toBeNull()
    expect(saveButton().disabled).toBe(true)
    await user.type(field('Channel (optional)'), '#x')
    expect(saveButton().disabled).toBe(false)
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('saveHook')[0]).toEqual({ id: 'hook-missing-connection', event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'old-slack', channel: '#x' }, enabled: false })
  })

  it('shows what a channel may not have, as soon as it is typed', async () => {
    const { user } = mount()
    await open(user)
    await pickConnection(user)
    const channel = field('Channel (optional)') as HTMLInputElement
    await user.type(channel, '#two words')
    expect(within(editor()).getByText('A channel has no spaces.')).toBeTruthy()
    expect(channel.getAttribute('aria-invalid')).toBe('true')
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(channel, { target: { value: '#a\u202eb' } })
    expect(within(editor()).getByText('The text has a character that changes the text direction.')).toBeTruthy()
    fireEvent.change(channel, { target: { value: '#a\u200bb' } })
    expect(within(editor()).getByText('The text has an invisible formatting character.')).toBeTruthy()
    fireEvent.change(channel, { target: { value: `#${'a'.repeat(80)}` } })
    expect(within(editor()).getByText('The channel is too long. At most 80 characters.')).toBeTruthy()
    fireEvent.change(channel, { target: { value: '#ok' } })
    expect(channel.getAttribute('aria-invalid')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('hints at a hook that can never post: a webhook with a channel, and a bot with no channel at all', async () => {
    const { user } = mount()
    await open(user)
    await pickConnection(user, 'ops-webhook')
    expect(within(editor()).queryByText(/always posts to its own channel/)).toBeNull()
    await user.type(field('Channel (optional)'), '#alerts')
    expect(within(editor()).getByText(/This connection is a webhook, which always posts to its own channel/)).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    await pickConnection(user, 'no-default-channel')
    expect(within(editor()).queryByText(/This connection is a webhook/)).toBeNull()
    expect(within(editor()).queryByText(/has no default channel/)).toBeNull()
    await user.clear(field('Channel (optional)'))
    expect(within(editor()).getByText(/This bot connection has no default channel/)).toBeTruthy()
    expect(saveButton().disabled).toBe(false)
    await pickConnection(user, 'team-slack')
    expect(within(editor()).queryByText(/has no default channel/)).toBeNull()
  })

  it('does not let a hook be saved twice: the same event, workflow and action, also in another spelling of the channel', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.one })
    await open(user)
    await pickConnection(user)
    await user.type(field('Channel (optional)'), ' #alerts ')
    expect(within(editor()).getByText('A hook with the same event, workflow and action is already saved.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    await user.selectOptions(select('When'), 'run.succeeded')
    expect(within(editor()).queryByText(/is already saved/)).toBeNull()
    expect(saveButton().disabled).toBe(false)
    expect(callsOf('saveHook')).toEqual([])
  })

  it('does not call the hook that is being edited a duplicate of itself', async () => {
    const { user } = mount({ hooks: hookFixtures.one })
    await ready()
    await user.click(within(rows()[0]!).getByRole('button', { name: /^Edit the hook/ }))
    expect(within(editor()).queryByText(/is already saved/)).toBeNull()
  })

  it('says that a notice cannot be switched on while a rule forbids notify.slack, and lets the hook be saved switched off', async () => {
    const { user, callsOf } = mount({ rules: [rule('r', 'notify.slack')] })
    await open(user)
    await pickConnection(user)
    await waitFor(() => expect(within(editor()).getByText(/A rule forbids the Slack message node, so a Slack notice cannot be switched on/)).toBeTruthy())
    expect(saveButton().disabled).toBe(true)
    await user.click(within(editor()).getByRole('checkbox', { name: 'Switch this hook on' }))
    expect(within(editor()).queryByText(/A rule forbids/)).toBeNull()
    expect(saveButton().disabled).toBe(false)
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect((callsOf('saveHook')[0] as { enabled: boolean }).enabled).toBe(false)
  })

  it('does not apply the rule to a record or a switch off', async () => {
    const { user } = mount({ rules: [rule('r', 'notify.slack')] })
    await open(user)
    await waitFor(() => expect(within(editor()).getByText(/A rule forbids/)).toBeTruthy())
    await user.selectOptions(select('Then'), 'record')
    expect(within(editor()).queryByText(/A rule forbids/)).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('shows a workflow that is not in the list as the chosen one, says that it does not exist, and does not let the hook be saved until another is chosen', async () => {
    const { user } = mount({ hooks: [hookOf('h', 'run.failed', { type: 'workflow', workflowId: 'wf-unknown' }, { type: 'record' })] })
    await ready()
    await user.click(within(rows()[0]!).getByRole('button', { name: /^Edit the hook/ }))
    expect(select('For').value).toBe('wf-unknown')
    expect(within(editor()).getByText('This workflow does not exist any more. Choose another one.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    await user.selectOptions(select('For'), '')
    expect(saveButton().disabled).toBe(false)
  })

  it('stops a new hook at the limit of 20, and still lets a hook be edited', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.full })
    await ready()
    expect((screen.getByRole('button', { name: 'New hook' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('20 of 20 hooks')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toBe('All 20 places are used. Delete a hook to add another.')
    await user.click(within(rows()[0]!).getByRole('button', { name: /^Edit the hook/ }))
    await user.clear(field('Channel (optional)'))
    await user.type(field('Channel (optional)'), '#renamed')
    expect(saveButton().disabled).toBe(false)
    await user.click(saveButton())
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(rows()).toHaveLength(HOOK_MAX_ITEMS)
  })

  it('has no limit note below the limit, and turns New hook on again after a delete', async () => {
    const { user } = mount({ hooks: hookFixtures.full })
    await ready()
    await user.click(within(rows()[0]!).getByRole('button', { name: /^Delete the hook/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete hook' }))
    await waitFor(() => expect(rows()).toHaveLength(19))
    expect((screen.getByRole('button', { name: 'New hook' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('the message preview', () => {
  it('shows the fixed English sentence of the chosen event, with a name that stands for the workflow', async () => {
    const { user } = mount()
    await open(user)
    const preview = (): string => within(editor()).getByRole('group', { name: 'Message in Slack' }).textContent ?? ''
    expect(preview()).toContain('Workflow "<name>" failed.')
    await user.selectOptions(select('When'), 'run.succeeded')
    expect(preview()).toContain('Workflow "<name>" finished.')
    await user.selectOptions(select('When'), 'plan.deployed')
    expect(preview()).toContain('Workflow "<name>" was deployed.')
    expect(preview()).toContain('Always this sentence, in English.')
  })

  it('shows the sentence with the name of the chosen workflow, as the engine would make it', async () => {
    const { user } = mount({
      workflows: [{ id: 'wf-hostile', workflow: workflowOf('<!channel> & "Q&A" \u202e\u200bdaily', [], []), active: false, createdAt: 1 }],
    })
    await open(user)
    await user.selectOptions(select('For'), 'wf-hostile')
    const preview = within(editor()).getByRole('group', { name: 'Message in Slack' })
    expect(preview.textContent).toContain(hookMessage('run.failed', '<!channel> & "Q&A" \u202e\u200bdaily'))
    expect(preview.textContent).toContain('Workflow "&lt;!channel&gt; &amp; \'Q&amp;A\' daily" failed.')
    expect(preview.querySelector('a, img, script')).toBeNull()
  })

  it('is shown for a Slack notice only', async () => {
    const { user } = mount()
    await open(user)
    await user.selectOptions(select('Then'), 'deactivateAfterFailures')
    expect(within(editor()).queryByRole('group', { name: 'Message in Slack' })).toBeNull()
    await user.selectOptions(select('Then'), 'record')
    expect(within(editor()).queryByRole('group', { name: 'Message in Slack' })).toBeNull()
  })
})

describe('the errors of a save', () => {
  async function fillAndSave(user: ReturnType<typeof userEvent.setup>) {
    await open(user)
    await pickConnection(user)
    await user.click(saveButton())
  }

  it.each([
    ['HOOK_FULL', [], 'At most 20 hooks can be saved. Delete one first.'],
    ['HOOK_NOT_FOUND', [], 'This hook does not exist any more. The list was refreshed.'],
    ['HOOK_INVALID', [], 'The hook is not valid.'],
    ['HOOK_INVALID', ['scope.unknown_workflow: x'], 'This workflow does not exist any more. Choose another one.'],
    ['HOOK_INVALID', ['connection.unknown_connection: x'], 'No saved connection has this name. Choose one from the list.'],
    ['HOOK_INVALID', ['connection.not_slack_connection: x'], 'This connection is not a Slack connection.'],
    ['HOOK_INVALID', ['action.forbidden_by_rule: x'], 'A rule forbids the Slack message node, so a Slack notice cannot be switched on. Change the rules, or save this hook switched off.'],
    ['HOOK_INVALID', ['hook.duplicate: x'], 'A hook with the same event, workflow and action is already saved.'],
    ['HOOK_INVALID', ['action.only_for_run_failed: x'], 'Switching a workflow off works only when a run fails.'],
    ['HOOK_INVALID', ['count.out_of_range: x'], 'Use a whole number from 2 to 20.'],
    ['HOOK_INVALID', ['channel.whitespace: x'], 'A channel has no spaces.'],
    ['HOOK_INVALID', ['connection.too_long: x'], 'The connection name is too long. At most 128 characters.'],
    ['INVALID_PARAMS', [], 'The engine did not accept the hook.'],
    ['INTERNAL', [], 'Something went wrong with the hook. Try again.'],
  ])('says what %s %j means, in an alert, and keeps the form and what was typed', async (code, problems, text) => {
    const { user } = mount({ intercept: (method) => (method === 'saveHook' ? Promise.reject(new RillError(code, 'x', problems)) : undefined) })
    await fillAndSave(user)
    expect((await within(editor()).findByRole('alert')).textContent).toBe(text)
    expect(select('Slack connection').value).toBe('team-slack')
    expect(saveButton().disabled).toBe(false)
  })

  it('clears the error when the person changes the form, and when a save works', async () => {
    let fail = true
    const { user } = mount({ intercept: (method) => (method === 'saveHook' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await fillAndSave(user)
    await within(editor()).findByRole('alert')
    await user.type(field('Channel (optional)'), '#ok')
    expect(within(editor()).queryByRole('alert')).toBeNull()
    await user.click(saveButton())
    await within(editor()).findByRole('alert')
    fail = false
    await user.click(saveButton())
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New hook' })).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the form of a hook that is gone, puts the alert on the page, and refreshes the list', async () => {
    const { user, callsOf, inner } = mount({ hooks: hookFixtures.some })
    await ready()
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
    await user.type(field('Channel (optional)'), '#x')
    inner.hooks.remove({ id: 'hook-ok-webhook' })
    await user.click(saveButton())
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Edit hook' })).toBeNull())
    expect((await screen.findByRole('alert')).textContent).toBe('This hook does not exist any more. The list was refreshed.')
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(callsOf('listHooks')).toHaveLength(2)
  })

  it('sends one request for two quick clicks on Save, and one for Enter pressed twice', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, callsOf, inner } = mount({
      intercept: (method, params) => (method === 'saveHook' ? gate.then(() => inner.request(method, params as MethodParams<'saveHook'>)) : undefined),
    })
    await open(user)
    await pickConnection(user)
    await user.click(saveButton())
    await user.click(saveButton())
    fireEvent.submit(within(editor()).getByRole('button', { name: 'Create hook' }).closest('form')!)
    fireEvent.submit(within(editor()).getByRole('button', { name: 'Create hook' }).closest('form')!)
    expect(callsOf('saveHook')).toHaveLength(1)
    expect(saveButton().disabled).toBe(true)
    await act(async () => {
      release()
    })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New hook' })).toBeNull())
    expect(callsOf('saveHook')).toHaveLength(1)
    expect(rows()).toHaveLength(1)
  })
})

describe('the activity', () => {
  it('asks for the last 50 rows when the screen opens, and shows the rows newest first', async () => {
    const { callsOf } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed })
    await ready()
    await waitFor(() => expect(within(activity()).getAllByRole('listitem').length).toBeGreaterThan(0))
    expect(callsOf('listHookLog')).toEqual([{ limit: 50 }])
    const items = within(activity()).getAllByRole('listitem')
    expect(items).toHaveLength(hookLogFixtures.mixed.length)
    expect(items[0]!.textContent).toContain('Nov 13, 2026, 9:27:00 AM')
    expect(items[0]!.textContent).toContain('Skipped, in cooldown')
    expect(items.at(-1)!.textContent).toContain('Nov 12, 2026, 6:30:00 PM')
  })

  it('shows for each row the time, the hook, the workflow as text, the result and the code of a failure', async () => {
    mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed })
    await ready()
    await within(activity()).findAllByRole('listitem')
    const items = within(activity()).getAllByRole('listitem')
    const failed = items.find((item) => (item.textContent ?? '').includes('connection'))!
    expect(within(failed).getByText('Failed')).toBeTruthy()
    expect(failed.querySelector('code')?.textContent).toBe('connection')
    expect(failed.textContent).toContain('Send a Slack notice via ops-webhook')
    expect(failed.textContent).toContain('A run succeeds')
    expect(failed.textContent).toContain('웹훅을 슬랙으로 전달')
    expect(failed.textContent).toContain('Nov 13, 2026, 9:18:00 AM')
    const ok = items[0]!
    expect(ok.querySelector('code')).toBeNull()
  })

  it.each([
    ['ok', 'Done', /outcomeOk/],
    ['failed', 'Failed', /outcomeFailed/],
    ['skipped_cooldown', 'Skipped, in cooldown', /outcomeSkipped/],
    ['rate_limited', 'Skipped, limit reached', /outcomeSkipped/],
    ['blocked_by_rule', 'Blocked by a rule', /outcomeBlocked/],
    ['skipped_inactive', 'Nothing to do', /outcomeSkipped/],
  ] as const)('says %s as %s, in a word and not by color alone', async (outcome, word, chipClass) => {
    mount({ hooks: hookFixtures.one, log: [logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', outcome, 5, outcome === 'failed' ? 'unknown' : null)] })
    await ready()
    const items = await within(activity()).findAllByRole('listitem')
    expect(within(items[0]!).getByText(word).className).toMatch(chipClass)
  })

  it.each([['connection'], ['timeout'], ['http_status'], ['slack_error'], ['unknown']] as const)('shows the code %s of a failed row', async (code) => {
    mount({ hooks: hookFixtures.one, log: [logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', 'failed', 5, code)] })
    await ready()
    const items = await within(activity()).findAllByRole('listitem')
    expect(items[0]!.querySelector('code')?.textContent).toBe(code)
  })

  it('shows the rows of a hook that is gone as a deleted hook, with its event, and a workflow that is gone as a workflow that is not available', async () => {
    mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed })
    await ready()
    const items = await within(activity()).findAllByRole('listitem')
    const removed = items.find((item) => (item.textContent ?? '').includes('Deleted hook'))!
    expect(removed.textContent).toContain('A run fails')
    expect(removed.querySelector('em')?.textContent).toBe('Deleted hook')
    expect(items.filter((item) => item.querySelector('em') !== null)).toEqual([removed])
    const gone = items.find((item) => (item.textContent ?? '').includes('A workflow whose name is not available'))
    expect(gone).toBeTruthy()
  })

  it('says that the action of a row is the one that the hook has now, since the log keeps no action: an old failure is not shown as a failure of the record action', async () => {
    mount({ hooks: hookFixtures.some, log: [logRow('hook-deployed', ids.workflows.receipt, 'plan.deployed', 'failed', 5, 'http_status')] })
    await ready()
    const items = await within(activity()).findAllByRole('listitem')
    expect(items[0]!.textContent).toContain('Now: Write to the activity log only')
    expect(items[0]!.textContent).not.toMatch(/(^|[^:] )Write to the activity log only/)
    expect(within(items[0]!).getByText('Failed')).toBeTruthy()
  })

  it('says it in Korean too, and does not say it of a deleted hook', async () => {
    mount({ hooks: hookFixtures.some, log: [{ ...logRow('hook-removed', ids.workflows.receipt, 'run.failed', 'ok', 6), id: 1 }, { ...logRow('hook-deployed', ids.workflows.receipt, 'plan.deployed', 'failed', 5, 'http_status'), id: 2 }], locale: 'ko' })
    await screen.findByRole('region', { name: '저장한 훅' })
    const items = await within(screen.getByRole('region', { name: '활동' })).findAllByRole('listitem')
    expect(items[0]!.textContent).toContain('지금: ')
    expect(items[1]!.textContent).toContain('지운 훅')
    expect(items[1]!.textContent).not.toContain('지금: ')
  })

  it('does not call the rows of a hook a deleted hook before the hooks are loaded', async () => {
    mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed, intercept: (method) => (method === 'listHooks' ? new Promise(() => undefined) : undefined) })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull()
  })

  it('shows a workflow name that is hostile as text', async () => {
    mount({
      hooks: hookFixtures.hostile,
      log: hookLogFixtures.hostile,
      connections: [...hookConnections, { name: hookFixtures.hostileConnection, kind: 'slack' }],
      workflows: [
        { id: 'wf-hostile', workflow: workflowOf(HOSTILE_WORKFLOW_NAME, [], []), active: false, createdAt: 2 },
        { id: 'wf-long', workflow: workflowOf(LONG_WORKFLOW_NAME, [], []), active: false, createdAt: 1 },
      ],
    })
    await ready()
    const items = await within(activity()).findAllByRole('listitem')
    expect(activity().querySelector('img, script')).toBeNull()
    expect(items[1]!.textContent).toContain('…')
    expect(items.some((item) => (item.textContent ?? '').includes('<img src=x onerror=alert(1)>'))).toBe(true)
    expect(items.some((item) => (item.textContent ?? '').includes('‹U+202E›'))).toBe(true)
  })

  it('refreshes on the button, and says how many rows it shows', async () => {
    const { user, callsOf, inner } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed.slice(0, 2) })
    await ready()
    await within(activity()).findAllByRole('listitem')
    expect(within(activity()).getByRole('status').textContent).toContain('Showing 2 rows.')
    inner.hooks.addLog({ hookId: 'hook-deployed', at: 1, event: 'plan.deployed', workflowId: ids.workflows.webhook, outcome: 'ok', code: null })
    await user.click(within(activity()).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(within(activity()).getAllByRole('listitem')).toHaveLength(3))
    expect(callsOf('listHookLog')).toEqual([{ limit: 50 }, { limit: 50 }])
    expect(within(activity()).getByRole('status').textContent).toContain('Showing 3 rows.')
  })

  it('says one row in the singular', async () => {
    mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed.slice(0, 1) })
    await ready()
    await within(activity()).findAllByRole('listitem')
    expect(within(activity()).getByRole('status').textContent).toContain('Showing 1 row.')
  })

  it('says that nothing happened yet', async () => {
    mount({ hooks: hookFixtures.some })
    await ready()
    expect(await within(activity()).findByText(/^Nothing yet\./)).toBeTruthy()
    expect(within(activity()).queryByRole('list')).toBeNull()
    expect(activity().textContent).not.toContain('Showing')
  })

  it('does not say that nothing happened while the rows are on their way, nor when they could not be loaded', async () => {
    const waiting = mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'listHookLog' ? new Promise(() => undefined) : undefined) })
    await ready()
    expect(activity().textContent).not.toContain('Nothing yet')
    expect(within(activity()).getByRole('status').textContent).toBe('Loading the activity…')
    waiting.view.unmount()
    mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'listHookLog' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await within(await screen.findByRole('region', { name: 'Activity' })).findByRole('alert')
    expect(activity().textContent).not.toContain('Nothing yet')
  })

  it('says that it is loading before the rows were asked for', () => {
    renderThemed(<HookActivity log={{ status: 'idle', entries: [] }} hooks={[]} visible={hookLabels(createTranslator('en'), new Map(), (text) => text)} names={new Map()} clip={(text) => text} onRefresh={() => undefined} />, { locale: 'en' })
    expect(screen.getByRole('status').textContent).toBe('Loading the activity…')
    expect(screen.queryByText(/^Nothing yet\./)).toBeNull()
  })

  it('says that it is loading, and then shows the rows', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { inner } = mount({
      hooks: hookFixtures.some,
      log: hookLogFixtures.mixed,
      intercept: (method, params) => (method === 'listHookLog' ? gate.then(() => inner.request(method, params as MethodParams<'listHookLog'>)) : undefined),
    })
    await ready()
    expect(within(activity()).getByRole('status').textContent).toContain('Loading the activity…')
    await act(async () => {
      release()
    })
    await within(activity()).findAllByRole('listitem')
  })

  it('shows an alert with the button to try again when the rows cannot be loaded, and keeps the rows that it has', async () => {
    let fail = true
    const { user } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed, intercept: (method) => (method === 'listHookLog' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    expect((await within(activity()).findByRole('alert')).textContent).toBe('Could not load the activity.')
    fail = false
    await user.click(within(activity()).getByRole('button', { name: 'Refresh' }))
    await within(activity()).findAllByRole('listitem')
    expect(within(activity()).queryByRole('alert')).toBeNull()
    fail = true
    await user.click(within(activity()).getByRole('button', { name: 'Refresh' }))
    await within(activity()).findByRole('alert')
    expect(within(activity()).getAllByRole('listitem')).toHaveLength(hookLogFixtures.mixed.length)
  })

  it('does not ask for the rows again after a save or a delete, only on open and on the button', async () => {
    const { user, callsOf } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed })
    await ready()
    await within(activity()).findAllByRole('listitem')
    await user.click(within(rowOf('ops-webhook')).getByRole('switch'))
    await waitFor(() => expect(callsOf('saveHook')).toHaveLength(1))
    expect(callsOf('listHookLog')).toHaveLength(1)
  })

  it.each([
    ['connection', 'The connection is missing, changed or cannot post as it is set up.'],
    ['timeout', 'Slack did not answer in 15 seconds.'],
    ['http_status', 'Slack answered with an HTTP error.'],
    ['slack_error', 'Slack refused the message.'],
    ['unknown', 'Something unexpected went wrong.'],
  ] as const)('says in words what the code %s of a failed row means, in the row, so that a screen reader does not have to spell it', async (code, meaning) => {
    mount({ hooks: hookFixtures.one, log: [logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', 'failed', 5, code)] })
    await ready()
    const row = (await within(activity()).findAllByRole('listitem'))[0]!
    expect(row.querySelector('code')?.getAttribute('title')).toBe(meaning)
    expect(row.textContent).toContain(meaning)
    const spoken = [...row.querySelectorAll('span')].find((element) => element.textContent === meaning)
    expect(spoken?.className).toMatch(/hidden/)
  })

  it('says the meaning of a code in Korean', async () => {
    mount({ hooks: hookFixtures.one, log: [logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', 'failed', 5, 'http_status')], locale: 'ko' })
    await screen.findByRole('region', { name: '저장한 훅' })
    const row = (await within(screen.getByRole('region', { name: '활동' })).findAllByRole('listitem'))[0]!
    expect(row.querySelector('code')?.getAttribute('title')).toBe('슬랙이 HTTP 오류로 답했어요.')
  })

  it('explains what each result and each code means', async () => {
    const { user } = mount({ hooks: hookFixtures.some })
    await ready()
    const summary = within(activity()).getByText('What the results mean')
    await user.click(summary)
    const text = activity().textContent ?? ''
    for (const phrase of ['Skipped, in cooldown', 'Skipped, limit reached', 'Blocked by a rule', 'Nothing to do', 'Slack did not answer in 15 seconds.', 'Slack refused the message.']) expect(text).toContain(phrase)
  })
})

function dropFocusOfDisabledControls(): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof HTMLElement && record.target === document.activeElement && record.target.matches(':disabled')) record.target.blur()
    }
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['disabled'], subtree: true })
  return () => observer.disconnect()
}

function gated(): { gate: Promise<void>; release(): Promise<void> } {
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    gate,
    release: () =>
      act(async () => {
        open()
      }),
  }
}

describe('the focus and the live regions', () => {
  it('gives the focus back to the switch after the request, where the browser drops the focus of a control that turns disabled', async () => {
    const stop = dropFocusOfDisabledControls()
    try {
      const { gate, release } = gated()
      const { user, inner } = mount({
        hooks: hookFixtures.some,
        intercept: (method, params) => (method === 'saveHook' ? gate.then(() => inner.request(method, params as MethodParams<'saveHook'>)) : undefined),
      })
      await ready()
      const toggle = within(rowOf('team-slack to #alerts')).getByRole('switch')
      toggle.focus()
      await user.keyboard(' ')
      await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(true))
      expect(document.activeElement).toBe(document.body)
      await release()
      await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))
      await waitFor(() => expect(document.activeElement).toBe(toggle))
    } finally {
      stop()
    }
  })

  it('gives the focus back to the switch after a refused switch', async () => {
    const stop = dropFocusOfDisabledControls()
    try {
      const { user } = mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'saveHook' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
      await ready()
      const toggle = within(rowOf('team-slack to #alerts')).getByRole('switch')
      toggle.focus()
      await user.keyboard(' ')
      await screen.findByRole('alert')
      await waitFor(() => expect(document.activeElement).toBe(toggle))
    } finally {
      stop()
    }
  })

  it('does not take the focus from where the person moved it while the switch waited', async () => {
    const stop = dropFocusOfDisabledControls()
    try {
      const { gate, release } = gated()
      const { user, inner } = mount({
        hooks: hookFixtures.some,
        intercept: (method, params) => (method === 'saveHook' ? gate.then(() => inner.request(method, params as MethodParams<'saveHook'>)) : undefined),
      })
      await ready()
      const toggle = within(rowOf('team-slack to #alerts')).getByRole('switch')
      toggle.focus()
      await user.keyboard(' ')
      await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(true))
      const refresh = within(activity()).getByRole('button', { name: 'Refresh' })
      refresh.focus()
      await release()
      await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false))
      expect(document.activeElement).toBe(refresh)
    } finally {
      stop()
    }
  })

  it('gives the focus back to the field where Enter was pressed, after a failed save, and puts the alert next to it', async () => {
    const stop = dropFocusOfDisabledControls()
    try {
      const { user } = mount({ intercept: (method) => (method === 'saveHook' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
      await open(user)
      await pickConnection(user)
      await user.type(field('Channel (optional)'), '#ops{Enter}')
      await within(editor()).findByRole('alert')
      await waitFor(() => expect(document.activeElement).toBe(field('Channel (optional)')))
    } finally {
      stop()
    }
  })

  it('gives the focus back to the Save button after a failed save that was started by a click', async () => {
    const stop = dropFocusOfDisabledControls()
    try {
      const { user } = mount({ intercept: (method) => (method === 'saveHook' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
      await open(user)
      await pickConnection(user)
      saveButton().focus()
      await user.keyboard('{Enter}')
      await within(editor()).findByRole('alert')
      await waitFor(() => expect(document.activeElement).toBe(saveButton()))
    } finally {
      stop()
    }
  })

  it('puts the focus on the heading of the list when the form closes because its hook is gone', async () => {
    const stop = dropFocusOfDisabledControls()
    try {
      const { user, inner } = mount({ hooks: hookFixtures.some })
      await ready()
      await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Edit the hook/ }))
      await user.type(field('Channel (optional)'), '#x')
      inner.hooks.remove({ id: 'hook-ok-webhook' })
      await user.keyboard('{Enter}')
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Edit hook' })).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Saved hooks' })))
    } finally {
      stop()
    }
  })

  it('keeps the focus on the switch through a slow answer, with the focus rules of the browser at work', async () => {
    const wait = gate()
    const { user, inner } = mount({
      hooks: hookFixtures.some,
      intercept: (method, params) => (method === 'saveHook' ? wait.promise.then(() => inner.request(method, params as MethodParams<'saveHook'>)) : undefined),
    })
    await ready()
    const toggle = within(rowOf('team-slack to #alerts')).getByRole('switch') as HTMLInputElement
    toggle.focus()
    await user.keyboard(' ')
    await waitFor(() => expect(toggle.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await waitFor(() => expect(toggle.checked).toBe(false))
    expect(toggle.disabled).toBe(false)
    expect(document.activeElement).toBe(toggle)
  })

  it('keeps the focus in the field where Enter was pressed through a slow refusal, with the focus rules of the browser at work', async () => {
    const wait = gate()
    const { user } = mount({ intercept: (method) => (method === 'saveHook' ? wait.promise.then(() => Promise.reject(new RillError('INTERNAL', 'x'))) : undefined) })
    await open(user)
    await pickConnection(user)
    const channel = field('Channel (optional)') as HTMLInputElement
    await user.type(channel, '#ops{Enter}')
    await waitFor(() => expect(channel.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await within(editor()).findByRole('alert')
    expect(channel.disabled).toBe(false)
    expect(document.activeElement).toBe(channel)
  })

  it('keeps the focus on the confirm button of the dialog when a slow delete is refused', async () => {
    const wait = gate()
    const { user } = mount({ hooks: hookFixtures.some, intercept: (method) => (method === 'deleteHook' ? wait.promise.then(() => Promise.reject(new RillError('INTERNAL', 'x'))) : undefined) })
    await ready()
    await user.click(within(rowOf('ops-webhook')).getByRole('button', { name: /^Delete the hook/ }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Delete hook' }) as HTMLButtonElement
    confirm.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(confirm.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await within(dialog).findByRole('alert')
    expect(document.activeElement).toBe(confirm)
  })

  it('has one live region for what happened, which stays in the page while it is empty', async () => {
    mount({ hooks: hookFixtures.some })
    await ready()
    const regions = screen.getAllByRole('status')
    expect(regions.length).toBeGreaterThanOrEqual(1)
    expect(regions.some((region) => (region.textContent ?? '') === '')).toBe(true)
  })

  it('puts an alert on a failed save inside the form, so the person hears it next to the button', async () => {
    const { user } = mount({ intercept: (method) => (method === 'saveHook' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await open(user)
    await pickConnection(user)
    await user.click(saveButton())
    const alert = await within(editor()).findByRole('alert')
    expect(alert.textContent).toBe('Something went wrong with the hook. Try again.')
    expect(within(editor()).getByRole('button', { name: /^(Save|Create hook)$/ })).toBeTruthy()
  })

  it('keeps the title of the screen for screen readers and does not draw it', async () => {
    mount()
    await ready()
    const heading = screen.getByRole('heading', { level: 2, name: 'Hooks' })
    expect(heading.className).toMatch(/hidden/)
    expect(heading.className).not.toMatch(/title/)
  })
})

describe('accessibility', () => {
  it('has no axe violation on the list, with the activity', async () => {
    const { view } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed })
    await ready()
    await within(activity()).findAllByRole('listitem')
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('has none for the form of each action, with problems shown', async () => {
    const { view, user } = mount({ hooks: hookFixtures.some })
    await open(user)
    expect(await axeViolations(view.container)).toEqual([])
    await pickConnection(user)
    await user.type(field('Channel (optional)'), '#two words')
    expect(await axeViolations(view.container)).toEqual([])
    await user.selectOptions(select('Then'), 'deactivateAfterFailures')
    await user.clear(field('Failures in a row'))
    await user.type(field('Failures in a row'), '1')
    expect(await axeViolations(view.container)).toEqual([])
    await user.selectOptions(select('Then'), 'record')
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('has none for the empty states, the limit and the delete dialog', async () => {
    const empty = mount({ connections: [] })
    await open(empty.user)
    expect(await axeViolations(empty.view.container)).toEqual([])
    empty.view.unmount()
    const full = mount({ hooks: hookFixtures.full })
    await ready()
    expect(await axeViolations(full.view.container)).toEqual([])
    await full.user.click(within(rows()[0]!).getByRole('button', { name: /^Delete the hook/ }))
    await screen.findByRole('dialog')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has none in Korean', async () => {
    const { view, user, t } = mount({ hooks: hookFixtures.some, log: hookLogFixtures.mixed, locale: 'ko' })
    await screen.findByRole('region', { name: t('agents.hooks.list.title') })
    await user.click(screen.getByRole('button', { name: t('agents.hooks.new') }))
    await screen.findByRole('region', { name: t('agents.hooks.editor.newTitle') })
    expect(await axeViolations(view.container)).toEqual([])
  })
})
