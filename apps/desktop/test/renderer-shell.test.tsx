import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Locale } from '../src/i18n'
import { SHELL_MESSAGES, createShellTranslator } from '../src/renderer-shell/messages'
import { StatusPage, type PingClient } from '../src/renderer-shell/StatusPage'
import { ThemeProvider } from '../src/theme/ThemeProvider'
import { HostError, type EngineInfo, type EngineStatus, type HostApi } from '../src/shared/host-api'

const TOKEN = 'shell-token-SECRET-0123456789'
const INFO: EngineInfo = { url: 'ws://127.0.0.1:43000/', token: TOKEN, protocol: 1 }

function themed(ui: ReactElement, locale: Locale) {
  return render(
    <ThemeProvider theme="light" locale={locale}>
      {ui}
    </ThemeProvider>,
  )
}

function fakeHost(options: { info?: () => Promise<EngineInfo> } = {}) {
  const listeners = new Set<(status: EngineStatus) => void>()
  const unsubscribed: number[] = []
  const host: Pick<HostApi, 'engine'> = {
    engine: {
      info: vi.fn(options.info ?? (async () => INFO)),
      restart: vi.fn(async () => undefined),
      onStatus: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          unsubscribed.push(1)
        }
      },
    },
  }
  return { host, emit: (status: EngineStatus) => listeners.forEach((listener) => listener(status)), listeners, unsubscribed }
}

function fakeConnect(options: { fail?: boolean; pingFails?: boolean } = {}) {
  const clients: Array<PingClient & { closed: boolean }> = []
  const infos: EngineInfo[] = []
  const connect = vi.fn(async (info: EngineInfo) => {
    infos.push(info)
    if (options.fail === true) throw new Error(`connect failed ${TOKEN}`)
    const client = {
      closed: false,
      request: vi.fn(async () => {
        if (options.pingFails === true) throw new Error('no answer')
        return { time: 1 }
      }),
      close() {
        client.closed = true
      },
    }
    clients.push(client)
    return client
  })
  return { connect, clients, infos }
}

let clock = 0
const now = () => (clock += 12)

