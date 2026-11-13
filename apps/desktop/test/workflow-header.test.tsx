import type { WorkflowSummary } from '@rill/protocol'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createFakeWorld } from '../src/app/fake-world'
import { useWorkflowList } from '../src/app/workflows/useWorkflowList'
import { WorkflowHeader } from '../src/app/workflows/WorkflowHeader'
import type { EngineClient } from '../src/engine/client'
import { ids } from '../src/fixtures'
import { createTranslator, type Locale } from '../src/i18n'
import { violations } from './axe'
import { renderThemed } from './render'

const refresh = async (): Promise<void> => undefined

const RECEIPT: WorkflowSummary = { id: ids.workflows.receipt, name: '영수증 정리', active: true, triggerType: 'trigger.folderWatch@1', createdAt: 3 }
const DAILY: WorkflowSummary = { id: ids.workflows.branching, name: '매일 서버 상태 확인', active: true, triggerType: 'trigger.cron@1', createdAt: 2 }
const HOOK: WorkflowSummary = { id: ids.workflows.webhook, name: '웹훅을 슬랙으로 전달', active: false, triggerType: 'trigger.webhook@1', createdAt: 1 }

const CSS = readFileSync(join(import.meta.dirname, '../src/app/workflows/Workflows.module.css'), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.:()]/g, '\\$&')
  const found = CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  if (found === null) throw new Error(`no rule ${selector}`)
  return found[1]!
}

interface HarnessProps {
  workflows: readonly WorkflowSummary[]
  status?: 'loading' | 'ready' | 'error'
  initial?: string | undefined
  onSelect?(id: string): void
  retry?(): Promise<void>
}

function Harness({ workflows, status = 'ready', initial, onSelect, retry = refresh }: HarnessProps) {
  const [selected, setSelected] = useState<string | undefined>(initial ?? workflows[0]?.id)
  return (
    <WorkflowHeader
      list={{ status, workflows, refresh: retry }}
      selectedId={selected}
      summary={workflows.find((item) => item.id === selected)}
      onSelect={(id) => {
        setSelected(id)
        onSelect?.(id)
      }}
    />
  )
}

function Live({ client }: { client: EngineClient }) {
  const list = useWorkflowList(client)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const id = selected ?? list.workflows[0]?.id
  return <WorkflowHeader list={list} selectedId={id} summary={list.workflows.find((item) => item.id === id)} onSelect={setSelected} />
}

function copies(container: HTMLElement, text: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('*')].filter((element) => element.tagName !== 'OPTION' && element.children.length === 0 && element.textContent === text)
}

const select = (locale: Locale = 'ko') => screen.getByLabelText(createTranslator(locale)('app.wf.switcher.label')) as HTMLSelectElement
const heading = (name: string) => screen.getByRole('heading', { level: 2, name })

