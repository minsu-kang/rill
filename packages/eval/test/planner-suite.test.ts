import { homedir } from 'node:os'
import type { LlmProvider, LlmRequest, LlmResult } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { PlanError, createPlanner, type PlanRequest, type PlannerDeps } from '@rill/planner'
import { describe, expect, it, vi } from 'vitest'
import type { RunContext } from '../src/suite'
import { PDF_INPUT_TOKENS, PNG_INPUT_TOKENS, TEXT_CHARS_PER_TOKEN } from '../src/suites/extract/suite'
import { BASE_INPUT_TOKENS, DEFAULT_MAX_REPAIR_ROUNDS } from '../src/suites/planner/budget'
import { loadPlannerData } from '../src/suites/planner/cases'
import { ERROR_ISSUE, fakeResult, fakeRound, workflowBody } from '../src/suites/planner/fake-results'
import { scorePlannerCase } from '../src/suites/planner/scoring'
import { PLANNER_SUITE_NAME, createPlannerSuite, plannerSentRequestOf, plannerVersions, type PlannerFactory, type PlannerFactoryInput } from '../src/suites/planner/suite'

vi.mock('@rill/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rill/planner')>()
  return { ...actual, createPlanner: vi.fn(actual.createPlanner) }
})

const data = loadPlannerData()
const gold = (id: string) => structuredClone(data.references[id] as never)

const stubProvider = (calls: LlmRequest[] = []): LlmProvider => ({
  name: 'stub',
  generate: (request): Promise<LlmResult> => {
    calls.push(request)
    return Promise.resolve({
      data: {},
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      model: 'stub',
      requestedModel: 'stub',
      stopReason: 'end_turn',
      durationMs: 1,
      fallbackUsed: false,
    })
  },
})

const ctxOf = (provider = stubProvider(), signal = new AbortController().signal): RunContext => ({ provider, signal })

interface Seen {
  input: PlannerFactoryInput
  request: PlanRequest
  home: string
}

function capture(onPlan?: (input: PlannerFactoryInput) => Promise<void>): { factory: PlannerFactory; seen: Seen[] } {
  const seen: Seen[] = []
  const factory: PlannerFactory = (input) => ({
    plan: async (request) => {
      seen.push({ input, request, home: homedir() })
      await onPlan?.(input)
      return fakeResult(workflowBody(gold(input.testCase.id)))
    },
  })
  return { factory, seen }
}

