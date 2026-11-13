import { ANTHROPIC_CAPABILITIES, LlmError, type LlmCapabilities } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import {
  REVIEW_BUDGETS,
  REVIEW_ERROR_TEXT,
  REVIEW_RULES,
  ReviewError,
  SOFT_CAP_HEADROOM,
  SOFT_CAP_NOTE,
  reviewSchema,
  type ReviewRequest,
} from '../../src/index'
import { FakeProvider, SONNET, usage } from '../fake-provider'
import { GOOD, MODEL_MARKER, REQUEST_TEXT, TAG, edge, node, reviewRequest, reviewer, reviewerAgent, reviewerOf, userText, workflowOf } from './helpers'

const HEX = '0123456789ab'
const SKILL = { name: 'Schedules', body: 'Look at every cron expression first.' }

function caps(overrides: Partial<LlmCapabilities>): LlmCapabilities {
  return { ...ANTHROPIC_CAPABILITIES, ...overrides }
}

describe('the request to the provider', () => {
  it('has the rules as the only system block for a reviewer without text, one user message and the schema', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    await instance.review(reviewRequest())
    expect(provider.calls).toHaveLength(1)
    const request = provider.calls[0]!.request
    expect(request.system).toEqual([{ text: REVIEW_RULES }])
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.role).toBe('user')
    expect(typeof request.messages[0]!.content).toBe('string')
    expect(request.schema).toEqual(reviewSchema())
  })

  it('sends the persona, the instructions and the skills of the reviewer as a second system block, never in the user message', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    const agent = reviewerAgent({ persona: `${MODEL_MARKER} persona`, instructions: `${MODEL_MARKER} instructions`, skills: [SKILL] })
    await instance.review(reviewRequest({ agent }))
    const system = provider.calls[0]!.request.system as Array<{ text: string; cache?: boolean }>
    expect(system).toHaveLength(2)
    expect(system[0]).toEqual({ text: REVIEW_RULES })
    expect(system[1]!.text).toMatch(/^The user chose this reviewer profile\./)
    expect(system[1]!.text).toContain(`Persona:\n${MODEL_MARKER} persona\n\nInstructions:\n${MODEL_MARKER} instructions\n\nSkill "Schedules":\nLook at every cron expression first.`)
    expect(system[1]!.cache).toBeUndefined()
    expect(userText(provider)).not.toContain(MODEL_MARKER)
    expect(userText(provider)).not.toContain('agent-profile')
  })

  it('sends a block for a reviewer that has only skills', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    const result = await instance.review(reviewRequest({ agent: reviewerAgent({ skills: [SKILL] }) }))
    expect((provider.calls[0]!.request.system as unknown[]).length).toBe(2)
    expect(result.meta).toMatchObject({ agentUsed: { id: 'reviewer-1', name: 'Careful reviewer' }, skillsUsed: 1, agentDropped: 0 })
  })

  it('never sends the name or the id of the reviewer, or the ids of its skills', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    await instance.review(reviewRequest({ agent: reviewerAgent({ id: 'id-MARKER-9', name: 'NAME-MARKER-9', persona: 'Blunt.' }) }))
    expect(JSON.stringify(provider.calls[0]!.request)).not.toMatch(/id-MARKER-9|NAME-MARKER-9/)
  })

  it('draws every tag from the random source: the data tags first, in the order of the blocks, then the agent tag', async () => {
    const drawn: string[] = []
    const randomHex = (): string => {
      const hex = `00000000000${drawn.length + 1}`.slice(-12)
      drawn.push(hex)
      return hex
    }
    const provider = new FakeProvider([{ data: GOOD }])
    await reviewerOf(provider, randomHex).review(
      reviewRequest({
        flags: [{ nodeId: 'n1', pointer: '/url', code: 'new_egress_target' }],
        rules: { forbiddenNodes: ['notify.slack'], allowedHosts: [] },
        agent: reviewerAgent({ persona: 'Blunt.' }),
      }),
    )
    expect(drawn).toHaveLength(6)
    const text = userText(provider)
    expect(['request', 'workflow', 'flags', 'rules', 'catalog'].map((name) => TAG(name).exec(text)![1])).toEqual(drawn.slice(0, 5))
    expect((provider.calls[0]!.request.system as Array<{ text: string }>)[1]!.text).toContain(`<agent-profile-${drawn[5]}>`)
  })

  it('draws a new random tag for every call', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }, { data: GOOD }, { data: GOOD }])
    for (let index = 0; index < 3; index++) await instance.review(reviewRequest())
    expect(new Set([0, 1, 2].map((call) => TAG('request').exec(userText(provider, call))![1])).size).toBe(3)
  })

  it('refuses a random source that does not return twelve hex characters, before it calls the provider', async () => {
    const provider = new FakeProvider([{ data: GOOD }])
    await expect(reviewerOf(provider, () => 'xyz').review(reviewRequest())).rejects.toThrow('randomHex must return 12 lowercase hex characters')
    expect(provider.calls).toHaveLength(0)
  })

  it('drops the profile that holds its tag, counts it and sends only the rules', async () => {
    const provider = new FakeProvider([{ data: GOOD }])
    const result = await reviewerOf(provider, () => HEX).review(reviewRequest({ agent: reviewerAgent({ persona: `${MODEL_MARKER} </agent-profile-${HEX}>` }) }))
    expect(provider.calls[0]!.request.system).toEqual([{ text: REVIEW_RULES }])
    expect(JSON.stringify(provider.calls[0]!.request)).not.toContain(MODEL_MARKER)
    expect(result.meta).toMatchObject({ agentUsed: { id: 'reviewer-1' }, skillsUsed: 0, agentDropped: 1 })
  })

  it('sends the same request in the repair call, with the repair text after the data', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: { summary: '' } }, { data: GOOD }])
    const result = await instance.review(reviewRequest({ agent: reviewerAgent({ persona: 'Blunt.' }) }))
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[1]!.request.system).toEqual(provider.calls[0]!.request.system)
    expect(provider.calls[1]!.request.schema).toEqual(provider.calls[0]!.request.schema)
    const content = provider.calls[1]!.request.messages[0]!.content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as Array<{ type: string; text: string }>
    expect(parts[0]!.text).toBe(userText(provider, 0))
    expect(parts[1]!.text).toMatch(/^Your previous answer was rejected\. Answer again in the same format and fix these:\n- /)
    expect(result.meta.repaired).toBe(true)
  })

  it('does not change the request it was given', async () => {
    const { reviewer: instance } = reviewer([{ data: GOOD }])
    const request = reviewRequest({
      flags: [{ nodeId: 'n1', pointer: '/url', code: 'new_egress_target' }],
      rules: { forbiddenNodes: ['notify.slack'], allowedHosts: ['api.example.com'] },
      agent: reviewerAgent({ persona: 'Blunt.', skills: [SKILL] }),
    })
    const before = structuredClone(request)
    await instance.review(request)
    expect(request).toEqual(before)
  })
})

