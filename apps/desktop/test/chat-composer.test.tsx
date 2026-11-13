import { RillError, type AttachmentRef } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Composer, type AttachmentPort, type ComposerProps } from '../src/chat/Composer'
import { activeModelOf } from '../src/chat/model/models'
import { attachmentRefs, models, modelsNothingConfigured } from '../src/fixtures/plan'
import { violations } from './axe'
import { renderThemed } from './render'

const opus = activeModelOf(models)!

function refFor(file: File, index: number): AttachmentRef {
  return { id: `att-test-${String(index).padStart(4, '0')}`, mediaType: 'text/plain', name: file.name, bytes: file.size }
}

function portOf(overrides: Partial<AttachmentPort> = {}): AttachmentPort & { add: ReturnType<typeof vi.fn> } {
  let count = 0
  const add = vi.fn(async (file: File) => refFor(file, ++count))
  return { add, ...overrides } as AttachmentPort & { add: ReturnType<typeof vi.fn> }
}

function propsOf(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    state: { draft: 'watch a folder', attachments: [], effort: 'medium', useMemory: true },
    model: opus,
    models,
    memoryCount: 3,
    port: portOf(),
    busy: false,
    onChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onClearEditContext: vi.fn(),
    ...overrides,
  }
}

function show(overrides: Partial<ComposerProps> = {}) {
  const props = propsOf(overrides)
  const view = renderThemed(<Composer {...props} />, { locale: 'en' })
  return { props, ...view }
}

const textFile = (name = 'a.txt', content = 'hello'): File => new File([content], name, { type: 'text/plain' })
const input = (container: HTMLElement): HTMLInputElement => container.querySelector('input[type="file"]')!
const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Your request' })

