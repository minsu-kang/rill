import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useEngineConnection, type ClockLike, type ConnectedClient, type ConnectionState } from '../src/app/connection'
import { createFakeHost } from '../src/engine/fake-host'
import type { EngineInfo } from '../src/shared/host-api'

const TOKEN = 'fake-engine-token'

function manualClock() {
  const timers: Array<{ id: number; fn: () => void; ms: number; live: boolean }> = []
  let next = 1
  const clock: ClockLike = {
    setTimeout(fn, ms) {
      const timer = { id: next++, fn, ms, live: true }
      timers.push(timer)
      return timer.id
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id)
      if (timer !== undefined) timer.live = false
    },
  }
  const pending = () => timers.filter((timer) => timer.live)
  async function fire(): Promise<number> {
    const timer = pending()[0]
    if (timer === undefined) throw new Error('no pending timer')
    timer.live = false
    await act(async () => {
      timer.fn()
    })
    return timer.ms
  }
  return { clock, pending, fire }
}

function fakeClient(): ConnectedClient & { closed: boolean; drop(): void; dropListeners: number } {
  const closers = new Set<(code: number, reason: string) => void>()
  const client = {
    closed: false,
    request: vi.fn(async () => ({})) as unknown as ConnectedClient['request'],
    onEvent: () => () => undefined,
    onClose(listener: (code: number, reason: string) => void) {
      closers.add(listener)
      return () => {
        closers.delete(listener)
      }
    },
    close() {
      client.closed = true
    },
    drop() {
      for (const listener of [...closers]) listener(1006, '')
    },
    get dropListeners() {
      return closers.size
    },
  }
  return client
}