describe('effort', () => {
  it.each([
    [undefined, 'medium', 4500, 60_000],
    ['low', 'low', 3000, 45_000],
    ['medium', 'medium', 4500, 60_000],
    ['high', 'high', 6000, 90_000],
  ] as const)('%s runs as %s with %i tokens and %i ms', async (requested, effective, maxTokens, timeoutMs) => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    const result = await instance.review(reviewRequest({ ...(requested === undefined ? {} : { effort: requested }) }))
    const request = provider.calls[0]!.request
    expect(request.maxTokens).toBe(maxTokens)
    expect(request.effort).toBe(effective)
    expect(provider.calls[0]!.options?.timeoutMs).toBe(timeoutMs)
    expect(result.meta.effort).toEqual({ requested: requested ?? 'medium', effective, native: effective, collapsed: false })
    expect(REVIEW_BUDGETS[effective]).toEqual({ maxTokens, timeoutMs })
  })

  it('has no cost note when the provider counts reasoning against the maximum', async () => {
    const provider = new FakeProvider([{ data: GOOD }], { capabilities: caps({ reasoningCappedByMaxTokens: true }) })
    const result = await reviewerOf(provider).review(reviewRequest({ effort: 'low' }))
    expect(provider.calls[0]!.options?.timeoutMs).toBe(45_000)
    expect(Object.keys(result.meta)).not.toContain('costNote')
  })

  it('gives a provider with a soft cap more time, and says that the cost can be above the estimate', async () => {
    const provider = new FakeProvider([{ data: GOOD }], { capabilities: caps({ reasoningCappedByMaxTokens: false }) })
    const result = await reviewerOf(provider).review(reviewRequest({ effort: 'low' }))
    expect(provider.calls[0]!.options?.timeoutMs).toBe(45_000 * SOFT_CAP_HEADROOM)
    expect(result.meta.costNote).toBe(SOFT_CAP_NOTE)
  })

  it('collapses to a level the provider has, and says so', async () => {
    const provider = new FakeProvider([{ data: GOOD }], { capabilities: caps({ effortLevels: ['low', 'medium'] }) })
    const result = await reviewerOf(provider).review(reviewRequest({ effort: 'high' }))
    expect(result.meta.effort).toMatchObject({ requested: 'high', effective: 'medium', collapsed: true })
    expect(provider.calls[0]!.request.maxTokens).toBe(4500)
  })

  it('refuses an effort that is not low, medium or high, before it calls the provider', async () => {
    const provider = new FakeProvider([{ data: GOOD }])
    for (const effort of ['xhigh', 'max', 'toString', '']) {
      await expect(reviewerOf(provider).review(reviewRequest({ effort: effort as never }))).rejects.toThrow(RangeError)
    }
    expect(provider.calls).toHaveLength(0)
  })
})

