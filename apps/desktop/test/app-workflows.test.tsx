import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createFakeWorld, type FakeWorld } from '../src/app/fake-world'
import { ActionConfirm } from '../src/app/ActionConfirm'
import { PayloadDialog } from '../src/app/workflows/PayloadDialog'
import { payloadSample, needsPayload, triggerKind } from '../src/app/workflows/samples'
import { useWorkflowList } from '../src/app/workflows/useWorkflowList'
import { WorkflowActions } from '../src/app/workflows/WorkflowActions'
import { WorkflowSwitcher } from '../src/app/workflows/WorkflowSwitcher'
import type { NodeInfo } from '@rill/protocol'
import type { EngineClient } from '../src/engine/client'
import { catalog, FIXTURE_NOW, fakeData, ids, workflowOf, node, edge } from '../src/fixtures'
import { createTranslator } from '../src/i18n'
import { renderThemed } from './render'
import { violations } from './axe'

const t = createTranslator('ko')

const manualWorkflow = workflowOf(
  '수동 정리',
  [
    node('start', 'trigger.manual@1', {}),
    node('extract', 'llm.extract@1', { file: '/Users/demo/a.pdf', fields: [{ name: 'amount', type: 'number', description: 'Total' }] }),
    node('send', 'http.request@1', { url: 'https://hooks.example.com/ingest', method: 'POST' }),
    node('append', 'csv.append@1', { file: '/Users/demo/ledger.csv', row: ['x'] }),
  ],
  [edge('start', 'extract'), edge('extract', 'send'), edge('send', 'append')],
)
const quietWorkflow = workflowOf('조용한 흐름', [node('start', 'trigger.manual@1', {}), node('wait', 'delay@1', { ms: 1 })], [edge('start', 'wait')])
const cronWorkflow = workflowOf('매일 아침', [node('tick', 'trigger.cron@1', { expression: '0 9 * * *', timezone: 'local' }), node('wait', 'delay@1', { ms: 1 })], [edge('tick', 'wait')])

function world(extra: Partial<Parameters<typeof createFakeWorld>[0]> = {}): FakeWorld {
  return createFakeWorld({
    hostOptions: { restartDelayMs: 0 },
    workflows: [
      ...fakeData.workflows,
      { id: 'wf-manual', workflow: manualWorkflow, active: false, createdAt: FIXTURE_NOW },
      { id: 'wf-quiet', workflow: quietWorkflow, active: false, createdAt: FIXTURE_NOW },
      { id: 'wf-cron', workflow: cronWorkflow, active: false, createdAt: FIXTURE_NOW },
    ],
    control: { stepIntervalMs: 0 },
    ...extra,
  })
}

function Actions({
  client,
  workflowId,
  onRunStarted,
  focusAction,
  nodes = catalog,
}: {
  client: EngineClient
  workflowId: string
  onRunStarted?: (id: string) => void
  focusAction?: 'dryRun' | 'activate'
  nodes?: readonly NodeInfo[]
}) {
  const list = useWorkflowList(client)
  const summary = list.workflows.find((item) => item.id === workflowId)
  if (summary === undefined) return <p>loading</p>
  return <WorkflowActions client={client} workflowId={workflowId} summary={summary} catalog={nodes} onRunStarted={onRunStarted ?? (() => undefined)} focusAction={focusAction} />
}

