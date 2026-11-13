import { RillError, type MethodName, type PlanResultBody } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fillChatDraft } from '../src/app/glue/actions'
import { ChatPanel, type ChatPanelProps } from '../src/chat/ChatPanel'
import type { AttachmentPort } from '../src/chat/Composer'
import type { ConversationEntry } from '../src/chat/model/conversation'
import { MAX_TABS } from '../src/chat/model/tabs'
import { catalog } from '../src/fixtures'
import { metas, outcomeOf, results } from '../src/fixtures/plan'
import { violations } from './axe'
import { makeWorld, type WorldOptions } from './chat-world'
import { renderThemed } from './render'

const summary = (results.workflow as Extract<PlanResultBody, { kind: 'workflow' }>).summary

const basePort: AttachmentPort = {
  async add(file) {
    return { id: `att-tab-${file.name.length}-xxxxxxxx`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}

function show(options: WorldOptions = {}, props: Partial<ChatPanelProps> = {}) {
  const world = makeWorld(options)
  let serial = 0
  const view = renderThemed(<ChatPanel client={world.client} port={basePort} catalog={catalog} newId={() => `plan-${++serial}`} {...props} />, { locale: 'en' })
  return { world, ...view, user: userEvent.setup() }
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Your request' }) as HTMLTextAreaElement
const send = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
const plus = (): HTMLButtonElement => screen.getByRole('button', { name: 'Open a new chat' }) as HTMLButtonElement
const tabs = (): HTMLElement[] => screen.getAllByRole('tab')
const tabNamed = (name: string | RegExp): HTMLElement => screen.getByRole('tab', { name })
const itemOf = (tab: HTMLElement): HTMLElement => document.querySelector<HTMLElement>(`[data-rill-cell="${tab.id}"]`)!
const panel = (): HTMLElement => screen.getByRole('tabpanel')
const closeButton = (title: string, which: 'first' | 'last' = 'first'): HTMLElement => {
  const found = screen.getAllByRole('button', { name: `Close ${title}` })
  return which === 'first' ? found[0]! : found.at(-1)!
}
const confirmClose = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Close the chat' }))
}

async function ready(): Promise<void> {
  await screen.findByText('Anthropic · Claude Opus 5.5')
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

function ask(text: string): void {
  type(text)
  fireEvent.click(send())
}

function later(method: MethodName, text: string): { intercept: WorldOptions['intercept']; release(): void; planId(): string | undefined } {
  let resolve: (value: unknown) => void = () => undefined
  let planId: string | undefined
  return {
    intercept: (name, params) => {
      if (name !== method || (params as { text?: string }).text !== text) return undefined
      planId = (params as { planId: string }).planId
      return new Promise((done) => {
        resolve = done
      })
    },
    release: () => resolve({ planId, result: results.workflow, meta: metas.plain }),
    planId: () => planId,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chat tabs: structure', () => {
  it('starts with one selected tab called New chat in a tablist, and a tabpanel labelled by it', async () => {
    show()
    await ready()
    expect(screen.getByRole('tablist', { name: 'Chats' })).toBeTruthy()
    expect(tabs().map((item) => item.textContent)).toEqual(['New chat'])
    const only = tabNamed('New chat')
    expect(only.getAttribute('aria-selected')).toBe('true')
    const panel = screen.getByRole('tabpanel', { name: 'New chat' })
    expect(only.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(only.id)
    expect(panel.contains(box())).toBe(true)
  })

  it('has no New chat button any more, and a plus button that opens a chat', async () => {
    show()
    await ready()
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
    expect(plus().getAttribute('type')).toBe('button')
  })

  it('shows the strip only in the Chat view, and the Model and Notes views keep the active tab', async () => {
    show()
    await ready()
    fireEvent.click(plus())
    ask('second chat')
    await screen.findByText(summary)
    fireEvent.click(tabs()[0]!)
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs()).toHaveLength(2)
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('keeps a conversation that finished while the Model view was open', async () => {
    const slow = later('plan', 'slow')
    show({ intercept: slow.intercept })
    await ready()
    ask('slow')
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    await act(async () => slow.release())
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(await screen.findByText(summary)).toBeTruthy()
  })

  it('loads the model list and the notes once for all tabs', async () => {
    const { world } = show()
    await ready()
    fireEvent.click(plus())
    fireEvent.click(plus())
    fireEvent.click(tabs()[0]!)
    expect(world.callsOf('llmModels')).toHaveLength(1)
    expect(world.callsOf('listMemory')).toHaveLength(1)
  })
})

describe('chat tabs: opening and switching', () => {
  it('opens an empty tab at the end, activates it and puts the cursor in its composer', async () => {
    show()
    await ready()
    ask('first request')
    await screen.findByText(summary)
    fireEvent.click(plus())
    expect(tabs().map((item) => item.textContent)).toEqual(['first request', 'New chat'])
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('What would you like to automate?')).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
    expect(document.activeElement).toBe(box())
  })

  it('keeps independent drafts, attachments, effort, notes switch and conversation in each tab', async () => {
    const { user } = show()
    await ready()
    type('draft one')
    fireEvent.click(screen.getByRole('radio', { name: 'Careful' }))
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use notes (3)' }))
    const first = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(first, { target: { files: [new File(['x'], 'one.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())

    fireEvent.click(plus())
    expect(box().value).toBe('')
    expect(within(panel()).queryByText('Attachments 1/5')).toBeNull()
    expect(screen.getByRole('radio', { name: 'Normal' }).getAttribute('aria-checked')).toBe('true')
    type('draft two')
    fireEvent.click(screen.getByRole('radio', { name: 'Very careful' }))
    ask('draft two')
    expect(await within(panel()).findByText(summary)).toBeTruthy()

    await user.click(tabNamed('New chat'))
    expect(box().value).toBe('draft one')
    expect(screen.getByRole('radio', { name: 'Careful' }).getAttribute('aria-checked')).toBe('true')
    expect(within(panel()).getByText('Attachments 1/5')).toBeTruthy()
    expect(within(panel()).queryByText(summary)).toBeNull()
    expect((screen.getByRole('checkbox', { name: 'Use notes (3)' }) as HTMLInputElement).checked).toBe(false)

    await user.click(tabNamed('draft two'))
    expect(within(panel()).getByText(summary)).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Very careful' }).getAttribute('aria-checked')).toBe('true')
    expect(box().value).toBe('')
    expect(within(panel()).queryByText('Attachments 1/5')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect((screen.getByRole('checkbox', { name: 'Use notes (3)' }) as HTMLInputElement).checked).toBe(true)
  })

  it('sends what a tab holds, with that tab effort and notes switch', async () => {
    const { world } = show()
    await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Careful' }))
    fireEvent.click(plus())
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use notes (3)' }))
    ask('from the second')
    await screen.findByText(summary)
    expect(world.planCalls()).toHaveLength(1)
    expect(world.planCalls()[0]).toMatchObject({ text: 'from the second', effort: 'medium', useMemory: false, turns: [] })
  })

  it('opens up to eight chats, disables the plus with a note, and enables it after a close', async () => {
    show()
    await ready()
    for (let count = 1; count < MAX_TABS; count += 1) fireEvent.click(plus())
    expect(tabs()).toHaveLength(MAX_TABS)
    expect(plus().disabled).toBe(true)
    expect(screen.getByText('You can keep at most 8 chats open. Close one to start another.')).toBeTruthy()
    expect(plus().getAttribute('aria-describedby')).toBe(screen.getByText(/at most 8 chats/).id)
    fireEvent.click(closeButton('New chat', 'last'))
    expect(tabs()).toHaveLength(MAX_TABS - 1)
    expect(plus().disabled).toBe(false)
    expect(screen.queryByText(/at most 8 chats/)).toBeNull()
  })

  it('does not open a ninth chat from the keyboard shortcut of a disabled button', async () => {
    show()
    await ready()
    for (let count = 1; count < MAX_TABS; count += 1) fireEvent.click(plus())
    fireEvent.click(plus())
    expect(tabs()).toHaveLength(MAX_TABS)
  })

  it('opens a new chat from the turn limit notice', async () => {
    const pairs: ConversationEntry[] = Array.from({ length: 21 }, (_, i): ConversationEntry[] => [
      { role: 'user', text: `u${i}`, attachments: [] },
      { role: 'assistant', planId: `p${i}`, result: results.unsupported, meta: metas.plain },
    ]).flat()
    show({}, { initialEntries: pairs })
    await ready()
    expect(send().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }))
    expect(tabs()).toHaveLength(2)
    expect(box().disabled).toBe(false)
    expect(send().disabled).toBe(true)
  })

  it('applies the initial entries and the initial draft to the first tab only', async () => {
    const entries: ConversationEntry[] = [
      { role: 'user', text: 'earlier', attachments: [] },
      { role: 'assistant', planId: 'p0', result: results.unsupported, meta: metas.plain },
    ]
    show({}, { initialEntries: entries, initialDraft: 'a draft' })
    await ready()
    expect(tabs().map((item) => item.textContent)).toEqual(['earlier'])
    expect(box().value).toBe('a draft')
    fireEvent.click(plus())
    expect(box().value).toBe('')
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('passes the edit context to every tab', async () => {
    const { world } = show({}, { editContext: { workflowId: 'wf-receipt', nodeId: 'extract' } })
    await ready()
    fireEvent.click(plus())
    expect(screen.getAllByText(/Editing: wf-receipt, node extract/)).toHaveLength(2)
    ask('change it')
    await screen.findByText(summary)
    expect(world.planCalls()[0]).toMatchObject({ workflowId: 'wf-receipt', selection: { nodeId: 'extract' } })
  })
})

describe('chat tabs: requests that finish in the background', () => {
  it('delivers the answer to the tab that asked, marks it unread and never shows it in the tab the user is in', async () => {
    const slow = later('plan', 'slow')
    show({ intercept: slow.intercept })
    await ready()
    ask('slow')
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy()
    fireEvent.click(plus())
    expect(within(itemOf(tabNamed('slow'))).getByRole('img', { name: 'Working' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    type('typing in the second')
    await act(async () => slow.release())
    await waitFor(() => expect(within(itemOf(tabNamed(/slow/))).queryByRole('img', { name: 'Working' })).toBeNull())
    expect(within(itemOf(tabNamed(/slow/))).getByRole('img', { name: 'New answer' })).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
    expect(box().value).toBe('typing in the second')
    expect(within(itemOf(tabNamed('New chat'))).queryByRole('img')).toBeNull()

    fireEvent.click(tabNamed(/slow/))
    expect(await within(panel()).findByText(summary)).toBeTruthy()
    expect(within(itemOf(tabNamed('slow'))).queryByRole('img')).toBeNull()
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('slow')
    fireEvent.click(tabNamed('New chat'))
    expect(within(panel()).queryByText(summary)).toBeNull()
  })

  it('marks a background tab when its request fails, and shows the failure when the tab is opened', async () => {
    let fail: () => void = () => undefined
    show({
      intercept: (name, params) =>
        name === 'plan' && (params as { text?: string }).text === 'bad'
          ? new Promise((_, reject) => {
              fail = () => reject(new RillError('PLAN_PROVIDER', 'x'))
            })
          : undefined,
    })
    await ready()
    ask('bad')
    fireEvent.click(plus())
    const first = tabs()[0]!
    await act(async () => fail())
    await waitFor(() => expect(within(itemOf(first)).queryByRole('img', { name: 'Working' })).toBeNull())
    expect(within(itemOf(first)).getByRole('img', { name: 'New answer' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(first)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(within(itemOf(first)).queryByRole('img')).toBeNull()
  })

  it('does not mark the tab the user is looking at as unread', async () => {
    show()
    await ready()
    ask('now')
    await screen.findByText(summary)
    expect(within(itemOf(tabNamed('now'))).queryByRole('img')).toBeNull()
  })

  it('lets a second tab send while the first one works, and delivers both answers', async () => {
    const slow = later('plan', 'slow')
    const { world } = show({ intercept: slow.intercept })
    await ready()
    ask('slow')
    fireEvent.click(plus())
    ask('quick')
    expect(await within(panel()).findByText(summary)).toBeTruthy()
    expect(world.planCalls().map((call) => call.text)).toEqual(['slow', 'quick'])
    await act(async () => slow.release())
    fireEvent.click(tabNamed(/slow/))
    expect(await within(panel()).findByText(summary)).toBeTruthy()
  })

  it('refuses a third request at the same time with a clear message in its own tab, and gives the text back', async () => {
    const { world } = show({ script: () => 'hang' })
    await ready()
    ask('one')
    fireEvent.click(plus())
    ask('two')
    fireEvent.click(plus())
    ask('three')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Other plans are still running. Try again when one finishes.')
    expect(box().value).toBe('three')
    expect(screen.queryByRole('article')).toBeNull()
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Working' })).toHaveLength(2))
    expect(world.planCalls()).toHaveLength(3)
    fireEvent.click(tabNamed('one'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('shows a failure in the tab that sent the request', async () => {
    const { world } = show({ script: (params) => (params.text === 'bad' ? new RillError('PLAN_PROVIDER', 'x') : outcomeOf(results.workflow)) })
    await ready()
    fireEvent.click(plus())
    ask('bad')
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(tabs()[0]!)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(world.planCalls()).toHaveLength(1)
  })
})

describe('chat tabs: closing', () => {
  it('closes an empty tab at once, without asking', async () => {
    show()
    await ready()
    fireEvent.click(plus())
    fireEvent.click(closeButton('New chat', 'last'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tabs()).toHaveLength(1)
  })

  it('treats a blank draft as empty', async () => {
    show()
    await ready()
    type('   ')
    fireEvent.click(closeButton('New chat'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['a draft', 'New chat', async () => type('half a thought')],
    ['an answered request', 'done already', async () => {
      ask('done already')
      await screen.findByText(summary)
    }],
  ])('asks before it closes a tab that has %s: Keep it keeps the tab, Close the chat closes it', async (_name, title, fill) => {
    show()
    await ready()
    await fill()
    fireEvent.click(closeButton(title))
    const dialog = screen.getByRole('dialog', { name: 'Close this chat?' })
    expect(dialog.textContent).toContain('Workflows already deployed from it stay.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tabs()).toHaveLength(1)
    fireEvent.click(closeButton(title))
    confirmClose()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tabs().map((item) => item.textContent)).toEqual(['New chat'])
  })

  it('closes with Escape out of the dialog without closing the tab', async () => {
    const { user } = show()
    await ready()
    type('keep me')
    fireEvent.click(closeButton('New chat'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(box().value).toBe('keep me')
  })

  it('leaves one fresh empty tab when the last one is closed', async () => {
    show()
    await ready()
    ask('only chat')
    await screen.findByText(summary)
    fireEvent.click(closeButton('only chat'))
    confirmClose()
    expect(tabs().map((item) => item.textContent)).toEqual(['New chat'])
    expect(screen.queryByRole('article')).toBeNull()
    expect(box().value).toBe('')
    expect(tabNamed('New chat').getAttribute('aria-selected')).toBe('true')
  })

  it('cancels the running request of a closed tab once, removes its unsent attachments and ignores a late answer', async () => {
    const remove = vi.fn(async () => undefined)
    const slow = later('plan', 'slow')
    const { world } = show({ intercept: slow.intercept, script: () => 'hang' }, { port: { ...basePort, remove } })
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'inflight.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    ask('slow')
    await screen.findByRole('button', { name: 'Cancel' })
    const planId = slow.planId()!
    fireEvent.click(plus())
    fireEvent.change(document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]!, { target: { files: [new File(['x'], 'unsent-in-second.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    fireEvent.click(tabNamed(/slow/))
    fireEvent.click(closeButton('slow'))
    confirmClose()
    expect(world.callsOf('cancelPlan')).toHaveLength(1)
    expect(world.callsOf('cancelPlan')[0]!.params).toEqual({ planId })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]).toEqual(['att-tab-12-xxxxxxxx'])
    await act(async () => slow.release())
    expect(tabs().map((item) => item.textContent)).toEqual(['New chat'])
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('removes the unsent attachments of an idle tab and keeps the sent ones', async () => {
    const remove = vi.fn(async () => undefined)
    show({}, { port: { ...basePort, remove } })
    await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'unsent.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText('Attachments 1/5')).toBeTruthy())
    await act(async () => undefined)
    fireEvent.click(closeButton('New chat'))
    confirmClose()
    expect(remove).toHaveBeenCalledExactlyOnceWith('att-tab-10-xxxxxxxx')
  })

  it('does not touch the other tabs when one closes', async () => {
    const remove = vi.fn(async () => undefined)
    const { world } = show({}, { port: { ...basePort, remove } })
    await ready()
    type('stay here')
    fireEvent.click(plus())
    fireEvent.click(closeButton('New chat', 'last'))
    expect(tabs().map((item) => item.textContent)).toEqual(['New chat'])
    expect(box().value).toBe('stay here')
    expect(remove).not.toHaveBeenCalled()
    expect(world.callsOf('cancelPlan')).toHaveLength(0)
  })

  it('never touches a workflow that was deployed from the closed tab', async () => {
    const { world } = show()
    await ready()
    ask('deploy me')
    await screen.findByText(summary)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    await screen.findByText('Deployed. Workflow wf-new')
    fireEvent.click(closeButton('deploy me'))
    confirmClose()
    const called = world.calls.map((call) => call.method)
    expect(called.filter((method) => method === 'deployPlan')).toHaveLength(1)
    for (const method of ['deactivate', 'activate', 'startRun', 'deploy', 'cancelPlan'] as const) expect(called).not.toContain(method)
  })

  it('activates the next tab when the active one closes, and puts the focus on it', async () => {
    show()
    await ready()
    fireEvent.click(plus())
    fireEvent.click(plus())
    fireEvent.click(tabs()[1]!)
    fireEvent.click(within(itemOf(tabs()[1]!)).getByRole('button', { name: /^Close / }))
    await waitFor(() => expect(tabs()).toHaveLength(2))
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(tabs()[1]))
  })
})

describe('chat tabs: titles', () => {
  it('uses the first message, and shows New chat while there is none', async () => {
    show()
    await ready()
    expect(tabs()[0]!.textContent).toBe('New chat')
    ask('watch my receipts')
    await screen.findByText(summary)
    expect(tabs()[0]!.textContent).toBe('watch my receipts')
    ask('a later message')
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(2))
    expect(tabs()[0]!.textContent).toBe('watch my receipts')
  })

  it('cuts a long first message to about 28 characters', async () => {
    show()
    await ready()
    ask('When a receipt PDF lands in a folder, put the amount and date in a CSV')
    await screen.findByText(summary)
    expect(tabs()[0]!.textContent).toBe('When a receipt PDF lands in…')
    expect(closeButton('When a receipt PDF lands in…')).toBeTruthy()
  })

  it('shows markup in a message as text and escapes invisible characters', async () => {
    const { container } = show()
    await ready()
    ask('<img src=x onerror=alert(1)> <b>bold</b>')
    await screen.findByText(summary)
    expect(tabs()[0]!.textContent).toBe('<img src=x onerror=alert(1)…')
    expect(container.querySelector('[role="tablist"] img, [role="tablist"] b')).toBeNull()
    fireEvent.click(plus())
    ask('a\u202Eb\u200Bc')
    await screen.findByText(summary)
    expect(tabs()[1]!.textContent).toBe('a‹U+202E›b‹U+200B›c')
  })

  it('shows the answers of a question card as nothing, because the first message is the title', async () => {
    show()
    await ready()
    ask('first words')
    await screen.findByText(summary)
    expect(tabs()[0]!.textContent).toBe('first words')
  })
})

describe('chat tabs: keyboard and aria', () => {
  async function three() {
    const shown = show()
    await ready()
    fireEvent.click(plus())
    fireEvent.click(plus())
    fireEvent.click(tabs()[0]!)
    return shown
  }

  it('keeps one tab stop in the tablist, and the close button of the active tab', async () => {
    await three()
    expect(tabs().map((item) => item.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    const closes = screen.getAllByRole('button', { name: /^Close /, hidden: true })
    expect(closes.map((item) => item.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })

  it('moves the focus with the arrows, Home and End, wrapping around, without activating', async () => {
    const { user } = await three()
    tabs()[0]!.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabs()[1]!.getAttribute('tabindex')).toBe('0')
    expect(tabs()[0]!.getAttribute('tabindex')).toBe('-1')
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(tabs()[2])
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tabs()[0])
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(tabs()[2])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(tabs()[0])
    expect(tabs().map((item) => item.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
  })

  it('activates the focused tab with Enter or Space', async () => {
    const { user } = await three()
    tabs()[0]!.focus()
    await user.keyboard('{ArrowRight}{Enter}')
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowRight} ')
    expect(tabs()[2]!.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs()[2]!.id)
  })

  it('closes the focused tab with Delete, asking first when it has content', async () => {
    const { user } = await three()
    tabs()[0]!.focus()
    await user.keyboard('{ArrowRight}{Delete}')
    expect(tabs()).toHaveLength(2)
    tabs()[0]!.focus()
    fireEvent.click(tabs()[0]!)
    type('has content')
    await user.keyboard('{Delete}')
    expect(screen.getByRole('dialog', { name: 'Close this chat?' })).toBeTruthy()
  })

  it('reaches the close button of the active tab with Tab and closes with Enter', async () => {
    const { user } = await three()
    tabs()[1]!.focus()
    await user.keyboard('{Enter}')
    await user.tab()
    expect(document.activeElement).toBe(within(itemOf(tabs()[1]!)).getByRole('button', { name: /^Close / }))
    await user.keyboard('{Enter}')
    expect(tabs()).toHaveLength(2)
  })

  it('wires every tab to its own panel, and hides the panels of the other tabs', async () => {
    await three()
    for (const item of tabs()) {
      const panelId = item.getAttribute('aria-controls')!
      const panel = document.getElementById(panelId)!
      expect(panel.getAttribute('role')).toBe('tabpanel')
      expect(panel.getAttribute('aria-labelledby')).toBe(item.id)
      expect(panel.hidden).toBe(item.getAttribute('aria-selected') !== 'true')
    }
    expect(new Set(tabs().map((item) => item.id)).size).toBe(3)
  })

  it('names the close button after the title', async () => {
    show()
    await ready()
    ask('the title')
    await screen.findByText(summary)
    expect(screen.getByRole('button', { name: 'Close the title' })).toBeTruthy()
  })

  it('has no axe violations with several tabs, a working one and an unread one', async () => {
    const slow = later('plan', 'slow')
    const { container } = show({ intercept: slow.intercept })
    await ready()
    ask('slow')
    fireEvent.click(plus())
    fireEvent.click(plus())
    expect(await violations(container)).toEqual([])
    await act(async () => slow.release())
    await waitFor(() => expect(within(itemOf(tabNamed(/slow/))).getByRole('img', { name: 'New answer' })).toBeTruthy())
    expect(await violations(container)).toEqual([])
  })
})

describe('chat tabs: the strip and the composer of the active tab', () => {
  it('scrolls the active tab into view when it changes', async () => {
    const scroll = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    show()
    await ready()
    fireEvent.click(plus())
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(scroll.mock.contexts).toContain(tabs()[1])
    expect(scroll.mock.contexts).toContain(itemOf(tabs()[1]!))
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('scrolls the strip sideways instead of squeezing the tabs', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/chat/ChatTabs.module.css'), 'utf8')
    expect(css).toMatch(/overflow-x:\s*auto/)
    expect(css).toMatch(/flex:\s*0 0 auto/)
  })

  it('keeps the close and plus buttons at least 24px square, the smallest pointer target', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/chat/ChatTabs.module.css'), 'utf8')
    const rule = /\.close,\s*\.plus\s*\{([^}]*)\}/.exec(css)![1]!
    expect(Number(/(?<![-\w])width:\s*(\d+)px/.exec(rule)![1])).toBeGreaterThanOrEqual(24)
    expect(Number(/(?<![-\w])height:\s*(\d+)px/.exec(rule)![1])).toBeGreaterThanOrEqual(24)
  })

  it('fills the draft of the active tab when the app proposes a fix, not the first tab', async () => {
    const { container } = show()
    await ready()
    fireEvent.click(plus())
    expect(fillChatDraft(container, 'fix the node')).toBe(true)
    expect(box().value).toBe('fix the node')
    fireEvent.click(tabs()[0]!)
    expect(box().value).toBe('')
  })
})

describe('chat tabs: scroll position of a conversation', () => {
  const FULL = 1000
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
  const originalSet = Element.prototype.setAttribute

  afterEach(() => {
    if (original !== undefined) Object.defineProperty(Element.prototype, 'scrollTop', original)
    if (originalHeight !== undefined) Object.defineProperty(Element.prototype, 'scrollHeight', originalHeight)
    Element.prototype.setAttribute = originalSet
  })

  function layout(): void {
    const tops = new WeakMap<Element, number>()
    const hidden = (element: Element): boolean => element.closest('[hidden]') !== null
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element) {
        return hidden(this) || this.getAttribute('role') !== 'log' ? 0 : FULL
      },
    })
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return hidden(this) ? 0 : (tops.get(this) ?? 0)
      },
      set(this: Element, value: number) {
        if (!hidden(this)) tops.set(this, value)
      },
    })
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (name === 'hidden') for (const log of this.querySelectorAll('[role="log"]')) tops.delete(log)
      originalSet.call(this, name, value)
    }
  }

  const logOf = (tab: HTMLElement): HTMLElement => document.getElementById(tab.getAttribute('aria-controls')!)!.querySelector<HTMLElement>('[role="log"]')!

  it('scrolls to the newest answer when a tab is opened that got its answer in the background', async () => {
    layout()
    const slow = later('plan', 'slow')
    show({ intercept: slow.intercept })
    await ready()
    ask('slow')
    fireEvent.click(plus())
    await act(async () => slow.release())
    await waitFor(() => expect(within(itemOf(tabNamed(/slow/))).getByRole('img', { name: 'New answer' })).toBeTruthy())
    fireEvent.click(tabNamed(/slow/))
    expect(await within(panel()).findByText(summary)).toBeTruthy()
    expect(logOf(tabNamed(/slow/)).scrollTop).toBe(FULL)
  })

  it('puts a tab back where the person was reading when nothing new came in while they were away', async () => {
    layout()
    show()
    await ready()
    ask('first')
    await screen.findByText(summary)
    const log = logOf(tabNamed('first'))
    expect(log.scrollTop).toBe(FULL)
    log.scrollTop = 300
    fireEvent.scroll(log)
    fireEvent.click(plus())
    expect(log.scrollTop).toBe(0)
    fireEvent.click(tabNamed('first'))
    expect(log.scrollTop).toBe(300)
  })

  it('still follows the newest message in the tab the person is looking at', async () => {
    layout()
    show()
    await ready()
    ask('first')
    await screen.findByText(summary)
    const log = logOf(tabNamed('first'))
    log.scrollTop = 300
    fireEvent.scroll(log)
    ask('second')
    await waitFor(() => expect(screen.getAllByText(summary)).toHaveLength(2))
    expect(log.scrollTop).toBe(FULL)
  })
})
