import { flagKey, type Flag, type PlanResultBody } from '@rill/protocol'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanResultCard, type PlanResultCardProps } from '../src/chat/PlanResultCard'
import type { AssistantEntry } from '../src/chat/model/conversation'
import { catalog } from '../src/fixtures'
import { metas, results } from '../src/fixtures/plan'
import { renderThemed } from './render'

function entryOf(result: PlanResultBody, deployed?: string): AssistantEntry {
  return { role: 'assistant', planId: 'p1', result, meta: metas.plain, ...(deployed === undefined ? {} : { deployed }) }
}

function flagsOf(result: PlanResultBody): Flag[] {
  if (result.kind !== 'workflow') throw new Error('workflow expected')
  return result.flags
}

function show(result: PlanResultBody, overrides: Partial<PlanResultCardProps> = {}) {
  const props: PlanResultCardProps = {
    entry: entryOf(result),
    catalog,
    confirmed: [],
    onToggleFlag: vi.fn(),
    onDeploy: vi.fn(),
    deploying: false,
    ...overrides,
  }
  const view = renderThemed(<PlanResultCard {...props} />, { locale: 'en' })
  return { props, ...view }
}

const deployButton = (): HTMLButtonElement => screen.getByRole('button', { name: /Deploy|Deploying/ }) as HTMLButtonElement

describe('PlanResultCard: a workflow with no flags', () => {
  it('shows the summary as text and a read-only preview with one card per node', async () => {
    const { container } = show(results.workflow)
    if (results.workflow.kind !== 'workflow') throw new Error('workflow expected')
    expect(screen.getByText(results.workflow.summary)).toBeTruthy()
    await waitFor(() => expect(container.querySelectorAll('.react-flow__node')).toHaveLength(results.workflow.kind === 'workflow' ? results.workflow.workflow.nodes.length : 0))
    expect(screen.getByRole('region', { name: 'Workflow preview' })).toBeTruthy()
  })

  it('shows no banner and no flag list, and the deploy button works at once', () => {
    const { props } = show(results.workflow)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(deployButton().disabled).toBe(false)
    fireEvent.click(deployButton())
    expect(props.onDeploy).toHaveBeenCalledTimes(1)
  })

  it('shows no patch list', () => {
    show(results.workflow)
    expect(screen.queryByText('What changes')).toBeNull()
  })
})

describe('PlanResultCard: a newer plan', () => {
  it('says a superseded plan was replaced, and cannot be deployed or re-confirmed', () => {
    const flagged = results.flagged as Extract<PlanResultBody, { kind: 'workflow' }>
    const { props } = show(flagged, { superseded: true, confirmed: flagged.flags.map(flagKey) })
    expect(screen.getByText('A newer plan replaced this one.')).toBeTruthy()
    expect(deployButton().disabled).toBe(true)
    fireEvent.click(deployButton())
    expect(props.onDeploy).not.toHaveBeenCalled()
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true)
  })

  it('does not call a deployed plan superseded', () => {
    show(results.workflow, { entry: entryOf(results.workflow, 'wf-9'), superseded: true })
    expect(screen.queryByText('A newer plan replaced this one.')).toBeNull()
    expect(screen.getByText('Deployed. Workflow wf-9')).toBeTruthy()
  })

  it('keeps deploy disabled with a reason while another plan is being made', () => {
    const { props } = show(results.workflow, { planning: true })
    expect(deployButton().disabled).toBe(true)
    expect(screen.getByText('Deploy is available when the new plan is ready.')).toBeTruthy()
    fireEvent.click(deployButton())
    expect(props.onDeploy).not.toHaveBeenCalled()
  })

  it('shows neither note for a plan that is the latest and nothing is planning', () => {
    show(results.workflow, { superseded: false, planning: false })
    expect(screen.queryByText('A newer plan replaced this one.')).toBeNull()
    expect(screen.queryByText('Deploy is available when the new plan is ready.')).toBeNull()
    expect(deployButton().disabled).toBe(false)
  })
})

