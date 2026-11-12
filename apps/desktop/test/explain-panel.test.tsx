import { RillError, type ExplainEffort, type RunSummary } from '@rill/protocol'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withExplainMethod } from '../src/engine/fake-explain'
import { ExplainPanel, type ExplainPanelProps } from '../src/explain/ExplainPanel'
import { fakeData, fixtureRuns, ids } from '../src/fixtures'
import { explainCases } from '../src/fixtures/explain'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations } from './axe'
import { manualExplainClient } from './explain-helpers'
import { renderThemed } from './render'

const run = (id: string): RunSummary => fixtureRuns.find((item) => item.id === id)!
const FAILED = run(ids.runs.receiptFailed)
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-5' }

function setup(overrides: Partial<ExplainPanelProps> = {}) {
  const manual = manualExplainClient()
  const onAction = vi.fn()
  const onProposeFix = vi.fn()
  const props: ExplainPanelProps = { client: manual.client, run: FAILED, model: MODEL, onAction, onProposeFix, ...overrides }
  const view = renderThemed(<ExplainPanel {...props} />)
  return { ...manual, onAction, onProposeFix, props, view, user: userEvent.setup() }
}

const ask = () => screen.getByRole('button', { name: ko['explain.ask'] })

describe('ExplainPanel button', () => {
  it('is enabled for a failed run only', () => {
    setup()
    expect((ask() as HTMLButtonElement).disabled).toBe(false)
  })

  it('is visible but disabled with a reason for every other status', () => {
    for (const [id, status] of [[ids.runs.receiptQueued, 'queued'], [ids.runs.branchingRunning, 'running'], [ids.runs.receiptOk, 'succeeded'], [ids.runs.webhookCancelled, 'cancelled']] as const) {
      const view = renderThemed(<ExplainPanel client={manualExplainClient().client} run={run(id)} onAction={vi.fn()} onProposeFix={vi.fn()} />)
      const button = screen.getByRole('button', { name: ko['explain.ask'] }) as HTMLButtonElement
      expect(button.disabled, status).toBe(true)
      expect(button.getAttribute('aria-describedby'), status).toBeTruthy()
      expect(screen.getByText(ko[`explain.reason.${status}`]), status).toBeTruthy()
      view.unmount()
    }
  })

  it('is disabled with a reason when there is no run', () => {
    renderThemed(<ExplainPanel client={manualExplainClient().client} run={undefined} onAction={vi.fn()} onProposeFix={vi.fn()} />)
    expect((ask() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(ko['explain.reason.none'])).toBeTruthy()
  })

  it('sends nothing for a click on a disabled button', async () => {
    const { client, requests } = manualExplainClient()
    renderThemed(<ExplainPanel client={client} run={run(ids.runs.receiptOk)} onAction={vi.fn()} onProposeFix={vi.fn()} />)
    await userEvent.setup().click(ask())
    expect(requests).toEqual([])
  })
})

describe('ExplainPanel notice', () => {
  it('opens on the first click, names the provider and model and sends nothing yet', async () => {
    const { user, requests } = setup()
    await user.click(ask())
    const notice = screen.getByRole('group', { name: ko['explain.notice.heading'] })
    expect(within(notice).getByText(ko['explain.notice.body'])).toBeTruthy()
    expect(within(notice).getByText('보내는 곳: anthropic · claude-sonnet-5')).toBeTruthy()
    expect(requests).toEqual([])
  })

  it('says so when the provider and model are not known', async () => {
    const { user } = setup({ model: undefined })
    await user.click(ask())
    expect(screen.getByText(ko['explain.notice.targetUnknown'])).toBeTruthy()
  })

  it('cancels without a request', async () => {
    const { user, requests } = setup()
    await user.click(ask())
    await user.click(screen.getByRole('button', { name: ko['explain.notice.cancel'] }))
    expect(screen.queryByRole('group', { name: ko['explain.notice.heading'] })).toBeNull()
    expect(ask()).toBeTruthy()
    expect(requests).toEqual([])
  })

  it('sends explainRun with the chosen effort', async () => {
    const { user, calls } = setup()
    await user.selectOptions(screen.getByLabelText(ko['explain.effort.label']), 'high')
    await user.click(ask())
    expect(screen.getByText('설명 깊이: 꼼꼼히')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual({ runId: FAILED.id, effort: 'high' })
  })

  it('offers only low, medium and high and starts at medium', () => {
    setup()
    const select = screen.getByLabelText(ko['explain.effort.label']) as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['low', 'medium', 'high'])
    expect(select.value).toBe('medium')
  })

  it('skips the notice for later asks in the same mount when the box was ticked, and forgets on remount', async () => {
    const { user, calls, view, props } = setup()
    await user.click(ask())
    await user.click(screen.getByRole('checkbox', { name: ko['explain.notice.skip'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    await user.click(screen.getByRole('button', { name: ko['explain.askAgain'] }))
    expect(screen.queryByRole('group', { name: ko['explain.notice.heading'] })).toBeNull()
    expect(calls).toHaveLength(2)
    await act(async () => calls[1]!.resolve(explainCases.unknown))
    view.rerender(<ExplainPanel {...props} run={run(ids.runs.receiptFailed)} />)
    view.unmount()
    renderThemed(<ExplainPanel {...props} />)
    await user.click(ask())
    expect(screen.getByRole('group', { name: ko['explain.notice.heading'] })).toBeTruthy()
    expect(calls).toHaveLength(2)
  })

  it('shows the notice again for each ask when the box was not ticked', async () => {
    const { user, calls } = setup()
    await user.click(ask())
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    await user.click(screen.getByRole('button', { name: ko['explain.askAgain'] }))
    expect(screen.getByRole('group', { name: ko['explain.notice.heading'] })).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: ko['explain.notice.skip'] }) as HTMLInputElement).checked).toBe(false)
  })

  it('comes back when the provider or the model changes', async () => {
    const { user, calls, view, props } = setup()
    await user.click(ask())
    await user.click(screen.getByRole('checkbox', { name: ko['explain.notice.skip'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    await user.click(screen.getByRole('button', { name: ko['explain.dismiss'] }))
    view.rerender(<ExplainPanel {...props} model={{ provider: 'openai', model: 'gpt-x' }} />)
    await user.click(ask())
    expect(screen.getByRole('group', { name: ko['explain.notice.heading'] })).toBeTruthy()
    expect(screen.getByText('보내는 곳: openai · gpt-x')).toBeTruthy()
    expect(calls).toHaveLength(1)
  })

  it('has no axe violations in the idle, notice and disabled states', async () => {
    const { user, view } = setup()
    expect(await violations(view.container)).toEqual([])
    await user.click(ask())
    expect(await violations(view.container)).toEqual([])
    const other = renderThemed(<ExplainPanel client={manualExplainClient().client} run={run(ids.runs.receiptOk)} onAction={vi.fn()} onProposeFix={vi.fn()} />)
    expect(await violations(other.container)).toEqual([])
  })

  it('is shown in English too', async () => {
    const manual = manualExplainClient()
    renderThemed(<ExplainPanel client={manual.client} run={FAILED} model={MODEL} onAction={vi.fn()} onProposeFix={vi.fn()} />, { locale: 'en' })
    await userEvent.setup().click(screen.getByRole('button', { name: en['explain.ask'] }))
    expect(screen.getByText(en['explain.notice.body'])).toBeTruthy()
  })
})

describe('ExplainPanel while asking and after', () => {
  async function asking() {
    const ctx = setup()
    await ctx.user.click(ask())
    await ctx.user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    return ctx
  }

  it('shows progress, says the answer is discarded when dismissed and keeps the request open', async () => {
    const { user, calls } = await asking()
    expect(screen.getByRole('status').textContent).toContain(ko['explain.progress'])
    expect(screen.getByText(ko['explain.dismissWarning'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.dismiss'] }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(ask()).toBeTruthy()
    await act(async () => calls[0]!.resolve(explainCases.unknown))
    expect(screen.queryByText(explainCases.unknown.explanation)).toBeNull()
  })

  it('shows the card when the answer arrives', async () => {
    const { calls } = await asking()
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    expect(screen.getByText(explainCases.credentials.explanation)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the notice and a retry button for every error key and retries with the same effort', async () => {
    const codes: Array<[string, keyof typeof ko]> = [
      ['NOT_FOUND', 'explain.error.notFound'],
      ['RUN_NOT_EXPLAINABLE', 'explain.error.notExplainable'],
      ['LLM_UNAVAILABLE', 'explain.error.llmUnavailable'],
      ['EXPLAIN_BUSY', 'explain.error.busy'],
      ['EXPLAIN_PROVIDER', 'explain.error.provider'],
      ['EXPLAIN_INVALID', 'explain.error.invalid'],
      ['INVALID_PARAMS', 'explain.error.params'],
      ['INTERNAL', 'explain.error.generic'],
    ]
    for (const [code, key] of codes) {
      const manual = manualExplainClient()
      const user = userEvent.setup()
      const view = renderThemed(<ExplainPanel client={manual.client} run={FAILED} model={MODEL} onAction={vi.fn()} onProposeFix={vi.fn()} />)
      await user.selectOptions(screen.getByLabelText(ko['explain.effort.label']), 'low')
      await user.click(ask())
      await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
      await act(async () => manual.calls[0]!.reject(new RillError(code, 'SERVER-TEXT-MARKER')))
      expect(screen.getByRole('alert').textContent, code).toBe(ko[key])
      expect(view.container.textContent, code).not.toContain('SERVER-TEXT-MARKER')
      await user.click(screen.getByRole('button', { name: ko['explain.retry'] }))
      expect(manual.calls, code).toHaveLength(2)
      expect(manual.calls[1]!.params, code).toEqual({ runId: FAILED.id, effort: 'low' })
      view.unmount()
    }
  })

  it('shows the notice again and sends nothing when Retry follows a change of provider', async () => {
    const manual = manualExplainClient()
    const user = userEvent.setup()
    const props = { client: manual.client, run: FAILED, onAction: vi.fn(), onProposeFix: vi.fn() }
    const view = renderThemed(<ExplainPanel {...props} model={MODEL} />)
    await user.click(ask())
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    await act(async () => manual.calls[0]!.reject(new RillError('LLM_UNAVAILABLE', 'x')))
    view.rerender(<ExplainPanel {...props} model={{ provider: 'openai', model: 'gpt-x' }} />)
    await user.click(screen.getByRole('button', { name: ko['explain.retry'] }))
    expect(manual.calls).toHaveLength(1)
    expect(screen.getByRole('group', { name: ko['explain.notice.heading'] })).toBeTruthy()
    expect(screen.getByText('보내는 곳: openai · gpt-x')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    expect(manual.calls).toHaveLength(2)
    expect(manual.calls[1]!.params).toEqual({ runId: FAILED.id, effort: 'medium' })
  })

  it('retries at once when the provider did not change, also after a later change back', async () => {
    const manual = manualExplainClient()
    const user = userEvent.setup()
    const props = { client: manual.client, run: FAILED, onAction: vi.fn(), onProposeFix: vi.fn() }
    const view = renderThemed(<ExplainPanel {...props} model={MODEL} />)
    await user.click(ask())
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    await act(async () => manual.calls[0]!.reject(new RillError('INTERNAL', 'x')))
    view.rerender(<ExplainPanel {...props} model={{ provider: MODEL.provider, model: 'other-model' }} />)
    view.rerender(<ExplainPanel {...props} model={MODEL} />)
    await user.click(screen.getByRole('button', { name: ko['explain.retry'] }))
    expect(manual.calls).toHaveLength(2)
    expect(screen.queryByRole('group', { name: ko['explain.notice.heading'] })).toBeNull()
  })

  it('hands the run on screen to onAction even when the answer names another run', async () => {
    const { user, calls, onAction } = await asking()
    await act(async () => calls[0]!.resolve({ ...explainCases.threeActions, runId: 'run-from-the-server' }))
    await user.click(screen.getByRole('button', { name: ko['explain.action.retry_run'] }))
    await user.click(screen.getByRole('button', { name: ko['explain.confirm.yes'] }))
    expect(onAction).toHaveBeenCalledWith('retry_run', { runId: FAILED.id, nodeId: 'alert' })
  })

  it('works end to end with the fake explain method', async () => {
    const client = withExplainMethod(createFakeClient(fakeData), () => explainCases.design)
    const user = userEvent.setup()
    renderThemed(<ExplainPanel client={client} run={FAILED} model={MODEL} onAction={vi.fn()} onProposeFix={vi.fn()} />)
    await user.click(ask())
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    expect(await screen.findByText(explainCases.design.explanation)).toBeTruthy()
  })

  it('sends the effort the fake validates', async () => {
    const seen: ExplainEffort[] = []
    const client = withExplainMethod(createFakeClient(fakeData), (params) => {
      seen.push(params.effort!)
      return explainCases.unknown
    })
    const user = userEvent.setup()
    renderThemed(<ExplainPanel client={client} run={FAILED} model={MODEL} onAction={vi.fn()} onProposeFix={vi.fn()} />)
    await user.click(ask())
    await user.click(screen.getByRole('button', { name: ko['explain.notice.send'] }))
    await screen.findByText(explainCases.unknown.explanation)
    expect(seen).toEqual(['medium'])
  })

  it('never calls onAction or onProposeFix by itself', async () => {
    const { calls, onAction, onProposeFix } = await asking()
    await act(async () => calls[0]!.resolve(explainCases.threeActions))
    expect(onAction).not.toHaveBeenCalled()
    expect(onProposeFix).not.toHaveBeenCalled()
  })

  it('keeps the click handler of the disabled reason out of the way', () => {
    setup({ run: run(ids.runs.receiptOk) })
    fireEvent.click(ask())
    expect(screen.queryByRole('group', { name: ko['explain.notice.heading'] })).toBeNull()
  })
})
