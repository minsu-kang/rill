import { MEMORY_MAX_INPUT_CHARS, RillError, type MemoryItem } from '@rill/protocol'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MemoryPanel } from '../src/chat/MemoryPanel'
import { en } from '../src/i18n/en'
import { memoryFixtures } from '../src/fixtures/plan'
import { makeWorld, type WorldOptions } from './chat-world'
import { frames, gate } from './keep-focus'
import { renderThemed } from './render'

function show(memory: MemoryItem[], intercept?: WorldOptions['intercept']) {
  const world = makeWorld({ memory, intercept })
  const view = renderThemed(<MemoryPanel client={world.client} />, { locale: 'en' })
  return { world, ...view }
}

const input = (): HTMLInputElement => screen.getByRole('textbox', { name: 'New note' }) as HTMLInputElement
const save = (): HTMLButtonElement => within(input().closest('form')!).getByRole('button', { name: 'Save' }) as HTMLButtonElement
const editorSave = (): HTMLButtonElement => within(screen.getByRole('textbox', { name: 'Edit note' }).closest('li')!).getByRole('button', { name: 'Save' }) as HTMLButtonElement

async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
}

async function add(text: string): Promise<void> {
  fireEvent.change(input(), { target: { value: text } })
  fireEvent.click(save())
}

