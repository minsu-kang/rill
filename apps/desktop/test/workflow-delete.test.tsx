import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, type AppProps } from '../src/app/App'
import { createFakeWorld, type FakeWorld, type FakeWorldOptions } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { engineErrorKey } from '../src/app/workflows/errors'
import { useWorkflowList } from '../src/app/workflows/useWorkflowList'
import { WorkflowActions } from '../src/app/workflows/WorkflowActions'
import type { EngineClient } from '../src/engine/client'
import { fakeSettings } from '../src/engine/fake-host'
import { catalog, FIXTURE_NOW, ids, node, workflowOf } from '../src/fixtures'
import { createTranslator } from '../src/i18n'
import { violations } from './axe'
import { renderThemed } from './render'

afterEach(cleanup)

const t = createTranslator('en')
const READY = fakeSettings({ configuredProviders: ['anthropic'], allowedFolders: ['/Users/demo/Receipts'] })

function Actions({ client, workflowId, onDeleted }: { client: EngineClient; workflowId: string; onDeleted?: (id: string) => void }) {
  const list = useWorkflowList(client)
  const summary = list.workflows.find((item) => item.id === workflowId)
  if (summary === undefined) return <p>loading</p>
  return <WorkflowActions client={client} workflowId={workflowId} summary={summary} catalog={catalog} onRunStarted={() => undefined} onDeleted={onDeleted} />
}

type Intercept = (method: MethodName, params: unknown) => Promise<unknown> | undefined

function wrap(world: FakeWorld, intercept: Intercept): EngineClient {
  return {
    onEvent: world.client.onEvent,
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => (intercept(method, params) ?? world.client.request(method, params)) as Promise<MethodResult<M>>,
  }
}

async function show(options: { world?: FakeWorld; client?: EngineClient; workflowId?: string; onDeleted?: (id: string) => void } = {}) {
  const world = options.world ?? createFakeWorld({ hostOptions: { restartDelayMs: 0 }, control: { stepIntervalMs: 0 } })
  const view = renderThemed(<Actions client={options.client ?? world.client} workflowId={options.workflowId ?? ids.workflows.webhook} onDeleted={options.onDeleted} />, { locale: 'en' })
  await screen.findByRole('region', { name: t('app.wf.actions.label') })
  return { world, view, user: userEvent.setup() }
}

const deleteButton = (): HTMLButtonElement => screen.getByRole('button', { name: t('app.wf.actions.delete') }) as HTMLButtonElement
const confirmButton = (): HTMLButtonElement => within(screen.getByRole('dialog')).getByRole('button', { name: t('app.delete.confirm') }) as HTMLButtonElement
const hostileName = '<img src=x onerror=alert(1)> ‹RLO›‮' + 'long '.repeat(30)

describe('error keys', () => {
  it('has a message for a workflow that is busy and keeps the older ones', () => {
    expect(engineErrorKey(new RillError('WORKFLOW_BUSY', 'x'))).toBe('app.wf.error.WORKFLOW_BUSY')
    expect(engineErrorKey(new RillError('NOT_FOUND', 'x'))).toBe('app.wf.error.NOT_FOUND')
    expect(engineErrorKey(new RillError('WHATEVER', 'x'))).toBe('app.wf.error.generic')
    expect(t('app.wf.error.WORKFLOW_BUSY')).toBe('This workflow still has a run in progress. Try again when it has finished.')
    expect(t('app.wf.error.WORKFLOW_BUSY_ACTIVE')).toBe('This workflow still has a run in progress. Deactivate it so that no new run starts, and try again when the run has finished.')
  })
})

