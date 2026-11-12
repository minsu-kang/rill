import { composeStories } from '@storybook/react-vite'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import * as stories from '../src/theme/Tokens.stories'

const { Palette } = composeStories(stories)

describe('Tokens story', () => {
  it('shows every surface, status and badge token by name', () => {
    const { container } = render(<Palette />)
    const text = container.textContent ?? ''
    for (const name of ['surface-raised', 'text-muted', 'accent-subtle', 'status-skipped', 'status-continued', 'badge-external', 'badge-effect']) {
      expect(text).toContain(name)
    }
    expect(container.querySelectorAll('[class*="chip"]').length).toBeGreaterThanOrEqual(15)
  })
})
