import { LlmError, costUsd, type LlmSystemBlock } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { EFFORT_BUDGETS, PLANNER_RULES, PlanError, catalogText, createPlanner, generationSchema, type PlanEffort } from '../src/index'
import { FakeProvider, SONNET, usage } from './fake-provider'
import { ROOT, receipts, registry, request, slackWorkflow, workflowData } from './fixtures'

async function planError(promise: Promise<unknown>): Promise<PlanError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlanError) return error
    throw error
  }
  throw new Error('expected a PlanError')
}

describe('createPlanner', () => {
  it('returns a valid workflow on the first try', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts(), 'Ledger') }])
    const result = await createPlanner({ provider, registry }).plan(request({ text: `Put my receipts into ${ROOT}/ledger.csv` }))
    expect(result.kind).toBe('workflow')
    if (result.kind !== 'workflow') return
    expect(result.workflow).toEqual(receipts())
    expect(result.summary).toBe('Ledger')
    expect(result.flags).toEqual([])
    expect(result.needsConfirmation).toBe(false)
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0]).toMatchObject({ index: 0, issues: [], targeted: [] })
    expect(result.model).toBe(SONNET)
    expect(result.effort).toBe('medium')
    expect(result.fallbackUsed).toBe(false)
    expect(provider.calls).toHaveLength(1)
  })

  it('asks for confirmation when the workflow has an external node', async () => {
    const provider = new FakeProvider([{ data: workflowData(slackWorkflow()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result).toMatchObject({ kind: 'workflow', needsConfirmation: true })
  })

  it('sends the rules and the catalog as system blocks with a cache breakpoint only on the catalog', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry }).plan(request())
    const sent = provider.calls[0]!.request
    const system = sent.system as LlmSystemBlock[]
    expect(system).toEqual([{ text: PLANNER_RULES }, { text: catalogText(registry), cache: true }])
    expect(sent.cache).toBeUndefined()
    const parts = sent.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    expect(parts.filter((p) => p.cache === true)).toEqual([])
    expect(sent.schema).toEqual(generationSchema(registry))
  })

  it('puts the environment and the request into the user turn, never secrets', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    await createPlanner({ provider, registry }).plan(request({ text: 'Bonjour, range mes reçus' }))
    const messages = provider.calls[0]!.request.messages
    expect(messages).toHaveLength(1)
    const text = messages[0]!.content as string
    expect(messages[0]!.role).toBe('user')
    expect(text).toContain('"allowedFolders":["/rill-planner-test-root"]')
    expect(text).toContain('"connections":[{"name":"team","kind":"slack"}]')
    expect(text.endsWith('Request:\nBonjour, range mes reçus')).toBe(true)
    expect(text).not.toContain('Patch mode')
  })

  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as PlanEffort[]) {
    it(`passes effort ${effort} with its token budget and timeout`, async () => {
      const provider = new FakeProvider([{ data: workflowData(receipts()) }])
      const result = await createPlanner({ provider, registry }).plan(request({ effort }))
      expect(provider.calls[0]!.request.effort).toBe(effort)
      expect(provider.calls[0]!.request.maxTokens).toBe(EFFORT_BUDGETS[effort].maxTokens)
      expect(provider.calls[0]!.options?.timeoutMs).toBe(EFFORT_BUDGETS[effort].timeoutMs)
      expect(result.effort).toBe(effort)
    })
  }

  it('uses the effort table of the brief', () => {
    expect(EFFORT_BUDGETS).toEqual({
      low: { maxTokens: 8000, timeoutMs: 60_000 },
      medium: { maxTokens: 12000, timeoutMs: 90_000 },
      high: { maxTokens: 16000, timeoutMs: 180_000 },
      xhigh: { maxTokens: 32000, timeoutMs: 300_000 },
      max: { maxTokens: 32000, timeoutMs: 600_000 },
    })
  })

  it('computes the cost from the price table and sums usage over rounds', async () => {
    const bad = receipts()
    bad.nodes[2]!.config = { file: '/elsewhere/x.csv', row: ['a'] }
    const provider = new FakeProvider([
      { data: workflowData(bad), usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 } },
      { data: workflowData(receipts()), usage: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 } },
    ])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 55, cacheCreationInputTokens: 7 })
    expect(result.rounds.map((r) => r.usage.inputTokens)).toEqual([100, 200])
    const expected =
      costUsd(SONNET, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 })! +
      costUsd(SONNET, { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 })!
    expect(result.costUsd).toBeCloseTo(expected, 12)
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('reports a null cost for an unknown model and the served model of the last round', async () => {
    const bad = receipts()
    bad.nodes[2]!.config = { file: '/elsewhere/x.csv', row: ['a'] }
    const provider = new FakeProvider([
      { data: workflowData(bad), model: 'mystery-model' },
      { data: workflowData(receipts()), model: 'claude-opus-5-5', fallbackUsed: true },
    ])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.costUsd).toBeNull()
    expect(result.model).toBe('claude-opus-5-5')
    expect(result.fallbackUsed).toBe(true)
  })

  it('keeps fallbackUsed when an earlier round fell back', async () => {
    const bad = receipts()
    bad.nodes[2]!.config = { file: '/elsewhere/x.csv', row: ['a'] }
    const provider = new FakeProvider([{ data: workflowData(bad), fallbackUsed: true }, { data: workflowData(receipts()) }])
    expect((await createPlanner({ provider, registry }).plan(request())).fallbackUsed).toBe(true)
  })

  it('maps provider errors to PlanError provider without retrying', async () => {
    for (const kind of ['rate_limit', 'auth', 'refusal', 'truncated', 'overloaded'] as const) {
      const provider = new FakeProvider([{ error: new LlmError(kind, `boom ${kind}`) }, { data: workflowData(receipts()) }])
      const error = await planError(createPlanner({ provider, registry }).plan(request()))
      expect(error.kind).toBe('provider')
      expect(error.cause).toBeInstanceOf(LlmError)
      expect(error.rounds).toEqual([])
      expect(provider.calls).toHaveLength(1)
    }
  })

  it('maps an aborted LlmError to PlanError aborted', async () => {
    const provider = new FakeProvider([{ error: new LlmError('aborted', 'stop') }])
    expect((await planError(createPlanner({ provider, registry }).plan(request()))).kind).toBe('aborted')
  })

  it('does not call the provider when the signal is already aborted', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const controller = new AbortController()
    controller.abort()
    const error = await planError(createPlanner({ provider, registry }).plan(request({ signal: controller.signal })))
    expect(error.kind).toBe('aborted')
    expect(provider.calls).toHaveLength(0)
  })

  it('passes the signal to the provider and aborts a running call', async () => {
    const provider = new FakeProvider([{ wait: true }])
    const controller = new AbortController()
    const pending = createPlanner({ provider, registry }).plan(request({ signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(provider.calls[0]!.options?.signal).toBe(controller.signal)
    controller.abort()
    expect((await planError(pending)).kind).toBe('aborted')
  })

  it('checks the signal between rounds', async () => {
    const bad = receipts()
    bad.nodes[2]!.config = { file: '/elsewhere/x.csv', row: ['a'] }
    const controller = new AbortController()
    const provider = new FakeProvider([{ data: workflowData(bad) }, { data: workflowData(receipts()) }])
    const generate = provider.generate.bind(provider)
    provider.generate = async (req, options) => {
      const result = await generate(req, options)
      controller.abort()
      return result
    }
    const error = await planError(createPlanner({ provider, registry }).plan(request({ signal: controller.signal })))
    expect(error.kind).toBe('aborted')
    expect(error.rounds).toHaveLength(1)
    expect(provider.calls).toHaveLength(1)
  })

  it('rethrows errors that are not LlmErrors', async () => {
    const provider = new FakeProvider([])
    await expect(createPlanner({ provider, registry }).plan(request())).rejects.toThrow(/no scripted step/)
  })

  it('defaults usage for a round to the call usage', async () => {
    const provider = new FakeProvider([{ data: workflowData(receipts()) }])
    const result = await createPlanner({ provider, registry }).plan(request())
    expect(result.usage).toEqual(usage())
    expect(result.rounds[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })
})
