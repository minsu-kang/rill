import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAction } from '../src/app/settings/useAction'
import { canRestoreFocus } from '../src/ui/focusRestore'
import { useKeepFocus } from '../src/ui/useKeepFocus'
import { frames } from './keep-focus'

interface FormProps {
  name?: string
  busy: boolean
  locked?: boolean
  hideSave?: boolean
  withSave?: boolean
}

function Form({ name = 'form', busy, locked = false, hideSave = false, withSave = true }: FormProps) {
  useKeepFocus(busy)
  return (
    <div role="group" aria-label={name}>
      <input aria-label={`${name} field`} disabled={busy || locked} />
      {withSave ? (
        <button type="button" hidden={hideSave} disabled={busy || locked}>
          {`${name} save`}
        </button>
      ) : null}
      <button type="button">{`${name} other`}</button>
    </div>
  )
}

const field = (name = 'form') => screen.getByRole('textbox', { name: `${name} field` })
const save = (name = 'form') => screen.getByRole('button', { name: `${name} save` })
const other = (name = 'form') => screen.getByRole('button', { name: `${name} other` })

async function lose(view: { rerender(ui: ReactElement): void }): Promise<void> {
  view.rerender(<Form busy />)
  await frames()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useKeepFocus', () => {
  it('puts the focus back on the button after the action, once the browser has dropped it', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    await lose(view)
    expect(document.activeElement).toBe(document.body)
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(save())
  })

  it('puts the focus back in the field where the person was typing', async () => {
    const view = render(<Form busy={false} />)
    field().focus()
    await lose(view)
    expect(document.activeElement).toBe(document.body)
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(field())
  })

  it('leaves the focus alone when the action ended before the browser dropped it', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    view.rerender(<Form busy />)
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(save())
    await frames()
    expect(document.activeElement).toBe(save())
  })

  it('does not take the focus from where the person moved it while the action ran', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    await lose(view)
    other().focus()
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(other())
  })

  it('does not put the focus back when the element is gone', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    await lose(view)
    view.rerender(<Form busy={false} withSave={false} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('does not put the focus back when the element is still disabled', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    await lose(view)
    view.rerender(<Form busy={false} locked />)
    expect(document.activeElement).toBe(document.body)
  })

  it('does not put the focus back when the element is hidden', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    await lose(view)
    view.rerender(<Form busy={false} hideSave />)
    expect(document.activeElement).toBe(document.body)
  })

  it('remembers nothing when the first render is already busy', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    const view = render(<Form busy />)
    outside.disabled = true
    await frames()
    outside.disabled = false
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(document.body)
    outside.remove()
  })

  it('remembers the element that had the focus before the first instance mounted', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    const view = render(<Form busy={false} />)
    view.rerender(<Form busy />)
    outside.disabled = true
    await frames()
    expect(document.activeElement).toBe(document.body)
    outside.disabled = false
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('forgets an element that the person left on purpose', async () => {
    const view = render(<Form busy={false} />)
    save().focus()
    save().blur()
    await lose(view)
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('moves the focus without scrolling', async () => {
    const view = render(<Form busy={false} />)
    const button = save()
    button.focus()
    await lose(view)
    const spy = vi.spyOn(button, 'focus')
    view.rerender(<Form busy={false} />)
    expect(spy).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does not throw when the element refuses the focus', async () => {
    const view = render(<Form busy={false} />)
    const button = save()
    button.focus()
    await lose(view)
    vi.spyOn(button, 'focus').mockImplementation(() => {
      throw new Error('refused')
    })
    expect(() => view.rerender(<Form busy={false} />)).not.toThrow()
  })

  it('puts the focus back again after each of several actions', async () => {
    const view = render(<Form busy={false} />)
    for (let round = 0; round < 3; round += 1) {
      save().focus()
      await lose(view)
      expect(document.activeElement).toBe(document.body)
      view.rerender(<Form busy={false} />)
      expect(document.activeElement).toBe(save())
    }
  })

  it('serves two instances at once, and gives the focus back only to the place where the person was last', async () => {
    const both = (a: boolean, b: boolean) => (
      <>
        <Form name="a" busy={a} />
        <Form name="b" busy={b} />
      </>
    )
    const view = render(both(false, false))
    save('a').focus()
    view.rerender(both(true, false))
    await frames()
    expect(document.activeElement).toBe(document.body)
    field('b').focus()
    view.rerender(both(true, true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    view.rerender(both(false, true))
    expect(document.activeElement).toBe(document.body)
    view.rerender(both(false, false))
    expect(document.activeElement).toBe(field('b'))
  })

  it('does not pull the focus behind a dialog when a background action ends first', async () => {
    function Background({ busy }: { busy: boolean }) {
      useKeepFocus(busy)
      return (
        <button type="button" disabled={busy}>
          background
        </button>
      )
    }
    function Dialog({ busy }: { busy: boolean }) {
      useKeepFocus(busy)
      return (
        <div role="dialog" aria-modal="true" aria-label="dialog">
          <button type="button" disabled={busy}>
            confirm
          </button>
        </div>
      )
    }
    const ui = (background: boolean, dialog: boolean | undefined) => (
      <>
        <Background busy={background} />
        {dialog === undefined ? null : <Dialog busy={dialog} />}
      </>
    )
    const view = render(ui(false, undefined))
    screen.getByRole('button', { name: 'background' }).focus()
    view.rerender(ui(true, undefined))
    await frames()
    view.rerender(ui(true, false))
    screen.getByRole('button', { name: 'confirm' }).focus()
    view.rerender(ui(true, true))
    await frames()
    expect(document.activeElement).toBe(document.body)
    view.rerender(ui(false, true))
    expect(document.activeElement).toBe(document.body)
    view.rerender(ui(false, false))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'confirm' }))
  })

  it('does not put the focus back when the person clicked away to the page while the action ran', async () => {
    const view = render(<Form busy={false} />)
    other().focus()
    view.rerender(<Form busy />)
    await frames()
    other().blur()
    view.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('works under StrictMode, where effects run twice', async () => {
    const view = render(
      <StrictMode>
        <Form busy={false} />
      </StrictMode>,
    )
    save().focus()
    view.rerender(
      <StrictMode>
        <Form busy />
      </StrictMode>,
    )
    await frames()
    expect(document.activeElement).toBe(document.body)
    view.rerender(
      <StrictMode>
        <Form busy={false} />
      </StrictMode>,
    )
    expect(document.activeElement).toBe(save())
  })

  it('does not remember anything when it was busy from the first render under StrictMode', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    const view = render(
      <StrictMode>
        <Form busy />
      </StrictMode>,
    )
    outside.disabled = true
    await frames()
    outside.disabled = false
    view.rerender(
      <StrictMode>
        <Form busy={false} />
      </StrictMode>,
    )
    expect(document.activeElement).toBe(document.body)
    outside.remove()
  })

  it('listens once for all instances and stops after the last one unmounts', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const times = (spy: typeof add, type: string): number => spy.mock.calls.filter(([name]) => name === type).length
    const first = render(<Form name="a" busy={false} />)
    const second = render(<Form name="b" busy={false} />)
    expect(times(add, 'focusin')).toBe(1)
    expect(times(add, 'focusout')).toBe(1)
    first.unmount()
    expect(times(remove, 'focusin')).toBe(0)
    second.unmount()
    expect(times(remove, 'focusin')).toBe(1)
    expect(times(remove, 'focusout')).toBe(1)
  })

  it('starts clean after every instance has unmounted', async () => {
    const first = render(<Form busy={false} />)
    save().focus()
    first.unmount()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    outside.blur()
    const second = render(<Form busy={false} />)
    second.rerender(<Form busy />)
    await frames()
    second.rerender(<Form busy={false} />)
    expect(document.activeElement).toBe(document.body)
    outside.remove()
  })
})

