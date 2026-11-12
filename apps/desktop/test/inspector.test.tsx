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
