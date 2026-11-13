import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar, type TopBarProps } from '../src/app/TopBar'
import { createTranslator } from '../src/i18n'
import { violations } from './axe'
import { renderThemed } from './render'

afterEach(cleanup)

const t = createTranslator('en')

function props(overrides: Partial<TopBarProps> = {}): TopBarProps {
  return {
    tab: 'workflows',
    onTab: () => undefined,
    connection: { state: 'connected', status: { state: 'running', restarts: 0 } },
    ping: { state: 'ok', ms: 3 },
    onRestart: () => undefined,
    chatOpen: false,
    onToggleChat: () => undefined,
    ...overrides,
  }
}

function bar(overrides: Partial<TopBarProps> = {}) {
  return renderThemed(<TopBar {...props(overrides)} />, { locale: 'en' })
}

const NOT_CONNECTED: Array<[string, TopBarProps['connection'], string]> = [
  ['connecting', { state: 'connecting' }, t('app.top.engine.connecting')],
  ['reconnecting', { state: 'reconnecting' }, t('app.top.engine.reconnecting')],
  ['restarting', { state: 'reconnecting', status: { state: 'restarting', restarts: 1 } }, t('app.top.engine.restarting')],
  ['stopped', { state: 'engine_stopped', status: { state: 'stopped', error: 'crashed', restarts: 6 } }, t('app.top.engine.stopped')],
  ['no host', { state: 'no_host' }, t('app.top.engine.noHost')],
]

describe('top bar when the engine is connected', () => {
  it('shows a small dot with the accessible name and the tooltip "Engine connected", and no chip text', () => {
    const { container } = bar()
    const status = screen.getByRole('status')
    expect(status.getAttribute('title')).toBe(t('app.top.engine.connected'))
    expect(status.textContent).toBe(t('app.top.engine.connected'))
    expect(status.querySelector('[data-rill-dot]')).not.toBeNull()
    expect(status.querySelector('[data-rill-dot]')?.getAttribute('aria-hidden')).toBe('true')
    expect(status.getAttribute('data-state')).toBe('connected')
    expect(container.querySelector('[data-rill-chip]')).toBeNull()
    expect(screen.getByText(t('app.top.engine.connected')).className).toMatch(/hidden/i)
  })

  it('keeps the ping attributes and the live region', () => {
    bar({ ping: { state: 'ok', ms: 7 } })
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('data-rill-ping')).toBe('ok')
    expect(status.getAttribute('data-rill-ping-ms')).toBe('7')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('has no restart button, no reason, no external transfer badge and no model text', () => {
    const { container } = bar()
    expect(screen.queryByRole('button', { name: t('app.top.engine.restart') })).toBeNull()
    expect(container.textContent).not.toContain(t('badge.externalTransfer'))
    expect(container.textContent).not.toMatch(/Anthropic|claude|model/i)
    expect(container.querySelector('[class*="transfer"]')).toBeNull()
  })
})

describe('top bar when the engine is not connected', () => {
  it.each(NOT_CONNECTED)('shows the text chip for %s', (_name, connection, text) => {
    const { container } = bar({ connection })
    const status = screen.getByRole('status')
    expect(status.textContent).toBe(text)
    expect(status.getAttribute('data-state')).toBe(connection.state)
    expect(status.querySelector('[data-rill-dot]')).toBeNull()
    expect(container.querySelector('[data-rill-chip]')).toBe(status)
    expect(status.getAttribute('title')).toBeNull()
    expect(container.textContent).not.toContain(t('badge.externalTransfer'))
  })

  it('shows the reason and the restart button when stopped, and calls onRestart', async () => {
    const onRestart = vi.fn()
    bar({ connection: { state: 'engine_stopped', status: { state: 'stopped', error: 'start_timeout', restarts: 1 } }, onRestart })
    expect(screen.getByText(t('app.engine.error.start_timeout'))).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: t('app.top.engine.restart') }))
    expect(onRestart).toHaveBeenCalledOnce()
  })

  it('disables the restart button while a restart is in progress', () => {
    bar({ connection: { state: 'engine_stopped', status: { state: 'stopped', restarts: 1 } }, restarting: true })
    expect((screen.getByRole('button', { name: t('app.top.engine.restart') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has no restart button while connecting, reconnecting or restarting', () => {
    for (const [, connection] of NOT_CONNECTED.filter(([name]) => name !== 'stopped')) {
      const view = bar({ connection })
      expect(screen.queryByRole('button', { name: t('app.top.engine.restart') })).toBeNull()
      view.unmount()
    }
  })
})

describe('top bar structure', () => {
  it('keeps the banner region, the screens navigation, the tab state and the keyboard order', async () => {
    const onTab = vi.fn()
    const onToggleChat = vi.fn()
    bar({ onTab, onToggleChat, tab: 'recipes' })
    const banner = screen.getByRole('banner', { name: t('app.region.top') })
    const nav = within(banner).getByRole('navigation', { name: t('app.top.screens') })
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['Workflows', 'Recipes', 'Agents', 'Settings'])
    expect(within(nav).getByRole('button', { name: 'Recipes' }).getAttribute('aria-current')).toBe('page')
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement).toBe(within(nav).getByRole('button', { name: 'Workflows' }))
    await user.tab()
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('app.top.chat.open') }))
    await user.keyboard('{Enter}')
    expect(onToggleChat).toHaveBeenCalledOnce()
    await user.click(within(nav).getByRole('button', { name: 'Settings' }))
    expect(onTab).toHaveBeenCalledWith('settings')
  })

  it('keeps the chat toggle state in aria-expanded', () => {
    bar({ chatOpen: true })
    expect(screen.getByRole('button', { name: t('app.top.chat.close') }).getAttribute('aria-expanded')).toBe('true')
  })

  it('has no axe violations in any engine state', async () => {
    const states: Array<TopBarProps['connection']> = [{ state: 'connected', status: { state: 'running', restarts: 0 } }, ...NOT_CONNECTED.map(([, connection]) => connection)]
    for (const connection of states) {
      const { container, unmount } = bar({ connection })
      expect(await violations(container), connection.state).toEqual([])
      unmount()
    }
  })
})

describe('TopBar brand', () => {
  it('shows the logo before the name, hidden from assistive technology, and keeps the name as its text', () => {
    bar()
    const header = screen.getByRole('banner')
    const brand = within(header).getByText(t('app.name')).closest('strong')
    expect(brand).not.toBeNull()
    const logo = brand!.querySelector('svg')
    expect(logo).not.toBeNull()
    expect(logo!.getAttribute('aria-hidden')).toBe('true')
    expect(logo!.getAttribute('data-rill-logo')).toBe('small')
    expect(brand!.firstElementChild).toBe(logo)
    expect(brand!.textContent).toBe(t('app.name'))
  })
})
