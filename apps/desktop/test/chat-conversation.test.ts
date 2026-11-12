// @vitest-environment node
import { flagKey, METHODS, type AttachmentRef, type Flag, type PlanMeta, type PlanResultBody } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import {
  MAX_TURNS,
  canDeploy,
  canSubmit,
  conversationReducer,
  initialConversation,
  memoryInUse,
  planParams,
  type ConversationAction,
  type ConversationEntry,
  type ConversationState,
} from '../src/chat/model/conversation'
import { workflows } from '../src/fixtures'

const META: PlanMeta = {
  rounds: [],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: null,
  model: 'm',
  effort: 'medium',
  fallbackUsed: false,
}
const ref = (id: string): AttachmentRef => ({ id: `att-${id}-12345678`, mediaType: 'text/plain', name: `${id}.txt`, bytes: 10 })
const flag = (nodeId: string, code: Flag['code'] = 'new_egress_target'): Flag => ({ nodeId, pointer: `/nodes/${nodeId}/config/url`, code, message: 'm' })
const workflowResult = (flags: Flag[] = [], needsConfirmation = flags.length > 0): PlanResultBody => ({
  kind: 'workflow',
  workflow: workflows.receipt,
  summary: 'done',
  flags,
  needsConfirmation,
})
const questionResult: PlanResultBody = { kind: 'questions', summary: 'q', questions: [{ id: 'a', text: 'A?', options: ['x', 'y'], default: 'x' }] }
const assistant = (planId: string, result: PlanResultBody, deployed?: string): Extract<ConversationEntry, { role: 'assistant' }> => ({
  role: 'assistant',
  planId,
  result,
  meta: META,
  ...(deployed === undefined ? {} : { deployed }),
})

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

function run(actions: ConversationAction[], from: ConversationState = initialConversation()): ConversationState {
  return actions.reduce((state, action) => conversationReducer(deepFreeze(state), action), from)
}

describe('initialConversation', () => {
  it('starts idle, empty, on medium effort with memory on', () => {
    expect(initialConversation()).toEqual({ entries: [], status: 'idle', draft: '', attachments: [], effort: 'medium', useMemory: true, confirmed: {} })
  })
})