describe.each(['ko', 'en'] as const)('WorkflowHeader (%s)', (locale) => {
  const t = createTranslator(locale)
  const trigger = { folderWatch: t('app.wf.trigger.folderWatch'), cron: t('app.wf.trigger.cron'), webhook: t('app.wf.trigger.webhook') }

  it('draws the name of the selected workflow once, as the level 2 heading, with its state and trigger beside it', () => {
    const view = renderThemed(<Harness workflows={[RECEIPT, DAILY, HOOK]} />, { locale })
    expect(copies(view.container, RECEIPT.name)).toHaveLength(1)
    expect(copies(view.container, RECEIPT.name)[0]).toBe(heading(RECEIPT.name))
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(copies(view.container, t('app.wf.active'))).toHaveLength(1)
    expect(copies(view.container, trigger.folderWatch)).toHaveLength(1)
    expect(copies(view.container, t('app.wf.inactive'))).toHaveLength(0)
    expect(copies(view.container, trigger.cron)).toHaveLength(0)
  })

  it('keeps every option as name, trigger and state, so that two workflows with one name stay apart', () => {
    const twin: WorkflowSummary = { ...HOOK, id: 'wf-twin', name: RECEIPT.name, triggerType: 'trigger.cron@1' }
    renderThemed(<Harness workflows={[RECEIPT, DAILY, twin]} />, { locale })
    const options = within(select(locale)).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual([
      t('app.wf.option', { name: RECEIPT.name, trigger: trigger.folderWatch, state: t('app.wf.active') }),
      t('app.wf.option', { name: DAILY.name, trigger: trigger.cron, state: t('app.wf.active') }),
      t('app.wf.option', { name: RECEIPT.name, trigger: trigger.cron, state: t('app.wf.inactive') }),
    ])
  })

  it('changes the workflow, the title and the chips when an option is chosen', async () => {
    const onSelect = vi.fn()
    const view = renderThemed(<Harness workflows={[RECEIPT, DAILY, HOOK]} onSelect={onSelect} />, { locale })
    await userEvent.setup().selectOptions(select(locale), HOOK.id)
    expect(onSelect).toHaveBeenCalledWith(HOOK.id)
    expect(heading(HOOK.name)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: RECEIPT.name })).toBeNull()
    expect(select(locale).value).toBe(HOOK.id)
    expect(copies(view.container, t('app.wf.inactive'))).toHaveLength(1)
    expect(copies(view.container, t('app.wf.active'))).toHaveLength(0)
    expect(copies(view.container, trigger.webhook)).toHaveLength(1)
    expect(copies(view.container, trigger.folderWatch)).toHaveLength(0)
  })

  it('draws a chevron when there is something to switch to, and none for a single workflow', () => {
    const many = renderThemed(<Harness workflows={[RECEIPT, DAILY]} />, { locale })
    const chevron = many.container.querySelector('svg')!
    expect(chevron.getAttribute('aria-hidden')).toBe('true')
    expect(chevron.getAttribute('focusable')).toBe('false')
    expect(chevron.parentElement).toBe(select(locale).parentElement)
    expect(select(locale).getAttribute('title')).toBe(`${RECEIPT.name}\n${t('app.wf.switcher.tooltip')}`)
    many.unmount()
    const single = renderThemed(<Harness workflows={[RECEIPT]} />, { locale })
    expect(single.container.querySelector('svg')).toBeNull()
    expect(select(locale).getAttribute('title')).toBe(RECEIPT.name)
    expect(heading(RECEIPT.name)).toBeTruthy()
    expect(select(locale).options).toHaveLength(1)
  })

  it('says what the switcher says while the list loads, after it failed, and when there is no workflow, with no title', async () => {
    const loading = renderThemed(<Harness workflows={[]} status="loading" />, { locale })
    expect(screen.getByText(t('app.wf.switcher.loading'))).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByLabelText(t('app.wf.switcher.label'))).toBeNull()
    loading.unmount()
    const retry = vi.fn(refresh)
    const failed = renderThemed(<Harness workflows={[]} status="error" retry={retry} />, { locale })
    expect(screen.getByRole('alert').textContent).toBe(t('app.wf.switcher.error'))
    await userEvent.setup().click(screen.getByRole('button', { name: t('app.wf.switcher.retry') }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading')).toBeNull()
    failed.unmount()
    renderThemed(<Harness workflows={[]} />, { locale })
    expect(screen.getByText(t('app.wf.switcher.empty'))).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByLabelText(t('app.wf.switcher.label'))).toBeNull()
  })

  it('has the select as its only tab stop, named by its hidden label, and moves on after it', async () => {
    const view = renderThemed(
      <>
        <button type="button">before</button>
        <Harness workflows={[RECEIPT, DAILY]} />
        <button type="button">after</button>
      </>,
      { locale },
    )
    const user = userEvent.setup()
    expect(view.container.querySelectorAll('select, button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])')).toHaveLength(3)
    expect(select(locale).labels?.[0]?.textContent).toBe(t('app.wf.switcher.label'))
    expect(select(locale).labels?.[0]?.className).toMatch(/labelHidden/)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'before' }))
    await user.tab()
    expect(document.activeElement).toBe(select(locale))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
    expect(heading(RECEIPT.name).getAttribute('tabindex')).toBeNull()
  })

  it('has no accessibility violations with one workflow, with several, and while it is loading', async () => {
    const many = renderThemed(<Harness workflows={[RECEIPT, DAILY, HOOK]} />, { locale })
    expect(await violations(many.container)).toEqual([])
    many.unmount()
    const single = renderThemed(<Harness workflows={[HOOK]} />, { locale })
    expect(await violations(single.container)).toEqual([])
    single.unmount()
    const loading = renderThemed(<Harness workflows={[]} status="loading" />, { locale })
    expect(await violations(loading.container)).toEqual([])
  })
})

