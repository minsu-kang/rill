import { flagKey, type Flag, type PlanMeta } from '@rill/protocol'
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorNotice } from '../src/chat/ErrorNotice'
import { FlagConfirm } from '../src/chat/FlagConfirm'
import { MessageBubble, UserMessage } from '../src/chat/MessageBubble'
import { MetaLine } from '../src/chat/MetaLine'
import { UnsupportedCard } from '../src/chat/UnsupportedCard'
import { attachmentRefs, metaOf, metas, results } from '../src/fixtures/plan'
import { renderThemed } from './render'

const flags: Flag[] = [
  { nodeId: 'n2', pointer: '/nodes/2/config/url', code: 'new_egress_target', message: 'Sends data to a new address.' },
  { nodeId: 'n2', pointer: '/nodes/2/config/body', code: 'untrusted_flow', message: 'The body comes from a document.' },
  { nodeId: 'n5', pointer: '/nodes/5/config/connection', code: 'attachment_origin', message: 'The connection name is only in the file.' },
]

describe('UnsupportedCard', () => {
  it('shows the reason and the nearest supported idea as text', () => {
    renderThemed(<UnsupportedCard summary="No mail reading." reason="There is no node for mail." nearest="Process mail attachments saved to a folder." />, { locale: 'en' })
    expect(screen.getByText('This cannot be built')).toBeTruthy()
    expect(screen.getByText('No mail reading.')).toBeTruthy()
    expect(screen.getByText('There is no node for mail.')).toBeTruthy()
    expect(screen.getByText('Process mail attachments saved to a folder.')).toBeTruthy()
    expect(screen.getByText('Why')).toBeTruthy()
    expect(screen.getByText('Closest thing that works')).toBeTruthy()
  })

  it('shows hostile text as text and caps a long one', () => {
    const { container } = renderThemed(
      <UnsupportedCard summary="<img src=x onerror=alert(1)>" reason={`<a href="https://evil.example">go</a> ${'r'.repeat(9000)}`} nearest={'**x** ‮evil'} />,
      { locale: 'en' },
    )
    expect(container.querySelector('img, a, script, strong')).toBeNull()
    expect(container.textContent).toContain('‹U+202E›evil')
    expect(screen.getAllByRole('button', { name: 'Show more' })).toHaveLength(1)
  })
})