describe('conversationReducer', () => {
  it('edits the draft, the effort and the memory switch', () => {
    const state = run([{ type: 'draft', text: 'hello' }, { type: 'effort', effort: 'high' }, { type: 'useMemory', value: false }])
    expect(state).toMatchObject({ draft: 'hello', effort: 'high', useMemory: false })
  })

  it('adds an attachment once, and removes it by id', () => {
    const added = run([{ type: 'attach', ref: ref('a') }, { type: 'attach', ref: ref('a') }, { type: 'attach', ref: ref('b') }])
    expect(added.attachments.map((item) => item.name)).toEqual(['a.txt', 'b.txt'])
    expect(run([{ type: 'detach', id: ref('a').id }], added).attachments.map((item) => item.name)).toEqual(['b.txt'])
    expect(run([{ type: 'detach', id: 'missing' }], added).attachments).toHaveLength(2)
  })

  it('never keeps more than five attachments', () => {
    const state = run(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ type: 'attach', ref: ref(id) }) as const))
    expect(state.attachments).toHaveLength(5)
  })

  it('submits a message: appends the user entry with the attachments, goes to planning and clears the draft', () => {
    const state = run([{ type: 'draft', text: 'watch a folder' }, { type: 'attach', ref: ref('a') }, { type: 'submit', text: 'watch a folder' }])
    expect(state.status).toBe('planning')
    expect(state.draft).toBe('')
    expect(state.attachments).toEqual([])
    expect(state.entries).toEqual([{ role: 'user', text: 'watch a folder', attachments: [ref('a')] }])
    expect(state.error).toBeUndefined()
  })

  it('submits answers: a user entry with empty text and the answers, and leaves the composer alone', () => {
    const base = run([{ type: 'submit', text: 'q' }, { type: 'planned', planId: 'p1', result: questionResult, meta: META }, { type: 'draft', text: 'half typed' }, { type: 'attach', ref: ref('a') }])
    const state = run([{ type: 'submit', text: '', answers: { a: 'y' } }], base)
    expect(state.entries.at(-1)).toEqual({ role: 'user', text: '', attachments: [], answers: { a: 'y' } })
    expect(state.draft).toBe('half typed')
    expect(state.attachments).toHaveLength(1)
  })

  it('records the plan result as an assistant entry and goes idle', () => {
    const state = run([{ type: 'submit', text: 'x' }, { type: 'planned', planId: 'p1', result: workflowResult(), meta: META }])
    expect(state.status).toBe('idle')
    expect(state.entries.at(-1)).toEqual({ role: 'assistant', planId: 'p1', result: workflowResult(), meta: META })
    expect(state.confirmed).toEqual({ p1: [] })
  })

  it('keeps the draft and the attachments when a request fails, and removes the entry that never got an answer', () => {
    const state = run([
      { type: 'draft', text: 'my request' },
      { type: 'attach', ref: ref('a') },
      { type: 'submit', text: 'my request' },
      { type: 'failed', error: 'chat.error.PLAN_PROVIDER' },
    ])
    expect(state.status).toBe('error')
    expect(state.error).toBe('chat.error.PLAN_PROVIDER')
    expect(state.draft).toBe('my request')
    expect(state.attachments).toEqual([ref('a')])
    expect(state.entries).toEqual([])
  })

  it('keeps the earlier draft of the composer when a failed request was an answer submission', () => {
    const base = run([{ type: 'submit', text: 'q' }, { type: 'planned', planId: 'p1', result: questionResult, meta: META }, { type: 'draft', text: 'typed' }])
    const state = run([{ type: 'submit', text: '', answers: { a: 'x' } }, { type: 'failed', error: 'chat.error.INTERNAL' }], base)
    expect(state.entries).toHaveLength(2)
    expect(state.draft).toBe('typed')
  })

  it('ignores a plan result or a failure that arrives when nothing is being planned', () => {
    const idle = initialConversation()
    expect(run([{ type: 'planned', planId: 'p', result: workflowResult(), meta: META }], idle)).toEqual(idle)
    expect(run([{ type: 'failed', error: 'chat.error.INTERNAL' }], idle)).toEqual(idle)
  })

  it('clears the error notice', () => {
    const state = run([{ type: 'submit', text: 'x' }, { type: 'failed', error: 'chat.error.INTERNAL' }, { type: 'clearError' }])
    expect(state.status).toBe('idle')
    expect(state.error).toBeUndefined()
  })

  it('toggles a flag confirmation on and off and never confirms the same key twice', () => {
    const base = run([{ type: 'submit', text: 'x' }, { type: 'planned', planId: 'p1', result: workflowResult([flag('n1')]), meta: META }])
    const on = run([{ type: 'toggleFlag', planId: 'p1', key: 'k1' }, { type: 'toggleFlag', planId: 'p1', key: 'k2' }], base)
    expect(on.confirmed.p1).toEqual(['k1', 'k2'])
    expect(run([{ type: 'toggleFlag', planId: 'p1', key: 'k1' }], on).confirmed.p1).toEqual(['k2'])
  })

  it('marks an entry as deployed with the workflow id', () => {
    const base = run([{ type: 'submit', text: 'x' }, { type: 'planned', planId: 'p1', result: workflowResult(), meta: META }])
    const state = run([{ type: 'deployed', planId: 'p1', workflowId: 'wf-9' }], base)
    expect(state.entries.at(-1)).toMatchObject({ role: 'assistant', deployed: 'wf-9' })
    expect(run([{ type: 'deployed', planId: 'nope', workflowId: 'wf-9' }], base)).toEqual(base)
  })

  it('starts a new chat: everything resets except the effort and the memory choice', () => {
    const busy = run([
      { type: 'effort', effort: 'xhigh' },
      { type: 'useMemory', value: false },
      { type: 'draft', text: 'abc' },
      { type: 'attach', ref: ref('a') },
      { type: 'submit', text: 'x' },
      { type: 'planned', planId: 'p1', result: workflowResult([flag('n1')]), meta: META },
      { type: 'toggleFlag', planId: 'p1', key: 'k' },
    ])
    expect(run([{ type: 'newChat' }], busy)).toEqual({ ...initialConversation(), effort: 'xhigh', useMemory: false })
  })

  it('refuses a submit that would pass the turn limit and says so through the error', () => {
    const entries: ConversationEntry[] = []
    for (let i = 0; i < MAX_TURNS / 2 + 1; i++) entries.push({ role: 'user', text: `u${i}`, attachments: [] }, assistant(`p${i}`, workflowResult()))
    const full: ConversationState = { ...initialConversation(), entries }
    expect(canSubmit(full.entries, 'message')).toBe(false)
    const refused = run([{ type: 'submit', text: 'one more' }], full)
    expect(refused.entries).toBe(full.entries)
    expect(refused.status).toBe('error')
    expect(refused.error).toBe('chat.error.turnLimit')
  })

  it('allows a message up to forty turns and answers up to thirty-nine', () => {
    const make = (count: number): ConversationEntry[] => Array.from({ length: count }, (_, i) => (i % 2 === 0 ? { role: 'user', text: 'u', attachments: [] } : assistant(`p${i}`, questionResult)))
    expect(canSubmit(make(40), 'message')).toBe(true)
    expect(canSubmit(make(42), 'message')).toBe(false)
    expect(canSubmit(make(38), 'answers')).toBe(true)
    expect(canSubmit(make(40), 'answers')).toBe(false)
  })

  it('does not mutate its input', () => {
    const state = deepFreeze(initialConversation())
    expect(() => conversationReducer(state, { type: 'draft', text: 'x' })).not.toThrow()
    expect(() => conversationReducer(state, { type: 'submit', text: 'x' })).not.toThrow()
  })

  it('returns the same state object for an action that changes nothing', () => {
    const state = initialConversation()
    expect(conversationReducer(state, { type: 'draft', text: '' })).toBe(state)
    expect(conversationReducer(state, { type: 'detach', id: 'x' })).toBe(state)
  })
})