describe('canRestoreFocus', () => {
  const nowhere = (): Element => document.body

  function connected<T extends HTMLElement>(element: T, parent: HTMLElement = document.body): T {
    parent.append(element)
    return element
  }

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('accepts a connected, enabled, visible element when the focus is nowhere', () => {
    const button = connected(document.createElement('button'))
    expect(canRestoreFocus(button, nowhere())).toBe(true)
    expect(canRestoreFocus(button, null)).toBe(true)
    expect(canRestoreFocus(button, document.documentElement)).toBe(true)
  })

  it('refuses when there is no element or it is not in the document', () => {
    expect(canRestoreFocus(null, nowhere())).toBe(false)
    expect(canRestoreFocus(document.createElement('button'), nowhere())).toBe(false)
  })

  it('refuses when the focus is somewhere', () => {
    const button = connected(document.createElement('button'))
    const input = connected(document.createElement('input'))
    expect(canRestoreFocus(button, input)).toBe(false)
    expect(canRestoreFocus(button, button)).toBe(false)
  })

  it('refuses a disabled element, also when a fieldset disables it', () => {
    const button = connected(document.createElement('button'))
    button.disabled = true
    expect(canRestoreFocus(button, nowhere())).toBe(false)
    const fieldset = connected(document.createElement('fieldset'))
    fieldset.disabled = true
    const inner = connected(document.createElement('input'), fieldset)
    expect(canRestoreFocus(inner, nowhere())).toBe(false)
  })

  it('refuses an element that is hidden by an attribute, by display, by visibility or by inert', () => {
    const wrapper = connected(document.createElement('div'))
    const button = connected(document.createElement('button'), wrapper)
    expect(canRestoreFocus(button, nowhere())).toBe(true)
    wrapper.hidden = true
    expect(canRestoreFocus(button, nowhere())).toBe(false)
    wrapper.hidden = false
    wrapper.style.display = 'none'
    expect(canRestoreFocus(button, nowhere())).toBe(false)
    wrapper.style.display = ''
    button.style.visibility = 'hidden'
    expect(canRestoreFocus(button, nowhere())).toBe(false)
    button.style.visibility = ''
    wrapper.setAttribute('inert', '')
    expect(canRestoreFocus(button, nowhere())).toBe(false)
  })
})

