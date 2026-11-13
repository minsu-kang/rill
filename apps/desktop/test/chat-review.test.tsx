import { RillError, type PlanResultBody, type ReviewResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app/App'
import { createFakeWorld } from '../src/app/fake-world'
import { HostProvider } from '../src/app/host'
import { ChatPanel, type ChatPanelProps } from '../src/chat/ChatPanel'
import { fakeSettings } from '../src/engine/fake-host'
import type { AttachmentPort } from '../src/chat/Composer'
import { PlanResultCard, type PlanResultCardProps } from '../src/chat/PlanResultCard'
import { ReviewPanel } from '../src/chat/ReviewPanel'
import { ReviewPart, type ReviewPartProps } from '../src/chat/ReviewPart'
import type { AssistantEntry } from '../src/chat/model/conversation'
import { IDLE_REVIEW, reviewErrorKey, type ReviewState } from '../src/chat/model/review'
import { catalog } from '../src/fixtures'
import { agentFixtures } from '../src/fixtures/agents'
import { metas, results } from '../src/fixtures/plan'
import { findingOf, reviewCases, reviewResultOf } from '../src/fixtures/review'
import { skillFixtures } from '../src/fixtures/skills'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations } from './axe'
import { makeWorld, type WorldOptions } from './chat-world'
import { renderThemed } from './render'

const port: AttachmentPort = {
  async add(file) {
    return { id: `att-review-${file.name.length}-xxxxxxxx`, mediaType: 'text/plain', name: file.name, bytes: file.size }
  },
}

const [safety, koReviewer] = agentFixtures.reviewers as [(typeof agentFixtures.reviewers)[0], (typeof agentFixtures.reviewers)[1]]
const reviewers = [
  { id: safety.id, name: safety.name },
  { id: koReviewer.id, name: koReviewer.name },
]

const result = reviewResultOf(reviewCases.mixed)

function partProps(overrides: Partial<ReviewPartProps> = {}): ReviewPartProps {
  return { reviewers: [reviewers[0]!], agents: 'ready', state: IDLE_REVIEW, deployed: false, onAsk: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(), ...overrides }
}

function showPart(overrides: Partial<ReviewPartProps> = {}, locale: 'en' | 'ko' = 'en') {
  const props = partProps(overrides)
  const view = renderThemed(<ReviewPart {...props} />, { locale })
  return { props, ...view }
}

const askButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Ask a reviewer$|^Ask again$|^Try again$/ }) as HTMLButtonElement
const done = (value: ReviewResult = result, agentId = safety.id): ReviewState => ({ phase: 'done', agentId, result: value })