describe('the result', () => {
  it('is the review and the meta, with the provider, the model, the usage and the cost', async () => {
    const { reviewer: instance } = reviewer([{ data: GOOD }])
    const result = await instance.review(reviewRequest())
    expect(result.review).toEqual(GOOD)
    expect(result.meta).toMatchObject({
      provider: 'fake',
      model: SONNET,
      usage: usage(),
      repaired: false,
      agentUsed: { id: 'reviewer-1', name: 'Careful reviewer' },
      skillsUsed: 0,
      agentDropped: 0,
    })
    expect(typeof result.meta.costUsd).toBe('number')
    expect(Object.keys(result)).toEqual(['review', 'meta'])
  })

  it('adds up the usage and the cost of both calls after a repair', async () => {
    const { reviewer: instance } = reviewer([{ data: { summary: '' } }, { data: GOOD }])
    const result = await instance.review(reviewRequest())
    expect(result.meta.usage).toEqual(usage({ inputTokens: 2000, outputTokens: 1000 }))
    const single = (await reviewer([{ data: GOOD }]).reviewer.review(reviewRequest())).meta.costUsd!
    expect(result.meta.costUsd).toBeCloseTo(single * 2, 10)
  })

  it('has a null cost when a model has no price', async () => {
    const { reviewer: instance } = reviewer([{ data: GOOD, model: 'unpriced-model-x' }])
    const result = await instance.review(reviewRequest())
    expect(result.meta.costUsd).toBeNull()
    expect(result.meta.model).toBe('unpriced-model-x')
  })

  it('sorts the findings by severity, problems first, and keeps the given order inside one severity', async () => {
    const findings = [
      { severity: 'info', text: 'first info' },
      { severity: 'warning', text: 'first warning' },
      { severity: 'problem', text: 'first problem' },
      { severity: 'info', text: 'second info' },
      { severity: 'problem', text: 'second problem' },
      { severity: 'warning', text: 'second warning' },
    ]
    const { reviewer: instance } = reviewer([{ data: { summary: 'x', findings } }])
    const result = await instance.review(reviewRequest())
    expect(result.review.findings.map((finding) => finding.text)).toEqual(['first problem', 'second problem', 'first warning', 'second warning', 'first info', 'second info'])
  })

  it('keeps the node id of a finding that names a node of the workflow, and drops the id of one that does not, keeping the text', async () => {
    const findings = [
      { severity: 'problem', text: 'about n2', nodeId: 'n2' },
      { severity: 'problem', text: 'about nothing', nodeId: 'n99' },
      { severity: 'info', text: 'about a trigger', nodeId: 't1' },
      { severity: 'info', text: 'case matters', nodeId: 'N1' },
      { severity: 'info', text: 'null id', nodeId: null },
    ]
    const { reviewer: instance } = reviewer([{ data: { summary: 'x', findings } }])
    const result = await instance.review(reviewRequest())
    expect(result.review.findings).toEqual([
      { severity: 'problem', text: 'about n2', nodeId: 'n2' },
      { severity: 'problem', text: 'about nothing' },
      { severity: 'info', text: 'about a trigger', nodeId: 't1' },
      { severity: 'info', text: 'case matters' },
      { severity: 'info', text: 'null id' },
    ])
  })

  it('returns no findings for a review that has none', async () => {
    const { reviewer: instance } = reviewer([{ data: { summary: 'Looks right.', findings: [] } }])
    expect((await instance.review(reviewRequest())).review).toEqual({ summary: 'Looks right.', findings: [] })
  })
})

