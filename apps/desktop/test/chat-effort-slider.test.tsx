import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EffortSlider } from '../src/chat/EffortSlider'
import { activeModelOf } from '../src/chat/model/models'
import { models, modelsHaikuActive } from '../src/fixtures/plan'
import { renderThemed } from './render'

const opus = activeModelOf(models)!
const haiku = activeModelOf(modelsHaikuActive)!

function radios(): HTMLElement[] {
  return screen.getAllByRole('radio')
}

describe('EffortSlider', () => {
  it('is a radio group with the four normal steps and no advanced step', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} />, { locale: 'en' })
    expect(screen.getByRole('radiogroup', { name: 'Planning care' })).toBeTruthy()
    expect(radios().map((radio) => radio.textContent)).toEqual(['Fast', 'Normal', 'Careful', 'Very careful'])
    expect(screen.queryByRole('radio', { name: 'Maximum' })).toBeNull()
  })

  it('says the same in Korean', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} />, { locale: 'ko' })
    expect(radios().map((radio) => radio.textContent)).toEqual(['빠르게', '보통', '꼼꼼히', '아주 꼼꼼히'])
  })

  it('checks the step of the value, with a roving tab index', () => {
    renderThemed(<EffortSlider value="high" onChange={() => undefined} model={opus} />, { locale: 'en' })
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false'])
    expect(radios().map((radio) => radio.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1'])
  })

  it('calls onChange with the effort of a clicked step and not for the checked one', () => {
    const onChange = vi.fn()
    renderThemed(<EffortSlider value="medium" onChange={onChange} model={opus} />, { locale: 'en' })
    fireEvent.click(screen.getByRole('radio', { name: 'Very careful' }))
    expect(onChange).toHaveBeenLastCalledWith('xhigh')
    onChange.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: 'Normal' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves with the arrow keys, Home and End, and wraps nowhere', () => {
    const onChange = vi.fn()
    renderThemed(<EffortSlider value="medium" onChange={onChange} model={opus} />, { locale: 'en' })
    const current = screen.getByRole('radio', { name: 'Normal' })
    fireEvent.keyDown(current, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('high')
    fireEvent.keyDown(current, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('high')
    fireEvent.keyDown(current, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('low')
    fireEvent.keyDown(current, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('low')
    fireEvent.keyDown(current, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('low')
    fireEvent.keyDown(current, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('xhigh')
    onChange.mockClear()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Very careful' }), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Fast' }), { key: 'ArrowLeft' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves focus to the step it chose', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} />, { locale: 'en' })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Normal' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Careful' }))
  })

  it('disables the steps a model does not list, explains why, and skips them with the keys', () => {
    const onChange = vi.fn()
    renderThemed(<EffortSlider value="medium" onChange={onChange} model={haiku} />, { locale: 'en' })
    const veryCareful = screen.getByRole('radio', { name: 'Very careful' })
    expect(veryCareful.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Careful' }).getAttribute('aria-disabled')).toBeNull()
    const reason = document.getElementById(veryCareful.getAttribute('aria-describedby')!)
    expect(reason?.textContent).toContain('does not support')
    fireEvent.click(veryCareful)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Careful' }), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Careful' }), { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('high')
  })

  it('skips a disabled step in the middle', () => {
    const onChange = vi.fn()
    const gap = { ...opus, capabilities: { ...opus.capabilities, effortLevels: ['low', 'medium', 'xhigh'] as const } }
    renderThemed(<EffortSlider value="medium" onChange={onChange} model={{ ...gap, capabilities: { ...gap.capabilities, effortLevels: [...gap.capabilities.effortLevels] } }} />, { locale: 'en' })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Normal' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('xhigh')
  })

  it('tells the person when the chosen step is one the model lowers', () => {
    renderThemed(<EffortSlider value="xhigh" onChange={() => undefined} model={haiku} />, { locale: 'en' })
    expect(screen.getByRole('status').textContent).toContain('closest step')
    expect(screen.getByRole('radio', { name: 'Very careful' }).getAttribute('aria-checked')).toBe('true')
  })

  it('disables every step with one reason when there is no model', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={undefined} />, { locale: 'en' })
    for (const radio of radios()) expect(radio.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByText('No model is available')).toHaveLength(1)
  })

  it('shows the advanced step only after the toggle, and also when it is the value', () => {
    const onChange = vi.fn()
    const { unmount } = renderThemed(<EffortSlider value="medium" onChange={onChange} model={opus} />, { locale: 'en' })
    const toggle = screen.getByRole('button', { name: 'Show advanced step' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide advanced step' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Maximum' }))
    expect(onChange).toHaveBeenLastCalledWith('max')
    fireEvent.click(screen.getByRole('button', { name: 'Hide advanced step' }))
    expect(screen.queryByRole('radio', { name: 'Maximum' })).toBeNull()
    unmount()
    renderThemed(<EffortSlider value="max" onChange={onChange} model={opus} />, { locale: 'en' })
    expect(screen.getByRole('radio', { name: 'Maximum' }).getAttribute('aria-checked')).toBe('true')
  })

  it('lets End reach the advanced step when it is shown', () => {
    const onChange = vi.fn()
    renderThemed(<EffortSlider value="max" onChange={onChange} model={opus} />, { locale: 'en' })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Maximum' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('xhigh')
  })

  it('shows no cost or delay without hints, and the numbers with their basis when hints are given', () => {
    const { unmount } = renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} />, { locale: 'en' })
    expect(screen.queryByText(/about/)).toBeNull()
    expect(screen.queryByText(/\$/)).toBeNull()
    unmount()
    renderThemed(
      <EffortSlider
        value="medium"
        onChange={() => undefined}
        model={opus}
        hints={[
          { effort: 'medium', costUsd: 0.04, latencyMs: 14_000, basis: '48 evaluation cases' },
          { effort: 'high', latencyMs: 30_000, basis: 'pilot of 6 cases' },
          { effort: 'low', basis: 'only a basis' },
        ]}
      />,
      { locale: 'en' },
    )
    const text = screen.getByRole('list', { name: 'Measured in evaluation runs' }).textContent ?? ''
    expect(text).toContain('Normal: cost about $0.04 · about 14 s (48 evaluation cases)')
    expect(text).toContain('Careful: about 30 s (pilot of 6 cases)')
    expect(text).toContain('Fast: only a basis')
  })

  it('shows no hint for the advanced step while it is hidden', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} hints={[{ effort: 'max', costUsd: 1, basis: 'b' }]} />, { locale: 'en' })
    expect(screen.queryByRole('list', { name: 'Measured in evaluation runs' })).toBeNull()
  })

  it('does nothing when disabled', () => {
    const onChange = vi.fn()
    renderThemed(<EffortSlider value="medium" onChange={onChange} model={opus} disabled />, { locale: 'en' })
    for (const radio of radios()) expect(radio.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Careful' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Normal' }), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders hint text as text', () => {
    const { container } = renderThemed(
      <EffortSlider value="medium" onChange={() => undefined} model={opus} hints={[{ effort: 'medium', costUsd: 0.1, basis: '<img src=x onerror=alert(1)>' }]} />,
      { locale: 'en' },
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