describe('useAction keeps the focus', () => {
  function Panel({ work }: { work(): Promise<void> }) {
    const action = useAction()
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(work)
        }}
      >
        <input aria-label="name" disabled={action.busy} />
        <button type="button" disabled={action.busy} onClick={() => void action.run(work)}>
          save
        </button>
        <button type="button">elsewhere</button>
      </form>
    )
  }

  function held() {
    let release: () => void = () => undefined
    let fail: () => void = () => undefined
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve
      fail = () => reject(new Error('refused'))
    })
    return {
      work: () => gate,
      release: () => act(async () => release()),
      fail: () => act(async () => fail()),
    }
  }

  it('gives the focus back to a field where Enter was pressed, after the answer came late', async () => {
    const { work, release } = held()
    const user = userEvent.setup()
    render(<Panel work={work} />)
    const name = screen.getByRole('textbox', { name: 'name' })
    await user.click(name)
    await user.keyboard('{Enter}')
    expect((name as HTMLInputElement).disabled).toBe(true)
    await frames()
    expect(document.activeElement).toBe(document.body)
    await release()
    expect((name as HTMLInputElement).disabled).toBe(false)
    expect(document.activeElement).toBe(name)
  })

  it('gives the focus back to a button that was pressed, after a failed answer', async () => {
    const { work, fail } = held()
    const user = userEvent.setup()
    render(<Panel work={work} />)
    const button = screen.getByRole('button', { name: 'save' })
    await user.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await frames()
    expect(document.activeElement).toBe(document.body)
    await fail()
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('does not take the focus from the control the person moved to meanwhile', async () => {
    const { work, release } = held()
    const user = userEvent.setup()
    render(<Panel work={work} />)
    await user.click(screen.getByRole('button', { name: 'save' }))
    await frames()
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' })
    elsewhere.focus()
    await release()
    expect(document.activeElement).toBe(elsewhere)
  })
})