describe('canDeploy', () => {
  it('needs a workflow result that has not been deployed', () => {
    expect(canDeploy(assistant('p', workflowResult()), [])).toBe(true)
    expect(canDeploy(assistant('p', questionResult), [])).toBe(false)
    expect(canDeploy(assistant('p', { kind: 'unsupported', reason: 'r', nearest: 'n', summary: 's' }), [])).toBe(false)
    expect(canDeploy(assistant('p', workflowResult(), 'wf-1'), [])).toBe(false)
  })

  it('needs every flag key confirmed, compared as a set', () => {
    const flags = [flag('n1'), flag('n2', 'untrusted_flow'), flag('n3', 'attachment_origin')]
    const entry = assistant('p', workflowResult(flags))
    const keys = flags.map(flagKey)
    expect(canDeploy(entry, [])).toBe(false)
    expect(canDeploy(entry, keys.slice(0, 2))).toBe(false)
    expect(canDeploy(entry, [...keys].reverse())).toBe(true)
    expect(canDeploy(entry, [...keys, ...keys])).toBe(true)
  })

  it('refuses a confirmed key that is not a flag of the plan, because the engine would', () => {
    const entry = assistant('p', workflowResult([flag('n1')]))
    expect(canDeploy(entry, [flagKey(flag('n1')), 'stray'])).toBe(false)
  })

  it('tells two flags of the same node and code apart by pointer', () => {
    const a: Flag = { nodeId: 'n1', pointer: '/a', code: 'new_egress_target', message: 'm' }
    const b: Flag = { nodeId: 'n1', pointer: '/b', code: 'new_egress_target', message: 'm' }
    const entry = assistant('p', workflowResult([a, b]))
    expect(canDeploy(entry, [flagKey(a)])).toBe(false)
    expect(canDeploy(entry, [flagKey(a), flagKey(b)])).toBe(true)
  })

  it('does not trust needsConfirmation alone when flags exist', () => {
    expect(canDeploy(assistant('p', workflowResult([flag('n1')], false)), [])).toBe(false)
  })
})

