import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { fakeData, FIXTURE_NOW, ids } from '../src/fixtures'
import { ko } from '../src/i18n/ko'
import { Workspace, type WorkspaceProps } from '../src/workspace/Workspace'
import { renderThemed } from './render'

async function loaded(): Promise<void> {
  await waitFor(() => expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0))
}

const historyOf = () => screen.getByRole('region', { name: ko['history.heading'] })
const selectedNode = () => document.querySelector('[data-selected="true"], [aria-pressed="true"]')

function show(props: Partial<WorkspaceProps> = {}, workflowId = ids.workflows.receipt) {
  return renderThemed(<Workspace client={createFakeClient(fakeData)} workflowId={workflowId} now={FIXTURE_NOW} timeZone="UTC" {...props} />)
}

describe('Workspace with optional controlled props', () => {
  it('reports a clicked node and a picked run through the callbacks while still working on its own', async () => {
    const onSelectNode = vi.fn()
    const onSelectRun = vi.fn()
    show({ onSelectNode, onSelectRun })
    await loaded()
    fireEvent.click(screen.getByTestId('rf__node-extract'))
    expect(onSelectNode).toHaveBeenCalledWith('extract')
    expect(screen.getByRole('heading', { name: 'Extract fields with AI', level: 3 })).toBeTruthy()
    await waitFor(() => expect(within(historyOf()).getAllByRole('button').length).toBeGreaterThan(0))
    fireEvent.click(within(historyOf()).getAllByRole('button')[0]!)
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(typeof onSelectRun.mock.calls[0]![0]).toBe('string')
    expect(within(historyOf()).getAllByRole('button').some((button) => button.getAttribute('aria-current') === 'true')).toBe(true)
  })

  it('is driven by selectedNodeId when it is given: a click only asks, the parent decides', async () => {
    const onSelectNode = vi.fn()
    function Parent() {
      const [node, setNode] = useState<string | undefined>('watch')
      return (
        <>
          <button type="button" onClick={() => setNode('append')}>
            parent picks append
          </button>
          <button type="button" onClick={() => setNode(undefined)}>
            parent clears
          </button>
          <Workspace
            client={createFakeClient(fakeData)}
            workflowId={ids.workflows.receipt}
            now={FIXTURE_NOW}
            selectedNodeId={node}
            onSelectNode={(next) => {
              onSelectNode(next)
            }}
          />
        </>
      )
    }
    renderThemed(<Parent />)
    await loaded()
    expect(screen.getByRole('heading', { name: 'Folder watch', level: 3 })).toBeTruthy()
    fireEvent.click(screen.getByTestId('rf__node-extract'))
    expect(onSelectNode).toHaveBeenCalledWith('extract')
    expect(screen.getByRole('heading', { name: 'Folder watch', level: 3 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Extract fields with AI', level: 3 })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'parent picks append' }))
    expect(await screen.findByRole('heading', { name: 'Append CSV row', level: 3 })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'parent clears' }))
    await waitFor(() => expect(screen.queryByRole('heading', { level: 3 })).toBeNull())
    expect(selectedNode()).toBeNull()
  })

  it('is driven by selectedRunId when it is given', async () => {
    const onSelectRun = vi.fn()
    function Parent() {
      const [run, setRun] = useState<string | undefined>(undefined)
      return (
        <>
          <button type="button" onClick={() => setRun(ids.runs.receiptFailed)}>
            parent picks failed
          </button>
          <Workspace client={createFakeClient(fakeData)} workflowId={ids.workflows.receipt} now={FIXTURE_NOW} selectedRunId={run} onSelectRun={onSelectRun} />
        </>
      )
    }
    renderThemed(<Parent />)
    await loaded()
    await waitFor(() => expect(within(historyOf()).getAllByRole('button').length).toBeGreaterThan(1))
    fireEvent.click(within(historyOf()).getAllByRole('button')[1]!)
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(within(historyOf()).queryAllByRole('button').some((button) => button.getAttribute('aria-current') === 'true')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'parent picks failed' }))
    await waitFor(() => expect(within(historyOf()).getAllByRole('button').some((button) => button.getAttribute('aria-current') === 'true')).toBe(true))
  })

  it('gives renderInspectorExtra the open run and its steps, and shows what it returns in the inspector area', async () => {
    const seen: Array<{ workflowId: string | undefined; nodeId: string | undefined; runId: string | undefined; steps: number }> = []
    show({
      selectedRunId: ids.runs.receiptFailed,
      onSelectRun: () => undefined,
      renderInspectorExtra: (context) => {
        seen.push({ workflowId: context.workflowId, nodeId: context.nodeId, runId: context.run?.id, steps: context.steps.length })
        return <p data-testid="extra">extra for {context.run?.id}</p>
      },
    })
    await loaded()
    await waitFor(() => expect(seen.some((item) => item.runId === ids.runs.receiptFailed && item.steps > 0)).toBe(true))
    expect(screen.getByTestId('extra').textContent).toBe(`extra for ${ids.runs.receiptFailed}`)
    expect(screen.getByTestId('extra').closest('[class*="inspector"]')).toBeTruthy()
    expect(screen.getByRole('heading', { name: ko['inspector.heading'] })).toBeTruthy()
    expect(seen[0]!.workflowId).toBe(ids.workflows.receipt)
  })

  it('shows nothing extra when renderInspectorExtra returns null, with the same markup as without the prop', async () => {
    const plain = show()
    await loaded()
    const before = plain.container.querySelector('[class*="inspector"]')!.innerHTML
    plain.unmount()
    const withNull = show({ renderInspectorExtra: () => null })
    await loaded()
    expect(withNull.container.querySelector('[class*="inspector"]')!.innerHTML).toBe(before)
  })

  it('calls renderRunActions only for the selected run, and shows its result under the history', async () => {
    const renderRunActions = vi.fn((run: { id: string }) => <button type="button">act on {run.id}</button>)
    show({ renderRunActions })
    await loaded()
    expect(renderRunActions).not.toHaveBeenCalled()
    await waitFor(() => expect(within(historyOf()).getAllByRole('button').length).toBeGreaterThan(0))
    fireEvent.click(within(historyOf()).getAllByRole('button')[0]!)
    const run = (await screen.findByRole('button', { name: /^act on / })).textContent!.replace('act on ', '')
    expect(renderRunActions).toHaveBeenCalled()
    expect(renderRunActions.mock.calls.at(-1)![0]).toMatchObject({ id: run, workflowId: ids.workflows.receipt })
  })

  it('keeps the default behaviour for the starting selection props', async () => {
    show({ initialNodeId: 'extract' })
    await loaded()
    expect(screen.getByRole('heading', { name: 'Extract fields with AI', level: 3 })).toBeTruthy()
  })
})
