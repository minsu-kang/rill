import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ClampedText } from '../src/chat/ClampedText'
import { renderThemed } from './render'

describe('ClampedText', () => {
  it('shows short text whole with no button', () => {
    renderThemed(<ClampedText text="hello" max={20} />, { locale: 'en' })
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('cuts long text at the cap, and a show more button reveals it and a show less button hides it again', () => {
    const text = `start ${'x'.repeat(300)} end`
    const { container } = renderThemed(<ClampedText text={text} max={50} />, { locale: 'en' })
    expect(container.textContent).not.toContain('end')
    const more = screen.getByRole('button', { name: 'Show more' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(container.textContent).toContain('end')
    const less = screen.getByRole('button', { name: 'Show less' })
    expect(less.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(less)
    expect(container.textContent).not.toContain('end')
  })

  it('stops at a hard cap even when expanded and says how much is not shown', () => {
    const { container } = renderThemed(<ClampedText text={'y'.repeat(10_000)} max={50} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    const shown = (container.textContent ?? '').match(/y/g)?.length ?? 0
    expect(shown).toBeLessThan(10_000)
    expect(shown).toBeGreaterThan(1000)
    expect(container.textContent).toMatch(/more characters are not shown/)
  })

  it('shows hostile text as text: no link, image, script or element is made from it', () => {
    const hostile = '<img src=x onerror=alert(1)> <a href="https://evil.example">click</a> <script>alert(1)</script> **bold** [link](https://evil.example)'
    const { container } = renderThemed(<ClampedText text={hostile} />, { locale: 'en' })
    expect(container.querySelector('img, a, script, strong, b')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('**bold**')
  })

  it('makes bidi, zero-width and control characters visible', () => {
    const { container } = renderThemed(<ClampedText text={'a‮b​c\u0007d'} />, { locale: 'en' })
    expect(container.textContent).toBe('a‹U+202E›b‹U+200B›c‹U+0007›d')
  })

  it('keeps line breaks and tabs of the text', () => {
    const { container } = renderThemed(<ClampedText text={'one\ntwo\tthree'} />, { locale: 'en' })
    expect(container.textContent).toBe('one\ntwo\tthree')
  })

  it('handles an empty text', () => {
    const { container } = renderThemed(<ClampedText text="" />, { locale: 'en' })
    expect(container.textContent).toBe('')
  })
})
