import { composeStories } from '@storybook/react-vite'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import preview from '../.storybook/preview'
import * as chatPanelStories from '../src/chat/ChatPanel.stories'

const { Empty, LongConversation, Patch } = composeStories(chatPanelStories, { ...preview, initialGlobals: { theme: 'light', locale: 'en' } } as never) as unknown as Record<
  'Empty' | 'LongConversation' | 'Patch',
  React.ComponentType
>

describe('ChatPanel stories', () => {
  it('lets the plan shown by the Patch story be deployed', async () => {
    render(<Patch />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    expect(await screen.findByText('Deployed. Workflow wf-story-1')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lets the flagged plan of the long conversation be confirmed and deployed', async () => {
    render(<LongConversation />)
    const boxes = (await screen.findAllByRole('checkbox')).filter((box) => (box as HTMLInputElement).getAttribute('aria-label')?.startsWith('I checked'))
    expect(boxes).toHaveLength(3)
    for (const box of boxes) fireEvent.click(box)
    const deploy = screen.getAllByRole('button', { name: 'Deploy' }).at(-1) as HTMLButtonElement
    expect(deploy.disabled).toBe(false)
    fireEvent.click(deploy)
    await screen.findByText('Deployed. Workflow wf-story-1', undefined, { timeout: 3000 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps two different files of the same name length and size as two attachments', async () => {
    const { container } = render(<Empty />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['same'], 'ab.txt', { type: 'text/plain' }), new File(['same'], 'cd.txt', { type: 'text/plain' })] } })
    const list = await screen.findByRole('list', { name: 'Attached files' }, { timeout: 3000 })
    await waitFor(() => expect(list.querySelectorAll('[data-state="pending"]')).toHaveLength(0), { timeout: 3000 })
    expect(list.textContent).toContain('ab.txt')
    expect(list.textContent).toContain('cd.txt')
    expect(screen.getByText('Attachments 2/5')).toBeTruthy()
  })
})
