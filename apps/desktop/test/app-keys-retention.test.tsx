import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostProvider } from '../src/app/host'
import { KeysSection } from '../src/app/settings/KeysSection'
import type { SettingsApi } from '../src/app/settings/types'
import { createFakeHost, fakeSettings } from '../src/engine/fake-host'
import { createTranslator } from '../src/i18n'
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

const MARKER = 'retention-secret-MARKER-0123456789'
const t = createTranslator('ko')

function held(): string[] {
  return refs.all.map((ref: RefObject<unknown>) => ref.current).filter((value): value is string => typeof value === 'string' && value.includes(MARKER))
}

function api(configured: Array<'anthropic'> = []): SettingsApi {
  return { settings: fakeSettings({ configuredProviders: configured }), apply: () => undefined, reload: async () => undefined }
}

const INVALID = (): { status: 'invalid'; reason: 'unauthorized' } => ({ status: 'invalid', reason: 'unauthorized' })

async function refused(options: { configured?: boolean; locked?: boolean } = {}) {
  const host = createFakeHost({}, { keyChecks: INVALID })
  const save = vi.spyOn(host.secrets, 'setProviderKey')
  const ui = (locked: boolean) => (
    <HostProvider host={host}>
      <KeysSection api={api(options.configured === true ? ['anthropic'] : [])} locked={locked} />
    </HostProvider>
  )
  const view = renderThemed(ui(false), { locale: 'ko' })
  const user = userEvent.setup()
  const field = screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })) as HTMLInputElement
  await user.type(field, `${MARKER}{Enter}`)
  const notice = await screen.findByRole('alert')
  return { host, save, view, user, field, notice, rerender: (locked: boolean) => view.rerender(ui(locked)) }
}

afterEach(() => {
  refs.all.length = 0
})

describe('KeysSection key retention', () => {
  it('holds a refused key only while the refusal notice is open', async () => {
    const host = createFakeHost({}, { keyChecks: () => ({ status: 'invalid', reason: 'unauthorized' }) })
    renderThemed(
      <HostProvider host={host}>
        <KeysSection api={api()} locked={false} />
      </HostProvider>,
      { locale: 'ko' },
    )
    const user = userEvent.setup()
    const field = screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })) as HTMLInputElement
    await user.type(field, `${MARKER}{Enter}`)
    const notice = await screen.findByRole('alert')
    expect(held()).toEqual([MARKER])
    await user.click(within(notice).getByRole('button', { name: t('app.common.close') }))
    expect(held()).toEqual([])
  })

  it('does not keep a refused key in the row after the row went away during the check', async () => {
    let release: () => void = () => undefined
    const host = createFakeHost({}, { keyChecks: () => new Promise((resolve) => (release = () => resolve({ status: 'invalid', reason: 'unauthorized' }))) })
    const view = renderThemed(
      <HostProvider host={host}>
        <KeysSection api={api()} locked={false} />
      </HostProvider>,
      { locale: 'ko' },
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })), `${MARKER}{Enter}`)
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0))
    view.unmount()
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(held()).toEqual([])
    expect(host.state().settings.configuredProviders).toEqual([])
  })

  it('still keeps it for the notice when the row stays', async () => {
    let release: () => void = () => undefined
    const host = createFakeHost({}, { keyChecks: () => new Promise((resolve) => (release = () => resolve({ status: 'invalid', reason: 'unauthorized' }))) })
    renderThemed(
      <HostProvider host={host}>
        <KeysSection api={api()} locked={false} />
      </HostProvider>,
      { locale: 'ko' },
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(t('app.keys.input', { provider: 'Anthropic' })), `${MARKER}{Enter}`)
    await act(async () => release())
    const notice = await screen.findByRole('alert')
    fireEvent.click(within(notice).getByRole('button', { name: t('app.keys.saveAnyway') }))
    expect(held()).toEqual([])
  })

  it('drops a refused key when the row goes away while the notice is open', async () => {
    const { view } = await refused()
    expect(held()).toEqual([MARKER])
    view.unmount()
    expect(held()).toEqual([])
  })

  it('drops a refused key when the field is edited', async () => {
    const { user, field } = await refused()
    expect(held()).toEqual([MARKER])
    await user.type(field, 'x')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(held()).toEqual([])
  })

  it('drops a refused key when the field is submitted empty, and closes the notice', async () => {
    const { field } = await refused()
    expect(held()).toEqual([MARKER])
    fireEvent.submit(field.closest('form')!)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(held()).toEqual([])
  })

  it('drops a refused key when the key is removed', async () => {
    const { user, field } = await refused({ configured: true })
    expect(held()).toEqual([MARKER])
    await user.click(within(field.closest('li')!).getByRole('button', { name: t('app.keys.remove') }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(held()).toEqual([])
  })

  it('does not send a refused key anyway while the section is locked', async () => {
    const { save, notice, rerender } = await refused()
    rerender(true)
    fireEvent.click(within(notice).getByRole('button', { name: t('app.keys.saveAnyway') }))
    expect(save).toHaveBeenCalledTimes(1)
  })
})
