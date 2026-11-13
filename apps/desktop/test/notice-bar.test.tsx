import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NoticeBar } from '../src/app/NoticeBar'
import { createTranslator } from '../src/i18n'
import { violations } from './axe'
import { renderThemed } from './render'

const t = createTranslator('en')

function show(notice: Parameters<typeof NoticeBar>[0]['notice'], onDismiss = vi.fn()) {
  const view = renderThemed(<NoticeBar notice={notice} onDismiss={onDismiss} />, { locale: 'en' })
  return { view, onDismiss, user: userEvent.setup() }
}

describe('NoticeBar', () => {
  it('shows nothing without a notice and keeps its live region', () => {
    show(undefined)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('shows the text and only a dismiss button for a notice without an action', async () => {
    const { onDismiss, user } = show({ id: 1, key: 'app.notice.deleted' })
    expect(screen.getByText(t('app.notice.deleted'))).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([t('app.notice.dismiss')])
    await user.click(buttons[0]!)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('shows the action before the dismiss button, runs it once and closes the notice', async () => {
    const run = vi.fn()
    const { onDismiss, user } = show({ id: 2, key: 'app.notice.reconnect', vars: { provider: 'Google' }, action: { key: 'app.notice.reconnect.action', run } })
    expect(screen.getByText('Your Google account needs to be connected again.')).toBeTruthy()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([t('app.notice.reconnect.action'), t('app.notice.dismiss')])
    await user.click(screen.getByRole('button', { name: t('app.notice.reconnect.action') }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not run the action when the notice is only dismissed', async () => {
    const run = vi.fn()
    const { onDismiss, user } = show({ id: 3, key: 'app.notice.reconnectBoth', action: { key: 'app.notice.reconnect.action', run } })
    await user.click(screen.getByRole('button', { name: t('app.notice.dismiss') }))
    expect(run).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('passes axe with an action', async () => {
    const { view } = show({ id: 4, key: 'app.notice.reconnect', vars: { provider: 'Microsoft' }, action: { key: 'app.notice.reconnect.action', run: () => undefined } })
    expect(await violations(view.container)).toEqual([])
  })
})
