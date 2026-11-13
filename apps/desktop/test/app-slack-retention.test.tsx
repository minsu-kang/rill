import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostProvider } from '../src/app/host'
import { SlackCard } from '../src/app/settings/SlackCard'
import type { SettingsApi } from '../src/app/settings/types'
import { createFakeHost, fakeSettings } from '../src/engine/fake-host'
import { createTranslator } from '../src/i18n'
import type { SlackVerdict } from '../src/shared/host-api'
import { renderThemed } from './render'

const refs = vi.hoisted(() => ({ all: [] as Array<{ current: unknown }> }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useRef: (initial: unknown) => {
      const ref = actual.useRef(initial)
      if (!refs.all.includes(ref as { current: unknown })) refs.all.push(ref as { current: unknown })
      return ref
    },
  }
})

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const t = createTranslator('en')

function held(): string[] {
  return refs.all.map((ref: RefObject<unknown>) => ref.current).filter((value): value is string => typeof value === 'string' && value.includes('SLACKTOKENMARKER'))
}

const api: SettingsApi = { settings: fakeSettings(), apply: () => undefined, reload: async () => undefined }
const invalid = (): SlackVerdict => ({ status: 'invalid', reason: 'unauthorized' })

async function refused() {
  const host = createFakeHost({}, { slackChecks: invalid })
  const view = renderThemed(
    <HostProvider host={host}>
      <SlackCard api={api} locked={false} full={false} onRemove={() => undefined} />
    </HostProvider>,
    { locale: 'en' },
  )
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(t('app.slackBot.name')), 'alerts')
  await user.type(screen.getByLabelText(t('app.slackBot.token')), `${TOKEN}{Enter}`)
  const notice = await screen.findByRole('alert')
  return { host, view, user, notice }
}

afterEach(() => {
  refs.all.length = 0
})

describe('SlackCard token retention', () => {
  it('holds a refused token only while the refusal notice is open', async () => {
    const { user, notice } = await refused()
    expect(held()).toEqual([TOKEN])
    await user.click(within(notice).getByRole('button', { name: t('app.common.close') }))
    expect(held()).toEqual([])
  })

  it('lets go of the token when the form is edited', async () => {
    const { user } = await refused()
    expect(held()).toEqual([TOKEN])
    await user.type(screen.getByLabelText(t('app.slackBot.channel')), '#a')
    expect(held()).toEqual([])
  })

  it('lets go of the token after save anyway', async () => {
    const { user, notice } = await refused()
    await user.click(within(notice).getByRole('button', { name: t('app.slackBot.saveAnyway') }))
    await screen.findByRole('status')
    expect(held()).toEqual([])
  })

  it('lets go of the token when the card goes away', async () => {
    const { view } = await refused()
    expect(held()).toEqual([TOKEN])
    view.unmount()
    expect(held()).toEqual([])
  })

  it('never holds a token that Slack accepted', async () => {
    const host = createFakeHost({}, {})
    renderThemed(
      <HostProvider host={host}>
        <SlackCard api={api} locked={false} full={false} onRemove={() => undefined} />
      </HostProvider>,
      { locale: 'en' },
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(t('app.slackBot.name')), 'alerts')
    await user.type(screen.getByLabelText(t('app.slackBot.token')), `${TOKEN}{Enter}`)
    await screen.findByRole('status')
    await act(async () => undefined)
    expect(held()).toEqual([])
  })
})
