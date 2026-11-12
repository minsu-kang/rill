import { isTrigger, type Workflow } from '@rill/dsl'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { catalog, fixtureSteps, ids, workflows } from '../src/fixtures'
import { branchingWorkflow, edge, node, workflowOf } from '../src/fixtures/workflows'
import { WorkflowGraph } from '../src/graph/WorkflowGraph'
import { ko } from '../src/i18n/ko'
import { NO_STATES, NODE_STATUSES, withState, type NodeStatus, type RunStates } from '../src/model/status'
import { statesFromSteps } from '../src/model/steps'
import { violations } from './axe'
import { errorsDuring } from './errors'
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
    expect(screen.getAllByRole('button', { name: /\(.+\), / })).toHaveLength(branchingWorkflow.nodes.length)
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
    await waitFor(() => expect(screen.getByTestId('rf__node-check').getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(screen.getByTestId('rf__node-alert'))
    expect(onSelect).toHaveBeenLastCalledWith('alert')
    await waitFor(() => expect(screen.getByTestId('rf__node-check').getAttribute('aria-pressed')).toBe('false'))
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
    expect(screen.getAllByRole('button', { name: /\(.+\), / })).toHaveLength(branchingWorkflow.nodes.length)
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
    expect(screen.getAllByRole('button', { name: /\(.+\), / })).toHaveLength(2)
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
      expect(screen.getAllByRole('button', { name: /\(.+\), / }), name).toHaveLength(workflow.nodes.length)
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

  it('has no accessibility violation with a selected card and the states of a run', async () => {
    const states = statesFromSteps(fixtureSteps[ids.runs.branchingContinued]!)
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} states={states} />)
    await ready(container, branchingWorkflow.edges.length)
    fireEvent.click(screen.getByTestId('rf__node-check'))
    await waitFor(() => expect(screen.getByTestId('rf__node-check').getAttribute('aria-pressed')).toBe('true'))
    expect(await violations(container)).toEqual([])
  })

  it('exposes the selection of a card as a pressed button named with its title, id and status', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    const check = screen.getByTestId('rf__node-check')
    expect(check.getAttribute('role')).toBe('button')
    expect(check.getAttribute('aria-pressed')).toBe('false')
    expect(check.getAttribute('aria-label')).toBe('HTTP request (check), 대기')
    expect(container.querySelector('[role="treeitem"], [aria-selected]')).toBeNull()
    fireEvent.click(check)
    await waitFor(() => expect(check.getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('rf__node-alert').getAttribute('aria-pressed')).toBe('false')
  })

  it('names every connection in the current language, with its condition, and never in the default English', async () => {
    const first = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(first.container, branchingWorkflow.edges.length)
    const labels = (container: HTMLElement) => [...container.querySelectorAll('.react-flow__edge')].map((item) => item.getAttribute('aria-label'))
    expect(labels(first.container)).toEqual([
      'schedule에서 check까지 연결',
      'check에서 healthy까지 연결',
      'healthy에서 log까지 연결, 조건 true',
      'healthy에서 alert까지 연결, 조건 false',
    ])
    first.unmount()
    const second = renderThemed(<Harness workflow={branchingWorkflow} />, { locale: 'en' })
    await ready(second.container, branchingWorkflow.edges.length)
    expect(labels(second.container)).toEqual([
      'Connection from schedule to check',
      'Connection from check to healthy',
      'Connection from healthy to log, when true',
      'Connection from healthy to alert, when false',
    ])
    expect(second.container.querySelector('[aria-label^="Edge from"]')).toBeNull()
  })

  it('shortens a long id or condition in the name of a connection', async () => {
    const longId = `n${'x'.repeat(80)}`
    const long = workflowOf('long', [node('a', 'trigger.manual@1', {}), node(longId, 'transform@1', {})], [edge('a', longId, 'w'.repeat(80))])
    const { container } = renderThemed(<Harness workflow={long} />, { locale: 'en' })
    await ready(container, 1)
    const label = container.querySelector('.react-flow__edge')!.getAttribute('aria-label')!
    expect(label).toBe(`Connection from a to n${'x'.repeat(30)}…, when ${'w'.repeat(23)}…`)
  })
})