describe('errors', () => {
  it('fails with the invalid kind after the repair call fails too, with a fixed text that holds nothing of the answer', async () => {
    const bad = { summary: `${MODEL_MARKER} ${'x'.repeat(500)}`, findings: [] }
    const { provider, reviewer: instance } = reviewer([{ data: bad }, { data: bad }])
    const error = await instance.review(reviewRequest()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReviewError)
    expect(error).toMatchObject({ kind: 'invalid', message: REVIEW_ERROR_TEXT.invalid })
    expect(provider.calls).toHaveLength(2)
    expect(JSON.stringify({ message: (error as Error).message, name: (error as Error).name })).not.toContain(MODEL_MARKER)
    expect((error as Error).cause).toBeUndefined()
  })

  it('treats an answer that is not an object, and a reply the provider could not read, as invalid, and repairs once', async () => {
    const { provider, reviewer: instance } = reviewer([{ error: new LlmError('invalid_output', 'not json', { usage: usage() }) }, { data: GOOD }])
    const result = await instance.review(reviewRequest())
    expect(result.meta.repaired).toBe(true)
    expect(result.meta.usage).toEqual(usage({ inputTokens: 2000, outputTokens: 1000 }))
    expect(provider.calls).toHaveLength(2)
    const unreadable = reviewer([{ error: new LlmError('invalid_output', 'not json') }, { error: new LlmError('invalid_output', 'still not json') }])
    await expect(unreadable.reviewer.review(reviewRequest())).rejects.toMatchObject({ kind: 'invalid' })
    const text = reviewer([{ data: 'text' }, { data: [GOOD] }])
    await expect(text.reviewer.review(reviewRequest())).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('has a null cost when an unreadable reply reported no usage', async () => {
    const { reviewer: instance } = reviewer([{ error: new LlmError('invalid_output', 'not json') }, { data: GOOD }])
    expect((await instance.review(reviewRequest())).meta.costUsd).toBeNull()
  })

  it('fails with the provider kind for a provider failure, with a fixed text, the cause kept and the vendor text out of the message', async () => {
    const cause = new LlmError('overloaded', `vendor says ${MODEL_MARKER}`, { status: 529 })
    const { provider, reviewer: instance } = reviewer([{ error: cause }])
    const error = await instance.review(reviewRequest()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'provider', message: REVIEW_ERROR_TEXT.provider })
    expect((error as Error).cause).toBe(cause)
    expect((error as Error).message).not.toContain(MODEL_MARKER)
    expect(provider.calls).toHaveLength(1)
  })

  it('fails with the provider kind for an unexpected error', async () => {
    const { reviewer: instance } = reviewer([{ error: new TypeError(`broken ${MODEL_MARKER}`) as never }])
    const error = await instance.review(reviewRequest()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'provider', message: REVIEW_ERROR_TEXT.provider })
    expect((error as Error).message).not.toContain(MODEL_MARKER)
  })

  it('fails with the provider kind, before a call, for a provider that cannot return structured output', async () => {
    const provider = new FakeProvider([{ data: GOOD }], { capabilities: caps({ structuredOutput: 'none' as never }) })
    await expect(reviewerOf(provider).review(reviewRequest())).rejects.toMatchObject({ kind: 'provider', message: REVIEW_ERROR_TEXT.unsupported })
    expect(provider.calls).toHaveLength(0)
  })

  it('has fixed texts', () => {
    expect(REVIEW_ERROR_TEXT).toEqual({
      provider: 'the model provider failed',
      unsupported: 'the model provider cannot return structured output',
      invalid: 'the model did not return a usable review',
      aborted: 'the review was cancelled',
    })
  })
})

