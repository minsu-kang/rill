import { isTrigger, type Workflow } from '@rill/dsl'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { catalog, fixtureSteps, ids, workflows } from '../src/fixtures'
import { branchingWorkflow, edge, node, workflowOf } from '../src/fixtures/workflows'
import { WorkflowGraph } from '../src/graph/WorkflowGraph'
import { ko } from '../src/i18n/ko'
import { NO_STATES, type RunStates } from '../src/model/status'
import { statesFromSteps } from '../src/model/steps'
import { renderThemed } from './render'

function Harness({ workflow, states = NO_STATES, onSelect }: { workflow: Workflow; states?: RunStates; onSelect?: (id: string | undefined) => void }) {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  return (
    <div style={{ width: 900, height: 600 }}>
      <WorkflowGraph
        workflow={workflow}
        catalog={catalog}
        states={states}
        selectedNodeId={selected}
        onSelect={(id) => {
          setSelected(id)
          onSelect?.(id)
        }}
      />
    </div>
  )
}

async function ready(container: HTMLElement, edgeCount: number): Promise<void> {
  await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(edgeCount))
}

describe('WorkflowGraph', () => {
  it('renders one card per node and one label per edge that has a when', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    expect(screen.getAllByRole('treeitem')).toHaveLength(branchingWorkflow.nodes.length)
    const labels = [...container.querySelectorAll('.react-flow__edge-text')].map((label) => label.textContent)
    expect(labels.sort()).toEqual(['false', 'true'])
  })

  it('draws the states of a run on the cards, with a fired trigger when a run is open', async () => {
    const states = statesFromSteps(fixtureSteps[ids.runs.branchingContinued]!)
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} states={states} />)
    await ready(container, branchingWorkflow.edges.length)
    const status = (nodeId: string) => screen.getByTestId(`rf__node-${nodeId}`).querySelector('[data-status]')!.getAttribute('data-status')
    expect(status('check')).toBe('continued')
    expect(status('healthy')).toBe('succeeded')
    expect(status('log')).toBe('skipped')
    expect(status('alert')).toBe('succeeded')
    expect(isTrigger(branchingWorkflow.nodes[0]!.type)).toBe(true)
    expect(status('schedule')).toBe('succeeded')
  })

  it('shows every card as waiting when no run is open', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    for (const item of branchingWorkflow.nodes) {
      expect(screen.getByTestId(`rf__node-${item.id}`).querySelector('[data-status]')!.getAttribute('data-status')).toBe('idle')
    }
  })

  it('calls onSelect with the node id on click and marks that card selected', async () => {
    const onSelect = vi.fn()
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} onSelect={onSelect} />)
    await ready(container, branchingWorkflow.edges.length)
    fireEvent.click(screen.getByTestId('rf__node-check'))
    expect(onSelect).toHaveBeenLastCalledWith('check')
    await waitFor(() => expect(screen.getByTestId('rf__node-check').querySelector('[role="treeitem"]')!.getAttribute('aria-selected')).toBe('true'))
    fireEvent.click(screen.getByTestId('rf__node-alert'))
    expect(onSelect).toHaveBeenLastCalledWith('alert')
    await waitFor(() => expect(screen.getByTestId('rf__node-check').querySelector('[role="treeitem"]')!.getAttribute('aria-selected')).toBe('false'))
  })

  it('calls onSelect on Enter and on Space for a focused card', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} onSelect={onSelect} />)
    await ready(container, branchingWorkflow.edges.length)
    const card = screen.getByTestId('rf__node-healthy')
    expect(card.getAttribute('tabindex')).toBe('0')
    act(() => card.focus())
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith('healthy')
    const other = screen.getByTestId('rf__node-log')
    act(() => other.focus())
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenLastCalledWith('log')
  })

  it('clears the selection on a click on the empty canvas and on Escape', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} onSelect={onSelect} />)
    await ready(container, branchingWorkflow.edges.length)
    fireEvent.click(screen.getByTestId('rf__node-check'))
    expect(onSelect).toHaveBeenLastCalledWith('check')
    fireEvent.click(container.querySelector('.react-flow__pane')!)
    expect(onSelect).toHaveBeenLastCalledWith(undefined)
    fireEvent.click(screen.getByTestId('rf__node-check'))
    act(() => screen.getByTestId('rf__node-check').focus())
    await user.keyboard('{Escape}')
    expect(onSelect).toHaveBeenLastCalledWith(undefined)
  })

  it('is read-only: nothing can be dragged, connected or deleted', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} onSelect={onSelect} />)
    await ready(container, branchingWorkflow.edges.length)
    expect(container.querySelectorAll('.react-flow__node.draggable')).toHaveLength(0)
    expect(container.querySelectorAll('.react-flow__handle.connectable')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('rf__node-check'))
    await user.keyboard('{Delete}')
    await user.keyboard('{Backspace}')
    expect(screen.getAllByRole('treeitem')).toHaveLength(branchingWorkflow.nodes.length)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(branchingWorkflow.edges.length)
    expect(container.querySelectorAll('.react-flow__edge.selectable')).toHaveLength(0)
  })

  it('gives the zoom controls localized names in Korean and in English', async () => {
    const first = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(first.container, branchingWorkflow.edges.length)
    for (const name of [ko['graph.zoomIn'], ko['graph.zoomOut'], ko['graph.fitView']]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByRole('region', { name: ko['graph.label'] })).toBeTruthy()
    first.unmount()
    const second = renderThemed(<Harness workflow={branchingWorkflow} />, { locale: 'en' })
    await ready(second.container, branchingWorkflow.edges.length)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fit to view' })).toBeTruthy()
  })

  it('describes the keyboard use of a card in the current language and never mentions deleting', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    const describedBy = screen.getByTestId('rf__node-check').getAttribute('aria-describedby')!
    const hint = document.getElementById(describedBy)!
    expect(hint.textContent).toBe(ko['graph.nodeHint'])
    expect(container.textContent).not.toMatch(/delete|remove/i)
  })

  it('ignores an edge to an unknown node and renders a node without a catalog entry', async () => {
    const odd = workflowOf(
      'odd',
      [node('a', 'trigger.manual@1', {}), node('b', 'mystery.node@1', {})],
      [edge('a', 'b'), edge('a', 'ghost'), edge('ghost', 'b', 'x')],
    )
    const { container } = renderThemed(<Harness workflow={odd} />)
    await ready(container, 1)
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    expect(container.querySelectorAll('.react-flow__edge-text')).toHaveLength(0)
  })

  it('shows an empty message for a workflow with no nodes', () => {
    const empty = { schemaVersion: 1, name: 'empty', nodes: [], edges: [] } as Workflow
    renderThemed(<Harness workflow={empty} />)
    expect(screen.getByText(ko['graph.empty'])).toBeTruthy()
  })

  it('renders the three fixture workflows with their fixture runs without errors', async () => {
    for (const [name, workflow] of Object.entries(workflows)) {
      const { container, unmount } = renderThemed(<Harness workflow={workflow} />)
      await ready(container, workflow.edges.length)
      expect(screen.getAllByRole('treeitem'), name).toHaveLength(workflow.nodes.length)
      unmount()
    }
  })

  it('shows the card of a hostile status text only as text', async () => {
    const hostile = workflowOf('<img src=x onerror=alert(1)>', [node('a', 'trigger.manual@1', {}), node('b', 'transform@1', {})], [edge('a', 'b', '<script>x</script>')])
    const { container } = renderThemed(<Harness workflow={hostile} />)
    await ready(container, 1)
    expect(container.querySelector('script, img')).toBeNull()
    expect(container.querySelector('.react-flow__edge-text')!.textContent).toBe('<script>x</script>')
  })

  it('has no handle that screen readers can reach', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    const handles = [...container.querySelectorAll('.react-flow__handle')]
    expect(handles.length).toBeGreaterThan(0)
    for (const handle of handles) expect(handle.getAttribute('aria-hidden')).toBe('true')
  })
})
