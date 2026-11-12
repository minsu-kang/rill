import { RillError, type MethodName, type MethodParams, type MethodResult, type StepDetail } from '@rill/protocol'
import { describe, expect, it, vi } from 'vitest'
import { fillChatDraft, filePathOf, handleExplainAction, type ExplainActionDeps } from '../src/app/glue/actions'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { fakeData, ids } from '../src/fixtures'

function setup(overrides: Partial<ExplainActionDeps> = {}) {
  const base = createFakeClient(fakeData)
  const calls: Array<{ method: string; params: unknown }> = []
  const client: EngineClient = {
    onEvent: base.onEvent,
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      if (method === 'startRun') return { runId: 'run-new' } as MethodResult<M>
      if (method === 'deactivate') return {} as MethodResult<M>
      return base.request(method, params)
    },
  }
  const deps = {
    client,
    openSettings: vi.fn(),
    selectNode: vi.fn(),
    setEditContext: vi.fn(),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    selectRun: vi.fn(),
    ...overrides,
  } satisfies ExplainActionDeps
  const context = { runId: ids.runs.receiptFailed, workflowId: ids.workflows.receipt, nodeId: 'extract' }
  return { deps, calls, context }
}

describe('handleExplainAction', () => {
  it('retry_run asks first and then starts the same workflow, selecting the new run', async () => {
    const { deps, calls, context } = setup()
    await handleExplainAction('retry_run', context, deps)
    expect(deps.confirm).toHaveBeenCalledWith('app.confirm.retry', { workflowId: ids.workflows.receipt })
    expect(calls.filter((call) => call.method === 'startRun')).toEqual([{ method: 'startRun', params: { workflowId: ids.workflows.receipt } }])
    expect(deps.selectRun).toHaveBeenCalledWith('run-new')
    expect(deps.notify).toHaveBeenCalledWith('app.notice.retryStarted')
  })

  it('retry_run keeps a dry run a dry run', async () => {
    const { deps, calls, context } = setup()
    await handleExplainAction('retry_run', { ...context, dryRun: true }, deps)
    expect(calls.find((call) => call.method === 'startRun')!.params).toEqual({ workflowId: ids.workflows.receipt, dryRun: true })
  })

  it('retry_run names no workflow for the confirmation when it is only a dry run', async () => {
    const { deps, context } = setup()
    await handleExplainAction('retry_run', { ...context, dryRun: true }, deps)
    expect(deps.confirm).toHaveBeenCalledWith('app.confirm.retry', undefined)
  })

  it('retry_run does nothing when the confirmation is refused', async () => {
    const { deps, calls, context } = setup({ confirm: vi.fn(async () => false) })
    await handleExplainAction('retry_run', context, deps)
    expect(calls).toHaveLength(0)
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('deactivate_workflow asks first and then deactivates', async () => {
    const { deps, calls, context } = setup()
    await handleExplainAction('deactivate_workflow', context, deps)
    expect(deps.confirm).toHaveBeenCalledWith('app.confirm.deactivate', undefined)
    expect(calls).toEqual([{ method: 'deactivate', params: { workflowId: ids.workflows.receipt } }])
    expect(deps.notify).toHaveBeenCalledWith('app.notice.deactivated')
  })

  it('deactivate_workflow does nothing when the confirmation is refused', async () => {
    const { deps, calls, context } = setup({ confirm: vi.fn(async () => false) })
    await handleExplainAction('deactivate_workflow', context, deps)
    expect(calls).toHaveLength(0)
  })

  it('open_connections opens the connections section and nothing else', async () => {
    const { deps, calls, context } = setup()
    await handleExplainAction('open_connections', context, deps)
    expect(deps.openSettings).toHaveBeenCalledWith('connections')
    expect(calls).toHaveLength(0)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('edit_node selects the node and sets the edit context when the node exists', async () => {
    const { deps, context } = setup()
    await handleExplainAction('edit_node', context, deps)
    expect(deps.selectNode).toHaveBeenCalledWith('extract')
    expect(deps.setEditContext).toHaveBeenCalledWith({ workflowId: ids.workflows.receipt, nodeId: 'extract' })
  })

  it('edit_node refuses a node that is not in the workflow, and a missing node', async () => {
    const first = setup()
    await handleExplainAction('edit_node', { ...first.context, nodeId: 'ghost-node' }, first.deps)
    expect(first.deps.selectNode).not.toHaveBeenCalled()
    expect(first.deps.setEditContext).not.toHaveBeenCalled()
    expect(first.deps.notify).toHaveBeenCalledWith('app.notice.nodeMissing')
    const second = setup()
    await handleExplainAction('edit_node', { runId: 'r', workflowId: ids.workflows.receipt }, second.deps)
    expect(second.deps.notify).toHaveBeenCalledWith('app.notice.nodeMissing')
  })

  it('check_input_file shows the path of the step input as text and opens nothing', async () => {
    const { deps, context } = setup()
    await handleExplainAction('check_input_file', context, deps)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const [key, vars] = vi.mocked(deps.notify).mock.calls[0]!
    expect(key).toBe('app.notice.filePath')
    expect(typeof (vars as { path: string }).path).toBe('string')
    expect(deps.openSettings).not.toHaveBeenCalled()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('check_input_file says so when the step input has no path', async () => {
    const { deps, context } = setup()
    await handleExplainAction('check_input_file', { ...context, nodeId: 'ghost-node' }, deps)
    expect(deps.notify).toHaveBeenCalledWith('app.notice.noFilePath')
  })

  it('wait_and_retry shows a reminder and does nothing else', async () => {
    const { deps, calls, context } = setup()
    await handleExplainAction('wait_and_retry', context, deps)
    expect(deps.notify).toHaveBeenCalledWith('app.notice.waitAndRetry')
    expect(calls).toHaveLength(0)
  })

  it('none does nothing', async () => {
    const { deps, calls, context } = setup()
    await handleExplainAction('none', context, deps)
    expect(calls).toHaveLength(0)
    expect(deps.notify).not.toHaveBeenCalled()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('shows a fixed notice when the engine fails, without the text of the error', async () => {
    const failing: EngineClient = { onEvent: () => () => undefined, request: () => Promise.reject(new RillError('INTERNAL', 'secret detail')) }
    const { deps, context } = setup({ client: failing })
    await handleExplainAction('retry_run', context, deps)
    expect(deps.notify).toHaveBeenCalledWith('app.notice.actionFailed')
    expect(JSON.stringify(vi.mocked(deps.notify).mock.calls)).not.toContain('secret detail')
  })
})

describe('filePathOf', () => {
  const step = (nodeId: string, input: unknown, status: StepDetail['status'] = 'failed', attempt = 1): StepDetail => ({ nodeId, attempt, status, input, output: null, error: null, startedAt: 1, finishedAt: 2 })

  it('reads file or path from the input of the named step, newest attempt first', () => {
    expect(filePathOf([step('a', { file: '/old.pdf' }, 'failed', 1), step('a', { file: '/new.pdf' }, 'failed', 2)], 'a')).toBe('/new.pdf')
    expect(filePathOf([step('a', { path: '/p.txt' })], 'a')).toBe('/p.txt')
  })

  it('takes the failed step when no node is named, and ignores inputs that are not objects or have no path', () => {
    expect(filePathOf([step('a', { file: '/ok.pdf' }, 'succeeded'), step('b', { file: '/bad.pdf' })], undefined)).toBe('/bad.pdf')
    expect(filePathOf([step('a', 'text'), step('a', [1]), step('a', null), step('a', { file: 5 }), step('a', { file: '' })], 'a')).toBeUndefined()
  })
})

describe('fillChatDraft', () => {
  function chat(value = '', disabled = false) {
    const root = document.createElement('div')
    const field = document.createElement('textarea')
    field.setAttribute('data-rill-composer', '')
    field.value = value
    field.disabled = disabled
    root.append(field)
    document.body.append(root)
    const heard: string[] = []
    field.addEventListener('input', () => heard.push(field.value))
    return { root, field, heard }
  }

  it('puts the text in the field, fires an input event, and focuses it without sending anything', () => {
    const { root, field, heard } = chat()
    expect(fillChatDraft(root, 'fix the node')).toBe(true)
    expect(field.value).toBe('fix the node')
    expect(heard).toEqual(['fix the node'])
    expect(document.activeElement).toBe(field)
  })

  it('adds to a draft that is already there instead of replacing it', () => {
    const { root, field } = chat('first line')
    fillChatDraft(root, 'second')
    expect(field.value).toBe('first line\n\nsecond')
  })

  it('writes into the composer even when an answer field comes before it, and leaves that field alone', () => {
    const { root, field, heard } = chat()
    const answer = document.createElement('textarea')
    root.prepend(answer)
    expect(fillChatDraft(root, 'fix the node')).toBe(true)
    expect(answer.value).toBe('')
    expect(field.value).toBe('fix the node')
    expect(heard).toEqual(['fix the node'])
  })

  it('does nothing when the only field is not the composer', () => {
    const root = document.createElement('div')
    root.append(document.createElement('textarea'))
    expect(fillChatDraft(root, 'x')).toBe(false)
  })

  it('does not use a disabled answer field to decide the composer is unavailable', () => {
    const { root, field } = chat()
    const answer = document.createElement('textarea')
    answer.disabled = true
    root.prepend(answer)
    expect(fillChatDraft(root, 'go')).toBe(true)
    expect(field.value).toBe('go')
  })

  it('does nothing without a field, with a disabled field and without a root', () => {
    expect(fillChatDraft(document.createElement('div'), 'x')).toBe(false)
    expect(fillChatDraft(chat('', true).root, 'x')).toBe(false)
    expect(fillChatDraft(null, 'x')).toBe(false)
  })
})