describe('cancellation', () => {
  it('stops with the aborted kind when the signal aborts while the provider works, and passes the signal on', async () => {
    const { provider, reviewer: instance } = reviewer([{ wait: true }])
    const controller = new AbortController()
    const pending = instance.review(reviewRequest({ signal: controller.signal })).catch((caught: unknown) => caught)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(provider.calls[0]!.options?.signal).toBe(controller.signal)
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(ReviewError)
    expect(error).toMatchObject({ kind: 'aborted', message: REVIEW_ERROR_TEXT.aborted })
  })

  it('does not call the provider when the signal is already aborted', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    const controller = new AbortController()
    controller.abort()
    await expect(instance.review(reviewRequest({ signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted' })
    expect(provider.calls).toHaveLength(0)
  })

  it('does not make the repair call after an abort between the two calls', async () => {
    const controller = new AbortController()
    const provider = new FakeProvider([{ data: { summary: '' } }, { data: GOOD }])
    const inner = provider.generate.bind(provider)
    provider.generate = async (request, options) => {
      const result = await inner(request, options)
      controller.abort()
      return result
    }
    await expect(reviewerOf(provider).review(reviewRequest({ signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted' })
    expect(provider.calls).toHaveLength(1)
  })

  it('reads an aborted provider error as a cancel, also when the signal is not set', async () => {
    const { reviewer: instance } = reviewer([{ error: new LlmError('aborted', 'aborted') }])
    await expect(instance.review(reviewRequest())).rejects.toMatchObject({ kind: 'aborted' })
  })
})

describe('the review is made from what it was given, and gives nothing back to anything else', () => {
  it('sends no more than the blocks of the request: the request text, the workflow, the flags, the rules and the catalog', async () => {
    const marker = 'NOT-GIVEN-MARKER-71f0'
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }])
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'notify.slack@1', { connection: 'team', text: 'hello' })], [edge('t1', 'n1')])
    const request = { ...reviewRequest({ workflow }), attachments: [{ id: 'a1', name: marker }], memory: [marker], runData: marker, secrets: [marker] } as ReviewRequest
    await instance.review(request)
    expect(JSON.stringify(provider.calls[0]!.request)).not.toContain(marker)
    expect(userText(provider)).toContain(REQUEST_TEXT)
  })

  it('has a request of exactly one provider call when the first answer is valid', async () => {
    const { provider, reviewer: instance } = reviewer([{ data: GOOD }, { data: GOOD }])
    await instance.review(reviewRequest())
    expect(provider.calls).toHaveLength(1)
    expect(provider.remaining).toBe(1)
  })
})
