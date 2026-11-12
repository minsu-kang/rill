import { render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { HostProvider, useConnect, useHost } from '../src/app/host'
import { createFakeHost } from '../src/engine/fake-host'
import type { HostApi } from '../src/shared/host-api'

afterEach(() => {
  delete (window as { rill?: HostApi }).rill
})

function wrapper(host?: HostApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <HostProvider host={host}>{children}</HostProvider>
  }
}

describe('HostProvider', () => {
  it('gives the host that was passed in', () => {
    const given = createFakeHost()
    const { result } = renderHook(() => useHost(), { wrapper: wrapper(given) })
    expect(result.current).toBe(given)
  })

  it('falls back to window.rill when no host is passed', () => {
    const real = createFakeHost()
    ;(window as { rill?: HostApi }).rill = real
    const { result } = renderHook(() => useHost(), { wrapper: wrapper() })
    expect(result.current).toBe(real)
  })

  it('prefers the host that was passed in over window.rill', () => {
    ;(window as { rill?: HostApi }).rill = createFakeHost()
    const given = createFakeHost()
    const { result } = renderHook(() => useHost(), { wrapper: wrapper(given) })
    expect(result.current).toBe(given)
  })

  it('falls back to an in-memory fake host when there is neither, and keeps it across renders', async () => {
    const { result, rerender } = renderHook(() => useHost(), { wrapper: wrapper() })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    expect(await first.settings.get()).toMatchObject({ provider: 'anthropic', configuredProviders: [] })
  })

  it('throws a clear error outside a provider', () => {
    function Probe() {
      useHost()
      return null
    }
    const originalError = console.error
    console.error = () => undefined
    try {
      expect(() => render(<Probe />)).toThrow(/HostProvider/)
    } finally {
      console.error = originalError
    }
  })

  it('passes a connect function down, and has none by default', () => {
    const connect = async () => {
      throw new Error('unused')
    }
    const { result } = renderHook(() => useConnect(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <HostProvider host={createFakeHost()} connect={connect}>
          {children}
        </HostProvider>
      ),
    })
    expect(result.current).toBe(connect)
    const bare = renderHook(() => useConnect(), { wrapper: wrapper(createFakeHost()) })
    expect(bare.result.current).toBeUndefined()
  })
})
