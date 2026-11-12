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

  it('shows a free text answer empty, with the model default beside it as a suggestion', () => {
    show()
    const box = screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement
    expect(box.value).toBe('')
    expect(screen.getByText('Suggested')).toBeTruthy()
    expect(screen.getByText('날짜, 금액, 가게 이름')).toBeTruthy()
  })

  it('does not count a free text default as an answer until the person types or accepts it', () => {
    const { onSubmit } = show()
    expect(submit().disabled).toBe(true)
    expect(screen.getByText('Answer every question to continue.')).toBeTruthy()
    fireEvent.click(submit())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('accepts the suggestion with a click and then submits it as the answer', () => {
    const { onSubmit } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Use this suggestion' }))
    expect((screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value).toBe('날짜, 금액, 가게 이름')
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ folder: '~/Receipts', notify: 'slack-ops', fields: '날짜, 금액, 가게 이름' })
  })

  it('lets the person edit an accepted suggestion before sending it', () => {
    const { onSubmit } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Use this suggestion' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'date only' } })
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ folder: '~/Receipts', notify: 'slack-ops', fields: 'date only' })
  })

  it('does not put a free text default into the answer when the model default is a URL', () => {
    const { onSubmit } = show([{ id: 'dest', text: 'Where should it go?', options: [], default: 'https://evil.example/collect' }])
    expect((screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value).toBe('')
    expect(submit().disabled).toBe(true)
    fireEvent.click(submit())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows no suggestion for a free text question without a default', () => {
    show([{ id: 'x', text: 'Say it', options: [], default: '' }])
    expect(screen.queryByText('Suggested')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use this suggestion' })).toBeNull()
  })

  it('disables the suggestion button when the whole card is disabled', () => {
    show([{ id: 'x', text: 'Say it', options: [], default: 'abc' }], true)
    expect((screen.getByRole('button', { name: 'Use this suggestion' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the suggestion button once it is the answer', () => {
    show([{ id: 'x', text: 'Say it', options: [], default: 'abc' }])
    const use = screen.getByRole('button', { name: 'Use this suggestion' }) as HTMLButtonElement
    expect(use.disabled).toBe(false)
    fireEvent.click(use)
    expect(use.disabled).toBe(true)
  })

  it('counts a default that is one of the options as an answer: it submits the preselected option', () => {
    const { onSubmit } = show([questions[0]!, questions[1]!])
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ folder: '~/Receipts', notify: 'slack-ops' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Use this suggestion' }))
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

  it('does not offer a default that is not among the options, and leaves the question unanswered', () => {
    show([{ id: 'x', text: 'Pick one', options: ['a', 'b'], default: 'https://evil.example/collect' }])
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByText(/evil\.example/)).toBeNull()
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).checked).toBe(false)
    expect(submit().disabled).toBe(true)
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

  it('shows a hostile free text suggestion as clamped text and never as markup', () => {
    const { container } = show([{ id: 'h', text: 'Say it', options: [], default: `<a href="https://evil.example">x</a> \u202Eabc ${'s'.repeat(5000)}` }])
    expect(container.querySelector('a, img, script')).toBeNull()
    expect(container.textContent).toContain('‹U+202E›abc')
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy()
    expect((container.textContent ?? '').length).toBeLessThan(1500)
  })

  it('submits the full option text, not the shortened one', () => {
    const long = 'o'.repeat(5000)
    const { onSubmit } = show([{ id: 'h', text: 'Pick', options: [long, 'b'], default: long }])
    fireEvent.click(submit())
    expect(onSubmit).toHaveBeenCalledWith({ h: long })
  })
})