describe('MemoryPanel: list and counts', () => {
  it('lists the notes with a count out of twenty', async () => {
    show([...memoryFixtures.three])
    expect(screen.getByText('Loading…')).toBeTruthy()
    const list = await screen.findByRole('list', { name: 'Saved notes' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(list.textContent).toContain(memoryFixtures.three[0]!.text)
    expect(screen.getByText('3/20')).toBeTruthy()
  })

  it('shows an empty state with 0/20', async () => {
    show([])
    expect(await screen.findByText('No notes saved yet.')).toBeTruthy()
    expect(screen.getByText('0/20')).toBeTruthy()
    expect(save().disabled).toBe(true)
  })

  it('shows 20/20 with a message, and cannot add', async () => {
    show([...memoryFixtures.full])
    expect(await screen.findByText('All 20 notes are used. Delete one to save another.')).toBeTruthy()
    expect(screen.getByText('20/20')).toBeTruthy()
    fireEvent.change(input(), { target: { value: 'one more' } })
    expect(save().disabled).toBe(true)
  })

  it('shows the one-line rule and the transfer notice before anything is saved', async () => {
    show([])
    await loaded()
    expect(screen.getByText('A note is one line of at most 300 characters. You can save up to 20.')).toBeTruthy()
    expect(screen.getByText('Saved notes are sent to the AI provider with every plan request.')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('Sent to the AI provider')
  })

  it('shows a load error with a retry, and the notes after the retry', async () => {
    let fail = true
    const { world } = show([...memoryFixtures.three], (method) => {
      if (method === 'listMemory' && fail) {
        fail = false
        return Promise.reject(new RillError('INTERNAL', 'SECRET-LOAD-TEXT'))
      }
      return undefined
    })
    expect((await screen.findByRole('alert')).textContent).toContain('The engine reported an error')
    expect(document.body.textContent).not.toContain('SECRET-LOAD-TEXT')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Saved notes' })).toBeTruthy()
    expect(world.callsOf('listMemory')).toHaveLength(2)
  })
})

describe('MemoryPanel: add, edit, delete', () => {
  it('adds a note, clears the field and counts it', async () => {
    const { world } = show([...memoryFixtures.three])
    await loaded()
    await add('  Weekly reports go to ~/Reports  ')
    expect(await screen.findByText('Weekly reports go to ~/Reports')).toBeTruthy()
    expect(screen.getByText('4/20')).toBeTruthy()
    expect(input().value).toBe('')
    expect(world.callsOf('saveMemory')[0]!.params).toEqual({ text: '  Weekly reports go to ~/Reports  ' })
  })

  it('does not send an empty or blank note', async () => {
    const { world } = show([])
    await loaded()
    fireEvent.change(input(), { target: { value: '   ' } })
    expect(save().disabled).toBe(true)
    expect(world.callsOf('saveMemory')).toHaveLength(0)
  })

  it('adds with the Enter key of the form', async () => {
    show([])
    await loaded()
    fireEvent.change(input(), { target: { value: 'by enter' } })
    fireEvent.submit(input().closest('form')!)
    expect(await screen.findByText('by enter')).toBeTruthy()
  })

  it('edits a note in place and keeps its id', async () => {
    const { world } = show([...memoryFixtures.three])
    await loaded()
    const first = memoryFixtures.three[0]!
    fireEvent.click(screen.getByRole('button', { name: `Edit note: ${first.text}` }))
    const field = screen.getByRole('textbox', { name: 'Edit note' }) as HTMLInputElement
    expect(field.value).toBe(first.text)
    fireEvent.change(field, { target: { value: 'Receipts are in ~/Inbox' } })
    fireEvent.click(editorSave())
    expect(await screen.findByText('Receipts are in ~/Inbox')).toBeTruthy()
    expect(world.callsOf('saveMemory').at(-1)!.params).toEqual({ id: first.id, text: 'Receipts are in ~/Inbox' })
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull()
    expect(screen.getByText('3/20')).toBeTruthy()
  })

  it('cancels an edit without saving', async () => {
    const { world } = show([...memoryFixtures.three])
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: `Edit note: ${memoryFixtures.three[0]!.text}` }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note' }), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('changed')).toBeNull()
    expect(world.callsOf('saveMemory')).toHaveLength(0)
  })

  it('asks before deleting, and keeps the note when the person cancels', async () => {
    const { world } = show([...memoryFixtures.three])
    await loaded()
    const target = memoryFixtures.three[1]!
    fireEvent.click(screen.getByRole('button', { name: `Delete note: ${target.text}` }))
    expect(screen.getByText('Delete this note?')).toBeTruthy()
    expect(world.callsOf('deleteMemory')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this note?')).toBeNull()
    expect(screen.getByText(target.text)).toBeTruthy()
  })

  it('deletes after the confirmation', async () => {
    const { world } = show([...memoryFixtures.three])
    await loaded()
    const target = memoryFixtures.three[1]!
    fireEvent.click(screen.getByRole('button', { name: `Delete note: ${target.text}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText(target.text)).toBeNull())
    expect(world.callsOf('deleteMemory')[0]!.params).toEqual({ id: target.id })
    expect(screen.getByText('2/20')).toBeTruthy()
  })

  it('shows hostile note text as text', async () => {
    const hostile: MemoryItem = { id: 'h1', text: '<img src=x onerror=alert(1)> <a href="https://evil.example">x</a> **bold** ‮txt', createdAt: 1, updatedAt: 1 }
    const { container } = show([hostile])
    await loaded()
    expect(container.querySelector('img, a, strong')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('‹U+202E›txt')
  })
})

describe('MemoryPanel: the error codes', () => {
  it('shows a localized message for an invalid note, by rule, and keeps the text in the field', async () => {
    show([])
    await loaded()
    const cases: Array<[string, string]> = [
      ['x'.repeat(301), 'A note is at most 300 characters.'],
      ['bell\u0007', 'A note is one line without control characters.'],
      ['dir‮ect', 'Invisible characters that change the text direction are not allowed.'],
      ['zero​width', 'Invisible formatting characters are not allowed.'],
    ]
    for (const [text, message] of cases) {
      await add(text)
      expect((await screen.findByRole('alert')).textContent).toContain(message)
      expect(input().value).toBe(text)
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    }
  })

  it('shows a localized message for a duplicate', async () => {
    show([...memoryFixtures.three])
    await loaded()
    await add(memoryFixtures.three[0]!.text.toUpperCase())
    expect((await screen.findByRole('alert')).textContent).toContain('That note already exists.')
  })

  it('shows a localized message when the engine says the store is full', async () => {
    show([...memoryFixtures.three], (method) => (method === 'saveMemory' ? Promise.reject(new RillError('MEMORY_FULL', 'at most 20 notes can be saved')) : undefined))
    await loaded()
    await add('one more')
    expect((await screen.findByRole('alert')).textContent).toBe(`${en['chat.error.MEMORY_FULL']}Dismiss`)
  })

  it('never puts the text of a note in an error', async () => {
    const SECRET = 'my-private-note-77'
    show([{ id: 'm1', text: SECRET, createdAt: 1, updatedAt: 1 }], (method, params) =>
      method === 'saveMemory' ? Promise.reject(new RillError('MEMORY_INVALID', `bad note ${(params as { text: string }).text}`, [`too_long: ${SECRET}`])) : undefined,
    )
    await loaded()
    await add(`${SECRET} new`)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain(SECRET)
    expect(alert.textContent).toContain('A note is at most 300 characters.')
  })

  it('shows an error when an edit fails and keeps the editor open', async () => {
    show([...memoryFixtures.three], (method) => (method === 'saveMemory' ? Promise.reject(new RillError('NOT_FOUND', 'x')) : undefined))
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: `Edit note: ${memoryFixtures.three[0]!.text}` }))
    fireEvent.click(editorSave())
    expect((await screen.findByRole('alert')).textContent).toContain('Not found')
    expect(screen.getByRole('textbox', { name: 'Edit note' })).toBeTruthy()
  })

  it('shows an error when a delete fails', async () => {
    show([...memoryFixtures.three], (method) => (method === 'deleteMemory' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined))
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: `Delete note: ${memoryFixtures.three[0]!.text}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The engine reported an error')
    expect(screen.getByText(memoryFixtures.three[0]!.text)).toBeTruthy()
  })
})

describe('MemoryPanel: loading, limits and ids', () => {
  it('keeps the add form disabled until the list has loaded, so a save cannot be lost to a late list', async () => {
    let finish: (value: unknown) => void = () => undefined
    const { world } = show([...memoryFixtures.three], (method) => (method === 'listMemory' ? new Promise((resolve) => (finish = resolve)) : undefined))
    expect(input().disabled).toBe(true)
    fireEvent.change(input(), { target: { value: 'typed early' } })
    expect(save().disabled).toBe(true)
    fireEvent.submit(input().closest('form')!)
    expect(world.callsOf('saveMemory')).toHaveLength(0)
    finish({ items: [...memoryFixtures.three] })
    await loaded()
    expect(input().disabled).toBe(false)
    fireEvent.change(input(), { target: { value: 'typed late' } })
    expect(save().disabled).toBe(false)
  })

  it('keeps the add form disabled when the list failed, and enables it after a successful retry', async () => {
    let attempts = 0
    const { world } = show([...memoryFixtures.three], (method) => {
      if (method !== 'listMemory') return undefined
      attempts += 1
      return attempts === 1 ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined
    })
    await screen.findByRole('alert')
    expect(input().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('list', { name: 'Saved notes' })
    expect(input().disabled).toBe(false)
    expect(world.callsOf('listMemory')).toHaveLength(2)
  })

  it('limits a pasted note to what the protocol accepts, in the add field and in the editor', async () => {
    show([...memoryFixtures.three])
    await loaded()
    expect(input().maxLength).toBe(MEMORY_MAX_INPUT_CHARS)
    fireEvent.click(screen.getByRole('button', { name: `Edit note: ${memoryFixtures.three[0]!.text}` }))
    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLInputElement).maxLength).toBe(MEMORY_MAX_INPUT_CHARS)
  })

  it('gives each panel its own title id, so two panels on one page label themselves', async () => {
    const world = makeWorld({ memory: [...memoryFixtures.three] })
    const view = renderThemed(
      <>
        <MemoryPanel client={world.client} />
        <MemoryPanel client={world.client} />
      </>,
      { locale: 'en' },
    )
    const sections = Array.from(view.container.querySelectorAll('section'))
    expect(sections).toHaveLength(2)
    const ids = sections.map((section) => section.getAttribute('aria-labelledby')!)
    expect(new Set(ids).size).toBe(2)
    for (const [index, section] of sections.entries()) expect(view.container.querySelector(`[id="${ids[index]}"]`)?.closest('section')).toBe(section)
  })
})

describe('MemoryPanel: lifecycle', () => {
  it('asks the engine nothing more after it is unmounted while the list is loading', async () => {
    let finish: (value: unknown) => void = () => undefined
    const world = makeWorld({ memory: [...memoryFixtures.three], intercept: (method) => (method === 'listMemory' ? new Promise((resolve) => (finish = resolve)) : undefined) })
    const view = renderThemed(<MemoryPanel client={world.client} />, { locale: 'en' })
    view.unmount()
    finish({ items: [...memoryFixtures.three] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(world.calls.map((call) => call.method)).toEqual(['listMemory'])
  })
})

describe('MemoryPanel: focus', () => {
  function refusedLate(method: 'saveMemory' | 'deleteMemory') {
    const wait = gate()
    const answer: WorldOptions['intercept'] = (name) => (name === method ? wait.promise.then(() => Promise.reject(new RillError('INTERNAL', 'x'))) : undefined)
    return { wait, answer }
  }

  it('gives the focus back to the Save button when a slow answer refuses the new note', async () => {
    const { wait, answer } = refusedLate('saveMemory')
    show([...memoryFixtures.three], answer)
    await loaded()
    const user = userEvent.setup()
    await user.type(input(), 'Weekly reports go to ~/Reports')
    const button = save()
    button.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(button.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await screen.findByRole('alert')
    expect(button.disabled).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('gives the focus back to the Save button of an edit when a slow answer refuses it', async () => {
    const { wait, answer } = refusedLate('saveMemory')
    show([...memoryFixtures.three], answer)
    await loaded()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `Edit note: ${memoryFixtures.three[0]!.text}` }))
    const button = editorSave()
    button.focus()
    await user.keyboard(' ')
    await waitFor(() => expect(button.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await screen.findByRole('alert')
    expect(button.disabled).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('gives the focus back to the confirm button of a delete when a slow answer refuses it', async () => {
    const { wait, answer } = refusedLate('deleteMemory')
    show([...memoryFixtures.three], answer)
    await loaded()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `Delete note: ${memoryFixtures.three[1]!.text}` }))
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    confirm.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(confirm.disabled).toBe(true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    await wait.open()
    await screen.findByRole('alert')
    expect(confirm.disabled).toBe(false)
    expect(document.activeElement).toBe(confirm)
  })
})
