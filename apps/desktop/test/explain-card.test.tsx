import type { ExplainResult } from '@rill/protocol'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ExplainCard } from '../src/explain/ExplainCard'
import { explainCases, explainMeta } from '../src/fixtures/explain'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations } from './axe'
import { renderThemed } from './render'

function show(result: ExplainResult, locale: 'ko' | 'en' = 'ko') {
  const onAction = vi.fn()
  const onProposeFix = vi.fn()
  const view = renderThemed(<ExplainCard result={result} onAction={onAction} onProposeFix={onProposeFix} />, { locale })
  return { onAction, onProposeFix, view, user: userEvent.setup() }
}

describe('ExplainCard content', () => {
  it('shows the explanation as text, the cause label and the signals with their node ids', () => {
    show(explainCases.credentials)
    expect(screen.getByText(explainCases.credentials.explanation)).toBeTruthy()
    expect(screen.getByText(ko['explain.cause.credentials_or_connection'])).toBeTruthy()
    const signals = screen.getByRole('list', { name: ko['explain.card.signals'] })
    const items = within(signals).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain(ko['explain.signal.unknown_connection'])
    expect(items[0]!.textContent).toContain('alert')
  })

  it('shows every cause in English as well', () => {
    show(explainCases.rateLimit, 'en')
    expect(screen.getByText(en['explain.cause.rate_limit_or_timeout'])).toBeTruthy()
    expect(screen.getByText(en['explain.signal.http_status_429'])).toBeTruthy()
  })

  it('shows no signal list when there are no signals', () => {
    show(explainCases.noActions)
    expect(screen.queryByRole('list', { name: ko['explain.card.signals'] })).toBeNull()
  })

  it('caps a long signal list and says how many are left out', () => {
    show(explainCases.manySignals)
    const items = within(screen.getByRole('list', { name: ko['explain.card.signals'] })).getAllByRole('listitem')
    expect(items).toHaveLength(13)
    expect(screen.getByText(/그 밖에 \d+개/)).toBeTruthy()
  })

  it('caps the explanation with a show more button and shows the whole 1,500 characters when asked', async () => {
    const { user } = show(explainCases.longExplanation)
    const full = explainCases.longExplanation.explanation
    expect(screen.queryByText(full)).toBeNull()
    await user.click(screen.getByRole('button', { name: ko['explain.card.showMore'] }))
    expect(screen.getByText(full)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.card.showLess'] }))
    expect(screen.queryByText(full)).toBeNull()
  })
})

describe('ExplainCard meta line', () => {
  it('shows the model, the effort and the cost as an upper bound', () => {
    show(explainCases.credentials)
    const meta = screen.getByLabelText(ko['explain.card.meta'])
    expect(meta.textContent).toContain('anthropic · claude-sonnet-5')
    expect(meta.textContent).toContain('깊이 보통')
    expect(meta.textContent).toContain('비용 상한 약 $0.0043')
    expect(meta.textContent).toContain('보낸 요약 3,412자')
  })

  it('shows the requested and the effective effort when they differ', () => {
    show(explainCases.effortLowered)
    expect(screen.getByLabelText(ko['explain.card.meta']).textContent).toContain('깊이 요청 꼼꼼히, 적용 보통')
  })

  it('says the cost is unknown when it is null', () => {
    show(explainCases.costUnknown)
    const meta = screen.getByLabelText(ko['explain.card.meta']).textContent ?? ''
    expect(meta).toContain(ko['explain.meta.costUnknown'])
    expect(meta).not.toContain('$')
  })

  it('notes a truncated record and a repaired answer, and only then', () => {
    show(explainCases.truncated)
    expect(screen.getByText(ko['explain.meta.truncated'])).toBeTruthy()
    expect(screen.queryByText(ko['explain.meta.repaired'])).toBeNull()
  })

  it('notes a repaired answer', () => {
    show(explainCases.repaired)
    expect(screen.getByText(ko['explain.meta.repaired'])).toBeTruthy()
    expect(screen.queryByText(ko['explain.meta.truncated'])).toBeNull()
  })

  it('shows xhigh and max efforts by name', () => {
    show({ ...explainCases.unknown, meta: explainMeta({ effort: { requested: 'xhigh', effective: 'max', native: 'x', collapsed: false } }) })
    expect(screen.getByLabelText(ko['explain.card.meta']).textContent).toContain('요청 아주 꼼꼼히, 적용 최대')
  })
})

describe('ExplainCard actions', () => {
  it('shows at most three action buttons and none for "none"', () => {
    show(explainCases.threeActions)
    const group = screen.getByRole('group', { name: ko['explain.card.actions'] })
    expect(within(group).getAllByRole('button')).toHaveLength(3)
    show(explainCases.unknown)
    expect(screen.getAllByRole('group', { name: ko['explain.card.actions'] })).toHaveLength(1)
  })

  it('caps the buttons at three even when more actions arrive', () => {
    show({ ...explainCases.credentials, suggestedActions: ['edit_node', 'retry_run', 'open_connections', 'check_input_file', 'wait_and_retry'] })
    expect(within(screen.getByRole('group', { name: ko['explain.card.actions'] })).getAllByRole('button')).toHaveLength(3)
  })

  it('shows no action group for zero actions', () => {
    show(explainCases.noActions)
    expect(screen.queryByRole('group', { name: ko['explain.card.actions'] })).toBeNull()
  })

  it('calls onAction at once for actions that only navigate or remind', async () => {
    const { user, onAction } = show({ ...explainCases.credentials, suggestedActions: ['open_connections', 'edit_node', 'check_input_file'] })
    await user.click(screen.getByRole('button', { name: ko['explain.action.open_connections'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.action.edit_node'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.action.check_input_file'] }))
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(['open_connections', 'edit_node', 'check_input_file'])
    expect(onAction.mock.calls[0]![1]).toEqual({ runId: explainCases.credentials.runId, nodeId: 'alert' })
  })

  it('shows wait_and_retry as a reminder that does not retry on its own', async () => {
    const { user, onAction } = show(explainCases.rateLimit)
    expect(screen.getByText(ko['explain.hint.wait_and_retry'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.action.wait_and_retry'] }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0]![0]).toBe('wait_and_retry')
  })

  it('asks before retry_run and deactivate_workflow and only then calls onAction', async () => {
    const { user, onAction } = show(explainCases.threeActions)
    await user.click(screen.getByRole('button', { name: ko['explain.action.retry_run'] }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.getByText(ko['explain.confirm.retry_run'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.confirm.yes'] }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0]![0]).toBe('retry_run')

    await user.click(screen.getByRole('button', { name: ko['explain.action.deactivate_workflow'] }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(screen.getByText(ko['explain.confirm.deactivate_workflow'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.confirm.yes'] }))
    expect(onAction.mock.calls[1]![0]).toBe('deactivate_workflow')
  })

  it('drops the confirm step without a call when it is cancelled', async () => {
    const { user, onAction } = show(explainCases.threeActions)
    await user.click(screen.getByRole('button', { name: ko['explain.action.retry_run'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.confirm.no'] }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByText(ko['explain.confirm.retry_run'])).toBeNull()
    expect(screen.getByRole('button', { name: ko['explain.action.retry_run'] })).toBeTruthy()
  })
})

describe('ExplainCard fix proposal', () => {
  it('shows the request text and hands it over as a draft without sending anything else', async () => {
    const { user, onProposeFix, onAction } = show(explainCases.configuration)
    const proposal = explainCases.configuration.fixProposal!
    expect(screen.getByText(proposal.requestText)).toBeTruthy()
    expect(screen.getByText(ko['explain.fix.note'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.fix.use'] }))
    expect(onProposeFix).toHaveBeenCalledTimes(1)
    expect(onProposeFix).toHaveBeenCalledWith({ nodeId: proposal.nodeId, requestText: proposal.requestText })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('shows no fix proposal when there is none', () => {
    show(explainCases.credentials)
    expect(screen.queryByRole('button', { name: ko['explain.fix.use'] })).toBeNull()
    expect(screen.queryByText(ko['explain.fix.heading'])).toBeNull()
  })

  it('keeps <hidden> visible in the text and explains it', () => {
    show(explainCases.hiddenText)
    expect(screen.getByText(explainCases.hiddenText.fixProposal!.requestText)).toBeTruthy()
    expect(screen.getByText(explainCases.hiddenText.explanation)).toBeTruthy()
    expect(screen.getByText(ko['explain.fix.hidden'])).toBeTruthy()
  })

  it('does not explain <hidden> when the text has none', () => {
    show(explainCases.configuration)
    expect(screen.queryByText(ko['explain.fix.hidden'])).toBeNull()
  })

  it('hands over the full request text even when the display is capped', async () => {
    const long = { nodeId: 'extract', requestText: 'x'.repeat(400) }
    const { user, onProposeFix } = show({ ...explainCases.unknown, fixProposal: long })
    await user.click(screen.getByRole('button', { name: ko['explain.fix.use'] }))
    expect(onProposeFix).toHaveBeenCalledWith(long)
  })
})

describe('ExplainCard hostile text', () => {
  it('renders HTML, links, markdown, bidi controls and very long text only as text', () => {
    const hostile = { ...explainCases.hostile, explanation: explainCases.hostile.explanation + 'Z'.repeat(10_000) }
    const { view } = show(hostile as ExplainResult)
    const root = view.container
    expect(root.querySelector('a, img, script, svg[onload], iframe')).toBeNull()
    expect(root.querySelector('[onerror], [onload], [href]')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror=')
    expect(root.textContent).toContain('<script>')
    expect(root.textContent).toContain('[링크](javascript:')
    expect(root.querySelectorAll('[data-invisible]').length).toBeGreaterThan(0)
    expect((root.textContent ?? '').length).toBeLessThan(9_000)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('shows a very long node id cut, with the whole id as a title', () => {
    show(explainCases.hostile)
    const chip = screen.getAllByRole('listitem').find((item) => item.textContent?.includes('img src=x'))!
    expect(chip.textContent!.length).toBeLessThan(200)
    expect(fireEvent.click(chip)).toBe(true)
  })

  it('shows the request text of a hostile fix proposal as text', () => {
    const { view } = show(explainCases.hostile)
    expect(view.container.querySelector('a')).toBeNull()
    expect(view.container.textContent).toContain('<a href="javascript:alert(1)">')
  })
})

describe('ExplainCard accessibility', () => {
  it('has no axe violations with actions, a confirm step, signals and a fix proposal', async () => {
    const { view, user } = show({ ...explainCases.hiddenText, suggestedActions: ['open_connections', 'retry_run', 'deactivate_workflow'] })
    await user.click(screen.getByRole('button', { name: ko['explain.action.retry_run'] }))
    expect(await violations(view.container)).toEqual([])
  })

  it('has no axe violations for the long and the hostile card', async () => {
    for (const result of [explainCases.longExplanation, explainCases.hostile, explainCases.manySignals]) {
      const { view } = show(result)
      expect(await violations(view.container)).toEqual([])
      view.unmount()
    }
  })
})
