import { RillError, type RunSummary } from '@rill/protocol'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ExplainCard } from '../src/explain/ExplainCard'
import { ExplainPanel, type ExplainPanelProps } from '../src/explain/ExplainPanel'
import { fixtureRuns, ids } from '../src/fixtures'
import { explainCases } from '../src/fixtures/explain'
import { ko } from '../src/i18n/ko'
import { manualExplainClient } from './explain-helpers'
import { renderThemed } from './render'

const run = (id: string): RunSummary => fixtureRuns.find((item) => item.id === id)!
const FAILED = run(ids.runs.receiptFailed)
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-5' }

function setup(extra: Partial<ExplainPanelProps> = {}) {
  const manual = manualExplainClient()
  const props: ExplainPanelProps = { client: manual.client, run: FAILED, model: MODEL, onAction: vi.fn(), onProposeFix: vi.fn(), ...extra }
  const ui = (next: ExplainPanelProps) => (
    <>
      <button type="button">outside</button>
      <ExplainPanel {...next} />
    </>
  )
  const view = renderThemed(ui(props))
  return { ...manual, props, view, ui, user: userEvent.setup() }
}

const ask = () => screen.getByRole('button', { name: ko['explain.ask'] })
const send = () => screen.getByRole('button', { name: ko['explain.notice.send'] })
const focused = () => document.activeElement

describe('ExplainPanel focus', () => {
  it('takes no focus when it first appears', () => {
    setup()
    expect(focused()).toBe(document.body)
  })

  it('moves to the notice heading when the notice opens and back to the ask button when it is cancelled', async () => {
    const { user } = setup()
    await user.click(ask())
    expect(focused()).toBe(screen.getByRole('heading', { name: ko['explain.notice.heading'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.notice.cancel'] }))
    expect(focused()).toBe(ask())
  })

  it('moves to the progress line while asking, then to the card when the answer arrives', async () => {
    const { user, calls } = setup()
    await user.click(ask())
    await user.click(send())
    expect(focused()).toBe(screen.getByRole('status'))
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    expect(focused()).toBe(screen.getByRole('article', { name: ko['explain.card.label'] }))
  })

  it('moves to the error message when the request fails and to the progress line on retry', async () => {
    const { user, calls } = setup()
    await user.click(ask())
    await user.click(send())
    await act(async () => calls[0]!.reject(new RillError('INTERNAL', 'x')))
    expect(focused()).toBe(screen.getByRole('alert'))
    await user.click(screen.getByRole('button', { name: ko['explain.retry'] }))
    expect(focused()).toBe(screen.getByRole('status'))
  })

  it('moves back to the ask button when the card or the progress line is closed', async () => {
    const { user, calls } = setup()
    await user.click(ask())
    await user.click(send())
    await user.click(screen.getByRole('button', { name: ko['explain.dismiss'] }))
    expect(focused()).toBe(ask())
    await user.click(ask())
    await user.click(send())
    await act(async () => calls[1]!.resolve(explainCases.unknown))
    await user.click(screen.getByRole('button', { name: ko['explain.dismiss'] }))
    expect(focused()).toBe(ask())
  })

  it('does not take focus from another place when the answer arrives', async () => {
    const { user, calls } = setup()
    await user.click(ask())
    await user.click(send())
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    expect(screen.getByRole('article', { name: ko['explain.card.label'] })).toBeTruthy()
    expect(focused()).toBe(outside)
  })

  it('does not take focus when another run is picked', async () => {
    const { user, calls, view, ui, props } = setup()
    await user.click(ask())
    await user.click(send())
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()
    view.rerender(ui({ ...props, run: run(ids.runs.receiptOk) }))
    expect(screen.queryByRole('article')).toBeNull()
    expect(focused()).toBe(outside)
  })

  it('does not take focus either when focus is on the page itself and another failed run is picked', async () => {
    const { user, calls, view, ui, props } = setup()
    await user.click(ask())
    await user.click(send())
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    ;(document.activeElement as HTMLElement).blur()
    expect(focused()).toBe(document.body)
    view.rerender(ui({ ...props, run: { ...FAILED, id: 'run-another-failed' } }))
    expect(screen.queryByRole('article')).toBeNull()
    expect(ask()).toBeTruthy()
    expect(focused()).toBe(document.body)
  })
})

describe('ExplainCard confirm step focus', () => {
  function show() {
    const onAction = vi.fn()
    renderThemed(<ExplainCard result={explainCases.threeActions} onAction={onAction} onProposeFix={vi.fn()} />)
    return { onAction, user: userEvent.setup() }
  }

  it('moves to the confirm button when the step opens and back to the action when it is cancelled', async () => {
    const { user, onAction } = show()
    const retry = screen.getByRole('button', { name: ko['explain.action.retry_run'] })
    await user.click(retry)
    expect(focused()).toBe(screen.getByRole('button', { name: ko['explain.confirm.yes'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.confirm.no'] }))
    expect(focused()).toBe(retry)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('goes back to the action after a yes, and an action that does not ask never moves focus', async () => {
    const { user, onAction } = show()
    const deactivate = screen.getByRole('button', { name: ko['explain.action.deactivate_workflow'] })
    await user.click(deactivate)
    await user.click(screen.getByRole('button', { name: ko['explain.confirm.yes'] }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(focused()).toBe(deactivate)
    const open = screen.getByRole('button', { name: ko['explain.action.open_connections'] })
    await user.click(open)
    expect(focused()).toBe(open)
  })

  it('takes no focus when it first appears', () => {
    show()
    expect(focused()).toBe(document.body)
  })
})