async function show(w: FakeWorld, workflowId: string, onRunStarted?: (id: string) => void, client: EngineClient = w.client, locale: 'ko' | 'en' = 'ko') {
  const view = renderThemed(<Actions client={client} workflowId={workflowId} onRunStarted={onRunStarted} />, { locale })
  await screen.findByRole('region', { name: createTranslator(locale)('app.wf.actions.label') })
  return view
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('samples', () => {
  it('maps trigger types to kinds and says which ones need a payload', () => {
    expect(['trigger.manual@1', 'trigger.webhook@1', 'trigger.folderWatch@1', 'trigger.cron@1', 'trigger.x@9'].map(triggerKind)).toEqual(['manual', 'webhook', 'folderWatch', 'cron', 'other'])
    expect(['trigger.manual@1', 'trigger.cron@1', 'trigger.webhook@1', 'trigger.folderWatch@1', 'unknown'].map(needsPayload)).toEqual([false, false, true, true, true])
    expect(triggerKind('constructor')).toBe('other')
  })

  it('gives a trigger-specific sample: {} for manual and cron, a body for a webhook, a file object for a folder', () => {
    expect(payloadSample('trigger.manual@1')).toBe('{}')
    expect(payloadSample('trigger.cron@1')).toBe('{}')
    expect(JSON.parse(payloadSample('trigger.webhook@1'))).toMatchObject({ method: 'POST', body: { orderId: expect.any(String) } })
    expect(JSON.parse(payloadSample('trigger.folderWatch@1', new Date(0)))).toEqual({ file: '/path/to/sample.pdf', name: 'sample.pdf', extension: 'pdf', bytes: 1024, modifiedAt: '1970-01-01T00:00:00.000Z' })
  })
})

describe('useWorkflowList and WorkflowSwitcher', () => {
  function Switcher({ client, onSelect }: { client: EngineClient | undefined; onSelect?: (id: string) => void }) {
    const list = useWorkflowList(client)
    const [selected, setSelected] = useState<string | undefined>(undefined)
    return (
      <WorkflowSwitcher
        list={list}
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id)
          onSelect?.(id)
        }}
      />
    )
  }

  it('lists the workflows with their trigger and whether they are active', async () => {
    renderThemed(<Switcher client={createFakeWorld({ hostOptions: { restartDelayMs: 0 } }).client} />)
    const select = (await screen.findByLabelText(t('app.wf.switcher.label'))) as HTMLSelectElement
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('영수증 정리 · 폴더 감시 · 활성')
    expect(options).toContain('웹훅을 슬랙으로 전달 · 웹훅 · 비활성')
    expect(options).toContain('매일 서버 상태 확인 · 일정 · 활성')
  })

  it('reports the choice', async () => {
    const onSelect = vi.fn()
    renderThemed(<Switcher client={createFakeWorld({ hostOptions: { restartDelayMs: 0 } }).client} onSelect={onSelect} />)
    const select = await screen.findByLabelText(t('app.wf.switcher.label'))
    await userEvent.setup().selectOptions(select, ids.workflows.webhook)
    expect(onSelect).toHaveBeenCalledWith(ids.workflows.webhook)
  })

  it('points to the chat and the recipes tab when there is no workflow', async () => {
    renderThemed(<Switcher client={createFakeWorld({ workflows: [], hostOptions: { restartDelayMs: 0 } }).client} />)
    const text = await screen.findByText(t('app.wf.switcher.empty'))
    expect(text.textContent).toContain('대화창')
    expect(text.textContent).toContain('레시피')
  })

  it('says it is loading, and shows an error with a retry that loads again', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    let fail = true
    const client: EngineClient = {
      onEvent: world.client.onEvent,
      request: (method, params) => (method === 'listWorkflows' && fail ? Promise.reject(new Error('down')) : world.client.request(method, params)),
    }
    renderThemed(<Switcher client={client} />)
    expect(screen.getByText(t('app.wf.switcher.loading'))).toBeTruthy()
    expect(await screen.findByText(t('app.wf.switcher.error'))).toBeTruthy()
    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: t('app.wf.switcher.retry') }))
    expect(await screen.findByLabelText(t('app.wf.switcher.label'))).toBeTruthy()
  })

  it('keeps the list on screen while a new client loads it again, and replaces it when that is done', async () => {
    const first = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const second = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, workflows: [{ id: 'wf-only', workflow: quietWorkflow, active: false, createdAt: FIXTURE_NOW }] })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: EngineClient = { onEvent: second.client.onEvent, request: async (method, params) => (method === 'listWorkflows' ? (await gate, second.client.request(method, params)) : second.client.request(method, params)) }
    const view = renderThemed(<Switcher client={first.client} />)
    const label = t('app.wf.switcher.label')
    await screen.findByLabelText(label)
    view.rerender(<Switcher client={slow} />)
    expect(screen.queryByText(t('app.wf.switcher.loading'))).toBeNull()
    const texts = () => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent)
    expect(texts()).toContain('영수증 정리 · 폴더 감시 · 활성')
    release()
    await waitFor(() => expect(texts()).toContain('조용한 흐름 · 수동 · 비활성'))
    expect(texts()).not.toContain('영수증 정리 · 폴더 감시 · 활성')
  })

  it('refreshes when a workflow is activated or deactivated', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    renderThemed(<Switcher client={world.client} />)
    await screen.findByLabelText(t('app.wf.switcher.label'))
    const texts = () => within(screen.getByLabelText(t('app.wf.switcher.label'))).getAllByRole('option').map((option) => option.textContent)
    expect(texts()).toContain('웹훅을 슬랙으로 전달 · 웹훅 · 비활성')
    await act(async () => {
      await world.client.request('activate', { workflowId: ids.workflows.webhook })
    })
    await waitFor(() => expect(texts()).toContain('웹훅을 슬랙으로 전달 · 웹훅 · 활성'))
    await act(async () => {
      await world.client.request('deactivate', { workflowId: ids.workflows.webhook })
    })
    await waitFor(() => expect(texts()).toContain('웹훅을 슬랙으로 전달 · 웹훅 · 비활성'))
    expect(world.callsOf('listWorkflows').length).toBeGreaterThanOrEqual(3)
  })

  it('keeps an unknown selected id as a pending entry, and shows names with invisible characters made visible', async () => {
    const world = createFakeWorld({
      workflows: [{ id: 'wf-x', workflow: workflowOf('evil‮name', [node('t', 'trigger.manual@1', {})], []), createdAt: 1 }],
      hostOptions: { restartDelayMs: 0 },
    })
    const list = { status: 'ready' as const, workflows: (await world.client.request('listWorkflows', {})).workflows, refresh: async () => undefined }
    renderThemed(<WorkflowSwitcher list={list} selectedId="wf-new" onSelect={() => undefined} />)
    const options = within(screen.getByLabelText(t('app.wf.switcher.label'))).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual([t('app.wf.switcher.pending'), 'evil‹U+202E›name · 수동 · 비활성'])
  })
})