describe('WorkflowGraph edges and states', () => {
  const trigger = node('a', 'trigger.manual@1', {})
  const action = node('b', 'transform@1', {})
  const chain = workflowOf('chain', [trigger, action], [edge('a', 'b')])
  const done = { status: 'succeeded', attempt: 1, retrying: false, error: null } as const
  const FLOWING: NodeStatus[] = ['running', 'succeeded', 'failed', 'abandoned', 'continued']

  function pathOf(container: HTMLElement, index = 0): SVGPathElement {
    return container.querySelectorAll('.react-flow__edge')[index]!.querySelector('.react-flow__edge-path') as SVGPathElement
  }

  it('points the arrow of every edge at a marker that exists in the page', async () => {
    const states = withState(withState(NO_STATES, 'check', done), 'healthy', { ...done, status: 'running' })
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} states={states} />)
    await ready(container, branchingWorkflow.edges.length)
    for (const path of container.querySelectorAll('.react-flow__edge-path')) {
      const reference = path.getAttribute('marker-end')!
      const id = /^url\('#([^']+)'\)$/.exec(reference)?.[1]
      expect(id, reference).toBeDefined()
      expect(document.getElementById(id!), reference).not.toBeNull()
    }
  })

  it('draws the edge to each target status the way the status asks for', async () => {
    for (const status of NODE_STATUSES) {
      const { container, unmount } = renderThemed(<Harness workflow={chain} states={withState(NO_STATES, 'b', { ...done, status })} />)
      await ready(container, 1)
      const path = pathOf(container)
      const active = FLOWING.includes(status)
      const style = path.getAttribute('style') ?? ''
      expect(style, `${status} color`).toContain(`stroke: var(--edge-${active ? 'active' : 'default'})`)
      expect(style, `${status} width`).toContain(`stroke-width: ${active ? 2 : 1.5}`)
      expect(style.includes('stroke-dasharray: 4 4'), `${status} dash`).toBe(status === 'skipped')
      expect(path.getAttribute('marker-end'), `${status} arrow`).toMatch(active ? /-active'\)$/ : /-idle'\)$/)
      unmount()
    }
  })

  it('draws the edge to a node that has no state as idle', async () => {
    const { container } = renderThemed(<Harness workflow={chain} states={withState(NO_STATES, 'a', done)} />)
    await ready(container, 1)
    expect(pathOf(container).getAttribute('style')).toContain('stroke: var(--edge-default)')
    expect(pathOf(container).getAttribute('marker-end')).toMatch(/-idle'\)$/)
  })

  it('cuts the condition of an edge at 24 characters and not sooner', async () => {
    const whole = renderThemed(<Harness workflow={workflowOf('w', [trigger, action], [edge('a', 'b', 'w'.repeat(24))])} />)
    await ready(whole.container, 1)
    expect(whole.container.querySelector('.react-flow__edge-text')!.textContent).toBe('w'.repeat(24))
    whole.unmount()
    const cut = renderThemed(<Harness workflow={workflowOf('w', [trigger, action], [edge('a', 'b', 'w'.repeat(25))])} />)
    await ready(cut.container, 1)
    expect(cut.container.querySelector('.react-flow__edge-text')!.textContent).toBe(`${'w'.repeat(23)}…`)
  })

  it('cannot focus an edge', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    expect(container.querySelectorAll('.react-flow__edge[tabindex]')).toHaveLength(0)
    expect(container.querySelectorAll('.react-flow__edge[role="img"]')).toHaveLength(branchingWorkflow.edges.length)
  })

  it('can be clicked, cleared and driven by the keyboard without a selection handler', async () => {
    const user = userEvent.setup()
    const { container } = renderThemed(
      <div style={{ width: 900, height: 600 }}>
        <WorkflowGraph workflow={branchingWorkflow} catalog={catalog} states={NO_STATES} />
      </div>,
    )
    await ready(container, branchingWorkflow.edges.length)
    const seen = errorsDuring(() => {
      fireEvent.click(screen.getByTestId('rf__node-check'))
      fireEvent.click(container.querySelector('.react-flow__pane')!)
    })
    act(() => screen.getByTestId('rf__node-check').focus())
    const more = errorsDuring(() => {
      void user.keyboard('{Enter}{Escape}')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect([...seen, ...more]).toEqual([])
  })

  it('cuts the title in the name of a card at 40 characters and not sooner', async () => {
    const named = (title: string) => catalog.map((entry) => (entry.type === 'http.request@1' ? { ...entry, title } : entry))
    const render = (title: string) =>
      renderThemed(
        <div style={{ width: 900, height: 600 }}>
          <WorkflowGraph workflow={branchingWorkflow} catalog={named(title)} states={NO_STATES} />
        </div>,
      )
    const whole = render('T'.repeat(40))
    await ready(whole.container, branchingWorkflow.edges.length)
    expect(screen.getByTestId('rf__node-check').getAttribute('aria-label')).toBe(`${'T'.repeat(40)} (check), 대기`)
    whole.unmount()
    const cut = render('T'.repeat(41))
    await ready(cut.container, branchingWorkflow.edges.length)
    expect(screen.getByTestId('rf__node-check').getAttribute('aria-label')).toBe(`${'T'.repeat(39)}… (check), 대기`)
  })

  it('draws a node that appears twice once and warns about nothing', async () => {
    const twice = workflowOf('twice', [trigger, action, action], [edge('a', 'b')])
    let container!: HTMLElement
    const seen = errorsDuring(() => {
      container = renderThemed(<Harness workflow={twice} />).container
    })
    await ready(container, 1)
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2)
    expect(seen).toEqual([])
  })

  it('draws an edge with one unknown end not at all and warns about nothing', async () => {
    const odd = workflowOf('odd', [trigger, action], [edge('a', 'b'), edge('a', 'ghost'), edge('ghost', 'b')])
    let container!: HTMLElement
    const seen = errorsDuring(() => {
      container = renderThemed(<Harness workflow={odd} />).container
    })
    await ready(container, 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(seen).toEqual([])
  })

  it('draws the cards again when the structure changes and keeps them when only the states change', async () => {
    const view = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(view.container, branchingWorkflow.edges.length)
    const first = screen.getByTestId('rf__node-check')
    view.rerender(<Harness workflow={branchingWorkflow} states={withState(NO_STATES, 'check', done)} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-check').querySelector('[data-status="succeeded"]')).not.toBeNull())
    expect(screen.getByTestId('rf__node-check')).toBe(first)
    const fewerEdges = { ...branchingWorkflow, edges: branchingWorkflow.edges.slice(0, 3) }
    view.rerender(<Harness workflow={fewerEdges} />)
    await ready(view.container, 3)
    const second = screen.getByTestId('rf__node-check')
    expect(second).not.toBe(first)
    const moreNodes = { ...fewerEdges, nodes: [...fewerEdges.nodes, node('extra', 'transform@1', {})] }
    view.rerender(<Harness workflow={moreNodes} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-extra')).toBeTruthy())
    expect(screen.getByTestId('rf__node-check')).not.toBe(second)
  })

  it('describes cards and connections for a screen reader in the current language', async () => {
    const { container } = renderThemed(<Harness workflow={branchingWorkflow} />)
    await ready(container, branchingWorkflow.edges.length)
    expect(container.querySelector('[id^="react-flow__node-desc"]')!.textContent).toBe(ko['graph.nodeHint'])
    expect(container.querySelector('[id^="react-flow__edge-desc"]')!.textContent).toBe(ko['graph.edgeHint'])
    expect(container.querySelector('[id^="react-flow__aria-live"]')!.textContent).toBe('')
    expect(container.querySelector('.react-flow__controls')!.getAttribute('aria-label')).toBe(ko['graph.controls'])
  })

  it('names the empty graph as a region too', () => {
    const empty = { schemaVersion: 1, name: 'empty', nodes: [], edges: [] } as Workflow
    renderThemed(<Harness workflow={empty} />)
    expect(screen.getByRole('region', { name: ko['graph.label'] })).toBeTruthy()
  })
})