function setup(options: { failures?: number; restartDelayMs?: number } = {}) {
  const host = createFakeHost({}, { restartDelayMs: options.restartDelayMs ?? 0 })
  const clients: Array<ReturnType<typeof fakeClient>> = []
  const infos: EngineInfo[] = []
  let failures = options.failures ?? 0
  const connect = vi.fn(async (url: string, token: string) => {
    infos.push({ url, token, protocol: 1 })
    if (failures > 0) {
      failures -= 1
      throw new Error(`connect failed ${token}`)
    }
    const client = fakeClient()
    clients.push(client)
    return client
  })
  const timers = manualClock()
  const view = renderHook(() => useEngineConnection(host, { connect, clock: timers.clock }))
  return { host, clients, infos, connect, timers, view, setFailures: (count: number) => (failures = count) }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

describe('useEngineConnection', () => {
  it('reports no_host without a host and never connects', () => {
    const connect = vi.fn()
    const view = renderHook(() => useEngineConnection(undefined, { connect }))
    expect(view.result.current).toMatchObject({ state: 'no_host', attempt: 0 })
    expect(view.result.current.client).toBeUndefined()
    expect(connect).not.toHaveBeenCalled()
  })

  it('connects with the address and the token from the host, going from connecting to connected', async () => {
    const { view, infos, clients } = setup()
    expect(view.result.current.state).toBe('connecting')
    await settle()
    expect(view.result.current.state).toBe('connected')
    expect(view.result.current.client).toBe(clients[0])
    expect(view.result.current.attempt).toBe(0)
    expect(infos).toEqual([{ url: 'ws://127.0.0.1:1/', token: TOKEN, protocol: 1 }])
  })

  it('retries after 1 s, 2 s, 4 s and then every 10 s while connecting fails, and counts the attempts', async () => {
    const { view, timers, setFailures, connect } = setup({ failures: 5 })
    await settle()
    expect(view.result.current).toMatchObject({ state: 'reconnecting', attempt: 1 })
    const delays: number[] = []
    for (let index = 0; index < 4; index += 1) {
      delays.push(await timers.fire())
      await settle()
    }
    expect(delays).toEqual([1000, 2000, 4000, 10_000])
    expect(view.result.current).toMatchObject({ state: 'reconnecting', attempt: 5 })
    setFailures(0)
    delays.push(await timers.fire())
    await settle()
    expect(delays[4]).toBe(10_000)
    expect(view.result.current).toMatchObject({ state: 'connected', attempt: 0 })
    expect(connect).toHaveBeenCalledTimes(6)
  })

  it('reconnects with back-off when the socket closes, and drops the old client', async () => {
    const { view, clients, timers } = setup()
    await settle()
    const first = clients[0]!
    act(() => first.drop())
    expect(view.result.current).toMatchObject({ state: 'reconnecting', attempt: 1 })
    expect(view.result.current.client).toBeUndefined()
    expect(view.result.current.previous).toBe(first)
    expect(await timers.fire()).toBe(1000)
    await settle()
    expect(view.result.current.state).toBe('connected')
    expect(view.result.current.client).toBe(clients[1])
    expect(view.result.current.client).not.toBe(first)
  })

  it('goes to reconnecting when the engine restarts, closes the client and connects again when it runs again', async () => {
    const { view, host, clients, connect } = setup()
    await settle()
    const first = clients[0]!
    act(() => host.setEngine({ state: 'restarting', restarts: 1 }))
    expect(view.result.current.state).toBe('reconnecting')
    expect(view.result.current.client).toBeUndefined()
    expect(first.closed).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
    act(() => host.setEngine({ state: 'running', restarts: 2 }))
    await settle()
    expect(view.result.current.state).toBe('connected')
    expect(view.result.current.client).toBe(clients[1])
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('stops trying at stopped and shows engine_stopped, then reconnects when the status returns to running', async () => {
    const { view, host, clients, timers, connect } = setup({ failures: 1 })
    await settle()
    expect(timers.pending()).toHaveLength(1)
    act(() => host.setEngine({ state: 'stopped', error: 'crashed', restarts: 6 }))
    expect(view.result.current).toMatchObject({ state: 'engine_stopped' })
    expect(view.result.current.client).toBeUndefined()
    expect(timers.pending()).toHaveLength(0)
    expect(view.result.current.status).toEqual({ state: 'stopped', error: 'crashed', restarts: 6 })
    expect(connect).toHaveBeenCalledTimes(1)
    act(() => host.setEngine({ state: 'running', restarts: 7 }))
    await settle()
    expect(view.result.current.state).toBe('connected')
    expect(clients).toHaveLength(1)
  })

  it('shows engine_stopped from the first status when the engine was already stopped', async () => {
    const host = createFakeHost({ engine: { state: 'stopped', error: 'no_keychain', restarts: 0 } })
    const connect = vi.fn()
    const view = renderHook(() => useEngineConnection(host, { connect }))
    await settle()
    expect(view.result.current.state).toBe('engine_stopped')
    expect(connect).not.toHaveBeenCalled()
  })

  it('does not connect while the engine is still starting, and connects when it runs', async () => {
    const host = createFakeHost({ engine: { state: 'starting', restarts: 0 } })
    const connect = vi.fn(async () => fakeClient())
    const view = renderHook(() => useEngineConnection(host, { connect }))
    await settle()
    expect(view.result.current.state).toBe('connecting')
    expect(connect).not.toHaveBeenCalled()
    act(() => host.setEngine({ state: 'running', restarts: 0 }))
    await settle()
    expect(view.result.current.state).toBe('connected')
  })

  it('unsubscribes from the status and closes the client on unmount, and sets no state afterwards', async () => {
    const { view, host, clients, timers } = setup()
    await settle()
    expect(host.state().statusListeners).toBe(1)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    view.unmount()
    expect(host.state().statusListeners).toBe(0)
    expect(clients[0]!.closed).toBe(true)
    expect(clients[0]!.dropListeners).toBe(0)
    host.setEngine({ state: 'restarting', restarts: 1 })
    expect(timers.pending()).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('drops a client that finishes connecting after the hook was unmounted', async () => {
    const host = createFakeHost()
    const late = fakeClient()
    let release: (client: ConnectedClient) => void = () => undefined
    const connect = vi.fn(() => new Promise<ConnectedClient>((resolve) => (release = resolve)))
    const view = renderHook(() => useEngineConnection(host, { connect }))
    await settle()
    view.unmount()
    release(late)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(late.closed).toBe(true)
  })

  it('never writes the token anywhere, also when connecting fails', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined))
    const { view } = setup({ failures: 2 })
    await settle()
    view.unmount()
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN)
      spy.mockRestore()
    }
  })

  it('reads the state it returns from the same fields in every render', async () => {
    const { view } = setup()
    const states: ConnectionState['state'][] = [view.result.current.state]
    await settle()
    states.push(view.result.current.state)
    expect(states).toEqual(['connecting', 'connected'])
  })
})
