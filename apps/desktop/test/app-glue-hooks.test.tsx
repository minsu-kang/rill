import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useConfirm } from '../src/app/glue/useConfirm'
import { useSelection } from '../src/app/glue/useSelection'

describe('useConfirm', () => {
  it('holds one question, names the workflow only when asked, and settles with the answer', async () => {
    const { result } = renderHook(() => useConfirm<'a' | 'b'>())
    expect(result.current.pending).toBeUndefined()
    let answer: Promise<boolean> = Promise.resolve(false)
    act(() => {
      answer = result.current.confirm('a', { workflowId: 'wf-1' })
    })
    expect(result.current.pending).toMatchObject({ text: 'a', workflowId: 'wf-1' })
    await act(async () => result.current.pending!.settle(true))
    expect(await answer).toBe(true)
    expect(result.current.pending).toBeUndefined()
    act(() => {
      answer = result.current.confirm('b')
    })
    expect(result.current.pending).toMatchObject({ text: 'b', workflowId: undefined })
    await act(async () => result.current.pending!.settle(false))
    expect(await answer).toBe(false)
  })

  it('answers no to the question that a new one replaces, and keeps the new one open', async () => {
    const { result } = renderHook(() => useConfirm<'a' | 'b'>())
    let first: Promise<boolean> = Promise.resolve(true)
    let second: Promise<boolean> = Promise.resolve(false)
    act(() => {
      first = result.current.confirm('a')
    })
    const old = result.current.pending!
    act(() => {
      second = result.current.confirm('b')
    })
    expect(await first).toBe(false)
    expect(result.current.pending).toMatchObject({ text: 'b' })
    await act(async () => old.settle(true))
    expect(result.current.pending).toMatchObject({ text: 'b' })
    await act(async () => result.current.pending!.settle(true))
    expect(await second).toBe(true)
    expect(result.current.pending).toBeUndefined()
  })

  it('answers no to a question that is still open when it unmounts', async () => {
    const { result, unmount } = renderHook(() => useConfirm<'a'>())
    let answer: Promise<boolean> = Promise.resolve(true)
    act(() => {
      answer = result.current.confirm('a')
    })
    unmount()
    expect(await answer).toBe(false)
  })
})

describe('useSelection', () => {
  it('starts from the initial selection', () => {
    const { result } = renderHook(() => useSelection({ workflowId: 'w', runId: 'r', nodeId: 'n' }))
    expect(result.current).toMatchObject({ workflowId: 'w', runId: 'r', nodeId: 'n' })
  })

  it('forgets the run and the node when another workflow is chosen', () => {
    const { result } = renderHook(() => useSelection({ workflowId: 'w', runId: 'r', nodeId: 'n' }))
    act(() => result.current.selectWorkflow('other'))
    expect(result.current).toMatchObject({ workflowId: 'other', runId: undefined, nodeId: undefined })
  })

  it('keeps the run and the node when the same workflow is chosen again', () => {
    const { result } = renderHook(() => useSelection({ workflowId: 'w', runId: 'r', nodeId: 'n' }))
    act(() => result.current.selectWorkflow('w'))
    expect(result.current).toMatchObject({ workflowId: 'w', runId: 'r', nodeId: 'n' })
  })

  it('changes the run and the node on their own', () => {
    const { result } = renderHook(() => useSelection({ workflowId: 'w' }))
    act(() => result.current.selectRun('r2'))
    act(() => result.current.selectNode('n2'))
    expect(result.current).toMatchObject({ workflowId: 'w', runId: 'r2', nodeId: 'n2' })
    act(() => result.current.selectNode(undefined))
    expect(result.current.nodeId).toBeUndefined()
    expect(result.current.runId).toBe('r2')
  })
})
