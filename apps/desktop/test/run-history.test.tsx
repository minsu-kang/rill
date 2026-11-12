import type { RunSummary } from '@rill/protocol'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { fixtureRuns, FIXTURE_NOW, ids } from '../src/fixtures'
import { ko } from '../src/i18n/ko'
import { RunHistory } from '../src/runs/RunHistory'
import { errorsDuring } from './errors'
import { renderThemed } from './render'

const run = (id: string): RunSummary => fixtureRuns.find((item) => item.id === id)!

describe('RunHistory', () => {
  it('shows the status of every run as text and as a named icon', () => {
    const runs = [ids.runs.receiptQueued, ids.runs.branchingRunning, ids.runs.receiptOk, ids.runs.receiptFailed, ids.runs.webhookCancelled].map(run)
    renderThemed(<RunHistory runs={runs} now={FIXTURE_NOW} />)
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      const label = ko[`run.status.${status}`]
      expect(screen.getAllByText(label).length, status).toBeGreaterThan(0)
      expect(screen.getAllByRole('img', { name: label }).length, status).toBeGreaterThan(0)
    }
  })

  it('tags a dry run and only a dry run', () => {
    renderThemed(<RunHistory runs={[run(ids.runs.webhookDry), run(ids.runs.receiptOk)]} now={FIXTURE_NOW} />)
    expect(screen.getAllByText(ko['run.dryRun'])).toHaveLength(1)
    const [dry, normal] = screen.getAllByRole('listitem')
    expect(within(dry!).getByText(ko['run.dryRun'])).toBeTruthy()
    expect(within(normal!).queryByText(ko['run.dryRun'])).toBeNull()
  })

  it('shows the relative time from the now prop', () => {
    renderThemed(<RunHistory runs={[run(ids.runs.receiptQueued), run(ids.runs.receiptOk), run(ids.runs.branchingSkipped)]} now={FIXTURE_NOW} timeZone="UTC" />)
    expect(screen.getByText('1분 전')).toBeTruthy()
    expect(screen.getByText('1일 전')).toBeTruthy()
    expect(screen.getByText('1시간 전')).toBeTruthy()
  })

  it('keeps the order it was given', () => {
    const runs = [run(ids.runs.receiptOk), run(ids.runs.receiptQueued), run(ids.runs.receiptFailed)]
    renderThemed(<RunHistory runs={runs} now={FIXTURE_NOW} />)
    const labels = screen.getAllByRole('button').map((button) => button.textContent)
    expect(labels[0]).toContain(ko['run.status.succeeded'])
    expect(labels[1]).toContain(ko['run.status.queued'])
    expect(labels[2]).toContain(ko['run.status.failed'])
  })

  it('selects a run on click and marks the current one with aria-current', () => {
    const onSelect = vi.fn()
    renderThemed(<RunHistory runs={[run(ids.runs.receiptOk), run(ids.runs.receiptFailed)]} selectedRunId={ids.runs.receiptFailed} now={FIXTURE_NOW} onSelect={onSelect} />)
    const [first, second] = screen.getAllByRole('button')
    expect(first!.getAttribute('aria-current')).toBeNull()
    expect(second!.getAttribute('aria-current')).toBe('true')
    fireEvent.click(first!)
    expect(onSelect).toHaveBeenCalledWith(ids.runs.receiptOk)
  })

  it('selects a run from the keyboard with Enter and with Space', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    renderThemed(<RunHistory runs={[run(ids.runs.receiptOk), run(ids.runs.receiptFailed)]} now={FIXTURE_NOW} onSelect={onSelect} />)
    await user.tab()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith(ids.runs.receiptOk)
    await user.tab()
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenLastCalledWith(ids.runs.receiptFailed)
  })

  it('shows the empty message and the heading when there are no runs', () => {
    renderThemed(<RunHistory runs={[]} now={FIXTURE_NOW} />)
    expect(screen.getByText(ko['history.empty'])).toBeTruthy()
    expect(screen.getByRole('heading', { name: ko['history.heading'] })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows the start of a failed run error, cut, and the rest only in a title', () => {
    const failed = run(ids.runs.receiptFailed)
    const { container } = renderThemed(<RunHistory runs={[failed]} now={FIXTURE_NOW} />)
    const text = container.textContent!
    expect(text).toContain('node extract failed: provider error: 503')
    expect(text.length).toBeLessThan(failed.error!.length)
  })

  it('shows a hostile error as text only', () => {
    const hostile: RunSummary = { ...run(ids.runs.receiptFailed), error: '<img src=x onerror=alert(1)><script>y</script>' }
    const { container } = renderThemed(<RunHistory runs={[hostile]} now={FIXTURE_NOW} />)
    expect(container.textContent).toContain('<img src=x onerror=alert(1)><script>y</script>')
    expect(container.querySelector('img, script, a')).toBeNull()
  })

  it('writes a hidden character of an error as a visible code point in the text and in the title', () => {
    const tricky: RunSummary = { ...run(ids.runs.receiptFailed), error: 'cannot open invoice \u202etxt.exe' }
    const { container } = renderThemed(<RunHistory runs={[tricky]} now={FIXTURE_NOW} />)
    expect(container.textContent).toContain('cannot open invoice ‹U+202E›txt.exe')
    expect(container.textContent).not.toContain('\u202e')
    expect(container.querySelector('[title]:not([title^="run"])')).not.toBeNull()
    for (const item of container.querySelectorAll('[title]')) expect(item.getAttribute('title')).not.toContain('\u202e')
  })

  it('works in English', () => {
    renderThemed(<RunHistory runs={[run(ids.runs.receiptQueued)]} now={FIXTURE_NOW} />, { locale: 'en' })
    expect(screen.getByText('Queued')).toBeTruthy()
    expect(screen.getByText('1 min ago')).toBeTruthy()
  })
})

