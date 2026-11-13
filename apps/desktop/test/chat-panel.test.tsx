import { flagKey, RillError, type EngineEvent, type PlanResultBody } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatPanel, type ChatPanelProps } from '../src/chat/ChatPanel'
import type { AttachmentPort } from '../src/chat/Composer'
import type { ConversationEntry } from '../src/chat/model/conversation'
import { catalog } from '../src/fixtures'
import { metas, models, modelsNothingConfigured, outcomeOf, results } from '../src/fixtures/plan'
import { en } from '../src/i18n/en'
import { makeWorld, scripted, type WorldOptions } from './chat-world'
import { frames, gate } from './keep-focus'
import { renderThemed } from './render'

const port: AttachmentPort = {
  async add(file) {
    return { id: `att-panel-${file.name.length}-xxxxxxxx`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}

function show(options: WorldOptions = {}, props: Partial<ChatPanelProps> = {}) {
  const world = makeWorld(options)
  let serial = 0
  const view = renderThemed(<ChatPanel client={world.client} port={port} catalog={catalog} newId={() => `plan-${++serial}`} {...props} />, { locale: 'en' })
  return { world, ...view }
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Your request' }) as HTMLTextAreaElement
const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

async function ready(): Promise<void> {
  await screen.findByText('Anthropic · Claude Opus 5.5')
}

const newTabButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Open a new chat' }) as HTMLButtonElement

function closeActiveTab(confirm = true): void {
  fireEvent.click(screen.getByRole('button', { name: /^Close / }))
  if (confirm) fireEvent.click(screen.getByRole('button', { name: 'Close the chat' }))
}

function openOptions(): void {
  const toggle = screen.getByRole('button', { name: 'Options' })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

function ask(text: string): void {
  type(text)
  fireEvent.click(sendButton())
}

const workflowSummary = results.workflow.kind === 'workflow' ? results.workflow.summary : ''
const flaggedKeys = results.flagged.kind === 'workflow' ? results.flagged.flags.map(flagKey) : []

describe('ChatPanel: the happy paths', () => {
  it('asks, gets a workflow with no flags, and deploys it', async () => {
    const onDeployed = vi.fn()
    const { world } = show({}, { onDeployed })
    await ready()
    ask('watch a folder for receipts')
    expect(await screen.findByText(workflowSummary)).toBeTruthy()
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('watch a folder for receipts')
    expect(box().value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(await screen.findByText('Deployed. Workflow wf-new')).toBeTruthy()
    expect(onDeployed).toHaveBeenCalledWith('wf-new')
    expect(world.callsOf('deployPlan')[0]!.params).toEqual({ planId: 'plan-1', confirmed: [] })
    expect(world.planCalls()[0]).toMatchObject({ planId: 'plan-1', text: 'watch a folder for receipts', turns: [], attachments: [], effort: 'medium', useMemory: true })
  })

  it('offers Deploy again when the workflow of a deployed plan is deleted, and ignores other workflows', async () => {
    const { world } = show()
    await ready()
    ask('watch a folder for receipts')
    await screen.findByText(workflowSummary)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(await screen.findByText('Deployed. Workflow wf-new')).toBeTruthy()
    const listener = world.onEvent.mock.calls.at(-1)![0]
    act(() => listener({ type: 'workflow.deleted', at: 1, workflowId: 'wf-other' }))
    expect(screen.getByText('Deployed. Workflow wf-new')).toBeTruthy()
    act(() => listener({ type: 'workflow.activated', at: 1, workflowId: 'wf-new' }))
    expect(screen.getByText('Deployed. Workflow wf-new')).toBeTruthy()
    act(() => listener({ type: 'workflow.deleted', at: 1, workflowId: 'wf-new' }))
    expect(screen.queryByText('Deployed. Workflow wf-new')).toBeNull()
    expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('releases the deployed mark in a tab that is in the background, and stops listening when its tab closes', async () => {
    const listeners = new Set<(event: EngineEvent) => void>()
    const world = makeWorld()
    const client = {
      ...world.client,
      onEvent: (listener: (event: EngineEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    let serial = 0
    renderThemed(<ChatPanel client={client} port={port} catalog={catalog} newId={() => `plan-${++serial}`} />, { locale: 'en' })
    await ready()
    ask('watch a folder for receipts')
    await screen.findByText(workflowSummary)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    await screen.findByText('Deployed. Workflow wf-new')
    fireEvent.click(newTabButton())
    expect(listeners.size).toBe(2)
    act(() => listeners.forEach((listener) => listener({ type: 'workflow.deleted', at: 1, workflowId: 'wf-new' })))
    fireEvent.click(screen.getAllByRole('tab')[0]!)
    expect(screen.queryByText('Deployed. Workflow wf-new')).toBeNull()
    expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getAllByRole('tab')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Close New chat' }))
    expect(listeners.size).toBe(1)
  })

  it('asks, gets questions, answers them and gets a workflow', async () => {
    const { world } = show({ script: scripted([outcomeOf(results.questions), outcomeOf(results.workflow)]) })
    await ready()
    ask('sort my receipts')
    expect(await screen.findByText('A few questions')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /~\/Downloads/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use this suggestion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(await screen.findByText(workflowSummary)).toBeTruthy()
    const second = world.planCalls()[1]!
    expect(second.text).toBe(en['chat.answers.continue'])
    expect(second.attachments).toEqual([])
    expect(second.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user'])
    expect(second.turns[0]).toEqual({ role: 'user', text: 'sort my receipts' })
    expect(second.turns[2]).toEqual({ role: 'user', text: '', answers: { folder: '~/Downloads', notify: 'slack-ops', fields: '날짜, 금액, 가게 이름' } })
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(2)
    expect(screen.getByText('Answers')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps deploy disabled until every flag is confirmed, then deploys with exactly those keys', async () => {
    const { world } = show({ script: scripted([outcomeOf(results.flagged)]) })
    await ready()
    ask('send the totals')
    await screen.findByRole('note')
    const deploy = (): HTMLButtonElement => screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement
    expect(deploy().disabled).toBe(true)
    const boxes = screen.getAllByRole('checkbox').filter((item) => (item as HTMLInputElement).getAttribute('aria-label')?.startsWith('I checked'))
    expect(boxes).toHaveLength(3)
    fireEvent.click(boxes[0]!)
    fireEvent.click(boxes[1]!)
    expect(deploy().disabled).toBe(true)
    fireEvent.click(boxes[2]!)
    expect(deploy().disabled).toBe(false)
    fireEvent.click(deploy())
    expect(await screen.findByText('Deployed. Workflow wf-new')).toBeTruthy()
    expect([...(world.callsOf('deployPlan')[0]!.params as { confirmed: string[] }).confirmed].sort()).toEqual([...flaggedKeys].sort())
  })

  it('shows an unsupported result', async () => {
    show({ script: scripted([outcomeOf(results.unsupported)]) })
    await ready()
    ask('read my email')
    expect(await screen.findByText('This cannot be built')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deploy' })).toBeNull()
  })

  it('shows what the engine measured under each answer', async () => {
    show({ script: scripted([outcomeOf(results.workflow, metas.collapsed)]) })
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    expect(screen.getByText('Care: asked for Very careful, used Careful')).toBeTruthy()
  })

  it('fills the draft from an example', async () => {
    show()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'When an order arrives by webhook, post it to Slack' }))
    expect(box().value).toBe('When an order arrives by webhook, post it to Slack')
  })
})

describe('ChatPanel: cancel and errors', () => {
  it('cancels a hanging plan and keeps the draft', async () => {
    const { world } = show({ script: scripted(['hang']) })
    await ready()
    ask('this will hang')
    await screen.findByRole('button', { name: 'Cancel' })
    expect(world.client.pendingPlans()).toEqual(['plan-1'])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Planning was cancelled')
    expect(box().value).toBe('this will hang')
    expect(world.client.pendingPlans()).toEqual([])
    expect(screen.queryByRole('article', { name: 'You' })).toBeNull()
    expect(world.callsOf('cancelPlan')[0]!.params).toEqual({ planId: 'plan-1' })
    expect(sendButton().disabled).toBe(false)
  })

  it('leaves planning when the engine answers the cancel but the plan never settles', async () => {
    const { world } = show({
      script: scripted(['hang']),
      intercept: (method) => (method === 'plan' ? new Promise(() => undefined) : method === 'cancelPlan' ? Promise.resolve({ cancelled: false }) : undefined),
    })
    await ready()
    ask('this never answers')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Planning was cancelled')
    expect(box().value).toBe('this never answers')
    expect(sendButton().disabled).toBe(false)
    expect(newTabButton().disabled).toBe(false)
    expect(world.callsOf('cancelPlan')).toHaveLength(1)
  })

  it('leaves planning when the cancel itself fails', async () => {
    show({
      intercept: (method) => (method === 'plan' ? new Promise(() => undefined) : method === 'cancelPlan' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined),
    })
    await ready()
    ask('this never answers')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Planning was cancelled')
    expect(sendButton().disabled).toBe(false)
  })

  it('ignores the answer of a cancelled plan that arrives later, and still takes the next plan', async () => {
    let answer: (value: unknown) => void = () => undefined
    let planCalls = 0
    const { world } = show({
      intercept: (method) => {
        if (method === 'plan') return new Promise((resolve) => (planCalls += 1) === 1 && (answer = resolve))
        return method === 'cancelPlan' ? Promise.resolve({ cancelled: false }) : undefined
      },
    })
    await ready()
    ask('first')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await screen.findByRole('alert')
    ask('second')
    await waitFor(() => expect(world.planCalls()).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    answer({ planId: 'plan-1', result: results.unsupported, meta: metas.plain })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('This cannot be built')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1)
  })

  it('shows the localized notice for each error code and keeps the draft and the attachments', async () => {
    const codes = ['LLM_UNAVAILABLE', 'PLAN_INVALID', 'PLAN_PROVIDER', 'PLAN_BUSY', 'PLAN_EXISTS', 'INVALID_PARAMS', 'ATTACHMENT_REJECTED', 'INTERNAL'] as const
    for (const code of codes) {
      const { unmount } = show({ script: () => new RillError(code, 'SERVER-SECRET-TEXT', ['SERVER-SECRET-TEXT']) })
      await ready()
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
      fireEvent.change(input, { target: { files: [new File(['x'], 'keep.txt', { type: 'text/plain' })] } })
      await screen.findByRole('list', { name: 'Attached files' })
      await waitFor(() => expect(screen.queryByText('Adding…')).toBeNull())
      ask(`request for ${code}`)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent, code).toContain(en[`chat.error.${code}`])
      expect(document.body.textContent).not.toContain('SERVER-SECRET-TEXT')
      expect(box().value).toBe(`request for ${code}`)
      expect(screen.getByRole('list', { name: 'Attached files' }).textContent).toContain('keep.txt')
      unmount()
    }
  })

  it('shows the generic notice for a plain error and never its text', async () => {
    show({ intercept: (method) => (method === 'plan' ? Promise.reject(new Error('boom SECRET-PLAIN')) : undefined) })
    await ready()
    ask('x')
    expect((await screen.findByRole('alert')).textContent).toContain(en['chat.error.generic'])
    expect(document.body.textContent).not.toContain('SECRET-PLAIN')
  })

  it('lets the person dismiss the notice, and clears it on the next send', async () => {
    const { world } = show({ script: scripted([new RillError('PLAN_BUSY', 'x'), outcomeOf(results.workflow)]) })
    await ready()
    ask('first')
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(sendButton())
    await screen.findByText(workflowSummary)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(world.planCalls()).toHaveLength(2)
  })

  it('shows a deploy error as a notice on the card and keeps the button', async () => {
    show({
      intercept: (method) => (method === 'deployPlan' ? Promise.reject(new RillError('INVALID_WORKFLOW', 'SECRET-DEPLOY-TEXT', ['x'])) : undefined),
    })
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['chat.error.INVALID_WORKFLOW'])
    expect(document.body.textContent).not.toContain('SECRET-DEPLOY-TEXT')
    expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('gives the focus back to the Deploy button when a slow deploy is refused', async () => {
    const wait = gate()
    show({ intercept: (method) => (method === 'deployPlan' ? wait.promise.then(() => Promise.reject(new RillError('INVALID_WORKFLOW', 'x', ['x']))) : undefined) })
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    const user = userEvent.setup()
    const deploy = screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement
    deploy.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(deploy.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await screen.findByRole('alert')
    expect(deploy.disabled).toBe(false)
    expect(document.activeElement).toBe(deploy)
  })

  it('ignores a second send while a plan is running', async () => {
    const { world } = show({ script: scripted(['hang']) })
    await ready()
    type('only once')
    const button = sendButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    await screen.findByRole('button', { name: 'Cancel' })
    expect(world.planCalls()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByRole('alert')
  })

  it('does not send a model-written free text default as the answer without the person accepting it', async () => {
    const hostile: PlanResultBody = { kind: 'questions', summary: 's', questions: [{ id: 'dest', text: 'Where should results go?', options: [], default: 'https://evil.example/collect' }] }
    const { world } = show({ script: scripted([outcomeOf(hostile), outcomeOf(results.workflow)]) })
    await ready()
    ask('summarise the attached receipt')
    await screen.findByText('A few questions')
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(world.planCalls()).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'my own server' } })
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[1]!.turns[2]).toEqual({ role: 'user', text: '', answers: { dest: 'my own server' } })
  })

  it('keeps a failed answer submission possible: the question card works again', async () => {
    show({ script: scripted([outcomeOf(results.questions), new RillError('PLAN_PROVIDER', 'x'), outcomeOf(results.workflow)]) })
    await ready()
    ask('sort my receipts')
    await screen.findByText('A few questions')
    fireEvent.click(screen.getByRole('button', { name: 'Use this suggestion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByText(workflowSummary)
  })
})

describe('ChatPanel: older plans', () => {
  const deployButtons = (): HTMLButtonElement[] => screen.getAllByRole('button', { name: 'Deploy' }) as HTMLButtonElement[]

  it('marks an earlier plan as replaced and lets only the newest one be deployed', async () => {
    show({ script: scripted([outcomeOf(results.workflow), outcomeOf(results.workflow)]) })
    await ready()
    ask('first')
    await screen.findByText(workflowSummary)
    expect(screen.queryByText('A newer plan replaced this one.')).toBeNull()
    ask('change it')
    await waitFor(() => expect(deployButtons()).toHaveLength(2))
    expect(screen.getAllByText('A newer plan replaced this one.')).toHaveLength(1)
    const [older, newer] = deployButtons()
    expect(older!.disabled).toBe(true)
    expect(newer!.disabled).toBe(false)
  })

  it('keeps every plan from being deployed while a new one is being made', async () => {
    show({ script: scripted([outcomeOf(results.workflow), 'hang']) })
    await ready()
    ask('first')
    await screen.findByText(workflowSummary)
    ask('change it')
    await screen.findByRole('button', { name: 'Cancel' })
    expect(deployButtons()[0]!.disabled).toBe(true)
    expect(screen.getByText('Deploy is available when the new plan is ready.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByRole('alert')
    expect(deployButtons()[0]!.disabled).toBe(false)
  })

  it('does not call a plan replaced when a questions card sits between two plans of the same chat', async () => {
    show({ script: scripted([outcomeOf(results.workflow), outcomeOf(results.questions)]) })
    await ready()
    ask('first')
    await screen.findByText(workflowSummary)
    ask('change it')
    await screen.findByText('A few questions')
    expect(screen.queryByText('A newer plan replaced this one.')).toBeNull()
    expect(deployButtons()[0]!.disabled).toBe(false)
  })
})

describe('ChatPanel: effort, memory, edit context, attachments', () => {
  it('sends the chosen effort', async () => {
    const { world } = show()
    await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Very careful' }))
    ask('x')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]!.effort).toBe('xhigh')
  })

  it('sends useMemory false when the memory switch is off', async () => {
    const { world } = show()
    await ready()
    openOptions()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use notes (3)' })).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use notes (3)' }))
    ask('x')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]!.useMemory).toBe(false)
  })

  it('sends useMemory false and says the notes are not loaded when listMemory fails', async () => {
    const { world } = show({ intercept: (method) => (method === 'listMemory' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    openOptions()
    expect((screen.getByRole('checkbox', { name: 'Notes not loaded' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('note').textContent).not.toContain('notes')
    ask('x')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]!.useMemory).toBe(false)
  })

  it('sends useMemory false while listMemory has not answered yet', async () => {
    const { world } = show({ intercept: (method) => (method === 'listMemory' ? new Promise(() => undefined) : undefined) })
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]!.useMemory).toBe(false)
  })

  it('sends useMemory true when notes exist, and false when there are none', async () => {
    const first = show()
    await ready()
    openOptions()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use notes (3)' })).toBeTruthy())
    ask('x')
    await screen.findByText(workflowSummary)
    expect(first.world.planCalls()[0]!.useMemory).toBe(true)
    first.unmount()
    const second = show({ memory: [] })
    await ready()
    openOptions()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'No saved notes' })).toBeTruthy())
    ask('y')
    await screen.findByText(workflowSummary)
    expect(second.world.planCalls()[0]!.useMemory).toBe(false)
  })

  it('sends the workflow id and the selected node of an edit context, and can clear it', async () => {
    const onClear = vi.fn()
    const { world } = show({}, { editContext: { workflowId: 'wf-receipt', nodeId: 'extract' }, onClearEditContext: onClear })
    await ready()
    expect(screen.getByText('Editing: wf-receipt, node extract')).toBeTruthy()
    ask('add a currency field')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]).toMatchObject({ workflowId: 'wf-receipt', selection: { nodeId: 'extract' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop editing' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('sends no workflow id without an edit context', async () => {
    const { world } = show()
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]).not.toHaveProperty('workflowId')
    expect(world.planCalls()[0]).not.toHaveProperty('selection')
  })

  it('attaches a file, sends it with the request, shows it in the transcript and clears the composer', async () => {
    const { world } = show()
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['hello'], 'receipt.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    ask('use this file')
    await screen.findByText(workflowSummary)
    const sent = world.planCalls()[0]!.attachments
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ name: 'receipt.txt', mediaType: 'text/plain' })
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('receipt.txt')
    expect(screen.queryByText('Attachments 1/5')).toBeNull()
  })

  it('asks the port to remove the unsent files when the chat is closed, and keeps the ones that were sent', async () => {
    const remove = vi.fn(async () => undefined)
    show({}, { port: { ...port, remove } })
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['hello'], 'sent.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    ask('use this file')
    await screen.findByText(workflowSummary)
    fireEvent.change(input, { target: { files: [new File(['hello'], 'unsent-file.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    closeActiveTab()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('att-panel-15-xxxxxxxx')
    expect(screen.queryByText('Attachments 1/5')).toBeNull()
  })

  it('asks the port to remove the unsent files when it is unmounted', async () => {
    const remove = vi.fn(async () => undefined)
    const { unmount } = show({}, { port: { ...port, remove } })
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['hello'], 'unsent.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    unmount()
    expect(remove).toHaveBeenCalledWith('att-panel-10-xxxxxxxx')
  })

  it('asks the port to remove the files of a request that was cancelled by closing the panel', async () => {
    const remove = vi.fn(async () => undefined)
    const { unmount } = show({ script: scripted(['hang']) }, { port: { ...port, remove } })
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['hello'], 'inflight.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    ask('x')
    await screen.findByRole('button', { name: 'Cancel' })
    unmount()
    expect(remove).toHaveBeenCalledWith('att-panel-12-xxxxxxxx')
  })

  it('survives a port without remove or whose remove fails when a chat is closed and on unmount', async () => {
    for (const remove of [undefined, vi.fn(() => Promise.reject(new Error('no')))]) {
      const { unmount } = show({}, { port: remove === undefined ? port : { ...port, remove } })
      await ready()
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
      fireEvent.change(input, { target: { files: [new File(['hello'], 'a.txt', { type: 'text/plain' })] } })
      await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
      await act(async () => undefined)
      closeActiveTab()
      fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File(['hello'], 'b.txt', { type: 'text/plain' })] } })
      await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
      unmount()
    }
  })

  it('counts attachments of earlier turns against the limit of ten', async () => {
    const earlier: ConversationEntry[] = Array.from({ length: 5 }, (_, i): ConversationEntry[] => [
      { role: 'user', text: `u${i}`, attachments: [{ id: `att-old-${i}-aaaa`, mediaType: 'text/plain', name: `old${i}.txt`, bytes: 1 }, { id: `att-old-${i}-bbbb`, mediaType: 'text/plain', name: `older${i}.txt`, bytes: 1 }] },
      { role: 'assistant', planId: `p${i}`, result: results.unsupported, meta: metas.plain },
    ]).flat()
    show({}, { initialEntries: earlier })
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'eleven.txt', { type: 'text/plain' })] } })
    expect((await screen.findByRole('alert')).textContent).toContain('up to 10 files in one conversation')
  })
})

