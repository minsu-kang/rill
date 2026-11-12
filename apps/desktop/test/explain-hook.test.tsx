import { RillError } from '@rill/protocol'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { explainCases } from '../src/fixtures/explain'
import { useExplain } from '../src/explain/useExplain'
import { errorsDuring } from './errors'
import { manualExplainClient } from './explain-helpers'

const settle = () => act(async () => { await Promise.resolve() })

describe('useExplain', () => {
  it('starts idle, opens the notice and closes it without a request', () => {
    const { client, requests } = manualExplainClient()
    const { result } = renderHook(() => useExplain(client, 'run-1'))
    expect(result.current.state).toEqual({ phase: 'idle' })
    act(() => result.current.open())
    expect(result.current.state).toEqual({ phase: 'confirming', effort: 'medium' })
    act(() => result.current.open('high'))
    expect(result.current.state).toEqual({ phase: 'confirming', effort: 'high' })
    act(() => result.current.cancelNotice())
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(requests).toEqual([])
  })

  it('sends explainRun with the effort, shows progress and then the answer', async () => {
    const { client, calls } = manualExplainClient()
    const { result } = renderHook(() => useExplain(client, 'run-1'))
    act(() => result.current.open())
    act(() => result.current.send('low'))
    expect(result.current.state).toMatchObject({ phase: 'asking', effort: 'low' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual({ runId: 'run-1', effort: 'low' })
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    expect(result.current.state).toEqual({ phase: 'done', result: explainCases.credentials })
  })

  it('shows the message key of a failure and never the server text', async () => {
    const { client, calls } = manualExplainClient()
    const { result } = renderHook(() => useExplain(client, 'run-1'))
    act(() => result.current.send('medium'))
    await act(async () => calls[0]!.reject(new RillError('EXPLAIN_BUSY', 'SECRET-SERVER-TEXT')))
    expect(result.current.state).toEqual({ phase: 'error', key: 'explain.error.busy' })
    expect(JSON.stringify(result.current.state)).not.toContain('SECRET-SERVER-TEXT')
    act(() => result.current.send('medium'))
    expect(result.current.state.phase).toBe('asking')
    expect(calls).toHaveLength(2)
  })

  it('sends once when send is called twice in a row', () => {
    const { client, calls } = manualExplainClient()
    const { result } = renderHook(() => useExplain(client, 'run-1'))
    act(() => {
      result.current.send('medium')
      result.current.send('medium')
    })
    expect(calls).toHaveLength(1)
  })

  it('does nothing without a run', () => {
    const { client, requests } = manualExplainClient()
    const { result } = renderHook(() => useExplain(client, undefined))
    act(() => {
      result.current.open()
      result.current.send('medium')
    })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(requests).toEqual([])
  })

  it('ignores the answer of the old run after a switch and starts the new run idle', async () => {
    const { client, calls } = manualExplainClient()
    const { result, rerender } = renderHook(({ runId }) => useExplain(client, runId), { initialProps: { runId: 'run-1' } })
    act(() => result.current.send('medium'))
    rerender({ runId: 'run-2' })
    expect(result.current.state).toEqual({ phase: 'idle' })
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    expect(result.current.state).toEqual({ phase: 'idle' })
    rerender({ runId: 'run-1' })
    expect(result.current.state).toEqual({ phase: 'idle' })
    act(() => result.current.send('medium'))
    expect(calls).toHaveLength(2)
  })

  it('can ask again for the new run while the old request is still open', async () => {
    const { client, calls } = manualExplainClient()
    const { result, rerender } = renderHook(({ runId }) => useExplain(client, runId), { initialProps: { runId: 'run-1' } })
    act(() => result.current.send('medium'))
    rerender({ runId: 'run-2' })
    act(() => result.current.send('high'))
    expect(calls).toHaveLength(2)
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    expect(result.current.state).toMatchObject({ phase: 'asking', effort: 'high' })
    await act(async () => calls[1]!.resolve(explainCases.unknown))
    expect(result.current.state).toEqual({ phase: 'done', result: explainCases.unknown })
  })

  it('keeps the guard of the newer request when an old answer arrives', async () => {
    const { client, calls } = manualExplainClient()
    const { result, rerender } = renderHook(({ runId }) => useExplain(client, runId), { initialProps: { runId: 'run-1' } })
    act(() => result.current.send('medium'))
    rerender({ runId: 'run-2' })
    act(() => result.current.send('medium'))
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    act(() => result.current.send('medium'))
    expect(calls).toHaveLength(2)
  })

  it('forgets a request that is dismissed and lets the next one through', async () => {
    const { client, calls } = manualExplainClient()
    const { result } = renderHook(() => useExplain(client, 'run-1'))
    act(() => result.current.send('medium'))
    act(() => result.current.reset())
    expect(result.current.state).toEqual({ phase: 'idle' })
    await act(async () => calls[0]!.resolve(explainCases.credentials))
    expect(result.current.state).toEqual({ phase: 'idle' })
    act(() => result.current.send('low'))
    expect(calls).toHaveLength(2)
    await act(async () => calls[1]!.resolve(explainCases.unknown))
    expect(result.current.state).toEqual({ phase: 'done', result: explainCases.unknown })
  })

  it('sets no state when the component unmounts while asking', async () => {
    const { client, calls } = manualExplainClient()
    const { result, unmount } = renderHook(() => useExplain(client, 'run-1'))
    act(() => result.current.send('medium'))
    const seen = errorsDuring(() => unmount())
    await settle()
    calls[0]!.resolve(explainCases.credentials)
    await settle()
    expect(seen).toEqual([])
  })
})