describe('memoryInUse', () => {
  it('is true only when the switch is on and the engine reported at least one note', () => {
    expect(memoryInUse(true, 3)).toBe(true)
    expect(memoryInUse(true, 1)).toBe(true)
    expect(memoryInUse(true, 0)).toBe(false)
    expect(memoryInUse(true, undefined)).toBe(false)
    expect(memoryInUse(false, 3)).toBe(false)
    expect(memoryInUse(false, undefined)).toBe(false)
  })
})

describe('planParams', () => {
  const base = (): ConversationState => run([{ type: 'draft', text: 'hello' }, { type: 'attach', ref: ref('a') }])

  it('is a closed object: only fields that plan accepts, and it passes the real schema', () => {
    const params = planParams(base(), { planId: 'p1', text: 'hello' })
    expect(Value.Check(METHODS.plan.params, params)).toBe(true)
    expect(Object.keys(params).sort()).toEqual(['attachments', 'effort', 'planId', 'text', 'turns', 'useMemory'])
  })

  it('carries the effort, the memory choice and the current attachments', () => {
    const state = run([{ type: 'effort', effort: 'xhigh' }, { type: 'useMemory', value: false }], base())
    expect(planParams(state, { planId: 'p1', text: 'hello' })).toMatchObject({ effort: 'xhigh', useMemory: false, attachments: [ref('a')] })
    expect(planParams(base(), { planId: 'p1', text: 'hello' }).useMemory).toBe(true)
  })

  it('sends workflowId and selection only when an edit context is given', () => {
    expect(planParams(base(), { planId: 'p', text: 't' })).not.toHaveProperty('workflowId')
    expect(planParams(base(), { planId: 'p', text: 't' })).not.toHaveProperty('selection')
    const withWorkflow = planParams(base(), { planId: 'p', text: 't', editContext: { workflowId: 'wf-1' } })
    expect(withWorkflow.workflowId).toBe('wf-1')
    expect(withWorkflow).not.toHaveProperty('selection')
    const withNode = planParams(base(), { planId: 'p', text: 't', editContext: { workflowId: 'wf-1', nodeId: 'n2' } })
    expect(withNode).toMatchObject({ workflowId: 'wf-1', selection: { nodeId: 'n2' } })
    expect(Value.Check(METHODS.plan.params, withNode)).toBe(true)
  })

  it('builds the turns from the earlier entries, not from the message being sent', () => {
    const state = run([{ type: 'submit', text: 'first' }, { type: 'planned', planId: 'p1', result: questionResult, meta: META }])
    const params = planParams(state, { planId: 'p2', text: 'second' })
    expect(params.turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(params.text).toBe('second')
  })

  it('puts answers into a user turn of their own, with no attachments on the request', () => {
    const state = run([{ type: 'submit', text: 'first' }, { type: 'planned', planId: 'p1', result: questionResult, meta: META }, { type: 'attach', ref: ref('a') }])
    const params = planParams(state, { planId: 'p2', text: 'go on', answers: { a: 'y' } })
    expect(params.turns.at(-1)).toEqual({ role: 'user', text: '', answers: { a: 'y' } })
    expect(params.attachments).toEqual([])
    expect(Value.Check(METHODS.plan.params, params)).toBe(true)
  })

  it('never sends more than five attachments', () => {
    const many: ConversationState = { ...initialConversation(), attachments: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(ref) }
    expect(planParams(many, { planId: 'p', text: 't' }).attachments).toHaveLength(5)
  })
})