function openOptions(): void {
  const toggle = screen.getByRole('button', { name: 'Options' })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

function sized(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('Composer: text and sending', () => {
  it('shows the draft and reports a change of it', () => {
    const { props } = show()
    expect(box().value).toBe('watch a folder')
    fireEvent.change(box(), { target: { value: 'new text' } })
    expect(props.onChange).toHaveBeenLastCalledWith({ draft: 'new text' })
  })

  it('sends by the button', () => {
    const { props } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(props.onSend).toHaveBeenCalledTimes(1)
  })

  it('sends with Ctrl+Enter or Cmd+Enter and not with Enter, Shift+Enter or while composing text', () => {
    const { props } = show({ state: { draft: 'line one\nline two', attachments: [], effort: 'medium', useMemory: true } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(props.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
    expect(props.onSend).toHaveBeenCalledTimes(2)
  })

  it('does not insert a line break itself for the shortcut', () => {
    show()
    const allowed = fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(allowed).toBe(false)
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true)
  })

  it('says how to send', () => {
    show()
    expect(screen.getByText('Press Ctrl or Cmd + Enter to send')).toBeTruthy()
  })

  it('disables send for an empty or blank draft, and the shortcut does nothing then', () => {
    for (const draft of ['', '   \n  ']) {
      const { props, unmount } = show({ state: { draft, attachments: [], effort: 'medium', useMemory: true } })
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
      expect(props.onSend).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('disables send over 8000 characters, says so, and allows exactly 8000', () => {
    const over = show({ state: { draft: 'x'.repeat(8001), attachments: [], effort: 'medium', useMemory: true } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('At most 8,000 characters')
    over.unmount()
    show({ state: { draft: 'x'.repeat(8000), attachments: [], effort: 'medium', useMemory: true } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a Cancel button instead of Send while busy, and cancels', () => {
    const { props } = show({ busy: true })
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Planning…')
    expect(box().disabled).toBe(true)
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('cannot send without a model, and says there is none', () => {
    const { props } = show({ model: undefined, models: modelsNothingConfigured })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('No model is set up')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('does not repeat the model, which the chat header shows', () => {
    const { container } = show()
    expect(container.textContent).not.toContain('Claude Opus 5.5')
    expect(container.textContent).not.toContain('Model:')
  })

  it('can be disabled from outside', () => {
    const { props } = show({ disabled: true })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(props.onSend).not.toHaveBeenCalled()
  })
})

describe('Composer: effort and memory', () => {
  it('reports a changed effort', () => {
    const { props } = show()
    fireEvent.click(screen.getByRole('radio', { name: 'Careful' }))
    expect(props.onChange).toHaveBeenLastCalledWith({ effort: 'high' })
  })

  it('shows the note count and reports the toggle', () => {
    const { props } = show()
    openOptions()
    const toggle = screen.getByRole('checkbox', { name: 'Use notes (3)' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(props.onChange).toHaveBeenLastCalledWith({ useMemory: false })
  })

  it('shows the toggle off, and disabled when there are no notes', () => {
    show({ memoryCount: 0 })
    openOptions()
    const toggle = screen.getByRole('checkbox', { name: 'No saved notes' }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.checked).toBe(false)
  })

  it('shows the toggle off and disabled while the notes are not known, and leaves notes out of the transfer notice', () => {
    show({ memoryCount: undefined })
    openOptions()
    const toggle = screen.getByRole('checkbox', { name: 'Notes not loaded' }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.checked).toBe(false)
    expect(screen.getByRole('note').textContent).not.toContain('notes')
  })

  it('shows the external transfer notice with what leaves the computer', () => {
    const first = show({ state: { draft: 'x', attachments: [], effort: 'medium', useMemory: false } })
    const note = screen.getByRole('note')
    expect(note.textContent).toBe('Sent to the AI provider')
    expect(note.getAttribute('title')).toBe('Sent to the AI provider: your request')
    expect(note.querySelector('[class*="badge"]')).toBeNull()
    first.unmount()
    show({ state: { draft: 'x', attachments: [attachmentRefs.pdf], effort: 'medium', useMemory: true } })
    expect(screen.getByRole('note').textContent).toContain('your request, attached files, notes')
    expect(screen.getByRole('note').getAttribute('title')).toBe(screen.getByRole('note').textContent)
  })

  it('does not list notes when memory is on but there are none', () => {
    show({ memoryCount: 0 })
    expect(screen.getByRole('note').textContent).not.toContain('notes')
  })
})

describe('Composer: attachments', () => {
  it('attaches by the button, calls the port with the file and reports the new list', async () => {
    const { props, container } = show()
    const file = textFile()
    fireEvent.change(input(container), { target: { files: [file] } })
    await waitFor(() => expect(props.onChange).toHaveBeenCalled())
    expect(props.port.add).toHaveBeenCalledWith(file)
    expect(props.onChange).toHaveBeenLastCalledWith({ attachments: [expect.objectContaining({ name: 'a.txt' })] })
  })

  it('opens the file picker from the visible button', () => {
    const { container } = show()
    const click = vi.spyOn(input(container), 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(click).toHaveBeenCalled()
  })

  it('attaches by drop and by paste', async () => {
    const { props, container } = show()
    const dropped = textFile('dropped.txt')
    fireEvent.drop(container.firstElementChild!.querySelector('[data-composer]')!, { dataTransfer: { files: [dropped], types: ['Files'] } })
    await waitFor(() => expect(props.port.add).toHaveBeenCalledWith(dropped))
    const pasted = new File(['png-bytes'], 'image.png', { type: 'image/png' })
    fireEvent.paste(box(), { clipboardData: { files: [pasted], getData: () => '' } })
    await waitFor(() => expect(props.port.add).toHaveBeenCalledWith(pasted))
  })

  it('lets a paste of plain text through', () => {
    const { props } = show()
    const allowed = fireEvent.paste(box(), { clipboardData: { files: [], getData: () => 'text' } })
    expect(allowed).toBe(true)
    expect(props.port.add).not.toHaveBeenCalled()
  })

  it('shows a drop hint while files are dragged over', () => {
    const { container } = show()
    const zone = container.querySelector('[data-composer]')!
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.getByText('Drop files here to attach them')).toBeTruthy()
    fireEvent.dragLeave(zone, { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.queryByText('Drop files here to attach them')).toBeNull()
  })

  it('takes over the drag of a file with the default action cancelled, and offers a copy', () => {
    const { container } = show()
    const zone = container.querySelector('[data-composer]')!
    const transfer = { types: ['Files'], files: [], dropEffect: '' }
    expect(fireEvent.dragOver(zone, { dataTransfer: transfer })).toBe(false)
    expect(transfer.dropEffect).toBe('copy')
  })

  it('cancels the default action of a dragged file while busy or disabled, shows no hint and refuses the drop', () => {
    for (const overrides of [{ busy: true }, { disabled: true }]) {
      const { props, container, unmount } = show(overrides)
      const zone = container.querySelector('[data-composer]')!
      const transfer = { types: ['Files'], files: [], dropEffect: '' }
      expect(fireEvent.dragOver(zone, { dataTransfer: transfer })).toBe(false)
      expect(transfer.dropEffect).toBe('none')
      expect(screen.queryByText('Drop files here to attach them')).toBeNull()
      expect(fireEvent.drop(zone, { dataTransfer: { files: [textFile()], types: ['Files'] } })).toBe(false)
      expect(props.port.add).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('leaves the drag of something that is not a file alone', () => {
    const { container } = show()
    const zone = container.querySelector('[data-composer]')!
    expect(fireEvent.dragOver(zone, { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true)
    expect(screen.queryByText('Drop files here to attach them')).toBeNull()
  })

  it('skips a dropped folder, even one that is named like a file, and attaches the files beside it', async () => {
    const { props, container } = show()
    const folder = new File(['x'], 'looks-like.pdf')
    const file = textFile('real.txt')
    const items = [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
    ]
    fireEvent.drop(container.querySelector('[data-composer]')!, { dataTransfer: { files: [folder, file], items, types: ['Files'] } })
    await waitFor(() => expect(props.port.add).toHaveBeenCalledTimes(1))
    expect(props.port.add).toHaveBeenCalledWith(file)
  })

  it('attaches a dropped file when the drop carries no item list, or an item that cannot say what it is', async () => {
    const { props, container } = show()
    const file = textFile('plain.txt')
    fireEvent.drop(container.querySelector('[data-composer]')!, { dataTransfer: { files: [file], items: [{ kind: 'file' }], types: ['Files'] } })
    await waitFor(() => expect(props.port.add).toHaveBeenCalledWith(file))
  })

  it('validates before it calls the port and shows the localized reason', async () => {
    const { props, container } = show()
    fireEvent.change(input(container), {
      target: { files: [new File(['x'], 'a.zip', { type: 'application/zip' }), new File([''], 'empty.txt', { type: 'text/plain' }), sized(textFile('big.txt'), 1024 * 1024 + 1)] },
    })
    expect(props.port.add).not.toHaveBeenCalled()
    const list = await screen.findByRole('list', { name: 'Attached files' })
    expect(list.textContent).toContain('This file type is not supported')
    expect(list.textContent).toContain('The file is empty.')
    expect(list.textContent).toContain('The file is too large')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('counts the files of the message and of the conversation', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...attachmentRefs.text, id: `att-have-${i}-xxxx`, name: `have${i}.txt` }))
    const a = show({ state: { draft: 'x', attachments: five, effort: 'medium', useMemory: true } })
    fireEvent.change(input(a.container), { target: { files: [textFile()] } })
    expect((await screen.findByRole('list', { name: 'Attached files' })).textContent).toContain('up to 5 files at a time')
    expect(a.props.port.add).not.toHaveBeenCalled()
    a.unmount()
    const b = show({ conversationAttachments: 10 })
    fireEvent.change(input(b.container), { target: { files: [textFile()] } })
    expect((await screen.findByRole('list', { name: 'Attached files' })).textContent).toContain('up to 10 files in one conversation')
    expect(b.props.port.add).not.toHaveBeenCalled()
  })

  it('counts the files of one batch against the limit of five', async () => {
    const { props, container } = show()
    const files = Array.from({ length: 7 }, (_, i) => textFile(`f${i}.txt`))
    fireEvent.change(input(container), { target: { files } })
    await waitFor(() => expect(props.port.add).toHaveBeenCalledTimes(5))
    expect(screen.getAllByText(/up to 5 files at a time/)).toHaveLength(2)
  })

  it('adds files that finish at different times without losing one', async () => {
    const resolvers: Array<(ref: AttachmentRef) => void> = []
    const port: AttachmentPort = { add: () => new Promise<AttachmentRef>((resolve) => resolvers.push(resolve)) }
    const { props, container } = show({ port })
    fireEvent.change(input(container), { target: { files: [textFile('one.txt'), textFile('two.txt')] } })
    expect(screen.getAllByText('Adding…')).toHaveLength(2)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolvers[1]!({ ...attachmentRefs.text, id: 'att-two-0002xx', name: 'two.txt' })
    })
    await act(async () => {
      resolvers[0]!({ ...attachmentRefs.text, id: 'att-one-0001xx', name: 'one.txt' })
    })
    const last = (props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { attachments: AttachmentRef[] }
    expect(last.attachments.map((item) => item.name)).toEqual(['two.txt', 'one.txt'])
    expect(screen.queryByText('Adding…')).toBeNull()
  })

  it('shows the localized rejection and never the text the server sent', async () => {
    const port: AttachmentPort = { add: () => Promise.reject(new RillError('ATTACHMENT_REJECTED', 'SERVER-SECRET /etc/passwd is a symlink')) }
    const { container } = show({ port })
    fireEvent.change(input(container), { target: { files: [textFile()] } })
    const list = await screen.findByRole('list', { name: 'Attached files' })
    await waitFor(() => expect(list.textContent).toContain('The attachment was rejected'))
    expect(document.body.textContent).not.toContain('SERVER-SECRET')
    expect(screen.queryByText('Adding…')).toBeNull()
  })

  it('shows a generic message for a port that fails with something else', async () => {
    const port: AttachmentPort = { add: () => Promise.reject(new Error('disk exploded: C:\\secret')) }
    const { container } = show({ port })
    fireEvent.change(input(container), { target: { files: [textFile()] } })
    const list = await screen.findByRole('list', { name: 'Attached files' })
    await waitFor(() => expect(list.textContent).toContain('Something went wrong'))
    expect(document.body.textContent).not.toContain('secret')
  })

  it('shows the chips, the counter and removes a file with the port and the list', async () => {
    const remove = vi.fn(async () => undefined)
    const port = portOf({ remove })
    const { props } = show({ port, state: { draft: 'x', attachments: [attachmentRefs.pdf, attachmentRefs.png], effort: 'medium', useMemory: true } })
    expect(screen.getByText('Attachments 2/5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment receipt-photo.png' }))
    expect(props.onChange).toHaveBeenLastCalledWith({ attachments: [attachmentRefs.pdf] })
    expect(remove).toHaveBeenCalledWith(attachmentRefs.png.id)
  })

  it('removes without a port.remove and survives a port.remove that fails', async () => {
    const remove = vi.fn(() => Promise.reject(new Error('no')))
    const { props } = show({ port: portOf({ remove }), state: { draft: 'x', attachments: [attachmentRefs.pdf], effort: 'medium', useMemory: true } })
    fireEvent.click(screen.getByRole('button', { name: /Remove attachment/ }))
    expect(props.onChange).toHaveBeenLastCalledWith({ attachments: [] })
    await Promise.resolve()
  })

  it('does not report to its parent after it was unmounted', async () => {
    let resolve!: (ref: AttachmentRef) => void
    const port: AttachmentPort = { add: () => new Promise<AttachmentRef>((done) => (resolve = done)) }
    const { props, container, unmount } = show({ port })
    fireEvent.change(input(container), { target: { files: [textFile()] } })
    unmount()
    await act(async () => {
      resolve({ ...attachmentRefs.text, id: 'att-late-0001x' })
    })
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('asks the port to remove a file that was added after the composer went away', async () => {
    let resolve!: (ref: AttachmentRef) => void
    const remove = vi.fn(async () => undefined)
    const port: AttachmentPort = { add: () => new Promise<AttachmentRef>((done) => (resolve = done)), remove }
    const { container, unmount } = show({ port })
    fireEvent.change(input(container), { target: { files: [textFile()] } })
    unmount()
    await act(async () => {
      resolve({ ...attachmentRefs.text, id: 'att-late-0001x' })
    })
    expect(remove).toHaveBeenCalledWith('att-late-0001x')
  })

  it('survives a port without remove, or whose remove fails, for a file added after the composer went away', async () => {
    for (const remove of [undefined, vi.fn(() => Promise.reject(new Error('no')))]) {
      let resolve!: (ref: AttachmentRef) => void
      const port: AttachmentPort = { add: () => new Promise<AttachmentRef>((done) => (resolve = done)), ...(remove === undefined ? {} : { remove }) }
      const { container, unmount } = show({ port })
      fireEvent.change(input(container), { target: { files: [textFile()] } })
      unmount()
      await act(async () => {
        resolve({ ...attachmentRefs.text, id: 'att-late-0002x' })
      })
    }
  })

  it('does not attach while busy', () => {
    const { props, container } = show({ busy: true })
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.drop(container.querySelector('[data-composer]')!, { dataTransfer: { files: [textFile()], types: ['Files'] } })
    expect(props.port.add).not.toHaveBeenCalled()
  })
})

describe('Composer: focus', () => {
  function again(view: ReturnType<typeof show>, overrides: Partial<ComposerProps>): void {
    view.rerender(<Composer {...propsOf(overrides)} />)
  }

  it('puts the focus back in the text field when the send is over and the focus was lost', () => {
    const view = show()
    box().focus()
    again(view, { busy: true })
    box().blur()
    expect(document.activeElement).toBe(document.body)
    again(view, { busy: false })
    expect(document.activeElement).toBe(box())
  })

  it('does not take the focus from another control that stays', () => {
    const editContext = { workflowId: 'wf-1' }
    const view = show({ busy: true, editContext })
    screen.getByRole('button', { name: 'Stop editing' }).focus()
    again(view, { busy: false, editContext })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop editing' }))
  })

  it('does not move the focus on the first render, nor while the send goes on', () => {
    const view = show()
    expect(document.activeElement).toBe(document.body)
    again(view, { busy: true })
    expect(document.activeElement).toBe(document.body)
  })
})

describe('Composer: edit context', () => {
  it('shows what is being edited with a clear button', () => {
    const { props } = show({ editContext: { workflowId: 'wf-receipt' } })
    expect(screen.getByText('Editing: wf-receipt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop editing' }))
    expect(props.onClearEditContext).toHaveBeenCalledTimes(1)
  })

  it('names the selected node too', () => {
    show({ editContext: { workflowId: 'wf-receipt', nodeId: 'extract' } })
    expect(screen.getByText('Editing: wf-receipt, node extract')).toBeTruthy()
  })

  it('shows nothing about editing without a context', () => {
    show()
    expect(screen.queryByText(/Editing/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop editing' })).toBeNull()
  })

  it('shows hidden characters of an id', () => {
    show({ editContext: { workflowId: 'wf\u202E1' } })
    expect(screen.getByText('Editing: wf‹U+202E›1')).toBeTruthy()
  })
})

describe('Composer: layout', () => {
  const toolbar = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('[data-rill-toolbar]')!
  const footer = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('[data-rill-footer]')!

  it('puts attach and the effort control on the left of one toolbar row and Send on the right', () => {
    const { container } = show()
    const bar = toolbar(container)
    const attach = within(bar).getByRole('button', { name: 'Attach files' })
    const effort = within(bar).getByRole('radiogroup', { name: 'Planning care' })
    const send = within(bar).getByRole('button', { name: 'Send' })
    expect(attach.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(effort.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(bar.lastElementChild?.contains(send)).toBe(true)
    expect(bar.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('shows Cancel on the right of the toolbar while busy', () => {
    const { container } = show({ busy: true })
    expect(toolbar(container).lastElementChild?.contains(within(toolbar(container)).getByRole('button', { name: 'Cancel' }))).toBe(true)
  })

  it('puts the transfer notice and the shortcut hint in one footer row below the toolbar, with the options closed', () => {
    const { container } = show()
    const row = footer(container)
    expect(within(row).getByRole('note').textContent).toContain('Sent to the AI provider')
    expect(within(row).getByRole('note').textContent).toContain('your request, notes')
    expect(within(row).getByText('Press Ctrl or Cmd + Enter to send')).toBeTruthy()
    expect(toolbar(container).compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Options' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the notice visible for attachments and notes without opening anything', () => {
    show({ state: { draft: 'x', attachments: [attachmentRefs.pdf], effort: 'medium', useMemory: true } })
    expect(screen.getByRole('note').textContent).toContain('your request, attached files, notes')
    expect(screen.getByRole('button', { name: 'Options' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the options closed by default and out of reach: no notes switch and no advanced step', () => {
    show()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show advanced step' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Maximum' })).toBeNull()
  })

  it('says next to the closed options that the notes are off, and describes the button with it', () => {
    const { container } = show({ state: { draft: 'x', attachments: [], effort: 'medium', useMemory: false } })
    const toggle = screen.getByRole('button', { name: 'Options' })
    const status = within(container.querySelector<HTMLElement>('[data-rill-options-bar]')!).getByText('Notes off')
    expect(toggle.getAttribute('aria-describedby')).toBe(status.id)
    expect(screen.getByRole('note').textContent).not.toContain('notes')
    fireEvent.click(toggle)
    expect(screen.queryByText('Notes off')).toBeNull()
    expect(toggle.getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('Notes off')).toBeTruthy()
  })

  it.each([
    ['notes are on', { useMemory: true }, 3],
    ['there are no notes to switch off', { useMemory: false }, 0],
    ['the notes have not loaded', { useMemory: false }, undefined],
  ])('does not say the notes are off when %s', (_name, patch, memoryCount) => {
    show({ state: { draft: 'x', attachments: [], effort: 'medium', ...patch }, memoryCount })
    expect(screen.queryByText('Notes off')).toBeNull()
    expect(screen.getByRole('button', { name: 'Options' }).getAttribute('aria-describedby')).toBeNull()
  })

  it('opens and closes the options with the button, which controls the region it opens', () => {
    const { container } = show()
    const toggle = screen.getByRole('button', { name: 'Options' })
    const region = container.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!
    expect(region.hidden).toBe(true)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(region.hidden).toBe(false)
    expect(within(region).getByRole('checkbox', { name: 'Use notes (3)' })).toBeTruthy()
    expect(within(region).getByRole('button', { name: 'Show advanced step' })).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(region.hidden).toBe(true)
  })

  it('can be opened, used and closed from the keyboard alone', async () => {
    const { props } = show()
    const user = userEvent.setup()
    const toggle = screen.getByRole('button', { name: 'Options' })
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Use notes (3)' }))
    await user.keyboard(' ')
    expect(props.onChange).toHaveBeenLastCalledWith({ useMemory: false })
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show advanced step' }))
    toggle.focus()
    await user.keyboard(' ')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the advanced effort step from the options and hides it again', () => {
    show()
    openOptions()
    fireEvent.click(screen.getByRole('button', { name: 'Show advanced step' }))
    expect(screen.getByRole('radio', { name: 'Maximum' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide advanced step' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide advanced step' }))
    expect(screen.queryByRole('radio', { name: 'Maximum' })).toBeNull()
  })

  it('offers no advanced toggle while the effort is the advanced step, which then stays shown', () => {
    show({ state: { draft: 'x', attachments: [], effort: 'max', useMemory: true } })
    expect(screen.getByRole('radio', { name: 'Maximum' })).toBeTruthy()
    openOptions()
    expect(screen.queryByRole('button', { name: /advanced step/ })).toBeNull()
  })

  it('keeps every effort step reachable in the toolbar, with no toggle inside the effort control', () => {
    const { container } = show()
    const group = within(toolbar(container)).getByRole('radiogroup', { name: 'Planning care' })
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Fast', 'Normal', 'Careful', 'Very careful'])
    expect(within(toolbar(container)).queryByRole('button', { name: /advanced step/ })).toBeNull()
  })

  it('disables the notes switch while busy, and keeps the options usable', () => {
    show({ busy: true })
    openOptions()
    expect((screen.getByRole('checkbox', { name: 'Use notes (3)' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('has no axe violations with the options closed and open, and while busy', async () => {
    const closed = show()
    expect(await violations(closed.container)).toEqual([])
    openOptions()
    expect(await violations(closed.container)).toEqual([])
    closed.unmount()
    const busy = show({ busy: true })
    expect(await violations(busy.container)).toEqual([])
  })
})
