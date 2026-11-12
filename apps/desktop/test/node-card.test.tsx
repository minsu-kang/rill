import type { WorkflowNode } from '@rill/dsl'
import type { NodeInfo } from '@rill/protocol'
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { catalog } from '../src/fixtures'
import { NodeCard } from '../src/graph/NodeCard'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { NODE_STATUSES, type NodeRunState, type NodeStatus } from '../src/model/status'
import { renderThemed } from './render'

const info = (type: string): NodeInfo => catalog.find((entry) => entry.type === type)!
const extract: WorkflowNode = { id: 'extract', type: 'llm.extract@1', config: {} }
const append: WorkflowNode = { id: 'append', type: 'csv.append@1', config: {} }
const request: WorkflowNode = { id: 'check', type: 'http.request@1', config: {} }
const transform: WorkflowNode = { id: 'shape', type: 'transform@1', config: {} }

const state = (status: NodeStatus, extra: Partial<NodeRunState> = {}): NodeRunState => ({
  status,
  attempt: 1,
  retrying: false,
  error: null,
  ...extra,
})

describe('NodeCard', () => {
  it('shows the localized status text and a named icon for each of the seven statuses', () => {
    for (const status of NODE_STATUSES) {
      const { unmount } = renderThemed(<NodeCard node={transform} info={info('transform@1')} state={state(status)} selected={false} />)
      const label = ko[`status.${status}`]
      expect(screen.getByText(label)).toBeTruthy()
      expect(screen.getByRole('img', { name: label })).toBeTruthy()
      unmount()
    }
  })

  it('shows English labels when the language is English', () => {
    renderThemed(<NodeCard node={transform} info={info('transform@1')} state={state('failed')} selected={false} />, { locale: 'en' })
    expect(screen.getByText(en['status.failed'])).toBeTruthy()
  })

  it('shows no attempt for a card without a state and shows the second attempt', () => {
    const first = renderThemed(<NodeCard node={transform} info={info('transform@1')} state={undefined} selected={false} />)
    expect(screen.queryByText(/번째 시도/)).toBeNull()
    first.unmount()
    renderThemed(<NodeCard node={transform} info={info('transform@1')} state={state('running', { attempt: 2 })} selected={false} />)
    expect(screen.getByText('2번째 시도')).toBeTruthy()
  })

  it('gives only the external transfer badge a hint', () => {
    const first = renderThemed(<NodeCard node={append} info={info('csv.append@1')} state={undefined} selected={false} />)
    expect(first.container.querySelector('[data-badge="writesFile"]')!.hasAttribute('title')).toBe(false)
    first.unmount()
    const second = renderThemed(<NodeCard node={request} info={info('http.request@1')} state={undefined} selected={false} />)
    expect(second.container.querySelector('[data-badge="network"]')!.hasAttribute('title')).toBe(false)
  })

  it('cuts the title at 36 characters, the id at 28 and the type at 30 and not a character sooner', () => {
    const fits: WorkflowNode = { id: 'i'.repeat(28), type: `t${'y'.repeat(29)}`, config: {} }
    const fitsInfo: NodeInfo = { ...info('transform@1'), title: 'T'.repeat(36) }
    const whole = renderThemed(<NodeCard node={fits} info={fitsInfo} state={undefined} selected={false} />)
    expect(whole.container.textContent).toContain('T'.repeat(36))
    expect(whole.container.textContent).toContain('i'.repeat(28))
    expect(whole.container.textContent).toContain(`t${'y'.repeat(29)}`)
    expect(whole.container.textContent).not.toContain('…')
    whole.unmount()
    const over: WorkflowNode = { id: 'i'.repeat(29), type: `t${'y'.repeat(30)}`, config: {} }
    const overInfo: NodeInfo = { ...info('transform@1'), title: 'T'.repeat(37) }
    const cut = renderThemed(<NodeCard node={over} info={overInfo} state={undefined} selected={false} />)
    expect(cut.container.textContent).toContain(`${'T'.repeat(35)}…`)
    expect(cut.container.textContent).toContain(`${'i'.repeat(27)}…`)
    expect(cut.container.textContent).toContain(`t${'y'.repeat(28)}…`)
    expect(cut.container.querySelector(`[title="${'T'.repeat(37)}"]`)).not.toBeNull()
    expect(cut.container.querySelector(`[title="${'i'.repeat(29)}"]`)).not.toBeNull()
    expect(cut.container.querySelector(`[title="t${'y'.repeat(30)}"]`)).not.toBeNull()
  })

  it('is as wide as the layout assumes', () => {
    const { container } = renderThemed(<NodeCard node={transform} info={info('transform@1')} state={undefined} selected={false} />)
    expect((container.querySelector('[data-selected]') as HTMLElement).style.width).toBe('264px')
  })

  it('shows the idle status when there is no state', () => {
    renderThemed(<NodeCard node={transform} info={info('transform@1')} state={undefined} selected={false} />)
    expect(screen.getByRole('img', { name: ko['status.idle'] })).toBeTruthy()
  })

  it('shows the attempt count above one and hides it for the first attempt', () => {
    const { unmount } = renderThemed(<NodeCard node={extract} info={info('llm.extract@1')} state={state('failed', { attempt: 3 })} selected={false} />)
    expect(screen.getByText('3번째 시도')).toBeTruthy()
    unmount()
    renderThemed(<NodeCard node={extract} info={info('llm.extract@1')} state={state('succeeded')} selected={false} />)
    expect(screen.queryByText(/번째 시도/)).toBeNull()
  })

  it('marks a retry', () => {
    const { unmount } = renderThemed(
      <NodeCard node={extract} info={info('llm.extract@1')} state={state('running', { attempt: 2, retrying: true })} selected={false} />,
    )
    expect(screen.getByText(ko['node.retrying'])).toBeTruthy()
    unmount()
    renderThemed(<NodeCard node={extract} info={info('llm.extract@1')} state={state('running')} selected={false} />)
    expect(screen.queryByText(ko['node.retrying'])).toBeNull()
  })

  it('shows the external transfer badge for llm.extract with its explanation', () => {
    renderThemed(<NodeCard node={extract} info={info('llm.extract@1')} state={undefined} selected={false} />)
    const badge = screen.getByText(ko['badge.externalTransfer'])
    expect(badge.closest('[title]')?.getAttribute('title')).toBe(ko['badge.externalTransfer.hint'])
  })

  it('shows a file-write badge for idempotent nodes and a network badge for external ones', () => {
    const first = renderThemed(<NodeCard node={append} info={info('csv.append@1')} state={undefined} selected={false} />)
    expect(screen.getByText(ko['badge.writesFile'])).toBeTruthy()
    expect(screen.queryByText(ko['badge.network'])).toBeNull()
    first.unmount()
    renderThemed(<NodeCard node={request} info={info('http.request@1')} state={undefined} selected={false} />)
    expect(screen.getByText(ko['badge.network'])).toBeTruthy()
    expect(screen.queryByText(ko['badge.externalTransfer'])).toBeNull()
  })

  it('shows no badge for a pure node', () => {
    const { container } = renderThemed(<NodeCard node={transform} info={info('transform@1')} state={undefined} selected={false} />)
    expect(container.querySelectorAll('[data-badge]')).toHaveLength(0)
  })

  it('shows the catalog title and falls back to the raw type when the catalog has no entry', () => {
    const first = renderThemed(<NodeCard node={extract} info={info('llm.extract@1')} state={undefined} selected={false} />)
    expect(screen.getByText('Extract fields with AI')).toBeTruthy()
    first.unmount()
    const ghost: WorkflowNode = { id: 'ghost', type: 'mystery.node@1', config: {} }
    renderThemed(<NodeCard node={ghost} info={undefined} state={undefined} selected={false} />)
    expect(screen.getAllByText('mystery.node@1').length).toBeGreaterThan(0)
    expect(screen.getByText('ghost')).toBeTruthy()
  })

  it('truncates a long id and a long title and keeps the full text in the title attribute', () => {
    const longId = `n${'x'.repeat(200)}`
    const longTitle = `Title ${'long '.repeat(60)}`
    const node: WorkflowNode = { id: longId, type: 'transform@1', config: {} }
    const longInfo: NodeInfo = { ...info('transform@1'), title: longTitle }
    const { container } = renderThemed(<NodeCard node={node} info={longInfo} state={undefined} selected={false} />)
    const idElement = container.querySelector(`[title="${longId}"]`)!
    expect(idElement.textContent!.length).toBeLessThan(longId.length)
    expect(idElement.textContent!.endsWith('…')).toBe(true)
    const titleElement = container.querySelector(`[title="${longTitle}"]`)!
    expect(titleElement.textContent!.length).toBeLessThan(longTitle.length)
    expect(titleElement.textContent!.endsWith('…')).toBe(true)
  })

  it('marks the selection with data-selected and adds no role of its own', () => {
    const first = renderThemed(<NodeCard node={transform} info={info('transform@1')} state={undefined} selected />)
    expect(first.container.querySelector('[data-selected="true"]')).not.toBeNull()
    const card = first.container.querySelector('[data-selected]')!
    expect(card.hasAttribute('role')).toBe(false)
    expect(card.hasAttribute('aria-selected')).toBe(false)
    first.unmount()
    const second = renderThemed(<NodeCard node={transform} info={info('transform@1')} state={undefined} selected={false} />)
    expect(second.container.querySelector('[data-selected="false"]')).not.toBeNull()
    expect(second.container.querySelector('[data-selected="true"]')).toBeNull()
  })

  it('renders hostile ids and titles as text only', () => {
    const node: WorkflowNode = { id: '<img src=x onerror=alert(1)>', type: 'transform@1', config: {} }
    const hostileInfo: NodeInfo = { ...info('transform@1'), title: '<script>window.__pwned = 1</script>' }
    const { container } = renderThemed(<NodeCard node={node} info={hostileInfo} state={state('failed', { error: '<img src=y onerror=alert(2)>' })} selected={false} />)
    expect(container.querySelector('img, script, a')).toBeNull()
    expect(within(container).getByText('<script>window.__pwned = 1</script>')).toBeTruthy()
  })
})