describe('WorkflowActions: delete button', () => {
  it('shows a danger styled Delete button after the other actions, for an active and an inactive workflow', async () => {
    for (const workflowId of [ids.workflows.webhook, ids.workflows.receipt]) {
      const { view } = await show({ workflowId })
      const row = deleteButton().parentElement!
      const buttons = within(row).getAllByRole('button')
      expect(buttons.at(-1)).toBe(deleteButton())
      expect(deleteButton().className).toMatch(/danger/)
      expect(buttons.length).toBeGreaterThanOrEqual(4)
      view.unmount()
    }
  })

  it('is disabled while another action of the workflow runs', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    let release!: () => void
    const client = wrap(world, (method) => (method === 'activate' ? new Promise((resolve) => (release = () => resolve({}))) : undefined))
    const { user } = await show({ world, client })
    await user.click(screen.getByRole('button', { name: t('app.wf.actions.activate') }))
    await waitFor(() => expect(deleteButton().disabled).toBe(true))
    release()
  })
})

describe('WorkflowActions: delete dialog', () => {
  it('names the workflow, says the run history goes too and that it cannot be undone', async () => {
    const { user } = await show()
    await user.click(deleteButton())
    const dialog = screen.getByRole('dialog', { name: t('app.delete.title') })
    expect(t('app.delete.title')).toBe('Delete this workflow?')
    expect(dialog.textContent).toContain('웹훅을 슬랙으로 전달')
    expect(dialog.textContent).toMatch(/run history/)
    expect(dialog.textContent).toMatch(/cannot be undone/)
    expect(within(dialog).getByRole('button', { name: t('app.common.cancel') })).toBeTruthy()
    expect(confirmButton().disabled).toBe(false)
  })

  it('renders an untrusted name as truncated text, whatever it contains', async () => {
    const world = createFakeWorld({
      hostOptions: { restartDelayMs: 0 },
      workflows: [{ id: 'wf-hostile', workflow: workflowOf(hostileName, [node('t', 'trigger.manual@1', {})], []), active: false, createdAt: FIXTURE_NOW }],
    })
    const { user } = await show({ world, workflowId: 'wf-hostile' })
    await user.click(deleteButton())
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(dialog.textContent).not.toContain('‮')
    expect(dialog.textContent).toContain('…')
    expect(dialog.textContent!.length).toBeLessThan(hostileName.length)
  })

  it('does nothing when it is cancelled, with the button or with Escape, and gives the focus back to Delete', async () => {
    const { world, user } = await show()
    await user.click(deleteButton())
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.common.cancel') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(deleteButton())
    await user.click(deleteButton())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(world.callsOf('deleteWorkflow')).toHaveLength(0)
    expect(world.workflowIds()).toContain(ids.workflows.webhook)
  })

  it('deletes once on confirm, calls onDeleted with the id and closes', async () => {
    const onDeleted = vi.fn()
    const { world, user } = await show({ onDeleted })
    await user.click(deleteButton())
    await user.click(confirmButton())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledExactlyOnceWith(ids.workflows.webhook))
    expect(world.callsOf('deleteWorkflow')).toEqual([{ method: 'deleteWorkflow', params: { workflowId: ids.workflows.webhook } }])
    expect(world.workflowIds()).not.toContain(ids.workflows.webhook)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('disables the confirm button while the call runs, so a double click sends once', async () => {
    const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    let release!: () => void
    const client = wrap(base, (method) => (method === 'deleteWorkflow' ? new Promise((resolve) => (release = () => resolve({}))) : undefined))
    const onDeleted = vi.fn()
    const { user } = await show({ world: base, client, onDeleted })
    await user.click(deleteButton())
    await user.dblClick(confirmButton())
    expect(confirmButton().disabled).toBe(true)
    expect(base.callsOf('deleteWorkflow')).toHaveLength(0)
    const sent = vi.spyOn(client, 'request')
    await user.click(confirmButton())
    expect(sent.mock.calls.filter(([method]) => method === 'deleteWorkflow')).toHaveLength(0)
    await act(async () => release())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('sends exactly one request for a double click', async () => {
    const calls: string[] = []
    const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    let release!: () => void
    const client = wrap(base, (method) => {
      if (method !== 'deleteWorkflow') return undefined
      calls.push(method)
      return new Promise((resolve) => (release = () => resolve({})))
    })
    const { user } = await show({ world: base, client })
    await user.click(deleteButton())
    await user.dblClick(confirmButton())
    expect(calls).toEqual(['deleteWorkflow'])
    await act(async () => release())
  })

  it('styles the confirm button of the delete dialog as dangerous and the one of the deactivate dialog as plain', async () => {
    const { user } = await show({ workflowId: ids.workflows.receipt })
    await user.click(deleteButton())
    expect(confirmButton().className).toMatch(/dangerPrimary/)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.common.cancel') }))
    await user.click(screen.getByRole('button', { name: t('app.wf.actions.deactivate') }))
    const plain = within(screen.getByRole('dialog')).getByRole('button', { name: t('app.deactivate.confirm') })
    expect(plain.className).not.toMatch(/danger/)
  })

  it('says the run is still in progress when the workflow is busy, keeps the dialog open and allows another try', async () => {
    const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    let busy = true
    const client = wrap(base, (method) => (method === 'deleteWorkflow' && busy ? Promise.reject(new RillError('WORKFLOW_BUSY', 'the workflow has a run that is queued or running')) : undefined))
    const onDeleted = vi.fn()
    const { user } = await show({ world: base, client, onDeleted })
    await user.click(deleteButton())
    await user.click(confirmButton())
    const alert = await within(screen.getByRole('dialog')).findByRole('alert')
    expect(alert.textContent).toBe('This workflow still has a run in progress. Try again when it has finished.')
    expect(alert.textContent).not.toContain('queued')
    expect(alert.textContent).not.toMatch(/deactivate/i)
    expect(onDeleted).not.toHaveBeenCalled()
    expect(confirmButton().disabled).toBe(false)
    busy = false
    await user.click(confirmButton())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('tells the person to deactivate an active workflow that is busy, so no new run keeps it busy', async () => {
    const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const client = wrap(base, (method) => (method === 'deleteWorkflow' ? Promise.reject(new RillError('WORKFLOW_BUSY', 'x')) : undefined))
    const { user } = await show({ world: base, client, workflowId: ids.workflows.receipt })
    expect(screen.getByRole('button', { name: t('app.wf.actions.deactivate') })).toBeTruthy()
    await user.click(deleteButton())
    await user.click(confirmButton())
    const alert = await within(screen.getByRole('dialog')).findByRole('alert')
    expect(alert.textContent).toBe('This workflow still has a run in progress. Deactivate it so that no new run starts, and try again when the run has finished.')
  })

  it('shows the plain error text for any other failure and does not leak the engine message', async () => {
    const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const client = wrap(base, (method) => (method === 'deleteWorkflow' ? Promise.reject(new RillError('INTERNAL', 'secret engine detail')) : undefined))
    const onDeleted = vi.fn()
    const { user } = await show({ world: base, client, onDeleted })
    await user.click(deleteButton())
    await user.click(confirmButton())
    const alert = await within(screen.getByRole('dialog')).findByRole('alert')
    expect(alert.textContent).toBe(t('app.wf.error.generic'))
    expect(document.body.textContent).not.toContain('secret engine detail')
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('clears the error when the dialog is cancelled and opened again', async () => {
    const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const client = wrap(base, (method) => (method === 'deleteWorkflow' ? Promise.reject(new RillError('NOT_FOUND', 'x')) : undefined))
    const { user } = await show({ world: base, client })
    await user.click(deleteButton())
    await user.click(confirmButton())
    await within(screen.getByRole('dialog')).findByRole('alert')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.common.cancel') }))
    await user.click(deleteButton())
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull()
  })

  it('has no axe violations in the dialog, with an error, and in English and Korean', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const base = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
      const client = wrap(base, (method) => (method === 'deleteWorkflow' ? Promise.reject(new RillError('WORKFLOW_BUSY', 'x')) : undefined))
      const view = renderThemed(<Actions client={client} workflowId={ids.workflows.webhook} />, { locale })
      const tr = createTranslator(locale)
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: tr('app.wf.actions.delete') }))
      expect(await violations(view.container)).toEqual([])
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: tr('app.delete.confirm') }))
      await within(screen.getByRole('dialog')).findByRole('alert')
      expect(await violations(view.container)).toEqual([])
      view.unmount()
    }
  })
})

