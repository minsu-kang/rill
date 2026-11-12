import type { Workflow } from '@rill/dsl'
import type { NodeInfo } from '@rill/protocol'
import { useEffect, useState } from 'react'
import type { EngineClient } from './client'

export interface WorkflowSourceResult {
  workflow: Workflow | undefined
  catalog: NodeInfo[]
  error: string | undefined
  loading: boolean
}

interface Loaded {
  workflowId: string
  workflow: Workflow | undefined
  catalog: NodeInfo[]
  error: string | undefined
}

const NO_CATALOG: NodeInfo[] = []
const IDLE: WorkflowSourceResult = { workflow: undefined, catalog: NO_CATALOG, error: undefined, loading: false }
const LOADING: WorkflowSourceResult = { ...IDLE, loading: true }

export function useWorkflowSource(client: EngineClient, workflowId: string | undefined): WorkflowSourceResult {
  const [data, setData] = useState<Loaded | undefined>(undefined)

  useEffect(() => {
    if (workflowId === undefined) return undefined
    let active = true
    void (async () => {
      try {
        const [{ workflow }, { nodes }] = await Promise.all([client.request('getWorkflow', { workflowId }), client.request('nodeCatalog', {})])
        if (active) setData({ workflowId, workflow, catalog: nodes, error: undefined })
      } catch (error) {
        if (active) setData({ workflowId, workflow: undefined, catalog: NO_CATALOG, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      active = false
    }
  }, [client, workflowId])

  if (workflowId === undefined) return IDLE
  if (data === undefined || data.workflowId !== workflowId) return LOADING
  return { workflow: data.workflow, catalog: data.catalog, error: data.error, loading: false }
}
