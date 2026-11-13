import type { WorkflowNode } from '@rill/dsl'
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FirstRunCard } from '../src/app/FirstRunCard'
import { ExternalTransferNotice } from '../src/chat/ExternalTransferNotice'
import { fakeSettings } from '../src/engine/fake-host'
import { catalog } from '../src/fixtures'
import { NodeCard } from '../src/graph/NodeCard'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { TransferMark } from '../src/ui/TransferMark'
import { renderThemed } from './render'

const extract: WorkflowNode = { id: 'extract', type: 'llm.extract@1', config: {} }
const info = catalog.find((entry) => entry.type === 'llm.extract@1')!

describe('the quiet transfer notice', () => {
  it('says in one muted line that content is sent when only the request goes out, with the list in the tooltip', () => {
    renderThemed(<ExternalTransferNotice items={['request']} />, { locale: 'en' })
    const note = screen.getByRole('note')
    expect(note.textContent).toBe(en['chat.transfer.short'])
    expect(note.getAttribute('title')).toBe(`${en['chat.transfer.lead']} ${en['chat.transfer.item.request']}`)
    expect(note.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it.each([
    ['notes', ['request', 'memory'] as const, 'your request, notes'],
    ['attached files', ['request', 'attachments'] as const, 'your request, attached files'],
    ['agent settings', ['request', 'agent'] as const, 'your request, agent settings'],
    ['everything', ['request', 'attachments', 'memory', 'agent'] as const, 'your request, attached files, notes, agent settings'],
  ])('lists what is sent on screen as soon as %s go out', (_name, items, list) => {
    renderThemed(<ExternalTransferNotice items={items} />, { locale: 'en' })
    const note = screen.getByRole('note')
    expect(note.textContent).toBe(`${en['chat.transfer.lead']} ${list}`)
    expect(note.getAttribute('title')).toBe(note.textContent)
  })

  it('shows nothing when nothing is sent, and has no pink badge in Korean either', () => {
    const empty = renderThemed(<ExternalTransferNotice items={[]} />, { locale: 'ko' })
    expect(empty.container.textContent).toBe('')
    empty.unmount()
    renderThemed(<ExternalTransferNotice items={['request']} />, { locale: 'ko' })
    expect(screen.getByRole('note').textContent).toBe(ko['chat.transfer.short'])
  })
})

describe('the transfer mark', () => {
  it('is an icon that assistive technology skips, with the label as hidden text and the hint as the tooltip', () => {
    const { container } = renderThemed(<TransferMark label="External transfer" hint="Sent to the AI provider" />, { locale: 'en' })
    const mark = container.querySelector('[title]') as HTMLElement
    expect(mark.getAttribute('title')).toBe('Sent to the AI provider')
    expect(mark.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(mark.textContent).toBe('External transfer')
    expect(mark.querySelector('span')?.className).toMatch(/hidden/)
  })

  it('can show the label next to the icon, in muted small text', () => {
    const { container } = renderThemed(<TransferMark label="External transfer" showLabel />, { locale: 'en' })
    const label = container.querySelector('[title] > span') as HTMLElement
    expect(label.textContent).toBe('External transfer')
    expect(label.className).not.toMatch(/hidden/)
  })

  it('falls back to the label as the tooltip', () => {
    const { container } = renderThemed(<TransferMark label="External transfer" />, { locale: 'en' })
    expect((container.querySelector('[title]') as HTMLElement).getAttribute('title')).toBe('External transfer')
  })
})

describe('the node card badge for steps that send content out', () => {
  it('is a small icon with a hidden label and the hint, not a coloured pill', () => {
    const { container } = renderThemed(<NodeCard node={extract} info={info} state={undefined} selected={false} />, { locale: 'en' })
    const badge = container.querySelector('[data-badge="externalTransfer"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(badge.textContent).toBe(en['badge.externalTransfer'])
    expect(badge.getAttribute('title')).toBe(en['badge.externalTransfer.hint'])
    expect(badge.className).toMatch(/badgeExternal/)
  })

  it('leaves the other effect badges as they were', () => {
    const append: WorkflowNode = { id: 'append', type: 'csv.append@1', config: {} }
    const { container } = renderThemed(<NodeCard node={append} info={catalog.find((entry) => entry.type === 'csv.append@1')!} state={undefined} selected={false} />, { locale: 'en' })
    const badge = container.querySelector('[data-badge="writesFile"]') as HTMLElement
    expect(badge.textContent).toBe(en['badge.writesFile'])
    expect(badge.className).toMatch(/badgeEffect/)
  })
})

describe('the first run card', () => {
  it('explains once what leaves the computer, in both languages', () => {
    const settings = fakeSettings({})
    const view = renderThemed(<FirstRunCard settings={settings} onOpen={() => undefined} />, { locale: 'en' })
    expect(within(view.container).getByText(en['app.firstRun.transfer'])).toBeTruthy()
    view.unmount()
    const korean = renderThemed(<FirstRunCard settings={settings} onOpen={() => undefined} />, { locale: 'ko' })
    expect(within(korean.container).getByText(ko['app.firstRun.transfer'])).toBeTruthy()
  })
})
