import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { NODE_STATUSES } from '../src/model/status'
import { StatusChip } from '../src/ui/StatusChip'
import { ThemeProvider } from '../src/theme/ThemeProvider'

describe('StatusChip', () => {
  it('shows the label as text and an icon with the same accessible name, for every status', () => {
    for (const status of NODE_STATUSES) {
      const label = ko[`status.${status}`]
      const { container, unmount } = render(<StatusChip status={status} label={label} />)
      expect(screen.getByRole('img', { name: label })).toBeTruthy()
      expect(container.textContent).toContain(label)
      expect(container.querySelector(`[data-status="${status}"]`)).not.toBeNull()
      unmount()
    }
  })

  it('draws a different icon for every status so color is never the only signal', () => {
    const shapes = new Set<string>()
    for (const status of NODE_STATUSES) {
      const { container, unmount } = render(<StatusChip status={status} label={status} />)
      shapes.add(container.querySelector('svg')!.innerHTML)
      unmount()
    }
    expect(shapes.size).toBe(NODE_STATUSES.length)
  })

  it('uses natural Korean and English labels for the seven node statuses', () => {
    expect(NODE_STATUSES.map((status) => ko[`status.${status}`])).toEqual(['대기', '실행 중', '성공', '실패', '중단됨', '건너뜀', '계속함'])
    expect(NODE_STATUSES.map((status) => en[`status.${status}`])).toEqual([
      'Waiting',
      'Running',
      'Succeeded',
      'Failed',
      'Interrupted',
      'Skipped',
      'Continued',
    ])
  })

  it('renders inside a theme provider in either language', () => {
    const t = createTranslator('en')
    render(
      <ThemeProvider theme="dark" locale="en">
        <StatusChip status="failed" label={t('status.failed')} />
      </ThemeProvider>,
    )
    expect(screen.getByText('Failed')).toBeTruthy()
  })
})