describe('MetaLine', () => {
  const lines = (meta: PlanMeta): string[] => {
    const { unmount } = renderThemed(<MetaLine meta={meta} />, { locale: 'en' })
    const items = within(screen.getByRole('list', { name: 'Plan details' })).getAllByRole('listitem').map((item) => item.textContent ?? '')
    unmount()
    return items
  }

  it('shows the model, the care and the cost as an upper bound', () => {
    expect(lines(metas.plain)).toEqual(['Model claude-opus-5-5', 'Care: Normal', 'Cost: at most about $0.041'])
  })

  it('shows requested versus effective effort when the engine lowered it', () => {
    expect(lines(metas.collapsed)).toContain('Care: asked for Very careful, used Careful')
    expect(lines(metas.collapsed).some((line) => line.startsWith('Care: Careful'))).toBe(false)
  })

  it('shows unknown for a null cost', () => {
    expect(lines(metas.nullCost)).toContain('Cost unknown')
  })

  it('shows how many notes were used and how many were left out, in singular and plural', () => {
    expect(lines(metas.memory)).toContain('Used 3 notes')
    expect(lines(metaOf({ memoryUsed: 1 }))).toContain('Used 1 note')
    expect(lines(metas.memoryDropped)).toEqual(expect.arrayContaining(['Used 18 notes', '2 notes did not fit and were left out']))
    expect(lines(metaOf({ memoryDropped: 1 }))).toContain('1 note did not fit and was left out')
  })

  it('shows no memory line when no note was used', () => {
    expect(lines(metaOf({ memoryUsed: 0 })).join('|')).not.toMatch(/note/)
    expect(lines(metas.plain).join('|')).not.toMatch(/note/)
  })

  it('shows the capped reasoning note and the cost note', () => {
    expect(lines(metas.reasoningCapped)).toContain('The thinking of the model was limited by the output size')
    expect(lines(metas.costNote).some((line) => line.includes('cached prompt tokens'))).toBe(true)
  })

  it('falls back to the plain effort for a record without effort detail', () => {
    const bare: PlanMeta = { ...metas.plain }
    delete bare.effortDetail
    expect(lines(bare)).toContain('Care: Normal')
  })

  it('shows the same in Korean', () => {
    renderThemed(<MetaLine meta={metas.memoryDropped} />, { locale: 'ko' })
    expect(screen.getByText('메모 2개는 들어가지 못했어요')).toBeTruthy()
    expect(screen.getByText('꼼꼼함 보통')).toBeTruthy()
  })

  it('shows a model name and a cost note from the engine as text', () => {
    const { container } = renderThemed(<MetaLine meta={metaOf({ model: '<img src=x onerror=alert(1)>‮', costNote: '<a href="x">x</a>' })} />, { locale: 'en' })
    expect(container.querySelector('img, a')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>‹U+202E›')
  })
})

describe('ErrorNotice', () => {
  it('is an alert with the localized text of its key', () => {
    renderThemed(<ErrorNotice messageKey="chat.error.PLAN_BUSY" />, { locale: 'en' })
    expect(screen.getByRole('alert').textContent).toContain('Other plans are still running')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has a dismiss button when it can be dismissed', () => {
    const onDismiss = vi.fn()
    renderThemed(<ErrorNotice messageKey="chat.error.generic" onDismiss={onDismiss} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('FlagConfirm', () => {
  it('groups by node in the order of first appearance, with the node title when it is known', () => {
    renderThemed(<FlagConfirm flags={flags} confirmed={[]} onToggle={() => undefined} nodeTitles={{ n2: 'HTTP request' }} />, { locale: 'en' })
    const headings = screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['Node n2 · HTTP request', 'Node n5'])
    const first = screen.getByRole('region', { name: 'Node n2 · HTTP request' })
    expect(within(first).getAllByRole('checkbox')).toHaveLength(2)
  })

  it('names each checkbox by its code and pointer and reports the flag key', () => {
    const onToggle = vi.fn()
    renderThemed(<FlagConfirm flags={flags} confirmed={[flagKey(flags[0]!)]} onToggle={onToggle} />, { locale: 'en' })
    const box = screen.getByRole('checkbox', { name: 'I checked this: New place to send or write data /nodes/2/config/url' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /untrusted|document flows here/ }))
    expect(onToggle).toHaveBeenCalledWith(flagKey(flags[1]!))
  })

  it('disables the checkboxes when disabled', () => {
    renderThemed(<FlagConfirm flags={flags} confirmed={[]} onToggle={() => undefined} disabled />, { locale: 'en' })
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true)
  })

  it('renders nothing for no flags', () => {
    const { container } = renderThemed(<FlagConfirm flags={[]} confirmed={[]} onToggle={() => undefined} />, { locale: 'en' })
    expect(container.querySelector('input')).toBeNull()
  })

  it('shows hostile flag text as text and keeps a hostile node id visible', () => {
    const hostile: Flag[] = [{ nodeId: 'n‮<img src=x>', pointer: '/<script>', code: 'attachment_origin', message: '<a href="https://evil.example">ok</a>' }]
    const { container } = renderThemed(<FlagConfirm flags={hostile} confirmed={[]} onToggle={() => undefined} />, { locale: 'en' })
    expect(container.querySelector('a, img, script')).toBeNull()
    expect(container.textContent).toContain('n‹U+202E›<img src=x>')
  })
})

describe('MessageBubble and UserMessage', () => {
  it('labels who spoke', () => {
    renderThemed(
      <>
        <MessageBubble role="user">hello</MessageBubble>
        <MessageBubble role="assistant">hi</MessageBubble>
      </>,
      { locale: 'en' },
    )
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('hello')
    expect(screen.getByRole('article', { name: 'Rill' }).textContent).toContain('hi')
  })

  it('shows the text, the attachment names and sizes, without a transfer badge', () => {
    renderThemed(<UserMessage entry={{ role: 'user', text: 'Please sort these', attachments: [attachmentRefs.pdf, attachmentRefs.hostile] }} />, { locale: 'en' })
    expect(screen.getByText('Please sort these')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Attached files' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list.textContent).toContain('Cafe Mori 영수증.pdf')
    expect(list.textContent).toContain('‹U+202E›')
    expect(list.textContent).not.toContain('External transfer')
  })

  it('shows answers next to the question they answer, or the id when the question is unknown', () => {
    const questions = (results.questions as Extract<typeof results.questions, { kind: 'questions' }>).questions
    renderThemed(<UserMessage entry={{ role: 'user', text: '', attachments: [], answers: { folder: '~/Downloads', ghost: 'x' } }} questions={questions} />, { locale: 'en' })
    const terms = screen.getAllByRole('term').map((term) => term.textContent)
    expect(terms).toEqual([questions[0]!.text, 'ghost'])
    expect(screen.getByText('~/Downloads')).toBeTruthy()
    expect(screen.getByText('Answers')).toBeTruthy()
  })

  it('shows hostile text as text', () => {
    const { container } = renderThemed(<UserMessage entry={{ role: 'user', text: '<img src=x onerror=alert(1)> **x**', attachments: [], answers: { '<b>': '<a href="x">y</a>' } }} />, { locale: 'en' })
    expect(container.querySelector('img, a, b, strong')).toBeNull()
    expect(container.textContent).toContain('<a href="x">y</a>')
  })
})