describe('ChatPanel: new chat and the turn limit', () => {
  it('opens a new chat tab with an empty conversation and the defaults, and keeps the first one', async () => {
    show()
    await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Careful' }))
    ask('first request')
    await screen.findByText(workflowSummary)
    fireEvent.click(newTabButton())
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.getByText('What would you like to automate?')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Normal' }).getAttribute('aria-checked')).toBe('true')
    expect(box().value).toBe('')
    fireEvent.click(screen.getByRole('tab', { name: 'first request' }))
    expect(screen.getByText(workflowSummary)).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Careful' }).getAttribute('aria-checked')).toBe('true')
  })

  it('can open a new chat while a plan is running in another one', async () => {
    show({ script: scripted(['hang']) })
    await ready()
    ask('x')
    await screen.findByRole('button', { name: 'Cancel' })
    expect(newTabButton().disabled).toBe(false)
    fireEvent.click(newTabButton())
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'x' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByRole('alert')
  })

  it('has no New chat button any more', async () => {
    show()
    await ready()
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
  })

  const pairs = (count: number): ConversationEntry[] =>
    Array.from({ length: count }, (_, i): ConversationEntry[] => [
      { role: 'user', text: `u${i}`, attachments: [] },
      { role: 'assistant', planId: `p${i}`, result: results.unsupported, meta: metas.plain },
    ]).flat()

  it('allows the message that makes forty turns and asks for a new chat after that', async () => {
    const { world, unmount } = show({}, { initialEntries: pairs(20) })
    await ready()
    expect(screen.queryByText('This conversation is too long. Start a new chat.')).toBeNull()
    ask('the twenty-first')
    await screen.findByText(workflowSummary)
    expect(world.planCalls()[0]!.turns).toHaveLength(40)
    expect(screen.getByText('This conversation is too long. Start a new chat.')).toBeTruthy()
    expect(box().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }))
    expect(box().disabled).toBe(false)
    unmount()
  })

  it('shows the notice at once for a conversation that is already too long', async () => {
    show({}, { initialEntries: pairs(21) })
    await ready()
    expect(screen.getByText('This conversation is too long. Start a new chat.')).toBeTruthy()
    expect(sendButton().disabled).toBe(true)
  })
})