describe('WorkflowHeader: text from the engine', () => {
  const LONG = '가나다라마바사 '.repeat(70)

  it('shows a very long name as one line of text, with the full text in the title of the select that lies over it', () => {
    const long: WorkflowSummary = { ...RECEIPT, name: LONG }
    const view = renderThemed(<Harness workflows={[long, DAILY]} />)
    const title = heading(LONG.trim())
    expect(title.textContent).toBe(LONG)
    expect(select().getAttribute('title')).toBe(`${LONG}\n${createTranslator('ko')('app.wf.switcher.tooltip')}`)
    expect(title.hasAttribute('title')).toBe(false)
    expect(title.className).toMatch(/name/)
    expect(view.container.querySelectorAll('h2')).toHaveLength(1)
    expect(rule('.name')).toMatch(/white-space:\s*nowrap/)
    expect(rule('.name')).toMatch(/overflow:\s*hidden/)
    expect(rule('.name')).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('shows markup, an invisible character and a bidirectional override as plain text', () => {
    const hostile: WorkflowSummary = { ...RECEIPT, name: '<img src=x onerror=alert(1)> \u202Eexe.txt \u200B\u2066zero\u2069', triggerType: 'trigger.<b>x</b>@1' }
    const view = renderThemed(<Harness workflows={[hostile, DAILY]} />)
    const visible = '<img src=x onerror=alert(1)> ‹U+202E›exe.txt ‹U+200B›‹U+2066›zero‹U+2069›'
    const title = screen.getByRole('heading', { level: 2 })
    expect(title.textContent).toBe(visible)
    expect(select().getAttribute('title')).toBe(`${visible}\n${createTranslator('ko')('app.wf.switcher.tooltip')}`)
    expect(view.container.querySelector('img, b, script')).toBeNull()
    expect(view.container.textContent).not.toMatch(/[\u202E\u200B\u2066\u2069]/)
    expect(copies(view.container, 'trigger.<b>x</b>@1')).toHaveLength(1)
    const option = within(select()).getAllByRole('option')[0]!
    expect(option.textContent?.startsWith(visible.slice(0, 40))).toBe(true)
    expect(option.textContent).not.toMatch(/[\u202E\u200B\u2066\u2069]/)
  })

  it('cuts the trigger of an unknown kind to 24 characters', () => {
    const odd: WorkflowSummary = { ...RECEIPT, triggerType: `trigger.${'q'.repeat(60)}@1` }
    const view = renderThemed(<Harness workflows={[odd]} />)
    const chip = [...view.container.querySelectorAll('span')].find((item) => item.textContent?.startsWith('trigger.qqq'))
    expect(chip?.textContent).toHaveLength(24)
    expect(chip?.textContent?.endsWith('…')).toBe(true)
  })

  it('names a workflow that the list does not hold yet, and shows no chips for it', () => {
    const view = renderThemed(<Harness workflows={[RECEIPT, DAILY]} initial="wf-just-deployed" />)
    const t = createTranslator('ko')
    expect(heading(t('app.wf.switcher.pending'))).toBeTruthy()
    expect(select().value).toBe('wf-just-deployed')
    expect(copies(view.container, t('app.wf.active'))).toHaveLength(0)
    expect(copies(view.container, t('app.wf.inactive'))).toHaveLength(0)
  })
})

describe('WorkflowHeader: the look of the title', () => {
  it('lays the select over the whole title box, invisible, and still the control', () => {
    const overlay = rule('.overlay')
    expect(overlay).toMatch(/position:\s*absolute/)
    expect(overlay).toMatch(/inset:\s*0/)
    expect(overlay).toMatch(/opacity:\s*0/)
    expect(overlay).toMatch(/cursor:\s*pointer/)
    expect(rule('.titleBox')).toMatch(/position:\s*relative/)
  })

  it('draws the focus ring on the title box only for keyboard focus, like every other control, and a quiet hover only when there is something to pick', () => {
    expect(rule('.titleBox:has(> select:focus-visible)')).toMatch(/outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring\)/)
    expect(CSS).not.toMatch(/focus-within/)
    expect(rule('.pick:hover')).toMatch(/background:\s*var\(--surface-sunken\)/)
  })

  it('lets the chips wrap under the title on a narrow window', () => {
    expect(rule('.header')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.titleBox')).toMatch(/max-width:\s*100%/)
    expect(rule('.titleBox')).toMatch(/min-width:\s*0/)
  })
})

describe('WorkflowHeader: chips follow the engine', () => {
  it('shows the new state after the workflow is activated and deactivated', async () => {
    const world = createFakeWorld({ hostOptions: { restartDelayMs: 0 } })
    const t = createTranslator('ko')
    const view = renderThemed(<Live client={world.client} />)
    await screen.findByRole('heading', { name: HOOK.name })
    expect(copies(view.container, t('app.wf.inactive'))).toHaveLength(1)
    await act(async () => {
      await world.client.request('activate', { workflowId: HOOK.id })
    })
    await waitFor(() => expect(copies(view.container, t('app.wf.active'))).toHaveLength(1))
    expect(copies(view.container, t('app.wf.inactive'))).toHaveLength(0)
    expect(copies(view.container, t('app.wf.trigger.webhook'))).toHaveLength(1)
    expect(heading(HOOK.name)).toBeTruthy()
    await act(async () => {
      await world.client.request('deactivate', { workflowId: HOOK.id })
    })
    await waitFor(() => expect(copies(view.container, t('app.wf.inactive'))).toHaveLength(1))
    expect(copies(view.container, t('app.wf.active'))).toHaveLength(0)
    await userEvent.setup().selectOptions(select(), RECEIPT.id)
    expect(heading(RECEIPT.name)).toBeTruthy()
    expect(copies(view.container, t('app.wf.active'))).toHaveLength(1)
    expect(copies(view.container, t('app.wf.trigger.folderWatch'))).toHaveLength(1)
  })
})
