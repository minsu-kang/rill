import type { WorkflowSummary } from '@rill/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineClient } from '../../engine/client'

export interface WorkflowListState {
  status: 'loading' | 'ready' | 'error'
  workflows: readonly WorkflowSummary[]
  refresh(): Promise<void>
}

type Loaded = { client: EngineClient; workflows: readonly WorkflowSummary[] } | { client: EngineClient; failed: true }

const NONE: readonly WorkflowSummary[] = []

export function useWorkflowList(client: EngineClient | undefined): WorkflowListState {
  const [data, setData] = useState<Loaded | undefined>(undefined)
  const alive = useRef(true)
  const clientRef = useRef(client)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    clientRef.current = client
  }, [client])

  const load = useCallback(
    (target: EngineClient): Promise<void> =>
      target.request('listWorkflows', {}).then(
        ({ workflows }) => {
          if (alive.current && clientRef.current === target) setData({ client: target, workflows })
        },
        () => {
          if (alive.current && clientRef.current === target) setData((previous) => (previous !== undefined && previous.client === target && 'workflows' in previous ? previous : { client: target, failed: true }))
        },
      ),
    [],
  )

  useEffect(() => {
    if (client === undefined) return undefined
    void load(client)
    const onFocus = (): void => {
      void load(client)
    }
    window.addEventListener('focus', onFocus)
    const off = client.onEvent((event) => {
      if (event.type === 'workflow.activated' || event.type === 'workflow.deactivated') void load(client)
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [client, load])

  const refresh = useCallback(async (): Promise<void> => {
    if (clientRef.current !== undefined) await load(clientRef.current)
  }, [load])

  const current = client === undefined ? undefined : data
  if (current === undefined) return { status: 'loading', workflows: NONE, refresh }
  if ('failed' in current) return { status: 'error', workflows: NONE, refresh }
  return { status: 'ready', workflows: current.workflows, refresh }
}
