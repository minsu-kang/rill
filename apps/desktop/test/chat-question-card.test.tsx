import type { PlanQuestion } from '@rill/protocol'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QuestionCard } from '../src/chat/QuestionCard'
import { results } from '../src/fixtures/plan'
import { renderThemed } from './render'

const questions = (results.questions as Extract<typeof results.questions, { kind: 'questions' }>).questions

function show(list: readonly PlanQuestion[] = questions, disabled = false) {
  const onSubmit = vi.fn()
  const view = renderThemed(<QuestionCard questions={list} onSubmit={onSubmit} disabled={disabled} />, { locale: 'en' })
  return { onSubmit, ...view }
}

const submit = (): HTMLButtonElement => screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement

describe('QuestionCard', () => {
  it('shows each question with its options and the default preselected', () => {
    show()
    expect(screen.getByRole('group', { name: /Which folder|영수증 PDF/ })).toBeTruthy()
    expect((screen.getByRole('radio', { name: /~\/Receipts/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /~\/Downloads/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('radio', { name: /slack-ops/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByText('default').length).toBe(2)
  })

  it('shows a free text answer, filled with the default, for a question with no options', () => {
    show()
    const box = screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement
    expect(box.value).toBe('날짜, 금액, 가게 이름')
  })

  it('counts a default as an answer: it submits the defaults as they are', () => {
    const { onSubmit } = show()
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ folder: '~/Receipts', notify: 'slack-ops', fields: '날짜, 금액, 가게 이름' })
  })

  it('submits what the person chose and typed, trimmed', () => {
    const { onSubmit } = show()
    fireEvent.click(screen.getByRole('radio', { name: /~\/Downloads/ }))
    fireEvent.click(screen.getByRole('radio', { name: /알림 없음/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: '  date, total  ' } })
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ folder: '~/Downloads', notify: '알림 없음', fields: 'date, total' })
  })

  it('blocks the submit and says why when a free text answer is blank', () => {
    const { onSubmit } = show()
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: '   ' } })
    expect(submit().disabled).toBe(true)
    expect(screen.getByText('Answer every question to continue.')).toBeTruthy()
    fireEvent.click(submit())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables every input and the button when disabled', () => {
    show(questions, true)
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect(submit().disabled).toBe(true)
  })

  it('offers a default that is not among the options as an option of its own, selected', () => {
    show([{ id: 'x', text: 'Pick one', options: ['a', 'b'], default: 'c' }])
    expect((screen.getByRole('radio', { name: /^c/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('does not repeat an option the model listed twice', () => {
    show([{ id: 'x', text: 'Pick one', options: ['a', 'a', 'b'], default: 'a' }])
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  it('shows a question with no default as unanswered and blocks the submit', () => {
    show([{ id: 'x', text: 'Pick one', options: ['a', 'b'], default: '' }])
    expect(submit().disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'b' }))
    expect(submit().disabled).toBe(false)
  })

  it('submits nothing for a card with no questions and still renders', () => {
    const { onSubmit } = show([])
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it('shows hostile question and option text as text, and caps long ones', () => {
    const hostile: PlanQuestion[] = [
      {
        id: 'h',
        text: `<img src=x onerror=alert(1)> <a href="https://evil.example">x</a> ${'q'.repeat(10_000)}`,
        options: ['<script>alert(1)</script>', `**bold** ‮exe ${'o'.repeat(5000)}`],
        default: '<script>alert(1)</script>',
      },
    ]
    const { container } = show(hostile)
    expect(container.querySelector('img, a, script, strong, b')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('‹U+202E›exe')
    expect(screen.getAllByRole('button', { name: 'Show more' }).length).toBeGreaterThanOrEqual(2)
    expect((container.textContent ?? '').length).toBeLessThan(3000)
  })

  it('submits the full option text, not the shortened one', () => {
    const long = 'o'.repeat(5000)
    const { onSubmit } = show([{ id: 'h', text: 'Pick', options: [long, 'b'], default: long }])
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ h: long })
  })
})
