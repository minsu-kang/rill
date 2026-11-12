// @vitest-environment node
import { flagKey, METHODS, RillError, type MemoryItem, type MethodParams } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import { withPlanMethods, type FakePlanData, type PlanOutcome } from '../src/engine/fake-plan'
import { createFakeClient } from '../src/engine/fake-client'
import { catalog, fakeData } from '../src/fixtures'
import { attachmentRefs, memoryFixtures, metas, models, results } from '../src/fixtures/plan'

const outcome = (result = results.workflow): PlanOutcome => ({ result, meta: metas.plain })

function setup(overrides: Partial<FakePlanData> = {}) {
  const calls: Array<MethodParams<'plan'>> = []
  const data: FakePlanData = {
    models,
    script: (params) => {
      calls.push(params)
      return outcome()
    },
    memory: [],
    ...overrides,
  }
  return { client: withPlanMethods(createFakeClient(fakeData), data), calls }
}

const params = (extra: Partial<MethodParams<'plan'>> = {}): MethodParams<'plan'> => ({
  planId: 'plan-1',
  text: 'watch a folder',
  turns: [],
  attachments: [],
  effort: 'medium',
  ...extra,
})

async function rejection(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('withPlanMethods: results follow the protocol', () => {
  it('answers every handled method with data that passes the result schema', async () => {
    const { client } = setup({ memory: [...memoryFixtures.three] })
    const planned = await client.request('plan', params())
    expect(Value.Check(METHODS.plan.result, planned)).toBe(true)
    expect(Value.Check(METHODS.cancelPlan.result, await client.request('cancelPlan', { planId: 'nope' }))).toBe(true)
    expect(Value.Check(METHODS.llmModels.result, await client.request('llmModels', {}))).toBe(true)
    expect(Value.Check(METHODS.listMemory.result, await client.request('listMemory', {}))).toBe(true)
    expect(Value.Check(METHODS.saveMemory.result, await client.request('saveMemory', { text: 'a note' }))).toBe(true)
    expect(Value.Check(METHODS.deleteMemory.result, await client.request('deleteMemory', { id: 'x' }))).toBe(true)
    expect(Value.Check(METHODS.deployPlan.result, await client.request('deployPlan', { planId: 'plan-1', confirmed: [] }))).toBe(true)
  })

  it('hands every other method to the client it wraps', async () => {
    const { client } = setup()
    const listed = await client.request('nodeCatalog', {})
    expect(listed.nodes).toHaveLength(catalog.length)
    expect((await client.request('listWorkflows', {})).workflows.length).toBeGreaterThan(0)
    expect(client.onEvent(() => undefined)).toBeTypeOf('function')
  })

  it('returns copies, so a caller cannot change what the fake serves', async () => {
    const { client } = setup({ memory: [...memoryFixtures.three] })
    const first = await client.request('listMemory', {})
    first.items[0]!.text = 'changed'
    expect((await client.request('listMemory', {})).items[0]!.text).not.toBe('changed')
    const modelsA = await client.request('llmModels', {})
    modelsA.models.length = 0
    expect((await client.request('llmModels', {})).models.length).toBeGreaterThan(0)
  })
})

describe('plan', () => {
  it('rejects what the real schema rejects', async () => {
    const { client } = setup()
    const bad: Array<[string, unknown]> = [
      ['unknown field', { ...params(), extra: 1 }],
      ['six attachments', params({ attachments: Array.from({ length: 6 }, () => attachmentRefs.text) })],
      ['empty text', params({ text: '' })],
      ['text over 8000', params({ text: 'x'.repeat(8001) })],
      ['41 turns', params({ turns: Array.from({ length: 41 }, () => ({ role: 'user' as const, text: 'x' })) })],
      ['bad effort', { ...params(), effort: 'turbo' }],
      ['no plan id', { ...params(), planId: '' }],
    ]
    for (const [name, value] of bad) {
      const error = await rejection(client.request('plan', value as MethodParams<'plan'>))
      expect(error.code, name).toBe('INVALID_PARAMS')
    }
  })

  it('accepts xhigh, 5 attachments, 40 turns and 8000 characters', async () => {
    const { client } = setup()
    await client.request('plan', params({ planId: 'a', effort: 'xhigh' }))
    await client.request('plan', params({ planId: 'b', attachments: Array.from({ length: 5 }, () => attachmentRefs.text) }))
    await client.request('plan', params({ planId: 'c', turns: Array.from({ length: 40 }, () => ({ role: 'user' as const, text: 'x' })) }))
    await client.request('plan', params({ planId: 'd', text: 'x'.repeat(8000) }))
  })

  it('does not call the script for a request the schema rejects', async () => {
    const { client, calls } = setup()
    await rejection(client.request('plan', params({ text: '' })))
    expect(calls).toHaveLength(0)
  })

  it('answers with the plan id, the result and the meta from the script', async () => {
    const { client, calls } = setup()
    const answer = await client.request('plan', params({ planId: 'p9' }))
    expect(answer).toEqual({ planId: 'p9', result: results.workflow, meta: metas.plain })
    expect(calls[0]!.planId).toBe('p9')
  })

  it('gives the script a copy of the parameters', async () => {
    const { client, calls } = setup({
      script: (given) => {
        given.text = 'mutated'
        return outcome()
      },
    })
    const sent = params()
    await client.request('plan', sent)
    expect(sent.text).toBe('watch a folder')
    expect(calls).toHaveLength(0)
  })

  it('fails with the error of the script', async () => {
    const { client } = setup({ script: () => new RillError('PLAN_PROVIDER', 'the model provider failed') })
    expect((await rejection(client.request('plan', params()))).code).toBe('PLAN_PROVIDER')
  })

  it('refuses a second plan with the same id, also while the first one hangs', async () => {
    const { client } = setup()
    await client.request('plan', params({ planId: 'same' }))
    expect((await rejection(client.request('plan', params({ planId: 'same' })))).code).toBe('PLAN_EXISTS')
    const hanging = setup({ script: () => 'hang' })
    const first = hanging.client.request('plan', params({ planId: 'h' }))
    first.catch(() => undefined)
    expect((await rejection(hanging.client.request('plan', params({ planId: 'h' })))).code).toBe('PLAN_EXISTS')
    await hanging.client.request('cancelPlan', { planId: 'h' })
  })

  it('does not remember the id of a plan that failed', async () => {
    let first = true
    const { client } = setup({
      script: () => {
        if (first) {
          first = false
          return new RillError('PLAN_PROVIDER', 'x')
        }
        return outcome()
      },
    })
    await rejection(client.request('plan', params({ planId: 'again' })))
    await expect(client.request('plan', params({ planId: 'again' }))).resolves.toBeDefined()
  })

  it('says PLAN_BUSY when two plans are already running', async () => {
    const { client } = setup({ script: () => 'hang' })
    const pending = ['a', 'b'].map((id) => {
      const promise = client.request('plan', params({ planId: id }))
      promise.catch(() => undefined)
      return promise
    })
    expect((await rejection(client.request('plan', params({ planId: 'c' })))).code).toBe('PLAN_BUSY')
    expect([...client.pendingPlans()].sort()).toEqual(['a', 'b'])
    for (const id of ['a', 'b']) await client.request('cancelPlan', { planId: id })
    await Promise.allSettled(pending)
  })

  it('waits for the delay when the data has one, and a cancel during it wins', async () => {
    vi.useFakeTimers()
    try {
      const { client } = setup({ delayMs: 500 })
      const done = client.request('plan', params({ planId: 'slow' }))
      expect(client.pendingPlans()).toEqual(['slow'])
      await vi.advanceTimersByTimeAsync(499)
      expect(client.pendingPlans()).toEqual(['slow'])
      await vi.advanceTimersByTimeAsync(2)
      await expect(done).resolves.toMatchObject({ planId: 'slow' })
      expect(client.pendingPlans()).toEqual([])
      const second = client.request('plan', params({ planId: 'slow2' }))
      second.catch(() => undefined)
      await client.request('cancelPlan', { planId: 'slow2' })
      await vi.advanceTimersByTimeAsync(1000)
      expect((await rejection(second)).code).toBe('PLAN_CANCELLED')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cancelPlan', () => {
  it('makes a hanging plan fail with PLAN_CANCELLED and says it cancelled one', async () => {
    const { client } = setup({ script: () => 'hang' })
    const running = client.request('plan', params({ planId: 'h1' }))
    running.catch(() => undefined)
    expect(client.pendingPlans()).toEqual(['h1'])
    expect(await client.request('cancelPlan', { planId: 'h1' })).toEqual({ cancelled: true })
    expect((await rejection(running)).code).toBe('PLAN_CANCELLED')
    expect(client.pendingPlans()).toEqual([])
  })

  it('says false for a plan that is not running', async () => {
    const { client } = setup()
    expect(await client.request('cancelPlan', { planId: 'unknown' })).toEqual({ cancelled: false })
    await client.request('plan', params({ planId: 'done' }))
    expect(await client.request('cancelPlan', { planId: 'done' })).toEqual({ cancelled: false })
  })

  it('rejects parameters the schema rejects', async () => {
    const { client } = setup()
    expect((await rejection(client.request('cancelPlan', {} as never))).code).toBe('INVALID_PARAMS')
  })
})

describe('deployPlan', () => {
  const flagged = (): FakePlanData['script'] => () => outcome(results.flagged)

  it('refuses until the confirmed keys equal the flag keys of the plan, then returns a workflow id', async () => {
    const { client } = setup({ script: flagged() })
    await client.request('plan', params({ planId: 'f' }))
    if (results.flagged.kind !== 'workflow') throw new Error('workflow expected')
    const keys = results.flagged.flags.map(flagKey)
    for (const given of [[], keys.slice(0, 2), [...keys, 'stray']]) {
      expect((await rejection(client.request('deployPlan', { planId: 'f', confirmed: given }))).code).toBe('PLAN_NOT_CONFIRMED')
    }
    const deployed = await client.request('deployPlan', { planId: 'f', confirmed: [...keys].reverse() })
    expect(deployed.workflowId).toBeTruthy()
  })

  it('uses the deploy id of the data, and says PLAN_DEPLOYED the second time', async () => {
    const { client } = setup({ deployId: 'wf-fixed' })
    await client.request('plan', params({ planId: 'p' }))
    expect(await client.request('deployPlan', { planId: 'p', confirmed: [] })).toEqual({ workflowId: 'wf-fixed' })
    expect((await rejection(client.request('deployPlan', { planId: 'p', confirmed: [] }))).code).toBe('PLAN_DEPLOYED')
  })

  it('gives a different workflow id to each deployed plan when no id is set', async () => {
    const { client } = setup()
    await client.request('plan', params({ planId: 'p1' }))
    await client.request('plan', params({ planId: 'p2' }))
    const a = await client.request('deployPlan', { planId: 'p1', confirmed: [] })
    const b = await client.request('deployPlan', { planId: 'p2', confirmed: [] })
    expect(a.workflowId).not.toBe(b.workflowId)
  })

  it('says NOT_FOUND for an unknown plan and PLAN_DEPLOYED for a plan that is not a workflow', async () => {
    const { client } = setup({ script: () => outcome(results.questions) })
    expect((await rejection(client.request('deployPlan', { planId: 'unknown', confirmed: [] }))).code).toBe('NOT_FOUND')
    await client.request('plan', params({ planId: 'q' }))
    expect((await rejection(client.request('deployPlan', { planId: 'q', confirmed: [] }))).code).toBe('PLAN_DEPLOYED')
  })

  it('rejects more than 200 confirmed keys like the schema does', async () => {
    const { client } = setup()
    await client.request('plan', params({ planId: 'p' }))
    const error = await rejection(client.request('deployPlan', { planId: 'p', confirmed: Array.from({ length: 201 }, (_, i) => `k${i}`) }))
    expect(error.code).toBe('INVALID_PARAMS')
  })
})

describe('llmModels', () => {
  it('returns the table with the provider that has no key marked', async () => {
    const { client } = setup()
    const answer = await client.request('llmModels', {})
    expect(answer.providers.filter((provider) => !provider.configured).map((provider) => provider.id)).toEqual(['grok'])
    expect(answer.active).toEqual(models.active)
  })
})

describe('memory methods', () => {
  const note = (text: string): { text: string } => ({ text })

  it('lists, saves, edits and deletes', async () => {
    const { client } = setup()
    const saved = await client.request('saveMemory', note('  My receipts   are in ~/Receipts  '))
    expect(saved.item.text).toBe('My receipts are in ~/Receipts')
    expect((await client.request('listMemory', {})).items).toEqual([saved.item])
    const edited = await client.request('saveMemory', { id: saved.item.id, text: 'Alerts go to slack-ops' })
    expect(edited.item.id).toBe(saved.item.id)
    expect(edited.item.createdAt).toBe(saved.item.createdAt)
    expect(edited.item.text).toBe('Alerts go to slack-ops')
    expect(await client.request('deleteMemory', { id: saved.item.id })).toEqual({ deleted: true })
    expect(await client.request('deleteMemory', { id: saved.item.id })).toEqual({ deleted: false })
    expect((await client.request('listMemory', {})).items).toEqual([])
  })

  it('keeps at most twenty notes and says MEMORY_FULL for the twenty-first', async () => {
    const { client } = setup({ memory: [...memoryFixtures.full] })
    expect((await rejection(client.request('saveMemory', note('one more')))).code).toBe('MEMORY_FULL')
    const [first] = memoryFixtures.full
    await expect(client.request('saveMemory', { id: first!.id, text: 'edited while full' })).resolves.toBeDefined()
  })

  it('refuses a duplicate, ignoring case and spacing, and allows a note to keep its own text', async () => {
    const { client } = setup({ memory: [...memoryFixtures.three] })
    const [a, b] = memoryFixtures.three as [MemoryItem, MemoryItem, MemoryItem]
    expect((await rejection(client.request('saveMemory', note(a.text.toUpperCase())))).code).toBe('MEMORY_DUPLICATE')
    expect((await rejection(client.request('saveMemory', note(`  ${a.text}  `)))).code).toBe('MEMORY_DUPLICATE')
    expect((await rejection(client.request('saveMemory', { id: b.id, text: a.text }))).code).toBe('MEMORY_DUPLICATE')
    await expect(client.request('saveMemory', { id: a.id, text: a.text })).resolves.toBeDefined()
  })

  it('says NOT_FOUND when editing a note that is not there', async () => {
    const { client } = setup()
    expect((await rejection(client.request('saveMemory', { id: 'ghost', text: 'text' }))).code).toBe('NOT_FOUND')
  })

  it('refuses an empty note, a long note, a line break, control, bidi and invisible format characters', async () => {
    const { client } = setup()
    const cases: Array<[string, string]> = [
      ['empty', '   '],
      ['too_long', 'x'.repeat(301)],
      ['line_separator', 'a\u2028b'],
      ['control_character', 'a\nb'],
      ['control_character', 'a\tb'],
      ['bidi_format', 'a\u202Eb'],
      ['bidi_format', 'a\u200Fb'],
      ['format_character', 'a\u200Bb'],
      ['format_character', 'a\u00ADb'],
      ['format_character', 'a\uFEFFb'],
      ['format_character', 'a\u{E0041}b'],
    ]
    for (const [rule, text] of cases) {
      const error = await rejection(client.request('saveMemory', note(text)))
      expect(error.code, rule).toBe('MEMORY_INVALID')
      expect(error.problems[0]!.startsWith(`${rule}:`), `${rule} for ${JSON.stringify(text)}`).toBe(true)
    }
  })

  it('accepts three hundred characters, a zero-width joiner and Korean text', async () => {
    const { client } = setup()
    await client.request('saveMemory', note('가'.repeat(300)))
    await client.request('saveMemory', note('family 👨‍👩‍👧 note'))
    await client.request('saveMemory', note('영수증은 ~/Receipts 폴더에 있어요'))
  })

  it('counts characters, not UTF-16 units, for the 300 limit', async () => {
    const { client } = setup()
    await client.request('saveMemory', note('😀'.repeat(300)))
    expect((await rejection(client.request('saveMemory', note('😀'.repeat(301))))).code).toBe('MEMORY_INVALID')
  })

  it('leaves the schema limit of 2000 input characters to the schema', async () => {
    const { client } = setup()
    expect((await rejection(client.request('saveMemory', note('x'.repeat(2001))))).code).toBe('INVALID_PARAMS')
  })

  it('never puts the text of a note in an error', async () => {
    const SECRET = 'my-secret-note-text-9981'
    const { client } = setup({ memory: [{ id: 'm1', text: SECRET, createdAt: 1, updatedAt: 1 }] })
    const errors = [
      await rejection(client.request('saveMemory', note(SECRET))),
      await rejection(client.request('saveMemory', note(`${SECRET}\u200B`))),
      await rejection(client.request('saveMemory', note(SECRET.repeat(20)))),
      await rejection(client.request('saveMemory', { id: 'ghost', text: SECRET })),
    ]
    for (const error of errors) expect(JSON.stringify({ message: error.message, problems: error.problems, code: error.code })).not.toContain(SECRET)
  })

  it('returns notes in the order they were created', async () => {
    const { client } = setup()
    for (const text of ['one', 'two', 'three']) await client.request('saveMemory', note(text))
    expect((await client.request('listMemory', {})).items.map((item) => item.text)).toEqual(['one', 'two', 'three'])
  })
})

describe('method names', () => {
  it('handles the plan, memory and model methods itself and leaves the rest to the wrapped client', async () => {
    const { client } = setup()
    expect((await rejection(client.request('explainRun', { runId: 'x' }))).code).toBe('UNKNOWN_METHOD')
    for (const method of ['plan', 'cancelPlan', 'deployPlan', 'saveMemory', 'deleteMemory'] as const) {
      const error = await rejection(client.request(method, {} as never))
      expect(error.code, method).toBe('INVALID_PARAMS')
    }
  })
})