describe('ChatPanel: models and views', () => {
  it('loads the model list once, however much is done', async () => {
    const { world } = show()
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(world.callsOf('llmModels')).toHaveLength(1)
  })

  it('shows a clear message and a disabled composer when nothing is configured', async () => {
    show({ models: modelsNothingConfigured })
    expect(await screen.findByText('No model is ready')).toBeTruthy()
    expect(screen.getByText(/Add a provider key in Settings/)).toBeTruthy()
    expect(box().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
  })

  it('shows an error and a retry when the model list cannot be loaded', async () => {
    let fail = true
    const { world } = show({
      intercept: (method) => {
        if (method === 'llmModels' && fail) {
          fail = false
          return Promise.reject(new RillError('INTERNAL', 'SECRET-MODELS'))
        }
        return undefined
      },
    })
    expect(await screen.findByText('Could not load the model list.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('SECRET-MODELS')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await ready()
    expect(world.callsOf('llmModels')).toHaveLength(2)
  })

  it('shows the model tab and reports a choice, and never claims a switch', async () => {
    const onSelectModel = vi.fn()
    show({}, { onSelectModel })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('button', { name: /GPT-6\.1 Sol/ }))
    expect(onSelectModel).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-6.1-sol' })
    expect(screen.getByRole('button', { name: /Claude Opus 5\.5/ }).getAttribute('aria-current')).toBe('true')
  })

  it('shows the notes tab, and keeps the conversation and the draft when the person comes back', async () => {
    show()
    await ready()
    ask('first')
    await screen.findByText(workflowSummary)
    type('half written')
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(await screen.findByRole('list', { name: 'Saved notes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByText(workflowSummary)).toBeTruthy()
    expect(box().value).toBe('half written')
  })

  it('counts the notes again when the person comes back from the notes tab', async () => {
    const { world } = show()
    await ready()
    openOptions()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use notes (3)' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    const field = await screen.findByRole('textbox', { name: 'New note' })
    fireEvent.change(field, { target: { value: 'a brand new note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('a brand new note')
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use notes (4)' })).toBeTruthy())
    expect(world.callsOf('listMemory').length).toBeGreaterThanOrEqual(3)
  })
})

describe('ChatPanel: lifecycle', () => {
  it('cancels the plan that runs when it is unmounted, once', async () => {
    const { world, unmount } = show({ script: scripted(['hang']) })
    await ready()
    ask('will be cancelled')
    await screen.findByRole('button', { name: 'Cancel' })
    unmount()
    await waitFor(() => expect(world.client.pendingPlans()).toEqual([]))
    expect(world.callsOf('cancelPlan')).toHaveLength(1)
    expect(world.callsOf('cancelPlan')[0]!.params).toEqual({ planId: 'plan-1' })
  })

  it('cancels nothing when it is unmounted after the plan answered', async () => {
    const { world, unmount } = show()
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(world.callsOf('cancelPlan')).toHaveLength(0)
  })

  it('does not report a deploy that finishes after it was unmounted', async () => {
    let finish: (value: unknown) => void = () => undefined
    const onDeployed = vi.fn()
    const { world, unmount } = show(
      { intercept: (method) => (method === 'deployPlan' ? new Promise((resolve) => (finish = resolve)) : undefined) },
      { onDeployed },
    )
    await ready()
    ask('x')
    await screen.findByText(workflowSummary)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(world.callsOf('deployPlan')).toHaveLength(1))
    unmount()
    finish({ workflowId: 'wf-late' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onDeployed).not.toHaveBeenCalled()
  })

  it('shows a planning bubble while a plan runs', async () => {
    show({ script: scripted(['hang']) })
    await ready()
    ask('x')
    expect(await screen.findByText('Working on a plan…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Working on a plan…')).toBeNull()
  })

  it('draws the planning bubble with decorative dots that assistive technology skips', async () => {
    show({ script: scripted(['hang']) })
    await ready()
    ask('x')
    const bubble = (await screen.findByText('Working on a plan…')) as HTMLElement
    const dots = bubble.querySelector('span[aria-hidden="true"]')
    expect(dots).not.toBeNull()
    expect(dots!.querySelectorAll('i')).toHaveLength(3)
    expect(bubble.textContent).toBe('Working on a plan…')
  })

  it('marks every message with who sent it so the bubble can sit on its side', async () => {
    show({ script: scripted([outcomeOf(results.unsupported)]) })
    await ready()
    ask('x')
    await screen.findByRole('article', { name: 'Rill' })
    expect(screen.getByRole('article', { name: 'You' }).getAttribute('data-role')).toBe('user')
    expect(screen.getByRole('article', { name: 'Rill' }).getAttribute('data-role')).toBe('assistant')
  })

  it('renders the model text of a result as text', async () => {
    const base = results.unsupported as Extract<typeof results.unsupported, { kind: 'unsupported' }>
    const { container } = show({
      script: scripted([outcomeOf({ ...base, reason: '<img src=x onerror=alert(1)> <a href="https://evil.example">x</a>', nearest: '<script>alert(1)</script>' })]),
    })
    await ready()
    ask('x')
    await screen.findByText('This cannot be built')
    expect(container.querySelector('img, script')).toBeNull()
    expect(within(screen.getByRole('log')).queryByRole('link')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})


describe('ChatPanel: header', () => {
  const header = (container: HTMLElement): HTMLElement => container.querySelector('header')!
  const modelText = 'Anthropic · Claude Opus 5.5'

  it('shows the active model once, in the header, and not in the composer', async () => {
    const { container } = show()
    await ready()
    expect(within(header(container)).getByText(modelText)).toBeTruthy()
    expect(screen.getAllByText(/Claude Opus 5\.5/)).toHaveLength(1)
    expect(container.querySelector('[data-composer]')!.textContent).not.toContain('Claude Opus 5.5')
  })

  it('opens the model view when the model text is pressed, and shows it as plain text there', async () => {
    const { container } = show()
    await ready()
    fireEvent.click(within(header(container)).getByRole('button', { name: modelText }))
    expect(await screen.findByRole('button', { name: /GPT-6\.1 Sol/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(header(container)).queryByRole('button', { name: modelText })).toBeNull()
    expect(within(header(container)).getByText(modelText)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(within(header(container)).getByRole('button', { name: modelText })).toBeTruthy()
  })

  it('keeps the Chat, Model and Notes switch in the header', async () => {
    const { container } = show()
    await ready()
    const group = within(header(container)).getByRole('group', { name: 'Switch view' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(expect.arrayContaining(['Chat', 'Model', 'Notes']))
  })

  it('shows no model text before the models arrive, nor when no model is ready', async () => {
    const loading = show({ intercept: (method) => (method === 'llmModels' ? new Promise(() => undefined) : undefined) })
    expect(header(loading.container).textContent).not.toContain('·')
    loading.unmount()
    const none = show({ models: modelsNothingConfigured })
    await screen.findByText('No model is ready')
    expect(header(none.container).textContent).not.toContain('·')
  })

  it('renders the model name as text, whatever it contains', async () => {
    const hostile = structuredClone(models)
    const active = hostile.models.find((model) => model.id === hostile.active?.model)!
    active.label = '<img src=x onerror=alert(1)>'
    const { container } = show({ models: hostile })
    await screen.findByText(/<img src=x onerror=alert\(1\)>/)
    expect(container.querySelector('img')).toBeNull()
    expect(header(container).textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
