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

  it('never invents a fake host: with neither a host nor window.rill it fails loudly', () => {
    const originalError = console.error
    console.error = () => undefined
    try {
      expect(() => renderHook(() => useHost(), { wrapper: wrapper() })).toThrow(/window\.rill/)
    } finally {
      console.error = originalError
    }
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