describe('renderer shell: without the app', () => {
  it.each([
    ['ko', '앱 안에서 실행해 주세요'],
    ['en', 'Run this page inside the Rill app.'],
  ] as const)('tells the user to run it inside the app (%s)', (locale, text) => {
    const { connect } = fakeConnect()
    const view = themed(<StatusPage host={undefined} connect={connect} now={now} />, locale)
    expect(view.container.textContent).toContain(text)
    expect(view.container.querySelector('[data-rill-ping]')).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('renderer shell: with the app', () => {
  it('shows the engine as running with the ping time, and exposes the result for the smoke check', async () => {
    const { host } = fakeHost()
    const { connect, clients, infos } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).not.toBeNull())
    const output = view.container.querySelector('[data-rill-ping]')!
    expect(output.getAttribute('data-rill-ping-ms')).toBe('12')
    expect(output.textContent).toBe('12 ms')
    expect(view.container.textContent).toContain('Running')
    expect(infos).toEqual([INFO])
    expect(clients[0]!.request).toHaveBeenCalledWith('ping', {})
  })

  it('never shows the engine token or address', async () => {
    const { host } = fakeHost()
    const { connect } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).not.toBeNull())
    expect(view.container.innerHTML).not.toContain('SECRET')
    expect(view.container.innerHTML).not.toContain('43000')
  })

  it('shows the state words in Korean', async () => {
    const { host, emit } = fakeHost()
    const { connect } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'ko')
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).not.toBeNull())
    expect(view.container.textContent).toContain('실행 중')
    act(() => emit({ state: 'restarting', restarts: 1 }))
    expect(view.container.textContent).toContain('다시 시작하는 중')
  })

  it('goes back to pending when the engine restarts, and measures again when it runs', async () => {
    const { host, emit } = fakeHost()
    const { connect, clients } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).not.toBeNull())
    act(() => emit({ state: 'restarting', restarts: 1 }))
    expect(view.container.querySelector('[data-rill-ping="pending"]')).not.toBeNull()
    expect(clients[0]!.closed).toBe(true)
    expect(view.container.textContent).toContain('Restarting')
    act(() => emit({ state: 'running', restarts: 1 }))
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).not.toBeNull())
    expect(connect).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('1')
  })

  it.each([
    ['crashed', 'stopped after repeated crashes'],
    ['start_timeout', 'did not start in time'],
    ['no_keychain', 'no system keychain'],
  ] as const)('shows a stopped engine with the reason %s', async (error, text) => {
    const { host, emit } = fakeHost()
    const { connect } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    act(() => emit({ state: 'stopped', error, restarts: 5 }))
    expect(view.container.textContent).toContain('Stopped')
    expect(view.container.textContent?.toLowerCase()).toContain(text)
    expect(view.container.querySelector('[data-rill-ping="ok"]')).toBeNull()
  })

  it('shows an error when the engine cannot be reached', async () => {
    const { host } = fakeHost()
    const { connect } = fakeConnect({ fail: true })
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="error"]')).not.toBeNull())
    expect(view.container.innerHTML).not.toContain('SECRET')
    expect(view.container.querySelector('[data-rill-ping-ms]')).toBeNull()
  })

  it('shows an error when the ping gets no answer, and when info is unavailable', async () => {
    const answerless = fakeConnect({ pingFails: true })
    const first = themed(<StatusPage host={fakeHost().host} connect={answerless.connect} now={now} />, 'en')
    await waitFor(() => expect(first.container.querySelector('[data-rill-ping="error"]')).not.toBeNull())
    expect(answerless.clients[0]!.closed).toBe(true)
    first.unmount()
    const unavailable = fakeHost({ info: async () => Promise.reject(new HostError('ENGINE_UNAVAILABLE')) })
    const second = themed(<StatusPage host={unavailable.host} connect={fakeConnect().connect} now={now} />, 'en')
    await waitFor(() => expect(second.container.querySelector('[data-rill-ping="error"]')).not.toBeNull())
  })

  it('unsubscribes from status events and closes the client when it goes away', async () => {
    const { host, unsubscribed, listeners } = fakeHost()
    const { connect, clients } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    await waitFor(() => expect(view.container.querySelector('[data-rill-ping="ok"]')).not.toBeNull())
    view.unmount()
    expect(unsubscribed).toHaveLength(1)
    expect(listeners.size).toBe(0)
    expect(clients[0]!.closed).toBe(true)
  })

  it('closes a client that connected after the page was gone', async () => {
    let release: (info: EngineInfo) => void = () => undefined
    const { host } = fakeHost({ info: () => new Promise<EngineInfo>((resolve) => (release = resolve)) })
    const { connect, clients } = fakeConnect()
    const view = themed(<StatusPage host={host} connect={connect} now={now} />, 'en')
    view.unmount()
    await act(async () => {
      release(INFO)
      await Promise.resolve()
    })
    expect(clients.every((client) => client.closed)).toBe(true)
  })

  it('announces the state politely for screen readers', async () => {
    const { host } = fakeHost()
    const view = themed(<StatusPage host={host} connect={fakeConnect().connect} now={now} />, 'en')
    const live = view.container.querySelector('[aria-live="polite"]')!
    expect(live.getAttribute('data-state')).toBe('starting')
    await waitFor(() => expect(live.textContent).toBe('Running'))
    expect(screen.getByRole('status').textContent).toBe('12 ms')
  })
})

describe('renderer shell: messages', () => {
  it('have the same keys in Korean and English, and no empty text', () => {
    expect(Object.keys(SHELL_MESSAGES.ko).sort()).toEqual(Object.keys(SHELL_MESSAGES.en).sort())
    for (const text of [...Object.values(SHELL_MESSAGES.ko), ...Object.values(SHELL_MESSAGES.en)]) expect(text.trim()).not.toBe('')
  })

  it('fill placeholders and fall back to the key for an unknown one', () => {
    const t = createShellTranslator('en')
    expect(t('shell.ping.ok', { ms: 12 })).toBe('12 ms')
    expect(t('shell.nope' as never)).toBe('shell.nope')
  })
})