describe('RunHistory details', () => {
  const make = (extra: Partial<RunSummary>): RunSummary => ({ ...run(ids.runs.receiptOk), ...extra })

  it('can be clicked without a handler', () => {
    renderThemed(<RunHistory runs={[make({})]} now={FIXTURE_NOW} />)
    expect(errorsDuring(() => fireEvent.click(screen.getByRole('button')))).toEqual([])
  })

  it('cuts an error at 90 characters and an id at 28 and not a character sooner', () => {
    const whole = renderThemed(<RunHistory runs={[make({ id: 'i'.repeat(28), status: 'failed', error: 'e'.repeat(90) })]} now={FIXTURE_NOW} />)
    expect(whole.container.textContent).toContain('i'.repeat(28))
    expect(whole.container.textContent).toContain('e'.repeat(90))
    expect(whole.container.textContent).not.toContain('…')
    whole.unmount()
    const cut = renderThemed(<RunHistory runs={[make({ id: 'i'.repeat(29), status: 'failed', error: 'e'.repeat(91) })]} now={FIXTURE_NOW} />)
    expect(cut.container.textContent).toContain(`${'i'.repeat(27)}…`)
    expect(cut.container.textContent).toContain(`${'e'.repeat(89)}…`)
  })

  it('keeps the whole id and the whole error in titles', () => {
    const id = 'i'.repeat(40)
    const error = 'e'.repeat(200)
    const { container } = renderThemed(<RunHistory runs={[make({ id, status: 'failed', error })]} now={FIXTURE_NOW} />)
    expect(container.querySelector(`[title="${id}"]`)).not.toBeNull()
    expect(container.querySelector(`[title="${error}"]`)).not.toBeNull()
  })

  it('draws each run status with the chip that looks like it', () => {
    const expected = { queued: 'idle', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'abandoned' } as const
    for (const [status, chip] of Object.entries(expected)) {
      const { container, unmount } = renderThemed(<RunHistory runs={[make({ status: status as RunSummary['status'] })]} now={FIXTURE_NOW} />)
      expect(container.querySelector('[data-status]')!.getAttribute('data-status'), status).toBe(chip)
      unmount()
    }
  })

  it('counts the time from the moment the run was created', () => {
    renderThemed(<RunHistory runs={[make({ createdAt: FIXTURE_NOW - 5 * 60_000, startedAt: FIXTURE_NOW - 60_000 })]} now={FIXTURE_NOW} />)
    expect(screen.getByText('5분 전')).toBeTruthy()
  })

  it('keeps the exact date in a title, in the language and time zone given', () => {
    const only = [make({ createdAt: FIXTURE_NOW })]
    const first = renderThemed(<RunHistory runs={only} now={FIXTURE_NOW} timeZone="UTC" />)
    expect(screen.getByText('방금').getAttribute('title')).toBe('2026. 11. 13. 오전 9:30:00')
    first.unmount()
    const second = renderThemed(<RunHistory runs={only} now={FIXTURE_NOW} timeZone="Asia/Seoul" />)
    expect(screen.getByText('방금').getAttribute('title')).toBe('2026. 11. 13. 오후 6:30:00')
    second.unmount()
    renderThemed(<RunHistory runs={only} now={FIXTURE_NOW} timeZone="UTC" />, { locale: 'en' })
    expect(screen.getByText('Just now').getAttribute('title')).toMatch(/^Nov 13, 2026, 9:30:00\sAM$/)
  })

  it('does not warn about keys when two runs share a status', () => {
    const runs = [make({ id: 'a' }), make({ id: 'b' })]
    expect(errorsDuring(() => renderThemed(<RunHistory runs={runs} now={FIXTURE_NOW} />))).toEqual([])
  })
})