describe('PlanResultCard: a patch', () => {
  it('lists each of the five operations in words, with node ids as text', () => {
    show(results.patch)
    const list = screen.getByRole('list', { name: 'What changes' })
    const items = within(list).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual([
      'Change the settings of extract (file, fields, retry)',
      'Add node notify (notify.slack@1)',
      'Connect extract to notify',
      'Disconnect extract from append',
      'Remove node append',
    ])
  })

  it('says when a connection has a condition', () => {
    const result: PlanResultBody = {
      ...(results.workflow as Extract<PlanResultBody, { kind: 'workflow' }>),
      patch: [{ op: 'connect', edge: { from: 'a', to: 'b', when: 'true' } }],
    }
    show(result)
    expect(screen.getByText('Connect a to b when true')).toBeTruthy()
  })

  it('says it in Korean too', () => {
    renderThemed(
      <PlanResultCard entry={entryOf(results.patch)} catalog={catalog} confirmed={[]} onToggleFlag={() => undefined} onDeploy={() => undefined} deploying={false} />,
      { locale: 'ko' },
    )
    expect(screen.getByText('노드 삭제: append')).toBeTruthy()
  })
})

describe('PlanResultCard: flags', () => {
  it('shows a banner and groups the flags by node with the code, pointer and message as text', () => {
    show(results.flagged)
    expect(screen.getByRole('note').textContent).toContain('3 items that need your confirmation')
    const flags = flagsOf(results.flagged)
    expect(screen.getAllByRole('checkbox')).toHaveLength(flags.length)
    for (const flag of flags) {
      expect(screen.getByText(flag.pointer)).toBeTruthy()
      expect(screen.getByText(flag.message)).toBeTruthy()
    }
    const headings = screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['Node c1 · Condition', 'Node n2 · HTTP request', 'Node n3 · Append CSV row'])
    expect(screen.getByText('A value read from a document flows here')).toBeTruthy()
    expect(screen.getByText('New place to send or write data')).toBeTruthy()
    expect(screen.getByText('Value from an attached file')).toBeTruthy()
  })

  it('puts two flags of one node under one heading', () => {
    show(results.manyFlags)
    const headings = screen.getAllByRole('heading', { level: 5 })
    expect(headings).toHaveLength(6)
    expect(screen.getAllByRole('checkbox')).toHaveLength(9)
  })

  it('reports the key of the flag when its checkbox is toggled', () => {
    const { props } = show(results.flagged)
    const flags = flagsOf(results.flagged)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(props.onToggleFlag).toHaveBeenCalledWith(flagKey(flags[1]!))
  })

  it('shows which flags are confirmed', () => {
    const flags = flagsOf(results.flagged)
    show(results.flagged, { confirmed: [flagKey(flags[0]!), flagKey(flags[2]!)] })
    expect(screen.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true])
    expect(screen.getByText('Confirmed 2/3')).toBeTruthy()
  })

  it('keeps deploy disabled until every flag is confirmed, then lets it run', () => {
    const flags = flagsOf(results.flagged)
    const keys = flags.map(flagKey)
    const first = show(results.flagged, { confirmed: [] })
    expect(deployButton().disabled).toBe(true)
    expect(screen.getByText('Confirm every item to deploy.')).toBeTruthy()
    first.unmount()
    const second = show(results.flagged, { confirmed: keys.slice(0, 2) })
    expect(deployButton().disabled).toBe(true)
    second.unmount()
    const third = show(results.flagged, { confirmed: keys })
    expect(deployButton().disabled).toBe(false)
    fireEvent.click(deployButton())
    expect(third.props.onDeploy).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Confirm every item to deploy.')).toBeNull()
  })

  it('does not call deploy when the button is disabled', () => {
    const { props } = show(results.flagged)
    fireEvent.click(deployButton())
    expect(props.onDeploy).not.toHaveBeenCalled()
  })

  it('uses the flags of the engine, not needsConfirmation, to decide', () => {
    const base = results.flagged as Extract<PlanResultBody, { kind: 'workflow' }>
    show({ ...base, needsConfirmation: false })
    expect(deployButton().disabled).toBe(true)
  })
})

