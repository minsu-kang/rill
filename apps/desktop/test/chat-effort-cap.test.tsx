import { RillError, type PlanEffort, type Rule } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../src/chat/ChatPanel'
import type { AttachmentPort } from '../src/chat/Composer'
import { EffortSlider } from '../src/chat/EffortSlider'
import { MetaLine } from '../src/chat/MetaLine'
import { EFFORT_STEPS, stepAvailability } from '../src/chat/model/effort'
import { planErrorKey } from '../src/chat/model/errors'
import { activeModelOf } from '../src/chat/model/models'
import { rulesStoreFor } from '../src/engine/rules'
import { catalog } from '../src/fixtures'
import { metaOf, models, modelsHaikuActive } from '../src/fixtures/plan'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { makeWorld, type WorldOptions } from './chat-world'
import { renderThemed } from './render'

const opus = activeModelOf(models)!
const haiku = activeModelOf(modelsHaikuActive)!

const radios = (): HTMLElement[] => screen.getAllByRole('radio')
const disabled = (): string[] => radios().filter((radio) => radio.getAttribute('aria-disabled') === 'true').map((radio) => radio.textContent ?? '')

describe('stepAvailability with a cap', () => {
  it('lets every step through without a cap', () => {
    expect(EFFORT_STEPS.map((step) => stepAvailability(step, opus, undefined).enabled)).toEqual([true, true, true, true, true])
  })

  it('blocks the steps above the cap with the reason rule_cap and keeps the cap itself', () => {
    expect(EFFORT_STEPS.map((step) => stepAvailability(step, opus, 'medium'))).toEqual([{ enabled: true }, { enabled: true }, { enabled: false, reason: 'rule_cap' }, { enabled: false, reason: 'rule_cap' }, { enabled: false, reason: 'rule_cap' }])
  })

  it('blocks nothing for the cap max', () => {
    expect(EFFORT_STEPS.map((step) => stepAvailability(step, opus, 'max').enabled)).toEqual([true, true, true, true, true])
  })

  it('names the rule before the model, and the missing model before both', () => {
    const veryCareful = EFFORT_STEPS[3]!
    expect(stepAvailability(veryCareful, haiku, 'medium')).toEqual({ enabled: false, reason: 'rule_cap' })
    expect(stepAvailability(veryCareful, haiku, 'xhigh')).toEqual({ enabled: false, reason: 'model_unsupported' })
    expect(stepAvailability(veryCareful, undefined, 'medium')).toEqual({ enabled: false, reason: 'no_model' })
  })
})

