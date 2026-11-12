import type { ExplainResult, StepDetail } from '@rill/protocol'
import type { EngineClient } from '../../engine/client'
import type { MessageKey } from '../../i18n'
import { escapeInvisible, truncate } from '../../model/text'

export type ExplainAction = ExplainResult['suggestedActions'][number]

export interface ExplainActionContext {
  runId: string
  nodeId?: string
  workflowId: string
  dryRun?: boolean
}

export interface ExplainActionDeps {
  client: EngineClient
  openSettings(section: 'connections' | 'keys' | 'folders'): void
  selectNode(nodeId: string): void
  setEditContext(context: { workflowId: string; nodeId?: string }): void
  confirm(text: MessageKey): Promise<boolean>
  notify(key: MessageKey, vars?: Record<string, string | number>): void
  selectRun?(runId: string): void
}

const PATH_KEYS = ['file', 'path']
const MAX_PATH_SHOWN = 240

export function filePathOf(steps: readonly StepDetail[], nodeId: string | undefined): string | undefined {
  const candidates = steps.filter((step) => (nodeId === undefined ? step.status === 'failed' : step.nodeId === nodeId)).sort((a, b) => b.attempt - a.attempt)
  for (const step of candidates) {
    const input = step.input
    if (typeof input !== 'object' || input === null || Array.isArray(input)) continue
    for (const key of PATH_KEYS) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

export async function nodeExists(client: EngineClient, workflowId: string, nodeId: string): Promise<boolean> {
  const { workflow } = await client.request('getWorkflow', { workflowId })
  return workflow.nodes.some((node) => node.id === nodeId)
}

export async function handleExplainAction(action: ExplainAction, context: ExplainActionContext, deps: ExplainActionDeps): Promise<void> {
  const { client, notify } = deps
  try {
    switch (action) {
      case 'retry_run': {
        if (!(await deps.confirm('app.confirm.retry'))) return
        const { runId } = await client.request('startRun', { workflowId: context.workflowId, ...(context.dryRun === true ? { dryRun: true } : {}) })
        deps.selectRun?.(runId)
        notify('app.notice.retryStarted')
        return
      }
      case 'deactivate_workflow': {
        if (!(await deps.confirm('app.confirm.deactivate'))) return
        await client.request('deactivate', { workflowId: context.workflowId })
        notify('app.notice.deactivated')
        return
      }
      case 'open_connections':
        deps.openSettings('connections')
        return
      case 'edit_node': {
        const { nodeId } = context
        if (nodeId === undefined || !(await nodeExists(client, context.workflowId, nodeId))) {
          notify('app.notice.nodeMissing')
          return
        }
        deps.selectNode(nodeId)
        deps.setEditContext({ workflowId: context.workflowId, nodeId })
        return
      }
      case 'check_input_file': {
        const { steps } = await client.request('getRun', { runId: context.runId })
        const path = filePathOf(steps, context.nodeId)
        if (path === undefined) notify('app.notice.noFilePath')
        else notify('app.notice.filePath', { path: truncate(escapeInvisible(path), MAX_PATH_SHOWN) })
        return
      }
      case 'wait_and_retry':
        notify('app.notice.waitAndRetry')
        return
      case 'none':
        return
    }
  } catch {
    notify('app.notice.actionFailed')
  }
}

export function fillChatDraft(root: ParentNode | null, text: string): boolean {
  const field = root?.querySelector('textarea')
  if (!(field instanceof HTMLTextAreaElement) || field.disabled) return false
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setValue === undefined) return false
  const next = field.value.trim() === '' ? text : `${field.value}\n\n${text}`
  setValue.call(field, next)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus()
  field.setSelectionRange(next.length, next.length)
  return true
}
