import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWorld } from '../src/app/fake-world'
import { createTranslator } from '../src/i18n'
import { createShellTranslator } from '../src/renderer-shell/messages'
import { Root } from '../src/renderer-shell/Root'
import { renderThemed } from './render'

afterEach(cleanup)

describe('renderer root', () => {
  it('shows a fixed message and no app, no settings and no fake host when the host bridge is missing', () => {
    const view = renderThemed(<Root host={undefined} />, { locale: 'en' })
    expect(screen.getByText(createShellTranslator('en')('shell.noHost'))).toBeTruthy()
    expect(view.container.querySelector('[data-rill-app]')).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByText('/Users/demo/Receipts')).toBeNull()
  })

  it('renders the app with the host it is given', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const view = renderThemed(<Root host={world.host} connect={world.connect} />)
    expect(view.container.querySelector('[data-rill-app]')).toBeTruthy()
    expect(await screen.findByText(createTranslator('ko')('app.top.engine.connected'))).toBeTruthy()
  })
})