describe('EffortSlider with a cap', () => {
  it('disables the steps above the cap and says why in the list of reasons', () => {
    renderThemed(<EffortSlider value="low" onChange={() => undefined} model={opus} cap="medium" />, { locale: 'en' })
    expect(disabled()).toEqual(['Careful', 'Very careful'])
    const reasons = screen.getAllByText(/A rule you set allows only a lower step/)
    expect(reasons).toHaveLength(2)
    const careful = screen.getByRole('radio', { name: 'Careful' })
    expect(document.getElementById(careful.getAttribute('aria-describedby')!)?.textContent).toBe('Careful: A rule you set allows only a lower step')
  })

  it('says the same in Korean', () => {
    renderThemed(<EffortSlider value="low" onChange={() => undefined} model={opus} cap="medium" />, { locale: 'ko' })
    expect(disabled()).toEqual(['꼼꼼히', '아주 꼼꼼히'])
    expect(screen.getAllByText(new RegExp(ko['chat.effort.reason.rule_cap']))).toHaveLength(2)
  })

  it('does not let a click or the keys reach a step above the cap', () => {
    const onChange = vi.fn()
    renderThemed(<EffortSlider value="medium" onChange={onChange} model={opus} cap="medium" />, { locale: 'en' })
    fireEvent.click(screen.getByRole('radio', { name: 'Careful' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Normal' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Normal' }), { key: 'End' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Normal' }), { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('low')
  })

  it('shows the advanced step disabled when it is open, and below the cap everything stays usable', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} cap="xhigh" expanded />, { locale: 'en' })
    expect(disabled()).toEqual(['Maximum'])
  })

  it('tells the person that a chosen step above the cap runs at the cap', () => {
    renderThemed(<EffortSlider value="xhigh" onChange={() => undefined} model={opus} cap="medium" />, { locale: 'en' })
    expect(screen.getByRole('status').textContent).toBe('A rule you set allows Normal at most, so this request runs at Normal. You can change the rule on the Rules screen.')
    expect(screen.getByRole('radio', { name: 'Very careful' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the model note for a step the model lowers and the rule does not block', () => {
    renderThemed(<EffortSlider value="xhigh" onChange={() => undefined} model={haiku} cap="xhigh" />, { locale: 'en' })
    expect(screen.getByRole('status').textContent).toContain('closest step')
  })

  it('has no tab stop on a step above the cap, so the keyboard lands on the cap', () => {
    renderThemed(<EffortSlider value="xhigh" onChange={() => undefined} model={opus} cap="medium" />, { locale: 'en' })
    expect(radios().map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
  })

  it('looks the same as before without a cap', () => {
    renderThemed(<EffortSlider value="medium" onChange={() => undefined} model={opus} />, { locale: 'en' })
    expect(disabled()).toEqual([])
    expect(screen.queryByText(/A rule you set/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('MetaLine and a plan that a rule lowered', () => {
  const capped = metaOf({ effort: 'medium', effortDetail: { requested: 'xhigh', effective: 'medium', native: 'medium', collapsed: false, cappedByRule: true } })

  it('says that a rule allowed no more, with both steps', () => {
    renderThemed(<MetaLine meta={capped} />, { locale: 'en' })
    expect(screen.getByText('Care: asked for Very careful, used Normal (a rule you set allows no more)')).toBeTruthy()
  })

  it('says it in Korean', () => {
    renderThemed(<MetaLine meta={capped} />, { locale: 'ko' })
    expect(screen.getByText('꼼꼼함: 요청 아주 꼼꼼히, 실제 보통 (직접 정한 규칙의 상한)')).toBeTruthy()
  })

  it('keeps the old lines for a plan that no rule lowered', () => {
    const { unmount } = renderThemed(<MetaLine meta={metaOf()} />, { locale: 'en' })
    expect(screen.getByText('Care: Normal')).toBeTruthy()
    unmount()
    renderThemed(<MetaLine meta={metaOf({ effort: 'high', effortDetail: { requested: 'xhigh', effective: 'high', native: 'high', collapsed: true, cappedByRule: false } })} />, { locale: 'en' })
    expect(screen.getByText('Care: asked for Very careful, used Careful')).toBeTruthy()
  })
})

const port: AttachmentPort = { add: async (file) => ({ id: `att-${file.name}-xxxxxxxx`, mediaType: 'text/plain', name: file.name, bytes: file.size }) }

function show(options: WorldOptions = {}) {
  const world = makeWorld(options)
  let serial = 0
  const view = renderThemed(<ChatPanel client={world.client} port={port} catalog={catalog} newId={() => `plan-${++serial}`} />, { locale: 'en' })
  return { world, ...view }
}

async function ready(): Promise<void> {
  await screen.findByText('Anthropic · Claude Opus 5.5')
}

const cap = (value: PlanEffort): Rule => ({ id: 'cap-1', kind: 'maxPlanEffort', value, createdAt: 1 })

describe('the effort control in the chat', () => {
  it('reads the cap from listRules and disables the steps above it', async () => {
    const { world } = show({ rules: [cap('medium')] })
    await ready()
    await waitFor(() => expect(disabled()).toEqual(['Careful', 'Very careful']))
    expect(world.callsOf('listRules')).toHaveLength(1)
  })

  it('follows a cap that is set or removed on the Rules screen while the chat is open', async () => {
    const { world } = show()
    await ready()
    await waitFor(() => expect(world.callsOf('listRules')).toHaveLength(1))
    expect(disabled()).toEqual([])
    const store = rulesStoreFor(world.client)
    await act(async () => {
      await store.save('maxPlanEffort', 'low')
    })
    expect(disabled()).toEqual(['Normal', 'Careful', 'Very careful'])
    const saved = store.getState().rules[0]!
    await act(async () => {
      await store.remove(saved.id)
    })
    expect(disabled()).toEqual([])
  })

  it('looks as before when the rules cannot be read', async () => {
    show({ intercept: (method) => (method === 'listRules' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Planning care' })).toBeTruthy())
    expect(disabled()).toEqual([])
  })

  it('tells the person that the step in use is above the cap, still sends it, and shows the lowered answer', async () => {
    const { world } = show({ rules: [cap('low')] })
    await ready()
    await waitFor(() => expect(screen.getByText(/runs at Fast/)).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox', { name: 'Your request' }), { target: { value: 'watch a folder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(world.planCalls()).toHaveLength(1))
    expect(world.planCalls()[0]!.effort).toBe('medium')
    await screen.findByText('Care: asked for Normal, used Fast (a rule you set allows no more)')
  })
})

describe('the error of a refused plan or deploy', () => {
  const issue = (pointer: string): string => `rule_violation at ${pointer}`

  it('names the forbidden node when only a node rule is broken', () => {
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', [issue('/nodes/2/type')]))).toBe('chat.error.rule.node')
    expect(planErrorKey(new RillError('INVALID_WORKFLOW', 'x', [issue('/nodes/0/type')]))).toBe('chat.error.rule.node')
  })

  it('names the host when only a host rule is broken', () => {
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', [issue('/nodes/3/config/url')]))).toBe('chat.error.rule.host')
  })

  it('names both when both are broken, also next to another problem', () => {
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', [issue('/nodes/2/type'), 'unknown_ref_node at /nodes/1/config/file', issue('/nodes/3/config/url')]))).toBe('chat.error.rule.both')
  })

  it('names the rules for RULE_VIOLATION and, with no problem it can read, says both', () => {
    expect(planErrorKey(new RillError('RULE_VIOLATION', 'x', [issue('/nodes/2/type')]))).toBe('chat.error.rule.node')
    expect(planErrorKey(new RillError('RULE_VIOLATION', 'x'))).toBe('chat.error.rule.both')
  })

  it('keeps the old text when the problems are not about rules', () => {
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', ['unknown_ref_node at /nodes/1/config/file']))).toBe('chat.error.PLAN_INVALID')
    expect(planErrorKey(new RillError('INVALID_WORKFLOW', 'x', ['cycle at /']))).toBe('chat.error.INVALID_WORKFLOW')
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x'))).toBe('chat.error.PLAN_INVALID')
  })

  it('reads only the pointer shape of the engine and ignores any other text', () => {
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', ['rule_violation at /nodes/2/type extra']))).toBe('chat.error.PLAN_INVALID')
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', ['node n1: the node type http.request is forbidden by the rules']))).toBe('chat.error.PLAN_INVALID')
    expect(planErrorKey(new RillError('PLAN_INVALID', 'x', ['rule_violation at /nodes/2/config/file']))).toBe('chat.error.PLAN_INVALID')
  })

  it('has the three texts in both languages, and every text points at the Rules screen', () => {
    for (const key of ['chat.error.rule.node', 'chat.error.rule.host', 'chat.error.rule.both'] as const) {
      expect(en[key]).toContain('Rules screen')
      expect(ko[key]).toContain('규칙 화면')
    }
  })

  it('shows the plain words in the chat when a plan stays invalid after the repair rounds', async () => {
    const world = makeWorld({ script: () => new RillError('PLAN_INVALID', 'no valid plan after the repair rounds', [issue('/nodes/2/type')]) })
    renderThemed(<ChatPanel client={world.client} port={port} catalog={catalog} newId={() => 'plan-1'} />, { locale: 'en' })
    await screen.findByText('Anthropic · Claude Opus 5.5')
    fireEvent.change(screen.getByRole('textbox', { name: 'Your request' }), { target: { value: 'pause then post' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(en['chat.error.rule.node'])).toBeTruthy()
  })

  it('shows the plain words in the card when the deploy of a plan is refused for a rule, and the plan stays ready', async () => {
    const world = makeWorld({ intercept: (method) => (method === 'deployPlan' ? Promise.reject(new RillError('INVALID_WORKFLOW', 'the workflow is not valid', [issue('/nodes/3/config/url')])) : undefined) })
    renderThemed(<ChatPanel client={world.client} port={port} catalog={catalog} newId={() => 'plan-1'} />, { locale: 'en' })
    await screen.findByText('Anthropic · Claude Opus 5.5')
    fireEvent.change(screen.getByRole('textbox', { name: 'Your request' }), { target: { value: 'post to a host' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    expect(await screen.findByText(en['chat.error.rule.host'])).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