describe('useWorkflowList and the workflow.deleted event', () => {
  function List({ client }: { client: EngineClient }) {
    const list = useWorkflowList(client)
    return (
      <div>
        <ul>
          {list.workflows.map((item) => (
            <li key={item.id}>{item.id}</li>
          ))}
        </ul>
        <button type="button" onClick={() => list.forget(ids.workflows.receipt)}>
          forget
        </button>
      </div>
    )
  }

  it('refreshes the list when another window deletes a workflow', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    renderThemed(<List client={world.client} />, { locale: 'en' })
    await screen.findByText(ids.workflows.webhook)
    await world.client.request('deleteWorkflow', { workflowId: ids.workflows.webhook })
    await waitFor(() => expect(screen.queryByText(ids.workflows.webhook)).toBeNull())
    expect(screen.getByText(ids.workflows.receipt)).toBeTruthy()
  })

  it('drops a workflow from the list at once when asked to forget it', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const user = userEvent.setup()
    renderThemed(<List client={world.client} />, { locale: 'en' })
    await screen.findByText(ids.workflows.receipt)
    await user.click(screen.getByRole('button', { name: 'forget' }))
    expect(screen.queryByText(ids.workflows.receipt)).toBeNull()
    expect(screen.getByText(ids.workflows.webhook)).toBeTruthy()
  })
})

