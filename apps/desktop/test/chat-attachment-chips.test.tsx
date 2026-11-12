import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentChips } from '../src/chat/AttachmentChips'
import { allAttachmentRefs, attachmentRefs } from '../src/fixtures/plan'
import { renderThemed } from './render'

const noop = (): void => undefined

describe('AttachmentChips', () => {
  it('renders nothing when there is nothing to show', () => {
    const { container } = renderThemed(<AttachmentChips items={[]} pending={[]} errors={[]} onRemove={noop} />, { locale: 'en' })
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('li')).toBeNull()
  })

  it('shows the name and the size of each file and an external transfer badge', () => {
    renderThemed(<AttachmentChips items={[attachmentRefs.pdf, attachmentRefs.png]} pending={[]} errors={[]} onRemove={noop} />, { locale: 'en' })
    const list = screen.getByRole('list', { name: 'Attached files' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('Cafe Mori 영수증.pdf')
    expect(items[0]!.textContent).toContain('180 KB')
    expect(items[1]!.textContent).toContain('2 MB')
    for (const item of items) expect(item.textContent).toContain('External transfer')
  })

  it('has a remove button that names the file and gives the id back', () => {
    const onRemove = vi.fn()
    renderThemed(<AttachmentChips items={[attachmentRefs.pdf, attachmentRefs.text]} pending={[]} errors={[]} onRemove={onRemove} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment notes.txt' }))
    expect(onRemove).toHaveBeenCalledWith(attachmentRefs.text.id)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('shows a hostile name with visible markers and no raw control or bidi character', () => {
    const { container } = renderThemed(<AttachmentChips items={[attachmentRefs.hostile]} pending={[]} errors={[]} onRemove={noop} />, { locale: 'en' })
    const text = container.textContent ?? ''
    expect(text).toContain('‹U+202E›')
    expect(text).toContain('‹U+0007›')
    expect(text).toContain('‹U+200B›')
    const everything = [text, ...[...container.querySelectorAll('[title], [aria-label]')].map((el) => `${el.getAttribute('title') ?? ''}${el.getAttribute('aria-label') ?? ''}`)].join('')
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(everything)).toBe(false)
  })

  it('cuts a very long name and keeps the whole safe name in the title', () => {
    renderThemed(<AttachmentChips items={[attachmentRefs.long]} pending={[]} errors={[]} onRemove={noop} />, { locale: 'en' })
    const shown = screen.getByTitle(attachmentRefs.long.name)
    expect((shown.textContent ?? '').length).toBeLessThan(attachmentRefs.long.name.length)
    expect(shown.textContent).toMatch(/…$/)
  })

  it('shows a file that is being added and a file that was not attached, with the reason', () => {
    renderThemed(
      <AttachmentChips items={[]} pending={[{ name: 'big.pdf' }]} errors={[{ name: 'virus.exe', reason: 'This file type is not supported.' }]} onRemove={noop} />,
      { locale: 'en' },
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]!.textContent).toContain('big.pdf')
    expect(items[0]!.textContent).toContain('Adding…')
    expect(items[0]!.getAttribute('aria-busy')).toBe('true')
    expect(items[1]!.textContent).toContain('virus.exe')
    expect(items[1]!.textContent).toContain('This file type is not supported.')
    expect(within(items[1]!).queryByRole('button')).toBeNull()
  })

  it('renders every fixture attachment, including the hostile one, without a link, image or script', () => {
    const { container } = renderThemed(<AttachmentChips items={allAttachmentRefs} pending={[{ name: '<img src=x onerror=alert(1)>' }]} errors={[{ name: '<a href="x">x</a>', reason: '<script>1</script>' }]} onRemove={noop} />, { locale: 'en' })
    expect(container.querySelector('a, img, script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