const caseIn = (suite: ReturnType<typeof createPlannerSuite>, id: string) => {
  const found = suite.cases().find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('createPlannerSuite: selection', () => {
  it('has the 48 cases, five groups and a stable version', () => {
    const suite = createPlannerSuite()
    expect(suite.name).toBe(PLANNER_SUITE_NAME)
    expect(suite.cases()).toHaveLength(48)
    expect(suite.fields).toEqual(['outcome', 'checks'])
    expect(suite.workflowCases()).toHaveLength(30)
    expect(new Set(suite.cases().map((entry) => entry.group))).toEqual(new Set(['easy', 'ambiguous', 'unsupported', 'attachment', 'patch']))
    expect(createPlannerSuite().version).toBe(suite.version)
    expect(suite.version).toMatch(/^1\.1-p\d{8}-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{12}$/)
  })
  it('changes the version when the case data changes', () => {
    const changed = { ...data, cases: data.cases.map((entry, index) => (index === 0 ? { ...entry, prompt: `${entry.prompt}!` } : entry)) }
    expect(createPlannerSuite({ data: changed }).version).not.toBe(createPlannerSuite().version)
  })
  it('filters by group, by exact id, by id substring and by list', () => {
    expect(createPlannerSuite({ group: 'patch' }).cases()).toHaveLength(4)
    expect(createPlannerSuite({ group: ['patch', 'attachment'] }).cases()).toHaveLength(10)
    expect(createPlannerSuite({ only: 'patch-01-change-schedule' }).cases().map((entry) => entry.id)).toEqual(['patch-01-change-schedule'])
    expect(createPlannerSuite({ only: 'ambig-0' }).cases()).toHaveLength(9)
    expect(createPlannerSuite({ only: ['easy-01-receipt-folder-to-csv', 'unsup-01-kakaotalk'] }).cases()).toHaveLength(2)
    expect(createPlannerSuite({ group: 'easy', only: 'easy-0' }).cases()).toHaveLength(9)
  })
  it('refuses an unknown group, an unknown id and an empty match', () => {
    expect(() => createPlannerSuite({ group: 'nope' })).toThrow('unknown group: nope; groups are easy, ambiguous, unsupported, attachment, patch')
    expect(() => createPlannerSuite({ only: ['nope-01'] })).toThrow('unknown case id: nope-01')
    expect(() => createPlannerSuite({ only: 'zzz' })).toThrow('no case id contains "zzz"')
    expect(() => createPlannerSuite({ group: 'patch', only: 'easy' })).toThrow('no case id contains "easy"')
  })
  it('refuses a negative or fractional repair round count', () => {
    expect(() => createPlannerSuite({ maxRepairRounds: -1 })).toThrow(RangeError)
    expect(() => createPlannerSuite({ maxRepairRounds: 1.5 })).toThrow(RangeError)
    expect(createPlannerSuite({ maxRepairRounds: 0 }).maxRepairRounds).toBe(0)
    expect(createPlannerSuite().maxRepairRounds).toBe(DEFAULT_MAX_REPAIR_ROUNDS)
  })
  it('reports the versions a results directory records', () => {
    expect(plannerVersions(undefined, 3)).toMatchObject({ suite: '1', scorer: '1', effort: 'per case', max_repair_rounds: '3' })
    expect(plannerVersions('high', 0)).toMatchObject({ effort: 'high', max_repair_rounds: '0' })
  })
})

describe('createPlannerSuite: run', () => {
  it('hands the planner the case prompt, effort, folders, connections, registry and repair limit', async () => {
    const { factory, seen } = capture()
    const suite = createPlannerSuite({ makePlanner: factory })
    const controller = new AbortController()
    await suite.run(caseIn(suite, 'easy-03-webhook-to-slack'), ctxOf(stubProvider(), controller.signal))
    const [call] = seen
    const spec = data.cases.find((entry) => entry.id === 'easy-03-webhook-to-slack')
    expect(call?.request).toMatchObject({
      text: spec?.prompt,
      turns: [],
      attachments: [],
      effort: spec?.effort,
      context: { connections: [{ name: 'slack-ops', kind: 'slack' }], allowedRoots: spec?.context.allowedFolders },
    })
    expect(call?.request.signal).toBe(controller.signal)
    const deps: PlannerDeps | undefined = call?.input.deps
    expect(deps?.maxRepairRounds).toBe(3)
    expect(deps?.registry.list().map((def) => def.type)).toEqual(createCoreRegistry().list().map((def) => def.type))
    expect(call?.input.testCase.id).toBe('easy-03-webhook-to-slack')
  })

  it('applies an effort override to the request', async () => {
    const { factory, seen } = capture()
    const suite = createPlannerSuite({ makePlanner: factory, effort: 'max', maxRepairRounds: 1 })
    await suite.run(caseIn(suite, 'easy-03-webhook-to-slack'), ctxOf())
    expect(seen[0]?.request.effort).toBe('max')
    expect(seen[0]?.input.deps.maxRepairRounds).toBe(1)
    expect(suite.effort).toBe('max')
  })

  it('sends the selected node and the existing workflow of a patch case', async () => {
    const { factory, seen } = capture()
    const suite = createPlannerSuite({ makePlanner: factory })
    await suite.run(caseIn(suite, 'patch-02-add-branch-for-large-amount'), ctxOf())
    const request = seen[0]?.request
    const spec = data.cases.find((entry) => entry.id === 'patch-02-add-branch-for-large-amount')
    expect(request?.selection).toEqual({ nodeId: spec?.context.selectedNodeId })
    expect(request?.context.existingWorkflow).toEqual(spec?.context.existingWorkflow)
  })

  it('stores the attachments of the case in a store the planner can read by id', async () => {
    let bytes: Uint8Array | undefined
    let missing: Uint8Array | undefined = new Uint8Array()
    const { factory, seen } = capture(async ({ deps }) => {
      bytes = await deps.attachmentStore?.read('att-1')
      missing = await deps.attachmentStore?.read('nope')
    })
    const suite = createPlannerSuite({ makePlanner: factory })
    await suite.run(caseIn(suite, 'attach-02-sample-png-english'), ctxOf())
    const refs = seen[0]?.request.attachments
    expect(refs).toEqual([{ id: 'att-1', mediaType: 'image/png', name: 'sample-1.png', bytes: bytes?.length }])
    expect(Buffer.from(bytes ?? []).subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(missing).toBeUndefined()
  })

  it('plans with ~ meaning the demo home and restores HOME afterwards', async () => {
    const { factory, seen } = capture()
    const suite = createPlannerSuite({ makePlanner: factory })
    const before = process.env['HOME']
    await suite.run(caseIn(suite, 'easy-06-english-receipt-csv'), ctxOf())
    expect(seen[0]?.home).toBe('/Users/demo')
    expect(process.env['HOME']).toBe(before)
  })

  it('wraps the provider so the first request is recorded for the trace, and still forwards it', async () => {
    const calls: LlmRequest[] = []
    const factory: PlannerFactory = ({ deps, testCase }) => ({
      plan: async () => {
        const first: LlmRequest = { system: 'rules', messages: [{ role: 'user', content: 'hello' }], schema: {} }
        await deps.provider.generate(first)
        await deps.provider.generate({ ...first, messages: [{ role: 'user', content: 'second' }] })
        return fakeResult(workflowBody(gold(testCase.id)))
      },
    })
    const suite = createPlannerSuite({ makePlanner: factory })
    const output = await suite.run(caseIn(suite, 'easy-03-webhook-to-slack'), ctxOf(stubProvider(calls)))
    expect(calls).toHaveLength(2)
    expect(plannerSentRequestOf(output)).toEqual({ system: 'rules', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] })
  })

  it('returns an invalid_after_repair failure as the output, so it is graded and not retried', async () => {
    const error = new PlanError('invalid_after_repair', 'x', [fakeRound(0, [ERROR_ISSUE])], [ERROR_ISSUE])
    const suite = createPlannerSuite({ makePlanner: () => ({ plan: () => Promise.reject(error) }) })
    const output = await suite.run(caseIn(suite, 'easy-03-webhook-to-slack'), ctxOf())
    expect(output).toBe(error)
    expect(plannerSentRequestOf(output)).toBeUndefined()
    expect(suite.score(caseIn(suite, 'easy-03-webhook-to-slack'), output).status).toBe('schema_failed')
  })

  it.each(['provider', 'aborted', 'attachment'] as const)('rethrows a %s plan error so the runner classifies it', async (kind) => {
    const error = new PlanError(kind, 'x', [], [])
    const suite = createPlannerSuite({ makePlanner: () => ({ plan: () => Promise.reject(error) }) })
    await expect(suite.run(caseIn(suite, 'easy-03-webhook-to-slack'), ctxOf())).rejects.toBe(error)
  })

  it('rethrows any other error and does not leak the demo home', async () => {
    const suite = createPlannerSuite({ makePlanner: () => ({ plan: () => Promise.reject(new TypeError('bad')) }) })
    const before = process.env['HOME']
    await expect(suite.run(caseIn(suite, 'easy-03-webhook-to-slack'), ctxOf())).rejects.toThrow('bad')
    expect(process.env['HOME']).toBe(before)
  })

  it('scores through scorePlannerCase', () => {
    const suite = createPlannerSuite()
    const testCase = caseIn(suite, 'easy-01-receipt-folder-to-csv')
    const output = fakeResult(workflowBody(gold(testCase.id)))
    expect(suite.score(testCase, output)).toEqual(scorePlannerCase(testCase, output))
  })

  it('builds the default planner with createPlanner(deps)', async () => {
    const result = fakeResult(workflowBody(gold('easy-01-receipt-folder-to-csv')))
    vi.mocked(createPlanner).mockReturnValueOnce({ plan: () => Promise.resolve(result) })
    const suite = createPlannerSuite()
    const provider = stubProvider()
    expect(await suite.run(caseIn(suite, 'easy-01-receipt-folder-to-csv'), ctxOf(provider))).toBe(result)
    const deps = vi.mocked(createPlanner).mock.calls.at(-1)?.[0]
    expect(deps?.maxRepairRounds).toBe(3)
    expect(deps?.attachmentStore).toBeDefined()
    expect(deps?.registry.list()).toHaveLength(12)
  })
})

describe('createPlannerSuite: input estimate', () => {
  const suite = createPlannerSuite()
  const estimate = (id: string): number => suite.estimateInputTokens?.(caseIn(suite, id)) ?? 0
  const spec = (id: string) => data.cases.find((entry) => entry.id === id)

  it('is the fixed prompt plus the case text for a plain case', () => {
    const easy = spec('easy-03-webhook-to-slack')
    const chars = (easy?.prompt.length ?? 0) + (easy?.context.connections.join(', ').length ?? 0) + (easy?.context.allowedFolders.join(', ').length ?? 0)
    expect(estimate('easy-03-webhook-to-slack')).toBe(BASE_INPUT_TOKENS + Math.ceil(chars / TEXT_CHARS_PER_TOKEN))
  })
  it('adds the existing workflow of a patch case', () => {
    const patch = spec('patch-01-change-schedule')
    expect(estimate('patch-01-change-schedule')).toBeGreaterThan(BASE_INPUT_TOKENS + Math.ceil(JSON.stringify(patch?.context.existingWorkflow).length / TEXT_CHARS_PER_TOKEN))
  })
  it('adds the media constants for a PDF and a PNG, and the text size for a text attachment', () => {
    const plain = (id: string): number => BASE_INPUT_TOKENS + Math.ceil(((spec(id)?.prompt.length ?? 0) + (spec(id)?.context.connections.join(', ').length ?? 0) + (spec(id)?.context.allowedFolders.join(', ').length ?? 0)) / TEXT_CHARS_PER_TOKEN)
    expect(estimate('attach-01-sample-pdf-extract-to-csv') - plain('attach-01-sample-pdf-extract-to-csv')).toBe(PDF_INPUT_TOKENS)
    expect(estimate('attach-02-sample-png-english') - plain('attach-02-sample-png-english')).toBe(PNG_INPUT_TOKENS)
    const text = estimate('attach-04-text-injection-outside-path') - plain('attach-04-text-injection-outside-path')
    expect(text).toBeGreaterThan(400)
    expect(text).toBeLessThan(1000)
  })
})
