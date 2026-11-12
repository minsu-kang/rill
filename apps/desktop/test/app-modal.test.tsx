import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from '../src/app/Modal'
import { renderThemed } from './render'

describe('Modal', () => {
  it('keeps Tab and Shift+Tab inside the dialog while nothing in it can take focus', () => {
    renderThemed(
      <fieldset disabled>
        <Modal title="Held" onClose={() => undefined}>
          <button type="button">Go</button>
        </Modal>
      </fieldset>,
    )
    const dialog = screen.getByRole('dialog')
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
  })

  it('lets Tab move on normally when there are controls, and closes with Escape', () => {
    const onClose = vi.fn()
    renderThemed(
      <Modal title="Open" onClose={onClose}>
        <button type="button">One</button>
        <button type="button">Two</button>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog')
    screen.getByRole('button', { name: 'One' }).focus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