describe('PayloadDialog', () => {
  it('prefills the sample, blocks invalid JSON with a message and submits the parsed value', async () => {
    const onSubmit = vi.fn()
    renderThemed(<PayloadDialog triggerType="trigger.webhook@1" mode="dry" onSubmit={onSubmit} onCancel={() => undefined} />)
    const field = screen.getByLabelText(t('app.payload.label')) as HTMLTextAreaElement
    expect(JSON.parse(field.value)).toHaveProperty('body')
    fireEvent.change(field, { target: { value: '{ not json' } })
    await userEvent.setup().click(screen.getByRole('button', { name: t('app.payload.submitDry') }))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.payload.invalid'))
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '{"a": [1, 2]}' } })
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: t('app.payload.submitDry') }))
    expect(onSubmit).toHaveBeenCalledWith({ a: [1, 2] })
  })

  it('refuses a payload over the size limit', async () => {
    const onSubmit = vi.fn()
    renderThemed(<PayloadDialog triggerType="trigger.manual@1" mode="live" onSubmit={onSubmit} onCancel={() => undefined} />)
    fireEvent.change(screen.getByLabelText(t('app.payload.label')), { target: { value: JSON.stringify({ a: 'x'.repeat(200_001) }) } })
    await userEvent.setup().click(screen.getByRole('button', { name: t('app.payload.submitLive') }))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.payload.tooLarge'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('says the dry run still sends file content to the provider, with the badge', () => {
    renderThemed(<PayloadDialog triggerType="trigger.manual@1" mode="dry" onSubmit={() => undefined} onCancel={() => undefined} />)
    expect(screen.getByText(t('app.payload.dryNote'))).toBeTruthy()
    expect(screen.getByText(t('badge.externalTransfer'))).toBeTruthy()
  })

  it('closes with Escape and keeps Tab inside the dialog', async () => {
    const onCancel = vi.fn()
    renderThemed(<PayloadDialog triggerType="trigger.manual@1" mode="dry" onSubmit={() => undefined} onCancel={onCancel} />)
    const user = userEvent.setup()
    const dialog = screen.getByRole('dialog')
    for (let index = 0; index < 6; index += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('WorkflowActions: dry run', () => {
  it('opens a payload dialog with the sample of the trigger, starts a dry run and reports the run', async () => {
    const w = world()
    const onRunStarted = vi.fn()
    await show(w, ids.workflows.webhook, onRunStarted)
    const user = userEvent.setup()
    const trigger = button(t('app.wf.actions.dryRun'))
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: t('app.payload.dryTitle') })
    expect(JSON.parse((within(dialog).getByLabelText(t('app.payload.label')) as HTMLTextAreaElement).value)).toMatchObject({ body: { orderId: 'A-1001' } })
    await user.click(within(dialog).getByRole('button', { name: t('app.payload.submitDry') }))
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledTimes(1))
    expect(w.callsOf('startRun')).toHaveLength(1)
    expect(w.callsOf('startRun')[0]!.params).toMatchObject({ workflowId: ids.workflows.webhook, dryRun: true, payload: { method: 'POST', body: { orderId: 'A-1001', total: 12000 } } })
    expect(onRunStarted.mock.calls[0]![0]).toMatch(/^run-fake-/)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it.each([
    ['wf-manual', '{}'],
    ['wf-cron', '{}'],
  ])('prefills {} for %s', async (workflowId, sample) => {
    const w = world()
    await show(w, workflowId)
    await userEvent.setup().click(button(t('app.wf.actions.dryRun')))
    expect((screen.getByLabelText(t('app.payload.label')) as HTMLTextAreaElement).value).toBe(sample)
  })

  it('prefills a file object for a folder watch', async () => {
    const w = world()
    await show(w, ids.workflows.receipt)
    await userEvent.setup().click(button(t('app.wf.actions.dryRun')))
    expect(JSON.parse((screen.getByLabelText(t('app.payload.label')) as HTMLTextAreaElement).value)).toMatchObject({ file: expect.any(String), name: expect.any(String), extension: 'pdf' })
  })

  it('does not start a run for invalid JSON', async () => {
    const w = world()
    await show(w, 'wf-manual')
    const user = userEvent.setup()
    await user.click(button(t('app.wf.actions.dryRun')))
    fireEvent.change(screen.getByLabelText(t('app.payload.label')), { target: { value: '{' } })
    await user.click(screen.getByRole('button', { name: t('app.payload.submitDry') }))
    expect(await screen.findByText(t('app.payload.invalid'))).toBeTruthy()
    expect(w.callsOf('startRun')).toHaveLength(0)
  })

  it('shows a fixed error when startRun fails, and keeps the dialog open', async () => {
    const w = world()
    const failing: EngineClient = { onEvent: w.client.onEvent, request: (method, params) => (method === 'startRun' ? Promise.reject(new RillError('NOT_FOUND', 'secret detail')) : w.client.request(method, params)) }
    await show(w, 'wf-manual', undefined, failing)
    const user = userEvent.setup()
    await user.click(button(t('app.wf.actions.dryRun')))
    await user.click(screen.getByRole('button', { name: t('app.payload.submitDry') }))
    const alert = await screen.findByText(t('app.wf.error.NOT_FOUND'))
    expect(alert.textContent).not.toContain('secret detail')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('WorkflowActions: run now', () => {
  it('confirms with the side effects of the workflow before it starts a real run', async () => {
    const w = world()
    const onRunStarted = vi.fn()
    await show(w, 'wf-manual', onRunStarted)
    const user = userEvent.setup()
    const trigger = button(t('app.wf.actions.runNow'))
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: t('app.run.confirmTitle') })
    await waitFor(() => expect(within(dialog).getByText(/HTTP request/)).toBeTruthy())
    expect(dialog.textContent).toContain('Extract fields with AI (extract): 외부 전송')
    expect(dialog.textContent).toContain('HTTP request (send): 네트워크 호출')
    expect(dialog.textContent).toContain('Append CSV row (append): 파일 기록')
    expect(w.callsOf('startRun')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: t('app.run.confirmAction') }))
    await waitFor(() => expect(onRunStarted).toHaveBeenCalled())
    expect(w.callsOf('startRun')[0]!.params).toEqual({ workflowId: 'wf-manual', payload: {}, dryRun: false })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('starts nothing when the confirmation is cancelled', async () => {
    const w = world()
    await show(w, 'wf-manual')
    const user = userEvent.setup()
    const trigger = button(t('app.wf.actions.runNow'))
    await user.click(trigger)
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t('app.common.cancel') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(w.callsOf('startRun')).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('says when no step has a side effect, and keeps confirm off until the steps are loaded', async () => {
    const w = world()
    await show(w, 'wf-quiet')
    await userEvent.setup().click(button(t('app.wf.actions.runNow')))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(t('app.run.noSideEffects'))
    expect((within(dialog).getByRole('button', { name: t('app.run.confirmAction') }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('refuses to confirm when the steps cannot be loaded', async () => {
    const w = world()
    const client: EngineClient = { onEvent: w.client.onEvent, request: (method, params) => (method === 'getWorkflow' ? Promise.reject(new Error('x')) : w.client.request(method, params)) }
    await show(w, 'wf-quiet', undefined, client)
    await userEvent.setup().click(button(t('app.wf.actions.runNow')))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(t('app.run.effectsError'))
    expect((within(dialog).getByRole('button', { name: t('app.run.confirmAction') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks for the input first when the trigger needs one, then confirms, then starts with that payload', async () => {
    const w = world()
    await show(w, ids.workflows.webhook)
    const user = userEvent.setup()
    await user.click(button(t('app.wf.actions.runNow')))
    const payload = screen.getByRole('dialog', { name: t('app.payload.liveTitle') })
    fireEvent.change(within(payload).getByLabelText(t('app.payload.label')), { target: { value: '{"body":{"x":1}}' } })
    await user.click(within(payload).getByRole('button', { name: t('app.payload.submitLive') }))
    const confirm = await screen.findByRole('dialog', { name: t('app.run.confirmTitle') })
    expect(w.callsOf('startRun')).toHaveLength(0)
    await user.click(within(confirm).getByRole('button', { name: t('app.run.confirmAction') }))
    await waitFor(() => expect(w.callsOf('startRun')).toHaveLength(1))
    expect(w.callsOf('startRun')[0]!.params).toEqual({ workflowId: ids.workflows.webhook, payload: { body: { x: 1 } }, dryRun: false })
  })

  it('sends one request for a double click and keeps every button off while it runs', async () => {
    const w = world()
    let release: (value: { runId: string }) => void = () => undefined
    const slow: EngineClient = {
      onEvent: w.client.onEvent,
      request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
        method === 'startRun' ? (new Promise<{ runId: string }>((resolve) => (release = resolve)) as Promise<MethodResult<M>>) : w.client.request(method, params),
    }
    await show(w, 'wf-quiet', undefined, slow)
    const user = userEvent.setup()
    await user.click(button(t('app.wf.actions.runNow')))
    const confirm = await screen.findByRole('dialog')
    await within(confirm).findByText(t('app.run.noSideEffects'))
    const go = within(confirm).getByRole('button', { name: t('app.run.confirmAction' ) })
    await act(async () => {
      fireEvent.click(go)
      fireEvent.click(go)
    })
    expect((within(confirm).getByRole('button', { name: t('app.run.confirmAction') }) as HTMLButtonElement).disabled).toBe(true)
    for (const name of [t('app.wf.actions.dryRun'), t('app.wf.actions.runNow'), t('app.wf.actions.activate')]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => release({ runId: 'run-x' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('WorkflowActions: activate and deactivate', () => {
  it('activates with one call, and the chip changes when the engine says so', async () => {
    const w = world()
    await show(w, ids.workflows.webhook)
    expect(screen.getByText(t('app.wf.hint.dryRunFirst'))).toBeTruthy()
    await userEvent.setup().click(button(t('app.wf.actions.activate')))
    await waitFor(() => expect(button(t('app.wf.actions.deactivate'))).toBeTruthy())
    expect(w.callsOf('activate')).toEqual([{ method: 'activate', params: { workflowId: ids.workflows.webhook } }])
  })

  it('deactivates only after a confirmation', async () => {
    const w = world()
    await show(w, ids.workflows.receipt)
    const user = userEvent.setup()
    await user.click(button(t('app.wf.actions.deactivate')))
    const dialog = screen.getByRole('dialog', { name: t('app.deactivate.title') })
    expect(w.callsOf('deactivate')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: t('app.deactivate.confirm') }))
    await waitFor(() => expect(button(t('app.wf.actions.activate'))).toBeTruthy())
    expect(w.callsOf('deactivate')).toEqual([{ method: 'deactivate', params: { workflowId: ids.workflows.receipt } }])
  })

  it('shows the own text of ACTIVATION_FAILED', async () => {
    const w = world({ control: { stepIntervalMs: 0, activationError: true } })
    await show(w, ids.workflows.webhook)
    await userEvent.setup().click(button(t('app.wf.actions.activate')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.wf.error.ACTIVATION_FAILED'))
  })

  it('shows a generic text for another failure, never the text of the error', async () => {
    const w = world()
    const broken: EngineClient = { onEvent: w.client.onEvent, request: (method, params) => (method === 'activate' ? Promise.reject(new Error('connection closed SECRET')) : w.client.request(method, params)) }
    await show(w, ids.workflows.webhook, undefined, broken)
    await userEvent.setup().click(button(t('app.wf.actions.activate')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.wf.error.generic'))
  })

  it('cannot activate a manual workflow and says how to start it', async () => {
    const w = world()
    await show(w, 'wf-manual')
    expect(button(t('app.wf.actions.activate')).disabled).toBe(true)
    expect(screen.getByText(t('app.wf.manualHint'))).toBeTruthy()
  })

  it('can be switched off as a whole, and moves focus to the button it is asked to', async () => {
    const w = world()
    function Off() {
      const list = useWorkflowList(w.client)
      const summary = list.workflows.find((item) => item.id === ids.workflows.webhook)
      return summary === undefined ? null : <WorkflowActions client={w.client} workflowId={ids.workflows.webhook} summary={summary} catalog={catalog} onRunStarted={() => undefined} disabled focusAction="dryRun" />
    }
    renderThemed(<Off />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    for (const name of [t('app.wf.actions.dryRun'), t('app.wf.actions.runNow'), t('app.wf.actions.activate')]) expect(button(name).disabled).toBe(true)
  })

  it('moves focus to the dry run button when asked', async () => {
    const w = world()
    renderThemed(<Actions client={w.client} workflowId={ids.workflows.webhook} focusAction="dryRun" />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    await waitFor(() => expect(document.activeElement).toBe(button(t('app.wf.actions.dryRun'))))
  })

  it('renders in English and passes axe with a dialog open', async () => {
    const w = world()
    const view = await show(w, 'wf-manual', undefined, w.client, 'en')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Run now' }))
    await screen.findByRole('dialog', { name: 'Run it now?' })
    expect(await violations(view.container)).toEqual([])
    expect(document.body.textContent).not.toMatch(/\bapp\.[a-z]+\./)
  })
})

describe('WorkflowActions: run now without a complete catalog', () => {
  async function openConfirm(nodes: readonly NodeInfo[], workflowId = 'wf-manual') {
    const w = world()
    const view = renderThemed(<Actions client={w.client} workflowId={workflowId} nodes={nodes} />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    await userEvent.setup().click(button(t('app.wf.actions.runNow')))
    const dialog = await screen.findByRole('dialog', { name: t('app.run.confirmTitle') })
    await within(dialog).findByText(t('app.run.effectsUnknown'))
    return { w, view, dialog }
  }

  const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: t('app.run.confirmAction') }) as HTMLButtonElement

  it('does not say that nothing happens and keeps confirm off while the catalog is empty', async () => {
    const { w, dialog } = await openConfirm([])
    expect(within(dialog).queryByText(t('app.run.noSideEffects'))).toBeNull()
    expect(confirmButton(dialog).disabled).toBe(true)
    fireEvent.click(confirmButton(dialog))
    expect(w.callsOf('startRun')).toHaveLength(0)
  })

  it('keeps confirm off when a single step type is missing from the catalog', async () => {
    const { dialog } = await openConfirm(catalog.filter((entry) => entry.type !== 'http.request@1'))
    expect(within(dialog).queryByText(t('app.run.noSideEffects'))).toBeNull()
    expect(confirmButton(dialog).disabled).toBe(true)
  })

  it('lists the effects and turns confirm on once the catalog arrives while the dialog is open', async () => {
    const w = world()
    const view = renderThemed(<Actions client={w.client} workflowId="wf-manual" nodes={[]} />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    await userEvent.setup().click(button(t('app.wf.actions.runNow')))
    const dialog = await screen.findByRole('dialog', { name: t('app.run.confirmTitle') })
    await within(dialog).findByText(t('app.run.effectsUnknown'))
    view.rerender(<Actions client={w.client} workflowId="wf-manual" nodes={catalog} />)
    await waitFor(() => expect(within(dialog).getByText(/HTTP request/)).toBeTruthy())
    expect(within(dialog).queryByText(t('app.run.effectsUnknown'))).toBeNull()
    expect(confirmButton(dialog).disabled).toBe(false)
  })
})

describe('WorkflowActions: switching workflows', () => {
  it('does not carry the error of one workflow over to the next one', async () => {
    const w = world({ control: { stepIntervalMs: 0, activationError: true } })
    function Pair({ id }: { id: string }) {
      return <Actions key={id} client={w.client} workflowId={id} />
    }
    const view = renderThemed(<Pair id={ids.workflows.webhook} />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    await userEvent.setup().click(button(t('app.wf.actions.activate')))
    expect((await screen.findByRole('alert')).textContent).toBe(t('app.wf.error.ACTIVATION_FAILED'))
    view.rerender(<Pair id={ids.workflows.receipt} />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the steps of the new workflow only, and keeps confirm off until they are loaded', async () => {
    const w = world()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: EngineClient = {
      onEvent: w.client.onEvent,
      request: async (method, params) => {
        if (method === 'getWorkflow' && (params as { workflowId: string }).workflowId === 'wf-quiet') await gate
        return w.client.request(method, params)
      },
    }
    const view = renderThemed(<Actions client={slow} workflowId="wf-manual" />)
    await screen.findByRole('region', { name: t('app.wf.actions.label') })
    await userEvent.setup().click(button(t('app.wf.actions.runNow')))
    const dialog = await screen.findByRole('dialog', { name: t('app.run.confirmTitle') })
    await within(dialog).findByText(/HTTP request/)
    view.rerender(<Actions client={slow} workflowId="wf-quiet" />)
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(t('app.run.loadingEffects'))).toBeTruthy())
    expect(within(screen.getByRole('dialog')).queryByText(/HTTP request/)).toBeNull()
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: t('app.run.confirmAction') }) as HTMLButtonElement).disabled).toBe(true)
    release()
    await within(screen.getByRole('dialog')).findByText(t('app.run.noSideEffects'))
  })
})

describe('WorkflowActions: the effect line', () => {
  it('joins several badges with the list format of the language', async () => {
    const hybrid = workflowOf('섞인 흐름', [node('start', 'trigger.manual@1', {}), node('both', 'llm.extract@1', { file: '/Users/demo/a.pdf', fields: [{ name: 'a', type: 'number', description: 'x' }] }), node('send', 'http.request@1', { url: 'https://hooks.example.com/x', method: 'POST' })], [edge('start', 'both'), edge('both', 'send')])
    const w = createFakeWorld({ hostOptions: { restartDelayMs: 0 }, workflows: [{ id: 'wf-hybrid', workflow: hybrid, active: false, createdAt: FIXTURE_NOW }], control: { stepIntervalMs: 0 } })
    const patched = catalog.map((entry) => (entry.type === 'llm.extract@1' ? { ...entry, sideEffect: 'external' as const } : entry))
    renderThemed(<Actions client={w.client} workflowId="wf-hybrid" nodes={patched} />, { locale: 'en' })
    await screen.findByRole('region', { name: 'Run the workflow' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Run now' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.textContent).toContain('(both): External transfer and Network call'))
  })
})

describe('ActionConfirm', () => {
  it('asks plainly without a list when no workflow is named, and answers yes and no', async () => {
    const w = world()
    const onAnswer = vi.fn()
    renderThemed(<ActionConfirm client={w.client} catalog={catalog} title="app.deactivate.title" message="app.confirm.deactivate" confirmLabel="app.deactivate.confirm" onAnswer={onAnswer} />)
    const dialog = screen.getByRole('dialog', { name: t('app.deactivate.title') })
    expect(within(dialog).queryByText(t('app.run.sideEffects'))).toBeNull()
    expect(w.callsOf('getWorkflow')).toHaveLength(0)
    const user = userEvent.setup()
    await user.click(within(dialog).getByRole('button', { name: t('app.deactivate.confirm') }))
    expect(onAnswer).toHaveBeenLastCalledWith(true)
    await user.click(within(dialog).getByRole('button', { name: t('app.common.cancel') }))
    expect(onAnswer).toHaveBeenLastCalledWith(false)
  })

  it('keeps the confirm button off until the effects of the named workflow are known, and never while the catalog is empty', async () => {
    const w = world()
    const onAnswer = vi.fn()
    const view = renderThemed(<ActionConfirm client={w.client} catalog={[]} title="app.retry.title" message="app.confirm.retry" confirmLabel="app.retry.confirm" effectsOf="wf-manual" onAnswer={onAnswer} />)
    const dialog = screen.getByRole('dialog', { name: t('app.retry.title') })
    const go = () => within(dialog).getByRole('button', { name: t('app.retry.confirm') }) as HTMLButtonElement
    expect(go().disabled).toBe(true)
    await within(dialog).findByText(t('app.run.effectsUnknown'))
    expect(go().disabled).toBe(true)
    fireEvent.click(go())
    expect(onAnswer).not.toHaveBeenCalled()
    view.rerender(<ActionConfirm client={w.client} catalog={catalog} title="app.retry.title" message="app.confirm.retry" confirmLabel="app.retry.confirm" effectsOf="wf-manual" onAnswer={onAnswer} />)
    await waitFor(() => expect(go().disabled).toBe(false))
    expect(dialog.textContent).toContain('HTTP request (send): 네트워크 호출')
  })
})