describe('deleting a workflow in the app', () => {
  function mount(initial: AppProps['initial'] = {}, world: FakeWorldOptions = {}, quiet = false) {
    const made = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, hostInit: { settings: READY }, control: { stepIntervalMs: 0 }, ...world })
    const connect = quiet ? async () => ({ request: made.client.request, onEvent: () => () => undefined }) : made.connect
    const view = renderThemed(
      <HostProvider host={made.host} connect={connect}>
        <App initial={initial} />
      </HostProvider>,
      { locale: 'en' },
    )
    return { world: made, view, user: userEvent.setup() }
  }

  const switcher = (): HTMLSelectElement => screen.getByLabelText(t('app.wf.switcher.label')) as HTMLSelectElement
  const main = (view: { container: HTMLElement }): HTMLElement => view.container.querySelector<HTMLElement>('main')!

  async function selected(id: string): Promise<void> {
    await waitFor(() => expect(switcher().value).toBe(id))
    await screen.findByRole('button', { name: t('app.wf.actions.delete') })
  }

  async function remove(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: t('app.wf.actions.delete') }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.delete.confirm') }))
  }

  it('moves to the next workflow, refreshes the list and says so after a delete', async () => {
    const { world, user } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await remove(user)
    await waitFor(() => expect(world.workflowIds()).not.toContain(ids.workflows.receipt))
    await waitFor(() => expect(Array.from(switcher().options).map((option) => option.value)).not.toContain(ids.workflows.receipt))
    expect(world.callsOf('deleteWorkflow')).toHaveLength(1)
    await waitFor(() => expect(Array.from(switcher().options).map((option) => option.value)).toContain(switcher().value))
    expect(switcher().value).not.toBe(ids.workflows.receipt)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText(t('app.notice.deleted'))).toBeTruthy()
  })

  it('moves on at once even when no event arrives, because it does not wait for the engine to say so', async () => {
    const { world, user } = mount({ workflowId: ids.workflows.receipt }, {}, true)
    await selected(ids.workflows.receipt)
    await remove(user)
    await waitFor(() => expect(world.workflowIds()).not.toContain(ids.workflows.receipt))
    await waitFor(() => expect(switcher().value).not.toBe(ids.workflows.receipt))
    expect(Array.from(switcher().options).map((option) => option.value)).not.toContain(ids.workflows.receipt)
  })

  it('does not ask the engine for the deleted workflow again', async () => {
    const { world, user } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await remove(user)
    await waitFor(() => expect(world.workflowIds()).not.toContain(ids.workflows.receipt))
    const before = world.calls.length
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    const later = world.calls.slice(before).filter((call) => (call.params as { workflowId?: string } | undefined)?.workflowId === ids.workflows.receipt)
    expect(later).toEqual([])
  })

  it('shows the empty state after the last workflow is deleted', async () => {
    const only = [{ id: 'wf-only', workflow: workflowOf('Only one', [node('t', 'trigger.manual@1', {})], []), active: false, createdAt: FIXTURE_NOW }]
    const { world, user, view } = mount({ workflowId: 'wf-only' }, { workflows: only, hostInit: { settings: fakeSettings() } })
    await selected('wf-only')
    await remove(user)
    await waitFor(() => expect(world.workflowIds()).toEqual([]))
    expect(await screen.findByText(t('app.wf.switcher.empty'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('app.wf.actions.delete') })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(main(view)))
  })

  it('puts the focus on the workflow switcher after a delete when other workflows remain', async () => {
    const { user } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await remove(user)
    await waitFor(() => expect(document.activeElement).toBe(switcher()))
  })

  it('does not delete anything when the person cancels', async () => {
    const { world, user } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await user.click(screen.getByRole('button', { name: t('app.wf.actions.delete') }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.common.cancel') }))
    expect(world.callsOf('deleteWorkflow')).toHaveLength(0)
    expect(switcher().value).toBe(ids.workflows.receipt)
  })

  it('keeps the selection and says to deactivate and wait when the active workflow is busy', async () => {
    const { world, user } = mount({ workflowId: ids.workflows.receipt }, { control: { stepIntervalMs: 60_000 } })
    await selected(ids.workflows.receipt)
    await user.click(screen.getByRole('button', { name: t('app.wf.actions.dryRun') }))
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button').at(-1)!)
    await waitFor(() => expect(world.callsOf('startRun')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: t('app.wf.actions.delete') }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('app.delete.confirm') }))
    const alert = await within(screen.getByRole('dialog')).findByRole('alert')
    expect(alert.textContent).toBe('This workflow still has a run in progress. Deactivate it so that no new run starts, and try again when the run has finished.')
    expect(switcher().value).toBe(ids.workflows.receipt)
  })

  it('follows a delete in another window: the selected workflow disappears and the next one shows', async () => {
    const { world } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await act(async () => {
      await world.client.request('deleteWorkflow', { workflowId: ids.workflows.receipt })
    })
    await waitFor(() => expect(Array.from(switcher().options).map((option) => option.value)).not.toContain(ids.workflows.receipt))
    await waitFor(() => expect(switcher().value).not.toBe(ids.workflows.receipt))
    expect(switcher().value).not.toBe('')
  })

  it('leaves the selection alone when another window deletes a workflow that is not selected', async () => {
    const { world } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await act(async () => {
      await world.client.request('deleteWorkflow', { workflowId: ids.workflows.webhook })
    })
    await waitFor(() => expect(Array.from(switcher().options).map((option) => option.value)).not.toContain(ids.workflows.webhook))
    expect(switcher().value).toBe(ids.workflows.receipt)
  })

  it('has the Delete button only on the Workflows screen with a workflow selected', async () => {
    const { user } = mount({ workflowId: ids.workflows.receipt })
    await selected(ids.workflows.receipt)
    await user.click(within(screen.getByRole('navigation', { name: t('app.top.screens') })).getByRole('button', { name: 'Recipes' }))
    expect(screen.queryByRole('button', { name: t('app.wf.actions.delete') })).toBeNull()
  })
})
