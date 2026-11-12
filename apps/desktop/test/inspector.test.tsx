import type { WorkflowNode } from '@rill/dsl'
import type { NodeInfo, StepDetail } from '@rill/protocol'
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { catalog, fixtureSteps, ids, workflows } from '../src/fixtures'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { Inspector } from '../src/inspector/Inspector'
import { statesFromSteps } from '../src/model/steps'
import { stateOf, type NodeRunState } from '../src/model/status'
import { renderThemed } from './render'

const info = (type: string): NodeInfo => catalog.find((entry) => entry.type === type)!
const nodeOf = (workflow: keyof typeof workflows, id: string): WorkflowNode => workflows[workflow].nodes.find((item) => item.id === id)!
const extract = nodeOf('receipt', 'extract')
const check = nodeOf('branching', 'check')

function view(node: WorkflowNode | undefined, steps: readonly StepDetail[], state?: NodeRunState, locale: 'ko' | 'en' = 'ko') {
  return renderThemed(<Inspector node={node} info={node === undefined ? undefined : info(node.type)} steps={steps} state={state} timeZone="UTC" />, { locale })
}

describe('Inspector', () => {
  it('shows the empty message when no node is selected', () => {
    view(undefined, [])
    expect(screen.getByText(ko['inspector.empty'])).toBeTruthy()
    expect(screen.getByRole('heading', { name: ko['inspector.heading'] })).toBeTruthy()
  })

  it('shows title, description, type, node id and the config of the node', () => {
    const { container } = view(extract, [])
    expect(screen.getByRole('heading', { name: 'Extract fields with AI' })).toBeTruthy()
    expect(screen.getByText(info('llm.extract@1').description)).toBeTruthy()
    expect(screen.getByText('llm.extract@1')).toBeTruthy()
    expect(screen.getByText('extract')).toBeTruthy()
    expect(container.textContent).toContain('{{watch.output.file}}')
    expect(container.textContent).toContain('amount')
    expect(container.querySelectorAll('span[data-template-ref]').length).toBeGreaterThan(0)
  })

  it('shows the retry setting and what happens on error', () => {
    view(check, [])
    expect(screen.getByText(ko['inspector.retryValue.other'].replace('{count}', '2'))).toBeTruthy()
    expect(screen.getByText(ko['inspector.onError.continue'])).toBeTruthy()
  })

  it('says a node that has not run has no record, and a trigger records no data', () => {
    const first = view(extract, [])
    expect(screen.getByText(ko['inspector.notRun'])).toBeTruthy()
    first.unmount()
    view(nodeOf('receipt', 'watch'), [])
    expect(screen.getByText(ko['inspector.triggerNoData'])).toBeTruthy()
    expect(screen.queryByText(ko['inspector.notRun'])).toBeNull()
  })

  it('shows the attempts of the selected node only, oldest first and newest last, with input, output, error and times', () => {
    const steps = fixtureSteps[ids.runs.receiptFailed]!
    const shuffled = [steps[2]!, steps[0]!, steps[1]!]
    const { container } = view(extract, shuffled, stateOf(statesFromSteps(steps), 'extract'))
    const attempts = screen.getAllByRole('listitem')
    expect(attempts).toHaveLength(3)
    expect(attempts.map((item) => within(item).getAllByText(/번째 시도/)[0]!.textContent)).toEqual(['1번째 시도', '2번째 시도', '3번째 시도'])
    expect(within(attempts[2]!).getByText(/provider error: 503 Service Unavailable\. The model provider/)).toBeTruthy()
    expect(within(attempts[0]!).getByText('provider error: 503 Service Unavailable')).toBeTruthy()
    expect(container.textContent).toContain('/Users/demo/Receipts/dinner.pdf')
    expect(within(attempts[0]!).getAllByText(/2026/).length).toBeGreaterThan(0)
  })

  it('ignores the rows of other nodes', () => {
    const { container } = view(nodeOf('receipt', 'append'), fixtureSteps[ids.runs.receiptOk]!)
    expect(container.textContent).toContain('ledger.csv')
    expect(container.textContent).not.toContain('Total amount paid')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows the output of a succeeded step', () => {
    const steps = fixtureSteps[ids.runs.receiptOk]!
    const { container } = view(extract, steps, stateOf(statesFromSteps(steps), 'extract'))
    expect(container.textContent).toContain('Cafe Mori')
    expect(container.textContent).toContain('12800')
    expect(screen.getAllByText(ko['status.succeeded'])).toHaveLength(2)
  })

  it('shows the error text of a failed step as text, with a hostile error staying inert', () => {
    const hostile: StepDetail = { nodeId: 'extract', attempt: 1, status: 'failed', input: null, output: null, startedAt: 0, finishedAt: 1, error: '<img src=x onerror=alert(1)> <script>x</script>' }
    const { container } = view(extract, [hostile])
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> <script>x</script>')
    expect(container.querySelector('img, script, a')).toBeNull()
    expect(screen.getByText(ko['inspector.error'])).toBeTruthy()
  })

  it('shows the live error of a retrying node when no step row has it yet', () => {
    const live: NodeRunState = { status: 'running', attempt: 2, retrying: true, error: 'HTTP 503 from the provider' }
    view(extract, [], live)
    expect(screen.getByText('HTTP 503 from the provider')).toBeTruthy()
    expect(screen.getByText(ko['inspector.liveError'])).toBeTruthy()
    expect(screen.queryByText(ko['inspector.notRun'])).toBeNull()
  })

  it('shows the external transfer badge and its explanation for llm.extract only', () => {
    const first = view(extract, [])
    expect(screen.getByText(ko['badge.externalTransfer'])).toBeTruthy()
    expect(screen.getByText(ko['badge.externalTransfer.hint'])).toBeTruthy()
    first.unmount()
    view(check, [])
    expect(screen.queryByText(ko['badge.externalTransfer'])).toBeNull()
    expect(screen.getByText(ko['badge.network'])).toBeTruthy()
  })

  it('renders hostile run data as text only', () => {
    const steps = fixtureSteps[ids.runs.receiptHostile]!
    const { container } = view(extract, steps, stateOf(statesFromSteps(steps), 'extract'))
    expect(container.querySelector('img, script, a, iframe, svg[onload]')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="window.__pwned = 1">')
    expect(container.textContent).toContain('<script>window.__pwned = 1</script>')
  })

  it('writes a hidden character of an error and of an input value as a visible code point', () => {
    const row: StepDetail = { nodeId: 'extract', attempt: 1, status: 'failed', input: { file: 'a\u202eb' }, output: null, startedAt: 0, finishedAt: 1, error: 'bad \u200bname' }
    const { container } = view(extract, [row], { status: 'failed', attempt: 1, retrying: false, error: 'live \u202ename' })
    expect(container.textContent).toContain('bad ‹U+200B›name')
    expect(container.textContent).toContain('a‹U+202E›b')
    expect(container.textContent).toContain('live ‹U+202E›name')
    expect(container.textContent).not.toMatch(/\p{Cf}/u)
  })

  it('lets the person reveal a long error through show more', () => {
    const long = 'e'.repeat(2000)
    const row: StepDetail = { nodeId: 'extract', attempt: 1, status: 'failed', input: null, output: null, startedAt: 0, finishedAt: 1, error: long }
    const { container } = view(extract, [row])
    expect(container.textContent).not.toContain(long)
    fireEvent.click(screen.getByRole('button', { name: ko['json.showMore'] }))
    expect(container.textContent).toContain(long)
  })

  it('uses English labels in English and formats times in the given time zone', () => {
    const steps = fixtureSteps[ids.runs.receiptOk]!
    view(extract, steps, stateOf(statesFromSteps(steps), 'extract'), 'en')
    expect(screen.getByText(en['inspector.input'])).toBeTruthy()
    expect(screen.getByText(en['inspector.output'])).toBeTruthy()
    expect(screen.getAllByText(en['status.succeeded'])).toHaveLength(2)
    expect(screen.getAllByText(/Nov 12, 2026, 8:3/).length).toBeGreaterThan(0)
  })
})

describe('Inspector details', () => {
  const row = (extra: Partial<StepDetail> = {}): StepDetail => ({ nodeId: 'extract', attempt: 1, status: 'succeeded', input: null, output: null, error: null, startedAt: 1_000, finishedAt: 2_000, ...extra })
  const idle: NodeRunState = { status: 'idle', attempt: 1, retrying: false, error: null }
  const mystery: WorkflowNode = { id: 'ghost', type: 'mystery.node@1', config: {} }

  it('lists two rows of one attempt in the order they started', () => {
    view(extract, [row({ startedAt: 2_000, status: 'failed', error: 'second-error' }), row({ startedAt: 1_000, status: 'failed', error: 'first-error' })])
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('first-error')
    expect(items[1]!.textContent).toContain('second-error')
  })

  it('does not show the live error again when a row already has it', () => {
    view(extract, [row({ status: 'failed', error: 'same text' })], { status: 'running', attempt: 2, retrying: true, error: 'same text' })
    expect(screen.queryByText(ko['inspector.liveError'])).toBeNull()
    expect(screen.getAllByText('same text')).toHaveLength(1)
  })

  it('shows no live error when the state has none', () => {
    view(extract, [], { status: 'running', attempt: 1, retrying: false, error: null })
    expect(screen.queryByText(ko['inspector.liveError'])).toBeNull()
  })

  it('does not say a node with a row did not run, and says it for a node whose state is idle', () => {
    const first = view(extract, [row({ status: 'running', finishedAt: null })])
    expect(screen.queryByText(ko['inspector.notRun'])).toBeNull()
    first.unmount()
    view(extract, [], idle)
    expect(screen.getByText(ko['inspector.notRun'])).toBeTruthy()
  })

  it('shows the note that triggers record no data only for a trigger without rows', () => {
    const first = view(extract, [])
    expect(screen.queryByText(ko['inspector.triggerNoData'])).toBeNull()
    first.unmount()
    view(nodeOf('receipt', 'watch'), [row({ nodeId: 'watch' })])
    expect(screen.queryByText(ko['inspector.triggerNoData'])).toBeNull()
  })

  it('draws a node without a state as waiting', () => {
    const { container } = view(extract, [])
    expect(container.querySelector('dl [data-status]')!.getAttribute('data-status')).toBe('idle')
  })

  it('falls back to the type for the title and shows no description without a catalog entry', () => {
    const { container } = renderThemed(<Inspector node={mystery} info={undefined} steps={[]} state={undefined} timeZone="UTC" />)
    expect(screen.getByRole('heading', { level: 3, name: 'mystery.node@1' })).toBeTruthy()
    expect(container.querySelector('header p')).toBeNull()
  })

  it('shows the retry and on error rows only when the node has them', () => {
    const first = view(nodeOf('receipt', 'watch'), [])
    expect(screen.queryByText(ko['inspector.retry'])).toBeNull()
    expect(screen.queryByText(ko['inspector.onError'])).toBeNull()
    first.unmount()
    view(check, [])
    expect(screen.getByText(ko['inspector.retry'])).toBeTruthy()
    expect(screen.getByText(ko['inspector.onError'])).toBeTruthy()
  })

  it('says a node that stops on error stops', () => {
    view({ ...extract, onError: 'fail' }, [])
    expect(screen.getByText(ko['inspector.onError.fail'])).toBeTruthy()
    expect(screen.queryByText(ko['inspector.onError.continue'])).toBeNull()
  })

  it('shows the file write note only for a file write and the network note only for a network call', () => {
    const first = view(nodeOf('receipt', 'append'), [])
    expect(screen.getByText(ko['badge.writesFile'])).toBeTruthy()
    expect(screen.queryByText(ko['badge.network'])).toBeNull()
    first.unmount()
    view(check, [])
    expect(screen.getByText(ko['badge.network'])).toBeTruthy()
    expect(screen.queryByText(ko['badge.writesFile'])).toBeNull()
  })

  it('shows the note for an empty config and the config otherwise', () => {
    const first = view(mystery, [])
    expect(screen.getByText(ko['inspector.noConfig'])).toBeTruthy()
    first.unmount()
    view(extract, [])
    expect(screen.queryByText(ko['inspector.noConfig'])).toBeNull()
  })

  it('shows the finish time only for a finished attempt', () => {
    const first = view(extract, [row({ status: 'running', finishedAt: null })])
    expect(screen.getByText(ko['inspector.startedAt'])).toBeTruthy()
    expect(screen.queryByText(ko['inspector.finishedAt'])).toBeNull()
    first.unmount()
    view(extract, [row()])
    expect(screen.getByText(ko['inspector.finishedAt'])).toBeTruthy()
  })

  it('shows input, output and error only for what the row has', () => {
    const first = view(extract, [row()])
    for (const name of ['inspector.input', 'inspector.output', 'inspector.error'] as const) expect(screen.queryByRole('heading', { name: ko[name] }), name).toBeNull()
    first.unmount()
    view(extract, [row({ input: { a: 1 }, output: { b: 2 }, error: 'bad' })])
    for (const name of ['inspector.input', 'inspector.output', 'inspector.error'] as const) expect(screen.getByRole('heading', { name: ko[name] }), name).toBeTruthy()
  })

  it('formats times in the language of the screen', () => {
    const at = Date.UTC(2026, 10, 12, 8, 30, 0)
    const first = view(extract, [row({ startedAt: at, finishedAt: at + 5_000 })], undefined, 'ko')
    expect(screen.getAllByText('2026. 11. 12. 오전 8:30:00')).toHaveLength(1)
    first.unmount()
    view(extract, [row({ startedAt: at, finishedAt: at + 5_000 })], undefined, 'en')
    expect(screen.getAllByText(/^Nov 12, 2026, 8:30:00\sAM$/)).toHaveLength(1)
  })
})
