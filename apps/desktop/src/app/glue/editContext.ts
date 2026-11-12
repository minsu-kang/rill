import { useCallback, useState } from 'react'

export interface EditContext {
  workflowId: string
  nodeId?: string
}

export interface EditContextApi {
  editContext: EditContext | undefined
  setEditContext(next: EditContext): void
  clearEditContext(): void
}

export function useEditContext(workflowId: string | undefined, initial?: EditContext): EditContextApi {
  const [stored, setStored] = useState<EditContext | undefined>(initial)
  const setEditContext = useCallback((next: EditContext) => setStored(next), [])
  const clearEditContext = useCallback(() => setStored(undefined), [])
  const editContext = stored !== undefined && stored.workflowId === workflowId ? stored : undefined
  return { editContext, setEditContext, clearEditContext }
}