describe('the reviewer part: before a review', () => {
  it('has a button that is off with the way out when there is no reviewer, and no select', () => {
    const { props } = showPart({ reviewers: [] })
    expect(askButton().disabled).toBe(true)
    expect(screen.getByText(en['chat.review.none'])).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(askButton())
    expect(props.onAsk).not.toHaveBeenCalled()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says that the agents are loading, or could not be loaded, instead of saying there is no reviewer', () => {
    const first = showPart({ reviewers: [], agents: 'loading' })
    expect(askButton().disabled).toBe(true)
    expect(screen.getByText(en['agents.picker.loading'])).toBeTruthy()
    expect(screen.queryByText(en['chat.review.none'])).toBeNull()
    first.unmount()
    showPart({ reviewers: [], agents: 'error' })
    expect(screen.getByText(en['agents.picker.loadError'])).toBeTruthy()
  })

  it('hides the select for exactly one reviewer and asks that reviewer', () => {
    const { props } = showPart()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(askButton().disabled).toBe(false)
    fireEvent.click(askButton())
    expect(props.onAsk).toHaveBeenCalledTimes(1)
    expect(props.onAsk).toHaveBeenCalledWith(safety.id)
  })

  it('shows a select of the reviewers for several, starting on the first, and asks the one that was picked', async () => {
    const { props } = showPart({ reviewers })
    const select = screen.getByRole('combobox', { name: 'Reviewer' }) as HTMLSelectElement
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Safety reviewer', '꼼꼼한 검토자'])
    expect(select.value).toBe(safety.id)
    await userEvent.setup().selectOptions(select, koReviewer.id)
    fireEvent.click(askButton())
    expect(props.onAsk).toHaveBeenCalledWith(koReviewer.id)
  })

  it('falls back to the first reviewer when the picked one is gone', async () => {
    const props = partProps({ reviewers })
    const { rerender } = renderThemed(<ReviewPart {...props} />, { locale: 'en' })
    await userEvent.setup().selectOptions(screen.getByRole('combobox'), koReviewer.id)
    rerender(<ReviewPart {...props} reviewers={[reviewers[0]!, { id: 'agent-new', name: 'New one' }]} />)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(safety.id)
  })

  it('says next to the button, before it is pressed, that the plan and the request are sent to the provider', () => {
    showPart({ reviewers })
    const note = screen.getByRole('note')
    expect(note.textContent).toBe(en['chat.review.transfer'])
    expect(note.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(note.parentElement).toBe(askButton().parentElement)
    expect(en['chat.review.transfer']).toContain('the plan and your request')
  })

  it('is off for a plan that is deployed, with a reason, and keeps no transfer note', () => {
    showPart({ deployed: true })
    expect(askButton().disabled).toBe(true)
    expect(screen.getByText(en['chat.review.deployed'])).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('is described in Korean', () => {
    showPart({ reviewers }, 'ko')
    expect(screen.getByRole('button', { name: ko['chat.review.ask'] })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: ko['chat.review.reviewer'] })).toBeTruthy()
    expect(screen.getByRole('note').textContent).toBe(ko['chat.review.transfer'])
  })
})

describe('the reviewer part: while it runs', () => {
  it('says that the reviewer is asked and offers Cancel instead of the button, saying that the answer is discarded', () => {
    const { props } = showPart({ reviewers, state: { phase: 'asking', agentId: safety.id, requestId: 1 } })
    expect(screen.getByRole('status').textContent).toBe(en['chat.review.asking'])
    expect(screen.getByText(en['chat.review.cancelNote'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ask/ })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('the reviewer part: the panel', () => {
  it('shows the summary, then the findings in the order given with a severity word each, and a node id as text', () => {
    showPart({ state: done() })
    const panel = screen.getByRole('article', { name: en['chat.review.panel'] })
    expect(within(panel).getByText(reviewCases.mixed.summary)).toBeTruthy()
    const items = within(within(panel).getByRole('list', { name: en['chat.review.findings'] })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Problem'),
      expect.stringContaining('Warning'),
      expect.stringContaining('Warning'),
      expect.stringContaining('Info'),
    ])
    expect(items[0]!.textContent).toContain(reviewCases.mixed.findings[0]!.text)
    expect(items[0]!.querySelector('code')?.textContent).toBe('append')
    expect(items[0]!.textContent).toContain('Node append')
    expect(items[2]!.querySelector('code')).toBeNull()
    expect(items[2]!.textContent).not.toContain('Node')
  })

  it('shows a chip for each severity, with the word and not only a colour', () => {
    showPart({ state: done() })
    const chips = [...document.querySelectorAll('[data-severity]')]
    expect(chips.map((chip) => [chip.getAttribute('data-severity'), chip.textContent])).toEqual([
      ['problem', 'Problem'],
      ['warning', 'Warning'],
      ['warning', 'Warning'],
      ['info', 'Info'],
    ])
  })

  it('says that nothing was found when there are no findings', () => {
    showPart({ state: done(reviewResultOf(reviewCases.clean)) })
    expect(screen.getByText(reviewCases.clean.summary)).toBeTruthy()
    expect(screen.getByText(en['chat.review.noFindings'])).toBeTruthy()
    expect(screen.queryByRole('list', { name: en['chat.review.findings'] })).toBeNull()
  })

  it('shows the meta line: the reviewer, the model, the cost and the skills, and the line that the plan and the request were sent', () => {
    showPart({ state: done(reviewResultOf(reviewCases.mixed, { costNote: 'The price of cached tokens is counted in full.', skillsUsed: 2 })) })
    const meta = screen.getByRole('list', { name: en['chat.review.details'] })
    const text = within(meta)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(text).toContain('Reviewer Safety reviewer')
    expect(text).toContain('anthropic · claude-opus-5-5')
    expect(text).toContain('Cost: at most about $0.021')
    expect(text).toContain('Used 2 skills')
    expect(text).toContain('The price of cached tokens is counted in full.')
    expect(screen.getByText(en['chat.review.sent'])).toBeTruthy()
    expect(en['chat.review.sent']).toContain('The plan and your request were sent to the AI provider')
  })

  it('says when the cost is unknown and when the reviewer settings were left out', () => {
    showPart({ state: done(reviewResultOf(reviewCases.clean, { costUsd: null, agentDropped: 1, skillsUsed: 0 })) })
    expect(screen.getByText(en['chat.meta.costUnknown'])).toBeTruthy()
    expect(screen.getByText(en['chat.meta.agentDropped'])).toBeTruthy()
    expect(screen.queryByText(/Used \d+ skill/)).toBeNull()
  })

  it('offers Ask again and Close, and calls them', () => {
    const { props } = showPart({ reviewers, state: done() })
    expect(askButton().textContent).toBe('Ask again')
    expect(screen.getByRole('note').textContent).toBe(en['chat.review.transfer'])
    fireEvent.click(askButton())
    expect(props.onAsk).toHaveBeenCalledWith(safety.id)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('selects the reviewer that made the review when there are several', () => {
    showPart({ reviewers, state: done(reviewResultOf(reviewCases.clean, { agentUsed: { id: koReviewer.id, name: koReviewer.name } }), koReviewer.id) })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(koReviewer.id)
  })

  it('keeps the panel of a deployed plan and takes the button off', () => {
    showPart({ state: done(), deployed: true })
    expect(screen.getByRole('article', { name: en['chat.review.panel'] })).toBeTruthy()
    expect(askButton().disabled).toBe(true)
  })

  it('says in words that the advice does not change the plan', () => {
    showPart({ state: done() })
    expect(screen.getByText(en['chat.review.advice'])).toBeTruthy()
  })

  it('shows hostile text as text: no markup, no link, hidden characters made visible, long ids cut', () => {
    const hostile = reviewResultOf(reviewCases.hostile, { agentUsed: { id: 'x', name: '<b>Evil</b>\u202e' } })
    const { container } = showPart({ state: done({ ...hostile, review: { ...hostile.review, findings: [...hostile.review.findings, findingOf('info', 'x', `${'n'.repeat(80)}\u200b`)] } }) })
    expect(container.querySelector('img, script, a, b')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('‹U+202E›')
    expect(container.textContent).toContain('javascript:alert(3)')
    expect(container.textContent).toContain('<b>Evil</b>‹U+202E›')
    for (const code of container.querySelectorAll('code')) expect((code.textContent ?? '').length).toBeLessThanOrEqual(40)
  })

  it('has no accessibility violations in the states', async () => {
    const first = showPart({ reviewers, state: done() })
    expect(await violations(first.container)).toEqual([])
    first.unmount()
    const second = showPart({ reviewers, state: { phase: 'asking', agentId: safety.id, requestId: 1 } })
    expect(await violations(second.container)).toEqual([])
    second.unmount()
    const third = showPart({ reviewers: [], state: IDLE_REVIEW })
    expect(await violations(third.container)).toEqual([])
    third.unmount()
    const fourth = showPart({ reviewers, state: { phase: 'error', agentId: safety.id, key: 'chat.review.error.busy' } })
    expect(await violations(fourth.container)).toEqual([])
  })
})

describe('the reviewer part: an error', () => {
  it('shows the fixed text as an alert and the button again, named Try again', () => {
    const { props } = showPart({ state: { phase: 'error', agentId: safety.id, key: 'chat.review.error.busy' } })
    expect(screen.getByRole('alert').textContent).toBe(en['chat.review.error.busy'])
    expect(askButton().textContent).toBe('Try again')
    fireEvent.click(askButton())
    expect(props.onAsk).toHaveBeenCalledWith(safety.id)
  })
})

describe('reviewErrorKey', () => {
  it.each([
    ['NOT_FOUND', 'chat.review.error.notFound'],
    ['PLAN_NOT_REVIEWABLE', 'chat.review.error.notReviewable'],
    ['AGENT_NOT_FOUND', 'chat.review.error.agentNotFound'],
    ['AGENT_NOT_REVIEWER', 'chat.review.error.notReviewer'],
    ['LLM_UNAVAILABLE', 'chat.review.error.llmUnavailable'],
    ['REVIEW_BUSY', 'chat.review.error.busy'],
    ['REVIEW_PROVIDER', 'chat.review.error.provider'],
    ['REVIEW_INVALID', 'chat.review.error.invalid'],
    ['INVALID_PARAMS', 'chat.review.error.params'],
    ['INTERNAL', 'chat.review.error.generic'],
    ['SOMETHING_ELSE', 'chat.review.error.generic'],
  ] as const)('gives %s its own fixed text', (code, key) => {
    expect(reviewErrorKey(new RillError(code, 'SECRET-DETAIL', ['x']))).toBe(key)
  })

  it('has a text of its own for every code, different from the others, in both languages, and never uses the message', () => {
    const codes = ['NOT_FOUND', 'PLAN_NOT_REVIEWABLE', 'AGENT_NOT_FOUND', 'AGENT_NOT_REVIEWER', 'LLM_UNAVAILABLE', 'REVIEW_BUSY', 'REVIEW_PROVIDER', 'REVIEW_INVALID', 'INVALID_PARAMS', 'INTERNAL']
    for (const locale of ['en', 'ko'] as const) {
      const t = createTranslator(locale)
      const texts = codes.map((code) => t(reviewErrorKey({ code, message: 'SECRET-DETAIL' })))
      expect(new Set(texts).size).toBe(codes.length)
      for (const text of texts) expect(text).not.toContain('SECRET-DETAIL')
    }
  })

  it('reads a thing that is not an error as the general text', () => {
    expect(reviewErrorKey(undefined)).toBe('chat.review.error.generic')
    expect(reviewErrorKey('x')).toBe('chat.review.error.generic')
    expect(reviewErrorKey({ code: 5 })).toBe('chat.review.error.generic')
  })
})

describe('ReviewPanel on its own', () => {
  it('labels itself and takes the focus ref', () => {
    renderThemed(<ReviewPanel result={result} />, { locale: 'en' })
    expect(screen.getByRole('article', { name: en['chat.review.panel'] })).toBeTruthy()
  })
})

function entryOf(planResult: PlanResultBody, deployed?: string): AssistantEntry {
  return { role: 'assistant', planId: 'p1', result: planResult, meta: metas.plain, ...(deployed === undefined ? {} : { deployed }) }
}

function showCard(overrides: Partial<PlanResultCardProps> = {}) {
  const props: PlanResultCardProps = {
    entry: entryOf(results.flagged),
    catalog,
    confirmed: [],
    onToggleFlag: vi.fn(),
    onDeploy: vi.fn(),
    deploying: false,
    ...overrides,
  }
  const view = renderThemed(<PlanResultCard {...props} />, { locale: 'en' })
  return { props, ...view }
}

describe('the plan card with the reviewer part', () => {
  const review = (state: ReviewState = IDLE_REVIEW) => ({ reviewers, agents: 'ready' as const, state, onAsk: vi.fn(), onCancel: vi.fn(), onClose: vi.fn() })

  it('shows the part below the Deploy button when it is given, and nothing when it is not', () => {
    const first = showCard()
    expect(screen.queryByRole('group', { name: en['chat.review.group'] })).toBeNull()
    first.unmount()
    showCard({ review: review() })
    const group = screen.getByRole('group', { name: en['chat.review.group'] })
    const deploy = screen.getByRole('button', { name: 'Deploy' })
    expect(deploy.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has no part for a plan without a workflow', () => {
    const questions = showCard({ entry: entryOf(results.questions), review: review() })
    expect(questions.container.textContent).toBe('')
    questions.unmount()
    const unsupported = showCard({ entry: entryOf(results.unsupported), review: review() })
    expect(unsupported.container.textContent).toBe('')
  })

  it('turns the button off for a deployed plan', () => {
    showCard({ entry: entryOf(results.workflow, 'wf-9'), review: review() })
    expect((screen.getByRole('button', { name: 'Ask a reviewer' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en['chat.review.deployed'])).toBeTruthy()
  })

  it('leaves the Deploy row, the flags and the card text exactly as they are with and without a result', () => {
    const snapshot = (container: HTMLElement): string[] => {
      const card = container.querySelector('[data-plan-card]')!
      const flags = [...card.querySelectorAll('input[type="checkbox"]')].map((box) => `${box.getAttribute('aria-label')}:${(box as HTMLInputElement).checked}:${(box as HTMLInputElement).disabled}`)
      const deploy = screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement
      const text = [...card.children].filter((child) => !child.matches('[role="group"], [role="region"]')).map((child) => child.outerHTML)
      return [deploy.disabled ? 'off' : 'on', deploy.outerHTML, ...flags, ...text]
    }
    const confirmed = results.flagged.kind === 'workflow' ? results.flagged.flags.slice(0, 2).map((flag) => `${flag.nodeId}|${flag.code}|${flag.pointer}`) : []
    const first = showCard({ confirmed })
    const before = snapshot(first.container)
    first.unmount()
    const second = showCard({ confirmed, review: review(done()) })
    expect(snapshot(second.container)).toEqual(before)
    second.unmount()
    const third = showCard({ confirmed, review: review({ phase: 'asking', agentId: safety.id, requestId: 1 }) })
    expect(snapshot(third.container)).toEqual(before)
    third.unmount()
    const fourth = showCard({ confirmed, review: review({ phase: 'error', agentId: safety.id, key: 'chat.review.error.provider' }) })
    expect(snapshot(fourth.container)).toEqual(before)
  })
})

function show(options: WorldOptions = {}, props: Partial<ChatPanelProps> = {}, locale: 'en' | 'ko' = 'en') {
  const world = makeWorld({ agents: [agentFixtures.few[0]!, ...agentFixtures.reviewers], skills: skillFixtures.few, ...options })
  let serial = 0
  const view = renderThemed(<ChatPanel client={world.client} port={port} catalog={catalog} newId={() => `plan-${++serial}`} {...props} />, { locale })
  return { world, ...view }
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Your request' }) as HTMLTextAreaElement

async function ready(): Promise<void> {
  await screen.findByText('Anthropic · Claude Opus 5.5')
  await screen.findByRole('combobox', { name: 'Agent' })
}

function ask(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

async function planned(options: WorldOptions = {}) {
  const shown = show(options)
  await ready()
  ask('watch a folder for receipts')
  await screen.findByText(results.workflow.kind === 'workflow' ? results.workflow.summary : '')
  return shown
}

const reviewButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Ask a reviewer$|^Ask again$|^Try again$/ }) as HTMLButtonElement

describe('the chat with a reviewer', () => {
  it('asks the engine with the plan id and the chosen reviewer, shows the answer and does not change Deploy', async () => {
    const { world } = await planned()
    expect(screen.queryByRole('combobox', { name: 'Reviewer' })).not.toBeNull()
    const deploy = screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement
    const before = deploy.outerHTML
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Reviewer' }), 'agent-reviewer-ko')
    fireEvent.click(reviewButton())
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Asking the reviewer')
    expect(await screen.findByRole('article', { name: en['chat.review.panel'] })).toBeTruthy()
    expect(world.callsOf('reviewPlan').map((call) => call.params)).toEqual([{ planId: 'plan-1', agentId: 'agent-reviewer-ko' }])
    expect(screen.getByText(en['chat.review.sent'])).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).outerHTML).toBe(before)
    expect(world.callsOf('deployPlan')).toEqual([])
    expect(world.callsOf('plan')).toHaveLength(1)
  })

  it('hides the select with one reviewer, and offers none to an assistant', async () => {
    await planned({ agents: [agentFixtures.few[0]!, agentFixtures.reviewers[0]!] })
    expect(screen.queryByRole('combobox', { name: 'Reviewer' })).toBeNull()
    fireEvent.click(reviewButton())
    expect(await screen.findByRole('article', { name: en['chat.review.panel'] })).toBeTruthy()
  })

  it('turns the button off with the way out when no reviewer exists', async () => {
    const { world } = await planned({ agents: [agentFixtures.few[0]!] })
    expect(reviewButton().disabled).toBe(true)
    expect(screen.getByText(en['chat.review.none'])).toBeTruthy()
    fireEvent.click(reviewButton())
    expect(world.callsOf('reviewPlan')).toEqual([])
  })

  it('replaces the panel when the person asks again', async () => {
    let calls = 0
    await planned({ review: () => ({ review: calls++ === 0 ? reviewCases.mixed : reviewCases.clean }) })
    fireEvent.click(reviewButton())
    await screen.findByText(reviewCases.mixed.summary)
    fireEvent.click(reviewButton())
    expect(screen.queryByText(reviewCases.mixed.summary)).toBeNull()
    await screen.findByText(reviewCases.clean.summary)
    expect(screen.getAllByRole('article', { name: en['chat.review.panel'] })).toHaveLength(1)
  })

  it('sends one request for a double press', async () => {
    const { world } = await planned()
    const button = reviewButton()
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByRole('article', { name: en['chat.review.panel'] })
    expect(world.callsOf('reviewPlan')).toHaveLength(1)
  })

  it('cancels by dropping the answer: the panel does not come, and the button is back', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { world } = await planned({
      intercept: (method) => (method === 'reviewPlan' ? gate.then(() => reviewResultOf(reviewCases.mixed)) : undefined),
    })
    fireEvent.click(reviewButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('status', { name: '' })?.textContent ?? '').not.toContain('Asking the reviewer')
    expect(reviewButton().textContent).toBe('Ask a reviewer')
    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    expect(screen.queryByRole('article', { name: en['chat.review.panel'] })).toBeNull()
    expect(world.callsOf('reviewPlan')).toHaveLength(1)
  })

  it.each([
    ['NOT_FOUND', 'notFound'],
    ['PLAN_NOT_REVIEWABLE', 'notReviewable'],
    ['AGENT_NOT_FOUND', 'agentNotFound'],
    ['AGENT_NOT_REVIEWER', 'notReviewer'],
    ['LLM_UNAVAILABLE', 'llmUnavailable'],
    ['REVIEW_BUSY', 'busy'],
    ['REVIEW_PROVIDER', 'provider'],
    ['REVIEW_INVALID', 'invalid'],
    ['INVALID_PARAMS', 'params'],
    ['INTERNAL', 'generic'],
  ] as const)('shows the fixed text of %s and never the message of the error', async (code, key) => {
    await planned({ intercept: (method) => (method === 'reviewPlan' ? Promise.reject(new RillError(code, 'SECRET-DETAIL', ['SECRET-PROBLEM'])) : undefined) })
    fireEvent.click(reviewButton())
    expect((await screen.findByRole('alert')).textContent).toBe(en[`chat.review.error.${key}`])
    expect(document.body.textContent).not.toContain('SECRET')
    expect(reviewButton().textContent).toBe('Try again')
    expect(screen.queryByRole('article', { name: en['chat.review.panel'] })).toBeNull()
  })

  it('loads the agents again when the engine says the reviewer is gone or is not one', async () => {
    const { world } = await planned({ intercept: (method) => (method === 'reviewPlan' ? Promise.reject(new RillError('AGENT_NOT_FOUND', 'x')) : undefined) })
    const before = world.callsOf('listAgents').length
    fireEvent.click(reviewButton())
    await screen.findByRole('alert')
    await waitFor(() => expect(world.callsOf('listAgents').length).toBeGreaterThan(before))
  })

  it('shows REVIEW_BUSY from the engine when another review is still running, and the card of the first review keeps its place', async () => {
    const { world } = show({ delayMs: 0, review: (_params, context) => (context.agent.id === 'agent-reviewer' ? 'hang' : { review: reviewCases.clean }) })
    await ready()
    ask('first plan')
    await screen.findAllByText(results.workflow.kind === 'workflow' ? results.workflow.summary : '')
    ask('second plan')
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Deploy' })).toHaveLength(2))
    const buttons = screen.getAllByRole('button', { name: 'Ask a reviewer' })
    fireEvent.click(buttons[0]!)
    await screen.findByText(en['chat.review.asking'])
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask a reviewer' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toBe(en['chat.review.error.busy'])
    expect(world.callsOf('reviewPlan')).toHaveLength(2)
  })

  it('keeps the panel when another chat is opened and the first one is shown again', async () => {
    await planned()
    fireEvent.click(reviewButton())
    await screen.findByRole('article', { name: en['chat.review.panel'] })
    fireEvent.click(screen.getByRole('button', { name: 'Open a new chat' }))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    expect(screen.queryByRole('article', { name: en['chat.review.panel'] })).toBeNull()
    fireEvent.click(screen.getAllByRole('tab')[0]!)
    expect(await screen.findByRole('article', { name: en['chat.review.panel'] })).toBeTruthy()
  })

  it('keeps a review that is still running when the person switches to the Model view and back', async () => {
    await planned({ review: () => 'hang' })
    fireEvent.click(reviewButton())
    await screen.findByText(en['chat.review.asking'])
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByText(en['chat.review.asking'])).toBeTruthy()
  })

  it('works in Korean', async () => {
    const shown = show({}, {}, 'ko')
    await screen.findByRole('combobox', { name: ko['agents.picker.label'] })
    fireEvent.change(screen.getByRole('textbox', { name: ko['chat.composer.label'] }), { target: { value: '영수증 폴더를 지켜봐 줘' } })
    fireEvent.click(screen.getByRole('button', { name: ko['chat.composer.send'] }))
    await screen.findByRole('button', { name: ko['chat.deploy.button'] })
    fireEvent.click(screen.getByRole('button', { name: ko['chat.review.ask'] }))
    expect(await screen.findByRole('article', { name: ko['chat.review.panel'] })).toBeTruthy()
    expect(screen.getByText(ko['chat.review.sent'])).toBeTruthy()
    expect(shown.world.callsOf('reviewPlan')).toHaveLength(1)
  })

  it('has no accessibility violations with a panel on the card', async () => {
    const { container } = await planned()
    fireEvent.click(reviewButton())
    await screen.findByRole('article', { name: en['chat.review.panel'] })
    expect(await violations(container)).toEqual([])
  })
})

describe('the app with a reviewer', () => {
  it('keeps the panel of a review when the chat is closed and opened again', async () => {
    const world = createFakeWorld({
      hostOptions: { restartDelayMs: 0 },
      hostInit: { settings: fakeSettings({ configuredProviders: ['anthropic', 'openai'], allowedFolders: ['/Users/demo/Receipts'] }) },
      control: { stepIntervalMs: 0 },
      agents: [agentFixtures.few[0]!, ...agentFixtures.reviewers],
      skills: skillFixtures.few,
    })
    const view = renderThemed(
      <HostProvider host={world.host} connect={world.connect}>
        <App />
      </HostProvider>,
      { locale: 'en' },
    )
    const user = userEvent.setup()
    const toggle = await screen.findByRole('button', { name: en['app.top.chat.open'] })
    const chat = view.container.querySelector('[data-rill-region="chat"]') as HTMLElement
    await user.click(toggle)
    await within(chat).findByRole('combobox', { name: 'Agent' })
    await user.type(within(chat).getByRole('textbox', { name: 'Your request' }), 'watch a folder')
    await user.click(within(chat).getByRole('button', { name: 'Send' }))
    await user.click(await within(chat).findByRole('button', { name: 'Ask a reviewer' }))
    await within(chat).findByRole('article', { name: en['chat.review.panel'] })
    await user.click(within(chat).getByRole('textbox', { name: 'Your request' }))
    await user.keyboard('{Escape}')
    expect(chat.getAttribute('data-open')).toBe('false')
    await user.click(toggle)
    expect(chat.getAttribute('data-open')).toBe('true')
    expect(within(chat).getByRole('article', { name: en['chat.review.panel'] })).toBeTruthy()
    expect(world.callsOf('reviewPlan')).toHaveLength(1)
  })
})
