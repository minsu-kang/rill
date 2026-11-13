import { useCallback, useState } from 'react'

export interface Selection {
  workflowId: string | undefined
  runId: string | undefined
  nodeId: string | undefined
}

export interface SelectionApi extends Selection {
  selectWorkflow(workflowId: string | undefined): void
  selectRun(runId: string | undefined): void
  selectNode(nodeId: string | undefined): void
  forgetWorkflow(workflowId: string): void
}

export function useSelection(initial: Partial<Selection> = {}): SelectionApi {
  const [selection, setSelection] = useState<Selection>(() => ({ workflowId: initial.workflowId, runId: initial.runId, nodeId: initial.nodeId }))

  const selectWorkflow = useCallback((workflowId: string | undefined) => {
    setSelection((previous) => (previous.workflowId === workflowId ? previous : { workflowId, runId: undefined, nodeId: undefined }))
  }, [])
  const selectRun = useCallback((runId: string | undefined) => setSelection((previous) => ({ ...previous, runId })), [])
  const selectNode = useCallback((nodeId: string | undefined) => setSelection((previous) => ({ ...previous, nodeId })), [])
  const forgetWorkflow = useCallback((workflowId: string) => {
    setSelection((previous) => (previous.workflowId === workflowId ? { workflowId: undefined, runId: undefined, nodeId: undefined } : previous))
  }, [])

  return { ...selection, selectWorkflow, selectRun, selectNode, forgetWorkflow }
}
