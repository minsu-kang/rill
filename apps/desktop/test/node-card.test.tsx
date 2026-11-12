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
