import type { MethodName, MethodParams, MethodResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { fakeData, FIXTURE_NOW, ids } from '../src/fixtures'
import { liveFakeData, liveIds, branchingEvents } from '../src/fixtures/live'
import { ko } from '../src/i18n/ko'
import { Workspace } from '../src/workspace/Workspace'
import { renderThemed } from './render'

const status = (nodeId: string) => screen.getByTestId(`rf__node-${nodeId}`).querySelector('[data-status]')!.getAttribute('data-status')

async function loaded(firstNodeId: string, edgeCount: number): Promise<void> {
  await waitFor(() => expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(edgeCount))
  expect(screen.getByTestId(`rf__node-${firstNodeId}`)).toBeTruthy()
}

function manualScheduler() {
  const queue: Array<() => void> = []
  return {
    schedule: (fn: () => void) => {
      queue.push(fn)
    },
    step: () => queue.shift()?.(),
    pending: () => queue.length,
  }
}

function show(client: EngineClient, workflowId: string | undefined, extra: { initialRunId?: string; initialNodeId?: string } = {}) {
  return renderThemed(<Workspace client={client} workflowId={workflowId} now={FIXTURE_NOW} timeZone="UTC" {...extra} />)
}

describe('Workspace', () => {
  it('shows a loading message, then the graph, the inspector and the history of the workflow', async () => {
    show(createFakeClient(fakeData), ids.workflows.receipt)
    expect(screen.getByText(ko['workspace.loading'])).toBeTruthy()
    await loaded('watch', 2)
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: ko['inspector.heading'] })).toBeTruthy()
    expect(screen.getByRole('heading', { name: ko['history.heading'] })).toBeTruthy()
    await waitFor(() => expect(within(screen.getByRole('region', { name: ko['history.heading'] })).getAllByRole('button')).toHaveLength(4))
  })

  it('lists only the runs of its own workflow', async () => {
    show(createFakeClient(fakeData), ids.workflows.webhook)
    await loaded('hook', 2)
    await waitFor(() => expect(within(screen.getByRole('region', { name: ko['history.heading'] })).getAllByRole('button')).toHaveLength(3))
  })

  it('shows the states of a run on the graph when the person picks it in the history', async () => {
    show(createFakeClient(fakeData), ids.workflows.branching)
    await loaded('check', 4)
    expect(status('check')).toBe('idle')
    const history = await screen.findByRole('region', { name: ko['history.heading'] })
    await waitFor(() => expect(within(history).getAllByRole('button')).toHaveLength(3))
    const skipped = within(history).getAllByRole('button').find((button) => button.textContent!.includes('1시간 전'))!
    fireEvent.click(skipped)
    await waitFor(() => expect(status('alert')).toBe('skipped'))
    expect(status('check')).toBe('succeeded')
    expect(status('log')).toBe('succeeded')
    expect(skipped.getAttribute('aria-current')).toBe('true')
  })

  it('fills the inspector with the node the person clicks, and with the input and output of the open run', async () => {
    show(createFakeClient(fakeData), ids.workflows.receipt, { initialRunId: ids.runs.receiptOk })
    await loaded('watch', 2)
    await waitFor(() => expect(status('extract')).toBe('succeeded'))
    expect(screen.getByText(ko['inspector.empty'])).toBeTruthy()
    fireEvent.click(screen.getByTestId('rf__node-extract'))
    const inspector = await screen.findByRole('complementary', { name: ko['inspector.heading'] })
    await waitFor(() => expect(inspector.textContent).toContain('Cafe Mori'))
    expect(within(inspector).getByRole('heading', { name: 'Extract fields with AI' })).toBeTruthy()
    expect(screen.getByTestId('rf__node-extract').querySelector('[role="treeitem"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('starts with a node selected when asked to', async () => {
    show(createFakeClient(fakeData), ids.workflows.receipt, { initialRunId: ids.runs.receiptFailed, initialNodeId: 'extract' })
    await loaded('watch', 2)
    const inspector = await screen.findByRole('complementary', { name: ko['inspector.heading'] })
    await waitFor(() => expect(within(inspector).getAllByText(/번째 시도/).length).toBeGreaterThanOrEqual(3))
  })

  it('updates the node cards while the open run is played live', async () => {
    const fake = createFakeClient(liveFakeData())
    show(fake, ids.workflows.branching, { initialRunId: liveIds.branching })
    await loaded('check', 4)
    await waitFor(() => expect(status('schedule')).toBe('idle'))
    const scheduler = manualScheduler()
    fake.play(liveIds.branching, branchingEvents(liveIds.branching), scheduler.schedule, 1)
    act(() => scheduler.step())
    expect(status('check')).toBe('idle')
    while (scheduler.pending() > 0) act(() => scheduler.step())
    await waitFor(() => expect(status('check')).toBe('continued'))
    expect(status('healthy')).toBe('succeeded')
    expect(status('log')).toBe('skipped')
    expect(status('alert')).toBe('succeeded')
    expect(status('schedule')).toBe('succeeded')
  })

  it('shows a node as running and retrying in the middle of a live run', async () => {
    const fake = createFakeClient(liveFakeData())
    show(fake, ids.workflows.branching, { initialRunId: liveIds.branching })
    await loaded('check', 4)
    const scheduler = manualScheduler()
    const events = branchingEvents(liveIds.branching)
    fake.play(liveIds.branching, events, scheduler.schedule, 1)
    const until = events.findIndex((event) => event.type === 'step.failed')
    for (let index = 0; index <= until; index += 1) act(() => scheduler.step())
    await waitFor(() => expect(status('check')).toBe('running'))
    expect(within(screen.getByTestId('rf__node-check')).getByText(ko['node.retrying'])).toBeTruthy()
  })

  it('shows a localized message when the workflow cannot be loaded', async () => {
    show(createFakeClient(fakeData), 'missing')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(ko['workspace.loadError'].replace('{message}', 'workflow not found: missing'))
  })

  it('shows a localized message when the open run cannot be loaded', async () => {
    show(createFakeClient(fakeData), ids.workflows.receipt, { initialRunId: 'run-gone' })
    await loaded('watch', 2)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(ko['workspace.loadError'].replace('{message}', 'run not found: run-gone'))
  })

  it('shows a localized message when the engine rejects a request', async () => {
    const inner = createFakeClient(fakeData)
    const client: EngineClient = {
      request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> =>
        method === 'listRuns' ? Promise.reject(new Error('socket closed')) : inner.request(method, params),
      onEvent: (listener) => inner.onEvent(listener),
    }
    show(client, ids.workflows.receipt)
    await loaded('watch', 2)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(ko['workspace.loadError'].replace('{message}', 'socket closed'))
  })

  it('shows the empty message and an empty history when there is no workflow', () => {
    show(createFakeClient({ workflows: [], runs: [], steps: {}, catalog: [] }), undefined)
    expect(screen.getByText(ko['graph.empty'])).toBeTruthy()
    expect(screen.getByText(ko['history.empty'])).toBeTruthy()
    expect(screen.getByText(ko['inspector.empty'])).toBeTruthy()
  })

  it('starts fresh when the workflow changes', async () => {
    const client = createFakeClient(fakeData)
    const view = show(client, ids.workflows.receipt, { initialRunId: ids.runs.receiptOk })
    await loaded('watch', 2)
    await waitFor(() => expect(status('extract')).toBe('succeeded'))
    view.rerender(<Workspace client={client} workflowId={ids.workflows.webhook} now={FIXTURE_NOW} timeZone="UTC" />)
    await waitFor(() => expect(screen.getByTestId('rf__node-hook')).toBeTruthy())
    expect(screen.queryByTestId('rf__node-extract')).toBeNull()
    expect(status('hook')).toBe('idle')
    expect(screen.getByText(ko['inspector.empty'])).toBeTruthy()
  })

  it('shows a trigger of an open run as succeeded in the inspector too, with the note that triggers record no data', async () => {
    show(createFakeClient(fakeData), ids.workflows.receipt, { initialRunId: ids.runs.receiptOk })
    await loaded('watch', 2)
    await waitFor(() => expect(status('watch')).toBe('succeeded'))
    fireEvent.click(screen.getByTestId('rf__node-watch'))
    const inspector = await screen.findByRole('complementary', { name: ko['inspector.heading'] })
    await waitFor(() => expect(within(inspector).getByText(ko['inspector.triggerNoData'])).toBeTruthy())
    expect(within(inspector).getByText(ko['status.succeeded'])).toBeTruthy()
  })

  it('shows hostile run data as text only', async () => {
    show(createFakeClient(fakeData), ids.workflows.receipt, { initialRunId: ids.runs.receiptHostile, initialNodeId: 'extract' })
    await loaded('watch', 2)
    const inspector = await screen.findByRole('complementary', { name: ko['inspector.heading'] })
    await waitFor(() => expect(inspector.textContent).toContain('<img src=x onerror="window.__pwned = 1">'))
    expect(document.querySelector('img, script, a[href^="javascript"]')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
  })
})