describe('PlanResultCard: deploy states', () => {
  it('shows a deploying state with a disabled button', () => {
    show(results.workflow, { deploying: true })
    expect(deployButton().textContent).toBe('Deploying…')
    expect(deployButton().disabled).toBe(true)
  })

  it('shows a deploy error as a localized notice and keeps the button', () => {
    show(results.workflow, { deployError: 'chat.error.PLAN_NOT_CONFIRMED' })
    expect(screen.getByRole('alert').textContent).toContain('Some flagged items are not confirmed')
    expect(deployButton().disabled).toBe(false)
  })

  it('shows the deployed state with the workflow id, no deploy button and locked checkboxes', () => {
    const flags = flagsOf(results.flagged)
    show(results.flagged, { entry: entryOf(results.flagged, 'wf-42'), confirmed: flags.map(flagKey) })
    expect(screen.getByText('Deployed. Workflow wf-42')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Deploy/ })).toBeNull()
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true)
  })

  it('locks the checkboxes while deploying', () => {
    show(results.flagged, { deploying: true })
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true)
  })

  it('renders nothing for a result that is not a workflow', () => {
    const { container } = show(results.questions)
    expect(container.querySelector('[data-plan-card]')).toBeNull()
  })
})

describe('PlanResultCard: text from the model', () => {
  const HOSTILE = '<img src=x onerror=alert(1)> <a href="https://evil.example">Confirm</a> <script>alert(1)</script> **bold** [x](https://evil.example) ‮exe.txt'
  const base = results.flagged as Extract<PlanResultBody, { kind: 'workflow' }>

  it('shows summary, flag message, pointer and patch ids as plain text', () => {
    const hostile: PlanResultBody = {
      ...base,
      summary: HOSTILE,
      flags: base.flags.map((flag, index) => (index === 0 ? { ...flag, message: HOSTILE, pointer: '/nodes/<img src=x>' } : flag)),
      patch: [
        { op: 'remove_node', nodeId: '<img src=x onerror=alert(1)>' },
        { op: 'set_config', nodeId: 'n‮1', config: { '<script>': 1 } },
      ],
    }
    const { container } = show(hostile)
    const outside = [...container.querySelectorAll('img, a, script, strong, b')].filter((element) => element.closest('.react-flow__attribution') === null)
    expect(outside).toEqual([])
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('‹U+202E›exe.txt')
    expect(container.textContent).toContain('**bold**')
    expect(container.textContent).toContain('Remove node <img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('Change the settings of n‹U+202E›1 (<script>)')
  })

  it('draws a hostile condition of the preview as text with its hidden characters marked', async () => {
    const hostile: PlanResultBody = {
      ...base,
      workflow: { ...base.workflow, edges: base.workflow.edges.map((link) => ({ ...link, when: '\u202E<img src=x>' })) },
    }
    const { container } = show(hostile)
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge-text').length).toBeGreaterThan(0))
    const preview = screen.getByRole('region', { name: 'Workflow preview' })
    expect([...preview.querySelectorAll('img, script, strong, b')]).toEqual([])
    expect([...preview.querySelectorAll('a')].filter((link) => link.closest('.react-flow__attribution') === null)).toEqual([])
    expect(preview.textContent).toContain('‹U+202E›')
    expect(preview.textContent).not.toContain('\u202E')
  })

  it('caps a very long summary and a very long flag message behind a show more button', () => {
    const long = 'z'.repeat(10_000)
    const hostile: PlanResultBody = { ...base, summary: long, flags: base.flags.map((flag, index) => (index === 0 ? { ...flag, message: long } : flag)) }
    const { container } = show(hostile)
    expect(screen.getAllByRole('button', { name: 'Show more' }).length).toBeGreaterThanOrEqual(2)
    expect((container.textContent ?? '').length).toBeLessThan(5000)
  })

  it('caps a very long list of patch operations', () => {
    const many: PlanResultBody = {
      ...base,
      flags: [],
      needsConfirmation: false,
      patch: Array.from({ length: 200 }, (_, i) => ({ op: 'remove_node' as const, nodeId: `node-${i}` })),
    }
    show(many)
    const items = within(screen.getByRole('list', { name: 'What changes' })).getAllByRole('listitem')
    expect(items.length).toBeLessThanOrEqual(51)
  })
})
